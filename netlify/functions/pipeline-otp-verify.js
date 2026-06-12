'use strict';
// POST { email, code } → verifies OTP, returns signed session token + dashboard redirect data.

const crypto = require('crypto');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1ZGlzbGZrbm1ob2ZjZ3p5b3pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMDI3ODAsImV4cCI6MjA5Mjc3ODc4MH0.Kxpe0kJt0k7ZchYu70BOwm4KdT0C5aSsyeR1ov6NlQ0';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const code  = (body.code  || '').trim();

  if (!email || !code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and code required.' }) };

  // Look up the OTP
  const otpRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pipeline_otp?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used=eq.false&order=created_at.desc&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
  );
  const rows = await otpRes.json();

  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Incorrect code. Please try again.' }) };
  }

  const row = rows[0];

  if (new Date(row.expires_at) < new Date()) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Code expired. Request a new one.' }) };
  }

  // Mark OTP used
  await fetch(`${SUPABASE_URL}/rest/v1/pipeline_otp?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ used: true }),
  });

  // HMAC-SHA256 signed session token
  const ts     = Date.now();
  const toSign = JSON.stringify({ email, ts });
  const sig    = crypto.createHmac('sha256', process.env.AUTH_TOKEN_SECRET || '').update(toSign).digest('hex');
  const token  = Buffer.from(JSON.stringify({ email, ts, sig })).toString('base64');

  // Look up subscriber record (service key bypasses RLS)
  let isSubscriber = false;
  let viewToken    = null;
  const lookupKey  = SERVICE_KEY || ANON_KEY;

  try {
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/capgen_subscriptions?email=eq.${encodeURIComponent(email)}&select=demo_token&limit=1`,
      { headers: { apikey: lookupKey, Authorization: `Bearer ${lookupKey}` } }
    );
    const subs = await subRes.json();
    if (Array.isArray(subs) && subs[0]) {
      isSubscriber = true;
      viewToken    = subs[0].demo_token || null;
    }
  } catch(e) { /* non-fatal */ }

  // If no token from subscription, check demo_snapshots (any status — pending snapshots still have a valid token)
  if (!viewToken) {
    try {
      const snapRes = await fetch(
        `${SUPABASE_URL}/rest/v1/demo_snapshots?requester_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1&select=view_token`,
        { headers: { apikey: lookupKey, Authorization: `Bearer ${lookupKey}` } }
      );
      const snaps = await snapRes.json();
      if (Array.isArray(snaps) && snaps[0] && snaps[0].view_token) {
        viewToken = snaps[0].view_token;
      }
    } catch(e) { /* non-fatal */ }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, token, email, view_token: viewToken, is_subscriber: isSubscriber }),
  };
};
