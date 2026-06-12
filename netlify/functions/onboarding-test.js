'use strict';
// TEMPORARY — delete after Section 8 acceptance. Fires signed Stripe test events.
// GET ?test=pathA&view_token=XXX&email=YYY
// GET ?test=pathB&email=YYY
// GET ?test=idempotency&event_id=ZZZ
// GET ?test=deleted&customer_id=CCC

const crypto = require('crypto');

exports.handler = async function(event) {
  const WEBHOOK_SEC  = process.env.STRIPE_CAPGEN_WEBHOOK_SECRET;
  const SITE_URL     = process.env.DEPLOY_URL || process.env.URL || '';
  const WEBHOOK_URL  = SITE_URL + '/.netlify/functions/stripe-capgen-webhook';
  const q = event.queryStringParameters || {};

  if (!WEBHOOK_SEC) return { statusCode: 500, body: JSON.stringify({ error: 'STRIPE_CAPGEN_WEBHOOK_SECRET not set' }) };

  // DB direct test: insert a row via REST API to expose exact Supabase error
  if (q.test === 'db') {
    const SUPA_URL = process.env.SUPABASE_URL;
    const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const testEmail = 'db-test-' + Date.now() + '@test.internal';
    const checkRes = await fetch(
      SUPA_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(testEmail) + '&select=id',
      { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } }
    );
    const insertRes = await fetch(SUPA_URL + '/rest/v1/capgen_subscriptions', {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ email: testEmail, business_name: 'DB Test', status: 'active', onboarding_state: 'enrichment_pending', first_name: 'Test' }),
    });
    const insertBody = await insertRes.text();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      supa_url: SUPA_URL ? SUPA_URL.slice(0,40) + '...' : 'NOT SET',
      supa_key_set: !!SUPA_KEY,
      supa_key_prefix: SUPA_KEY ? SUPA_KEY.slice(0,10) + '...' : 'NOT SET',
      check_status: checkRes.status,
      insert_status: insertRes.status,
      insert_response: insertBody,
    }) };
  }

  function makeEvent(type, data, eventId) {
    return {
      id: eventId || ('evt_test_' + Date.now()),
      type: type,
      data: { object: data },
    };
  }

  function sign(body) {
    const ts  = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', WEBHOOK_SEC).update(ts + '.' + body).digest('hex');
    return { sig: 't=' + ts + ',v1=' + sig };
  }

  async function sendEvent(payload) {
    const body = JSON.stringify(payload);
    const { sig } = sign(body);
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: body,
    });
    return { status: res.status, body: await res.text() };
  }

  const test = q.test;
  const email = q.email || 'onboarding-test-' + Date.now() + '@capgen-test.internal';

  if (test === 'pathA') {
    const viewToken = q.view_token || '';
    const session = {
      id: 'cs_test_pathA_' + Date.now(), object: 'checkout.session',
      client_reference_id: viewToken,
      customer: 'cus_test_' + Date.now(), subscription: 'sub_test_' + Date.now(),
      customer_details: { email: email, name: 'Test User Path A' },
      customer_email: email,
      metadata: { business_name: 'Test Business Path A' },
    };
    const result = await sendEvent(makeEvent('checkout.session.completed', session));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'pathA', email, view_token: viewToken, webhook: result }) };
  }

  if (test === 'pathB') {
    const session = {
      id: 'cs_test_pathB_' + Date.now(), object: 'checkout.session',
      client_reference_id: 'direct',
      customer: 'cus_test_' + Date.now(), subscription: 'sub_test_' + Date.now(),
      customer_details: { email: email, name: 'Test User Path B' },
      customer_email: email,
      metadata: {},
    };
    const result = await sendEvent(makeEvent('checkout.session.completed', session));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'pathB', email, webhook: result }) };
  }

  if (test === 'idempotency') {
    const eventId = q.event_id || ('evt_test_idem_' + Date.now());
    const session = {
      id: 'cs_test_idem_' + Date.now(), object: 'checkout.session',
      client_reference_id: '',
      customer: 'cus_test_idem', subscription: 'sub_test_idem',
      customer_details: { email: email, name: 'Idempotency Test' },
      customer_email: email, metadata: {},
    };
    const payload = makeEvent('checkout.session.completed', session, eventId);
    const r1 = await sendEvent(payload);
    const r2 = await sendEvent(payload); // exact same event_id — should be ignored
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'idempotency', event_id: eventId,
        first_call: r1, second_call: r2,
        idempotent: r2.body.includes('Duplicate') }) };
  }

  if (test === 'deleted') {
    const customerId = q.customer_id || 'cus_test_del_' + Date.now();
    const sub = {
      id: 'sub_test_del_' + Date.now(), object: 'subscription',
      customer: customerId, status: 'canceled',
    };
    const result = await sendEvent(makeEvent('customer.subscription.deleted', sub));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'deleted', customer_id: customerId, webhook: result }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'test param required: pathA, pathB, idempotency, deleted' }) };
};
