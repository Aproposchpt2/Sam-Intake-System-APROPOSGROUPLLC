'use strict';
// demo-get.js — Public snapshot poll endpoint. Token IS the access.
// GET ?t={view_token} → snapshot row (PII stripped)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const token = (event.queryStringParameters || {}).t || '';
  if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'view_token required' }) };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/demo_snapshots?view_token=eq.${encodeURIComponent(token)}&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
  );
  if (!res.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Database error' }) };
  const rows = await res.json();
  if (!rows.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Snapshot not found' }) };

  const r = rows[0];
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      status:                  r.status,
      business_name:           r.business_name,
      generated_at:            r.generated_at,
      profile:                 r.profile,
      opportunities:           r.opportunities,
      additional_match_count:  r.additional_match_count,
      analysis:                r.analysis,
      view_token:              r.view_token,
    }),
  };
};
