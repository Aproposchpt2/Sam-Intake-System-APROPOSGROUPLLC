'use strict';
// TEMPORARY — delete after test
exports.handler = async function(event) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const TO = 'jmitchell1126@gmail.com';
  const FROM_TEST = 'reports@capgen.aproposgroupllc.com';

  if (!RESEND_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'RESEND_API_KEY not set in runtime' }) };

  // 1. Check which domains are verified
  const domainsRes = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: 'Bearer ' + RESEND_KEY },
  });
  const domainsBody = await domainsRes.text();

  // 2. Send test email
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'CapGen Reports <' + FROM_TEST + '>',
      to: [TO],
      subject: 'CapGen Sender Test — ' + new Date().toISOString(),
      html: '<p>This is a sender verification test from <strong>' + FROM_TEST + '</strong>. If you received this, the FROM address is verified and working.</p>',
    }),
  });
  const sendBody = await sendRes.text();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domains_status: domainsRes.status,
      domains: JSON.parse(domainsBody),
      send_status: sendRes.status,
      send_response: JSON.parse(sendBody),
      from_tested: FROM_TEST,
      to: TO,
    }, null, 2),
  };
};
