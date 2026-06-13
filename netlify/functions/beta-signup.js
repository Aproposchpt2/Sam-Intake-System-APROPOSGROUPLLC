'use strict';
// POST { full_name, company_name, email, primary_naics, additional_naics?, cage_code?, linkedin_url?, referral_source? }
// Idempotent: duplicate email returns existing token.

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'CapGen <jmitchell@ai4websitedesign.com>';
const SITE_URL     = 'https://capgen.aproposgroupllc.com';

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
    // Re-send welcome email so returning signups always get their link
    const existingToken   = existingRows[0].access_token;
    const existingDashUrl = SITE_URL + '/demo/snapshot?t=' + encodeURIComponent(existingToken);
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: 'Your CapGen Beta Dashboard Link',
        html: `<div style="font-family:Arial,sans-serif;background:#0A1A3A;padding:40px 20px;"><div style="max-width:480px;margin:0 auto;background:#0f2244;border:1px solid rgba(91,175,255,.25);border-radius:18px;padding:36px 32px;"><h2 style="margin:0 0 16px;font-size:22px;color:#f0f6ff;">Here's your dashboard link.</h2><p style="margin:0 0 20px;font-size:14px;color:#8facd0;line-height:1.7;">You already have an active beta account. Here's your personal dashboard link:</p><div style="background:#07111f;border:2px solid #6EE7A8;border-radius:14px;padding:20px 24px;margin-bottom:24px;"><a href="${existingDashUrl}" style="color:#6EE7A8;font-size:13px;word-break:break-all;font-weight:700;text-decoration:none;">${existingDashUrl}</a></div><a href="${existingDashUrl}" style="display:block;background:#6EE7A8;color:#0A1A3A;font-weight:700;font-size:15px;padding:16px;border-radius:10px;text-align:center;text-decoration:none;">Open My Dashboard →</a></div></div>`,
      }),
    }).catch(() => {});
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, access_token: existingToken, existing: true }),
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

  // Send welcome email with personal dashboard link
  const dashboardUrl = SITE_URL + '/demo/snapshot?t=' + encodeURIComponent(access_token);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: 'You\'re in — Your CapGen Beta Dashboard',
        html: `
<div style="font-family:Arial,sans-serif;background:#0A1A3A;padding:40px 20px;min-height:100vh;">
  <div style="max-width:480px;margin:0 auto;background:#0f2244;border:1px solid rgba(91,175,255,.25);border-radius:18px;padding:36px 32px;">
    <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#5BD3FF;font-weight:700;">CapGen Beta</p>
    <h2 style="margin:0 0 16px;font-size:22px;color:#f0f6ff;">You're in, ${full_name.split(' ')[0]}.</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#8facd0;line-height:1.7;">
      Your personal CapGen dashboard is ready. It's already filtered to your NAICS codes and scoring live federal opportunities against your profile.
    </p>
    <div style="background:#07111f;border:2px solid #6EE7A8;border-radius:14px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:11px;color:#5a7899;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;">Your Personal Dashboard Link</div>
      <a href="${dashboardUrl}" style="color:#6EE7A8;font-size:13px;word-break:break-all;font-weight:700;text-decoration:none;">${dashboardUrl}</a>
    </div>
    <p style="margin:0 0 10px;font-size:13px;color:#8facd0;line-height:1.7;">
      <strong style="color:#f0f6ff;">Bookmark this link</strong> — it's your access for the full 30-day beta period. No password needed.
    </p>
    <p style="margin:0 0 24px;font-size:13px;color:#8facd0;line-height:1.7;">
      We'll check in around day 10 for your honest feedback. That's all we ask.
    </p>
    <a href="${dashboardUrl}" style="display:block;background:#6EE7A8;color:#0A1A3A;font-weight:700;font-size:15px;padding:16px;border-radius:10px;text-align:center;text-decoration:none;">Open My Dashboard →</a>
    <p style="margin:20px 0 0;font-size:11px;color:#2a3f52;font-style:italic;text-align:center;">CapGen intelligence is sourced from official public records.</p>
  </div>
</div>`,
      }),
    });
  } catch(e) { console.error('[beta-signup] email failed:', e.message); }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, access_token, existing: false }),
  };
};
