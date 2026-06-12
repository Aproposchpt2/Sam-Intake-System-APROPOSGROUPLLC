const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const rawNumber = clean(process.env.FLOWDESK_PUBLIC_TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER);
  const phoneNumber = rawNumber || 'Twilio number pending';
  const telHref = rawNumber ? `tel:${rawNumber.replace(/[^\d+]/g, '')}` : '';
  const smsHref = rawNumber ? `sms:${rawNumber.replace(/[^\d+]/g, '')}` : '';

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      phoneNumber,
      telHref,
      smsHref,
      voiceWebhook: absoluteUrl(event, '/.netlify/functions/flowdesk-voice-webhook'),
      smsWebhook: absoluteUrl(event, '/.netlify/functions/flowdesk-sms-webhook')
    })
  };
};

function absoluteUrl(event, path) {
  const configured = clean(process.env.FLOWDESK_SITE_URL).replace(/\/$/, '');
  if (configured) return `${configured}${path}`;

  const host = event.headers.host || event.headers.Host || '';
  return host ? `https://${host}${path}` : path;
}

function clean(value) {
  return String(value || '').trim();
}
