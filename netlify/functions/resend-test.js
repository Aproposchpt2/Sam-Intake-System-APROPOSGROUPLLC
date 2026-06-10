'use strict';
// TEMPORARY dual-send test — delete after use
exports.handler = async function(event) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return { statusCode: 500, body: JSON.stringify({ error: 'no key' }) };

  async function tryFrom(from, subject) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from, to: ['jmitchell1126@gmail.com'], subject: subject,
        html: '<p>Sender test from <strong>' + from + '</strong> — CapGen</p>',
      }),
    });
    return { status: r.status, response: await r.json() };
  }

  const root   = await tryFrom('CapGen Reports <reports@aproposgroupllc.com>',        'Test 1 — reports@aproposgroupllc.com');
  const capgen = await tryFrom('CapGen Reports <reports@capgen.aproposgroupllc.com>',  'Test 2 — reports@capgen.aproposgroupllc.com');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_domain: root, capgen_subdomain: capgen }, null, 2),
  };
};
