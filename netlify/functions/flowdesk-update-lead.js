const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-FlowDesk-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const STATUS_MAP = {
  new: 'New / Needs Review',
  priority: 'New / Priority Review',
  contacted: 'In Progress',
  scheduled: 'In Progress',
  followup: 'In Progress',
  'follow-up': 'In Progress',
  progress: 'In Progress',
  closed: 'Closed / Resolved',
  resolved: 'Closed / Resolved',
  'New / Needs Review': 'New / Needs Review',
  'New / Priority Review': 'New / Priority Review',
  'In Progress': 'In Progress',
  'Closed / Resolved': 'Closed / Resolved'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON payload.' });
  }

  const id = clean(payload.id);
  const intakeId = clean(payload.intake_id);
  const status = normalizeStatus(payload.status || payload.lead_status);
  const internalNotes = clean(payload.internal_notes);
  const nextAction = clean(payload.next_action);
  const hasFollowUpNeeded = typeof payload.follow_up_needed === 'boolean';

  if (!id && !intakeId) {
    return jsonResponse(400, { error: 'Missing lead id or intake_id.' });
  }

  if (!status && !internalNotes && !nextAction && !hasFollowUpNeeded) {
    return jsonResponse(400, { error: 'No update fields provided.' });
  }

  const update = {};
  if (status) {
    update.lead_status = status;
    update.follow_up_needed = status !== 'Closed / Resolved';
    if (status === 'Closed / Resolved') update.closed_at = new Date().toISOString();
  }
  if (internalNotes) update.internal_notes = internalNotes;
  if (nextAction) update.next_action = nextAction;
  if (hasFollowUpNeeded) update.follow_up_needed = payload.follow_up_needed;

  const filter = id ? `id=eq.${encodeURIComponent(id)}` : `intake_id=eq.${encodeURIComponent(intakeId)}`;
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(tableName)}?${filter}`;

  try {
    let result = await patchRecord(endpoint, serviceKey, update);
    const message = String((result.data && result.data.message) || '');

    if (!result.ok && message.includes("'internal_notes' column")) {
      delete update.internal_notes;
      result = await patchRecord(endpoint, serviceKey, update);
      result.usedFallback = true;
    }

    if (!result.ok) {
      console.error('FlowDesk lead update error:', result.status, result.data);
      return jsonResponse(result.status, {
        error: 'Unable to update FlowDesk lead.',
        details: result.data
      });
    }

    return jsonResponse(200, {
      ok: true,
      record: Array.isArray(result.data) ? result.data[0] : result.data,
      usedFallback: Boolean(result.usedFallback)
    });
  } catch (error) {
    console.error('FlowDesk lead update exception:', error);
    return jsonResponse(500, { error: 'Unexpected server error while updating lead.' });
  }
};

async function patchRecord(endpoint, serviceKey, update) {
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(update)
  });

  const data = await readJson(response);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function normalizeStatus(value) {
  const raw = clean(value);
  if (!raw) return '';
  return STATUS_MAP[raw] || STATUS_MAP[raw.toLowerCase()] || '';
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
