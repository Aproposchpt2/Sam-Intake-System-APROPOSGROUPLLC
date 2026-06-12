const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: jsonHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const tableName = process.env.FLOWDESK_INTAKE_TABLE || 'flowdesk_intake_records';

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(500, { error: 'Supabase environment variables are not configured.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON payload.' });
  }

  const record = normalizeRecord(payload);
  const missing = requiredFields(record).filter((field) => !record[field]);

  if (missing.length) {
    return jsonResponse(400, {
      error: 'Missing required intake fields.',
      missing
    });
  }

  try {
    const insertResult = await insertSupabaseRecord(supabaseUrl, serviceKey, tableName, record);

    if (!insertResult.ok) {
      console.error('FlowDesk Supabase insert error:', insertResult.status, insertResult.data);
      return jsonResponse(insertResult.status, {
        error: 'Unable to save intake record.',
        details: insertResult.data
      });
    }

    const savedRecord = Array.isArray(insertResult.data) ? insertResult.data[0] : insertResult.data;
    const emailResult = await sendIntakeNotification(savedRecord || record);

    return jsonResponse(200, {
      ok: true,
      record: savedRecord,
      notification: emailResult
    });
  } catch (error) {
    console.error('FlowDesk submit error:', error);
    return jsonResponse(500, {
      error: 'Unexpected server error while saving intake record.'
    });
  }
};

async function insertSupabaseRecord(supabaseUrl, serviceKey, tableName, record) {
  let result = await postSupabaseRecord(supabaseUrl, serviceKey, tableName, record);
  const message = String((result.data && result.data.message) || '');

  if (!result.ok && message.includes("'sms_consent' column")) {
    const fallbackRecord = { ...record };
    delete fallbackRecord.sms_consent;
    delete fallbackRecord.sms_consent_text;
    result = await postSupabaseRecord(supabaseUrl, serviceKey, tableName, fallbackRecord);
    result.usedFallback = true;
  }

  return result;
}

async function postSupabaseRecord(supabaseUrl, serviceKey, tableName, record) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(record)
  });

  const responseText = await response.text();
  let data = null;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = responseText;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function normalizeRecord(input) {
  return {
    intake_id: clean(input.intake_id),
    created_at: clean(input.created_at) || new Date().toISOString(),
    full_name: clean(input.full_name),
    email: clean(input.email).toLowerCase(),
    phone: clean(input.phone),
    business_name: clean(input.business_name),
    industry: clean(input.industry),
    request_type: clean(input.request_type),
    service_needed: clean(input.service_needed),
    urgency: clean(input.urgency) || 'Normal',
    preferred_contact_method: clean(input.preferred_contact_method),
    preferred_callback_time: clean(input.preferred_callback_time),
    sms_consent: Boolean(input.sms_consent),
    sms_consent_text: clean(input.sms_consent_text),
    details: clean(input.details),
    notes: clean(input.notes),
    ai_summary: clean(input.ai_summary),
    category: clean(input.category),
    lead_status: clean(input.lead_status) || 'New / Needs Review',
    follow_up_needed: Boolean(input.follow_up_needed),
    next_action: clean(input.next_action),
    source_page: clean(input.source_page) || 'flowdesk-intake-engine'
  };
}

function requiredFields(record) {
  return ['full_name', 'email', 'business_name', 'urgency', 'details'];
}

async function sendIntakeNotification(record) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.RESEND_TO_EMAIL;

  if (!apiKey || !from || !to) {
    return {
      ok: false,
      skipped: true,
      reason: 'Resend environment variables are not configured.'
    };
  }

  const siteUrl = clean(process.env.FLOWDESK_SITE_URL);
  const subject = `New FlowDesk intake: ${record.business_name || record.full_name || 'New lead'}`;
  const html = buildEmailHtml(record, siteUrl);
  const text = buildEmailText(record, siteUrl);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: splitEmails(to),
        subject,
        html,
        text
      })
    });

    const responseText = await response.text();
    let data = null;

    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = responseText;
    }

    if (!response.ok) {
      console.error('FlowDesk Resend notification error:', response.status, data);
      return {
        ok: false,
        status: response.status,
        details: data
      };
    }

    return {
      ok: true,
      details: data
    };
  } catch (error) {
    console.error('FlowDesk Resend notification exception:', error);
    return {
      ok: false,
      error: error.message
    };
  }
}

