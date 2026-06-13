'use strict';
// POST { full_name, company_name, email, primary_naics, additional_naics?, cage_code?, linkedin_url?, referral_source? }
// Idempotent: duplicate email returns existing token.

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbH(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

function validNaics(code) { return /^\d{6}$/.test((code || '').trim()); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const full_name        = (body.full_name       || '').trim();
  const company_name     = (body.company_name    || '').trim();
  const email            = (body.email           || '').trim().toLowerCase();
  const primary_naics    = (body.primary_naics   || '').trim();
  const linkedin_url     = (body.linkedin_url    || '').trim() || null;
  const cage_code        = (body.cage_code       || '').trim() || null;
  const referral_source  = (body.referral_source || '').trim() || null;

  // Validate additional NAICS
  const rawExtra = (body.additional_naics || '');
  const additional_naics = typeof rawExtra === 'string'
    ? rawExtra.split(',').map(c => c.trim()).filter(c => c.length)
    : Array.isArray(rawExtra) ? rawExtra.map(c => String(c).trim()).filter(c => c.length) : [];

  if (!full_name)    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Full name required.' }) };
  if (!company_name) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Company name required.' }) };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email required.' }) };
  if (!validNaics(primary_naics))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Primary NAICS must be a 6-digit code.' }) };
  for (const c of additional_naics) {
    if (!validNaics(c)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Invalid NAICS code: ${c}` }) };
  }

  // Idempotent — return existing token if email already registered
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/beta_testers?email=eq.${encodeURIComponent(email)}&select=access_token,status&limit=1`,
    { headers: sbH() }
  );
  const existingRows = await existing.json();
  if (Array.isArray(existingRows) && existingRows[0]) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, access_token: existingRows[0].access_token, existing: true }),
    };
  }

  // Generate beta_ prefixed token + 30-day expiry
  const access_token     = 'beta_' + crypto.randomUUID().replace(/-/g, '');
  const token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/beta_testers`, {
    method: 'POST',
    headers: { ...sbH(), Prefer: 'return=representation' },
    body: JSON.stringify({
      full_name, company_name, email, primary_naics,
      additional_naics: additional_naics.length ? additional_naics : null,
      cage_code, linkedin_url, referral_source,
      access_token, token_expires_at,
    }),
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    console.error('[beta-signup] insert failed:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Signup failed. Please try again.' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, access_token, existing: false }),
  };
};
