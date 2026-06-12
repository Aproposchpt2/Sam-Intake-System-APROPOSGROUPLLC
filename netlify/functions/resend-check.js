'use strict';
// TEMPORARY — delete after use
exports.handler = async function() {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return { statusCode: 500, body: JSON.stringify({ error: 'no key' }) };
  // List recent emails sent to the test address
  const res = await fetch('https://api.resend.com/emails?limit=10', {
    headers: { Authorization: 'Bearer ' + KEY },
  });
  const data = await res.json();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: res.status, emails: data }, null, 2),
  };
};
