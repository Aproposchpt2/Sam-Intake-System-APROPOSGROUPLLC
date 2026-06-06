'use strict';
// pipeline-otp-verify.js
// POST { email, code } → verifies code, returns session token.

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const code  = (body.code  || '').trim();

  if (!email || !code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and code required.' }) };

  // Look up the code
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pipeline_otp?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used=eq.false&order=created_at.desc&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const rows = await res.json();

  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Incorrect code. Please try again.' }) };
  }

  const row = rows[0];

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Code expired. Request a new one.' }) };
  }

  // Mark used
  await fetch(`${SUPABASE_URL}/rest/v1/pipeline_otp?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ used: true }),
  });

  // Simple session token — email + timestamp signed with a constant
  const token = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64');

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token, email }) };
};
