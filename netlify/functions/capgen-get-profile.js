'use strict';
// capgen-get-profile.js — GET authenticated user's capgen_subscriptions profile
// Auth: signed OTP session token

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_SECRET  = process.env.AUTH_TOKEN_SECRET;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sbH() {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
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
    if (expBuf.length !== sigBuf.length || !require('crypto').timingSafeEqual(expBuf, sigBuf)) return null;
    return data.email.toLowerCase().trim();
  } catch(e) { return null; }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  var email = verifyToken(event.headers.authorization || event.headers.Authorization || '');
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };

  var res = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email)
      + '&select=email,first_name,last_name,business_name,uei,cage,naics,primary_naics,sam_status,address,certifications,set_asides,capabilities,past_performance,team_size,keywords,profile_version,onboarding_state,status&limit=1',
    { headers: sbH() }
  );
  if (!res.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Database error' }) };
  var rows = await res.json();
  if (!rows.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Profile not found' }) };

  return { statusCode: 200, headers: CORS, body: JSON.stringify(rows[0]) };
};
