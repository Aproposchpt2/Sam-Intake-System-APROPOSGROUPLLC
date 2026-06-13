'use strict';
// POST { session_token } → validates against client_sessions, returns session data or 401.
// Used by analyze-fit.mjs and future functions requiring auth.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbH() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const token = (body.session_token || '').trim();
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'session_token required' }) };

  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/client_sessions?session_token=eq.${encodeURIComponent(token)}&revoked=eq.false&limit=1`,
    { headers: sbH() }
  );
  if (!res.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Database error' }) };

  const rows = await res.json();
  if (!Array.isArray(rows) || !rows[0]) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  const session = rows[0];
  if (new Date(session.expires_at) < new Date()) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired. Please log in again.' }) };
  }

  // Touch last_seen_at (non-blocking)
  fetch(`${SUPABASE_URL}/rest/v1/client_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    headers: { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      session_token:    session.session_token,
      email:            session.email,
      uei:              session.uei,
      business_name:    session.business_name,
      onboarding_state: session.onboarding_state,
      account_type:     session.account_type,
    }),
  };
};
