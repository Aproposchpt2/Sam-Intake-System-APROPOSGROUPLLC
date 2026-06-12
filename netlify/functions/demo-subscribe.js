'use strict';
// demo-subscribe.js — Email capture for not-registered path (double opt-in)
// POST { email, source? }

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'CapGen by Apropos Group <jmitchell@ai4websitedesign.com>';
const SITE_URL     = process.env.DEPLOY_URL || process.env.URL || '';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbH(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // GET ?confirm={token} → double opt-in confirmation
  if (event.httpMethod === 'GET') {
    var cToken = (event.queryStringParameters || {}).confirm;
    if (!cToken) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'confirm token required' }) };
    var res = await fetch(
      SUPABASE_URL + '/rest/v1/email_subscribers?confirm_token=eq.' + encodeURIComponent(cToken) + '&limit=1',
      { headers: sbH() }
    );
    var rows = await res.json();
    if (!rows.length) return { statusCode: 404, headers: CORS, body: '<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Link not found or already used.</h2></body></html>' };
    await fetch(SUPABASE_URL + '/rest/v1/email_subscribers?confirm_token=eq.' + encodeURIComponent(cToken), {
      method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirm_token: null }),
    });
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'text/html' }),
      body: '<html><body style="font-family:Arial,sans-serif;background:#0F2A6A;color:#fff;text-align:center;padding:60px 20px"><h2 style="font-size:1.8rem;margin-bottom:12px">You\'re confirmed!</h2><p style="color:rgba(255,255,255,.7)">We\'ll send you federal opportunities matched to your profile.</p><p style="margin-top:24px"><a href="/" style="color:#6EE7A8">← Back to CapGen</a></p></body></html>' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST or GET only' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var email  = (body.email  || '').trim().toLowerCase();
  var source = (body.source || 'not_registered');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid email' }) };

  var confirmToken = crypto.randomBytes(32).toString('hex');
  try {
    var insertRes = await fetch(SUPABASE_URL + '/rest/v1/email_subscribers', {
      method: 'POST', headers: sbH({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ email: email, source: source, status: 'pending', confirm_token: confirmToken }),
    });
    if (!insertRes.ok) { /* duplicate — silently succeed */ }
  } catch(e) { /* ignore */ }

  // Send confirmation email
  var confirmUrl = SITE_URL + '/.netlify/functions/demo-subscribe?confirm=' + confirmToken;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL, to: [email],
        subject: 'Confirm your CapGen alerts',
        html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">'
          + '<p style="font-size:18px;font-weight:700;color:#0F2A6A">One more step</p>'
          + '<p style="color:#43506a">Click below to confirm your email and start receiving federal opportunities matched to your profile.</p>'
          + '<p style="margin:24px 0"><a href="' + confirmUrl + '" style="background:#0F2A6A;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Confirm My Email →</a></p>'
          + '<p style="font-size:11px;color:#aaa">If you did not request this, ignore this email. No further emails will be sent.</p>'
          + '<p style="font-size:11px;color:#aaa;font-style:italic">CapGen intelligence is sourced from official public records.</p>'
          + '</div>',
      }),
    });
  } catch(e) { console.error('[demo-subscribe] email error:', e.message); }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