function splitEmails(value) {
  return String(value || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

function buildEmailText(record, siteUrl) {
  return [
    'New FlowDesk Pro intake received',
    '',
    `Business: ${record.business_name || 'Not provided'}`,
    `Contact: ${record.full_name || 'Not provided'}`,
    `Email: ${record.email || 'Not provided'}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Industry: ${record.industry || 'Not provided'}`,
    `Request type: ${record.request_type || 'Not provided'}`,
    `Urgency: ${record.urgency || 'Not provided'}`,
    `Preferred contact: ${record.preferred_contact_method || 'Not provided'}`,
    `Callback window: ${record.preferred_callback_time || 'Not provided'}`,
    '',
    `Service needed: ${record.service_needed || 'Not provided'}`,
    '',
    `AI summary: ${record.ai_summary || 'Not provided'}`,
    '',
    `Details: ${record.details || 'Not provided'}`,
    '',
    `Next action: ${record.next_action || 'Not provided'}`,
    '',
    siteUrl ? `FlowDesk app: ${siteUrl}` : ''
  ].filter(Boolean).join('\n');
}

function buildEmailHtml(record, siteUrl) {
  return `
    <div style="margin:0;padding:0;background:#07111f;color:#edf7ff;font-family:Arial,sans-serif;">
      <div style="max-width:680px;margin:0 auto;padding:28px;">
        <div style="border:1px solid rgba(91,200,255,.3);border-radius:18px;background:#0d1b2d;padding:24px;">
          <p style="margin:0 0 8px;color:#6fdcff;font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;">FlowDesk Pro Intake</p>
          <h1 style="margin:0 0 16px;color:#fff;font-size:24px;line-height:1.2;">New intake received</h1>
          ${emailRow('Business', record.business_name)}
          ${emailRow('Contact', record.full_name)}
          ${emailRow('Email', record.email)}
          ${emailRow('Phone', record.phone)}
          ${emailRow('Industry', record.industry)}
          ${emailRow('Request Type', record.request_type)}
          ${emailRow('Urgency', record.urgency)}
          ${emailRow('Preferred Contact', record.preferred_contact_method)}
          ${emailRow('Callback Window', record.preferred_callback_time)}
          ${emailSection('Service Needed', record.service_needed)}
          ${emailSection('AI Summary', record.ai_summary)}
          ${emailSection('Customer Details', record.details)}
          ${emailSection('Next Action', record.next_action)}
          ${siteUrl ? `<p style="margin:22px 0 0;"><a href="${escapeAttr(siteUrl)}" style="color:#07111f;background:#6fdcff;border-radius:999px;padding:12px 18px;text-decoration:none;font-weight:700;display:inline-block;">Open FlowDesk App</a></p>` : ''}
        </div>
      </div>
    </div>
  `;
}

function emailRow(label, value) {
  return `
    <div style="border-top:1px solid rgba(157,180,202,.18);padding:10px 0;">
      <strong style="display:block;color:#9db4ca;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(label)}</strong>
      <span style="display:block;margin-top:4px;color:#edf7ff;font-size:15px;">${escapeHtml(value || 'Not provided')}</span>
    </div>
  `;
}

function emailSection(label, value) {
  return `
    <div style="border-top:1px solid rgba(157,180,202,.18);padding:14px 0;">
      <strong style="display:block;color:#6fdcff;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(label)}</strong>
      <p style="margin:7px 0 0;color:#edf7ff;line-height:1.6;font-size:15px;">${escapeHtml(value || 'Not provided')}</p>
    </div>
  `;
}

function clean(value) {
  return String(value || '').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}
