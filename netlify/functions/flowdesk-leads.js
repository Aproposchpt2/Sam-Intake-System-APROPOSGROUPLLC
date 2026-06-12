const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-FlowDesk-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if (!isAuthorized(event)) {
    return jsonResponse(401, { error: 'Admin key required.' });
  }

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const tableName = clean(process.env.FLOWDESK_INTAKE_TABLE) || 'flowdesk_intake_records';

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(500, { error: 'Supabase environment variables are not configured.' });
  }

  const limit = clampNumber(new URLSearchParams(event.rawQuery || '').get('limit'), 1, 250, 100);
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(tableName)}?select=*&order=created_at.desc&limit=${limit}`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await readJson(response);

    if (!response.ok) {
      console.error('FlowDesk leads read error:', response.status, data);
      return jsonResponse(response.status, {
        error: 'Unable to load FlowDesk leads.',
        details: data
      });
    }

    return jsonResponse(200, {
      ok: true,
      records: Array.isArray(data) ? data : []
    });
  } catch (error) {
    console.error('FlowDesk leads exception:', error);
    return jsonResponse(500, { error: 'Unexpected server error while loading leads.' });
  }
};

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function clean(value) {
  return String(value || '').trim();
}

function isAuthorized(event) {
  const expected = clean(process.env.FLOWDESK_ADMIN_KEY);
  if (!expected) return true;
  const headers = event.headers || {};
  const provided = clean(headers['x-flowdesk-admin-key'] || headers['X-FlowDesk-Admin-Key']);
  return provided === expected;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}
