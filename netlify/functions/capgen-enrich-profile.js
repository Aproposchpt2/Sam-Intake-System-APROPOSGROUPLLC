'use strict';
// capgen-enrich-profile.js — First-Run Experience: enrichment form submission
// POST { capabilities, past_performance, team_size, set_asides }
// Updates capgen_subscriptions profile fields, sets onboarding_state = 'complete'
// Auth: signed OTP session token

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_SECRET  = process.env.AUTH_TOKEN_SECRET;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sbH(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ') || !AUTH_SECRET) return null;
  try {
    var raw  = authHeader.slice(7);
    var data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!data.email || !data.ts || !data.sig) return null;
    if (Date.now() - data.ts > 7 * 24 * 3600000) return null;
    var toSign   = JSON.stringify({ email: data.email, ts: data.ts });
    var expected = crypto.createHmac('sha256', AUTH_SECRET).update(toSign).digest('hex');
    var expBuf   = Buffer.from(expected, 'hex');
    var sigBuf   = Buffer.from(data.sig, 'hex');
    if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) return null;
    return data.email.toLowerCase().trim();
  } catch(e) { return null; }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  var email = verifyToken(event.headers.authorization || event.headers.Authorization || '');
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var capabilities     = (body.capabilities     || '').trim();
  var past_performance = (body.past_performance || '').trim();
  var team_size        = body.team_size ? parseInt(body.team_size, 10) : null;
  var set_asides       = Array.isArray(body.set_asides) ? body.set_asides : [];
  var keywords         = Array.isArray(body.keywords)   ? body.keywords   : [];

  var patch = {
    capabilities:     capabilities || null,
    past_performance: past_performance || null,
    team_size:        isNaN(team_size) ? null : team_size,
    set_asides:       set_asides,
    keywords:         keywords,
    onboarding_state: 'complete',
    updated_at:       new Date().toISOString(),
  };

  var res = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
    { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) }
  );
  if (!res.ok) {
    var err = await res.text();
    console.error('[enrich-profile] patch error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Update failed' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, onboarding_state: 'complete' }) };
};
