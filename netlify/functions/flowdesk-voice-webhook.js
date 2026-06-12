const xmlHeaders = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: xmlHeaders, body: '' };
  }

  const actionUrl = absoluteUrl(event, '/.netlify/functions/flowdesk-voice-intake');

  return twiml(`
    <Response>
      <Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="6">
        <Say voice="alice">
          Thank you for calling FlowDesk Pro. Please tell us your name, business name, what you need help with, and how urgent the request is. When you are finished, pause for a moment.
        </Say>
      </Gather>
      <Say voice="alice">
        We did not receive the request details. Please call back or submit the web intake form. Goodbye.
      </Say>
    </Response>
  `);
};

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
