// get-analysis.mjs — Phase 2 polling endpoint
// GET ?id=<rowId>   — poll by row ID (primary, returned by analyze-fit.mjs 202)
// GET ?opportunityId=<noticeId>&profileVersion=<n>  — poll by opportunity key
// Auth: same signed HMAC token as analyze-fit.mjs

import { createHmac, timingSafeEqual } from 'crypto';

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
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() });
  if (!res.ok) throw new Error(`Supabase GET: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  if (!AUTH_SECRET) return null;
  try {
    const raw  = authHeader.slice(7);
    const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!data.email || !data.ts || !data.sig) return null;
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    const toSign   = JSON.stringify({ email: data.email, ts: data.ts });
    const expected = createHmac('sha256', AUTH_SECRET).update(toSign).digest('hex');
    const expBuf   = Buffer.from(expected, 'hex');
    const sigBuf   = Buffer.from(data.sig,  'hex');
    if (expBuf.length !== sigBuf.length || !timingSafeEqual(expBuf, sigBuf)) return null;
    return data.email.toLowerCase().trim();
  } catch { return null; }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const accountEmail = verifyToken(event.headers?.authorization || event.headers?.Authorization || '');
  if (!accountEmail) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };

  const q = event.queryStringParameters || {};
  const aeEnc = encodeURIComponent(accountEmail);

  let rows;
  if (q.id) {
    // Primary: poll by row ID (scoped to account for security)
    rows = await sbGet(
      `opportunity_analyses?id=eq.${encodeURIComponent(q.id)}&account_email=eq.${aeEnc}&limit=1`
    );
  } else if (q.opportunityId && q.profileVersion) {
    // Secondary: poll by opportunity + version
    rows = await sbGet(
      `opportunity_analyses?account_email=eq.${aeEnc}&opportunity_id=eq.${encodeURIComponent(q.opportunityId)}&profile_version=eq.${encodeURIComponent(q.profileVersion)}&limit=1`
    );
  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id or (opportunityId + profileVersion) required' }) };
  }

  if (!rows.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
  return { statusCode: 200, headers: CORS, body: JSON.stringify(rows[0]) };
};
