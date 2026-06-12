const xmlHeaders = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: xmlHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return twiml('<Response></Response>');
  }

  const params = new URLSearchParams(event.body || '');
  const from = clean(params.get('From'));
  const to = clean(params.get('To'));
  const body = clean(params.get('Body'));
  const messageSid = clean(params.get('MessageSid'));
  const keyword = body.toUpperCase();

  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
    return message('FlowDesk Pro: You have been opted out and will no longer receive SMS messages from FlowDesk Pro. Reply START to opt back in.');
  }

  if (['HELP', 'INFO'].includes(keyword)) {
    return message('FlowDesk Pro: For help with your intake request, visit https://ai4app.aiflowdeskpro.com. Reply STOP to opt out. Message and data rates may apply.');
  }

  if (['START', 'YES', 'UNSTOP'].includes(keyword)) {
    return message('FlowDesk Pro: You are now opted in to receive SMS messages about your intake request, appointments, and follow-up. Reply STOP to opt out or HELP for help.');
  }

  const record = {
    intake_id: uniqueId('fd-sms', messageSid),
    full_name: from ? `SMS sender ${from}` : 'SMS sender',
    email: phoneEmail(from, messageSid),
    phone: from,
    business_name: from ? `SMS intake from ${from}` : 'SMS intake',
    industry: 'SMS Intake',
    request_type: 'SMS Intake Message',
    service_needed: 'SMS request capture and follow-up',
    urgency: inferUrgency(body),
    preferred_contact_method: 'SMS/Text',
    preferred_callback_time: 'As soon as possible',
    sms_consent: true,
    sms_consent_text: 'Inbound SMS message received by FlowDesk Pro.',
    details: body || 'Inbound SMS received without message body.',
    notes: `Twilio SMS simulation. MessageSid: ${messageSid || 'not provided'}. To: ${to || 'not provided'}.`,
    ai_summary: `Inbound SMS from ${from || 'unknown sender'}: ${body || 'No body captured.'}`,
    category: 'SMS Intake',
    lead_status: 'New / Priority Review',
    follow_up_needed: true,
    next_action: 'Review inbound SMS and respond from the approved messaging workflow.',
    source_page: 'twilio-sms-webhook'
  };

  const result = await submitRecord(event, record);

  if (!result.ok) {
    console.error('FlowDesk SMS intake save failed:', result);
    return message('FlowDesk Pro received your message, but the intake record could not be saved automatically. A team member should review the SMS log.');
  }

  return message('FlowDesk Pro received your message and prepared it for follow-up. Reply HELP for help or STOP to opt out.');
};

async function submitRecord(event, record) {
  const siteUrl = absoluteUrl(event, '').replace(/\/$/, '');

  try {
    const response = await fetch(`${siteUrl}/.netlify/functions/flowdesk-submit-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function message(text) {
  return twiml(`<Response><Message>${escapeXml(text)}</Message></Response>`);
}

function inferUrgency(text) {
  const value = String(text || '').toLowerCase();
  if (/emergency|urgent|asap|immediately|critical/.test(value)) return 'Urgent';
  if (/today|time sensitive|this week|soon|missed call|after hours/.test(value)) return 'Time-sensitive';
  if (/whenever|not urgent|low priority/.test(value)) return 'Low';
  return 'Normal';
}

function phoneEmail(phone, fallback) {
  const digits = String(phone || '').replace(/\D/g, '');
  const suffix = digits || String(fallback || Date.now()).replace(/\W/g, '').toLowerCase();
  return `sms-${suffix}@flowdesk.local`;
}

function uniqueId(prefix, value) {
  const cleanValue = String(value || Date.now()).replace(/\W/g, '').toLowerCase();
  return `${prefix}-${cleanValue.slice(-18)}`;
}

function absoluteUrl(event, path) {
  const configured = clean(process.env.FLOWDESK_SITE_URL).replace(/\/$/, '');
  if (configured) return `${configured}${path}`;

  const host = event.headers.host || event.headers.Host || '';
  return host ? `https://${host}${path}` : path;
}

function twiml(body) {
  return {
    statusCode: 200,
    headers: xmlHeaders,
    body: body.replace(/^\s+/gm, '').trim()
  };
}

function clean(value) {
  return String(value || '').trim();
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
