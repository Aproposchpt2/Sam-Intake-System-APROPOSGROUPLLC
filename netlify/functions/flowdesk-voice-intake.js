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
    return twiml('<Response><Say voice="alice">Method not allowed.</Say></Response>');
  }

  const params = parseBody(event);
  const speech = clean(params.get('SpeechResult'));
  const from = clean(params.get('From'));
  const to = clean(params.get('To'));
  const callSid = clean(params.get('CallSid'));
  const confidence = clean(params.get('Confidence'));
  const urgency = inferUrgency(speech);

  const record = {
    intake_id: uniqueId('fd-voice', callSid),
    full_name: from ? `Voice caller ${from}` : 'Voice caller',
    email: phoneEmail(from, callSid),
    phone: from,
    business_name: from ? `Voice intake from ${from}` : 'Voice intake',
    industry: 'Voice Intake',
    request_type: 'AI Voice Attendant Call',
    service_needed: 'Voice caller intake and follow-up',
    urgency,
    preferred_contact_method: 'Phone Call',
    preferred_callback_time: 'As soon as possible',
    sms_consent: false,
    details: speech || 'Caller reached the FlowDesk voice intake simulation but no speech transcript was captured.',
    notes: `Twilio simulation. CallSid: ${callSid || 'not provided'}. To: ${to || 'not provided'}. Speech confidence: ${confidence || 'not provided'}.`,
    ai_summary: buildSummary(speech, from, urgency),
    category: 'Voice Intake',
    lead_status: urgency === 'Urgent' || urgency === 'Time-sensitive' ? 'New / Priority Review' : 'New / Needs Review',
    follow_up_needed: true,
    next_action: 'Review voice transcript and return the call.',
    source_page: 'twilio-voice-webhook'
  };

  const result = await submitRecord(event, record);

  if (!result.ok) {
    console.error('FlowDesk voice intake save failed:', result);
    return twiml(`
      <Response>
        <Say voice="alice">
          Thank you. Your request was received, but the intake system could not save the record automatically. A team member should review the call log.
        </Say>
      </Response>
    `);
  }

  return twiml(`
    <Response>
      <Say voice="alice">
        Thank you. FlowDesk Pro captured your request and prepared it for follow up. Goodbye.
      </Say>
    </Response>
  `);
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

function parseBody(event) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

  if (contentType.includes('application/json')) {
    try {
      const body = JSON.parse(event.body || '{}');
      return new URLSearchParams(Object.entries(body));
    } catch {
      return new URLSearchParams();
    }
  }

  return new URLSearchParams(event.body || '');
}

function inferUrgency(text) {
  const value = String(text || '').toLowerCase();
  if (/emergency|urgent|as soon as possible|asap|immediately|right away|critical/.test(value)) return 'Urgent';
  if (/today|time sensitive|this week|soon|missed call|after hours/.test(value)) return 'Time-sensitive';
  if (/whenever|not urgent|low priority/.test(value)) return 'Low';
  return 'Normal';
}

function buildSummary(speech, from, urgency) {
  const detail = speech || 'No speech transcript was captured.';
  return `Voice intake from ${from || 'unknown caller'} marked ${urgency}. Caller said: ${detail}`;
}

function phoneEmail(phone, fallback) {
  const digits = String(phone || '').replace(/\D/g, '');
  const suffix = digits || String(fallback || Date.now()).replace(/\W/g, '').toLowerCase();
  return `voice-${suffix}@flowdesk.local`;
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
