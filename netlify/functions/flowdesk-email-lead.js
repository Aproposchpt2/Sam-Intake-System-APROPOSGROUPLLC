const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-FlowDesk-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
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

  const apiKey = clean(process.env.RESEND_API_KEY);
  const from = clean(process.env.RESEND_FROM_EMAIL);

  if (!apiKey || !from) {
    return jsonResponse(500, { error: 'Resend environment variables are not configured.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON payload.' });
  }

  const lead = normalizeLead(payload.lead || payload);
  const to = clean(payload.to || lead.email).toLowerCase();

  if (!isSendableEmail(to)) {
    return jsonResponse(400, { error: 'This lead does not have a sendable email address yet.' });
  }

  const subject = `FlowDesk Pro follow-up for ${lead.business_name || 'your automation request'}`;
  const html = buildEmailHtml(lead);
  const text = buildEmailText(lead);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text
      })
    });

    const data = await readJson(response);

    if (!response.ok) {
      console.error('FlowDesk lead email error:', response.status, data);
      return jsonResponse(response.status, {
        error: 'Unable to send lead email.',
        details: data
      });
    }

    return jsonResponse(200, {
      ok: true,
      email: to,
      details: data
    });
  } catch (error) {
    console.error('FlowDesk lead email exception:', error);
    return jsonResponse(500, { error: 'Unexpected server error while sending lead email.' });
  }
};

function normalizeLead(input) {
  return {
    intake_id: clean(input.intake_id),
    full_name: clean(input.full_name || input.name || input.customer_name),
    email: clean(input.email).toLowerCase(),
    phone: clean(input.phone),
    business_name: clean(input.business_name || input.company || input.business),
    request_type: clean(input.request_type),
    service_needed: clean(input.service_needed),
    urgency: clean(input.urgency),
    preferred_contact_method: clean(input.preferred_contact_method),
    preferred_callback_time: clean(input.preferred_callback_time),
    details: clean(input.details || input.message),
    ai_summary: clean(input.ai_summary || input.summary),
    next_action: clean(input.next_action),
    source_page: clean(input.source_page)
  };
}

function isSendableEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (email.endsWith('@flowdesk.local')) return false;
  if (email.endsWith('@example.com')) return false;
  return true;
}

function buildEmailText(lead) {
  const name = lead.full_name || 'there';
  return [
    `Hi ${name},`,
    '',
    'Thank you for reaching out to FlowDesk Pro. We received your automation request and have it in our lead manager for review.',
    '',
    lead.business_name ? `Business: ${lead.business_name}` : '',
    lead.service_needed ? `Service requested: ${lead.service_needed}` : '',
    lead.preferred_callback_time ? `Preferred callback time: ${lead.preferred_callback_time}` : '',
    '',
    'Next step: we will review your request and follow up with the best path forward.',
    '',
    'FlowDesk Pro'
  ].filter(Boolean).join('\n');
}

function buildEmailHtml(lead) {
  const name = lead.full_name || 'there';
  return `
    <div style="margin:0;padding:0;background:#07111f;color:#edf7ff;font-family:Arial,sans-serif;">
      <div style="max-width:640px;margin:0 auto;padding:28px;">
        <div style="border:1px solid rgba(91,200,255,.3);border-radius:18px;background:#0d1b2d;padding:24px;">
          <p style="margin:0 0 8px;color:#6fdcff;font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;">FlowDesk Pro</p>
          <h1 style="margin:0 0 16px;color:#fff;font-size:24px;line-height:1.2;">We received your request</h1>
          <p style="margin:0 0 16px;color:#cfe9ff;line-height:1.65;">Hi ${escapeHtml(name)}, thank you for reaching out. Your automation request has been received and is now queued for review.</p>
          ${emailRow('Business', lead.business_name)}
          ${emailRow('Service requested', lead.service_needed)}
          ${emailRow('Preferred callback time', lead.preferred_callback_time)}
          ${emailRow('Request summary', lead.ai_summary || lead.details)}
          <p style="margin:18px 0 0;color:#cfe9ff;line-height:1.65;">Next step: we will review your request and follow up with the best path forward.</p>
        </div>
      </div>
    </div>
  `;
}

function emailRow(label, value) {
  if (!clean(value)) return '';
  return `
    <div style="border-top:1px solid rgba(255,255,255,.12);padding:12px 0;">
      <p style="margin:0 0 4px;color:#8fc8ff;font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;">${escapeHtml(label)}</p>
      <p style="margin:0;color:#fff;line-height:1.5;">${escapeHtml(value)}</p>
    </div>
  `;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}
