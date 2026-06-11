'use strict';
// stripe-capgen-webhook.js — EXTENDED (Subscriber Onboarding spec)
// Events: checkout.session.completed (Path A + Path B) | customer.subscription.deleted
// Idempotency: stripe_events table keyed on Stripe event ID
// SECURITY: Set STRIPE_CAPGEN_WEBHOOK_SECRET in Netlify — without it, signature
//           verification is skipped and any POST is accepted. FLAG TO JEFF.

const crypto = require('crypto');

const PIPELINE_URL = 'https://capgen.aproposgroupllc.com/pipeline';
const ONBOARD_URL  = 'https://capgen.aproposgroupllc.com/capgen-onboarding';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'CapGen Reports <reports@aproposgroupllc.com>';
const WEBHOOK_SEC  = process.env.STRIPE_CAPGEN_WEBHOOK_SECRET || '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sbH(extra) {
  return Object.assign({ apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',').reduce(function(acc, p) {
      var kv = p.split('='); acc[kv[0]] = kv[1]; return acc;
    }, {});
    var signed   = parts.t + '.' + rawBody;
    var expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    var received = Buffer.from(parts.v1 || '', 'hex');
    var exp      = Buffer.from(expected, 'hex');
    return received.length === exp.length && crypto.timingSafeEqual(exp, received);
  } catch(e) { return false; }
}

// ── Idempotency ───────────────────────────────────────────────────────────────

async function isEventProcessed(eventId) {
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/stripe_events?id=eq.' + encodeURIComponent(eventId) + '&select=id',
    { headers: sbH() }
  );
  if (!res.ok) return false;
  return (await res.json()).length > 0;
}

async function markEventProcessed(eventId) {
  await fetch(SUPABASE_URL + '/rest/v1/stripe_events', {
    method: 'POST',
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ id: eventId }),
  });
}

// ── Demo snapshot lookup (Path A) ─────────────────────────────────────────────

async function getSnapshot(viewToken) {
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/demo_snapshots?view_token=eq.' + encodeURIComponent(viewToken)
      + '&status=eq.complete&limit=1',
    { headers: sbH() }
  );
  if (!res.ok) return null;
  var rows = await res.json();
  return rows[0] || null;
}

// ── capgen_subscriptions upsert ───────────────────────────────────────────────

async function upsertSubscription(record) {
  var email = record.email;
  var checkRes = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email) + '&select=id,status',
    { headers: sbH() }
  );
  var existing = checkRes.ok ? await checkRes.json() : [];
  var method = existing.length > 0 ? 'PATCH' : 'POST';
  var url = method === 'PATCH'
    ? SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email)
    : SUPABASE_URL + '/rest/v1/capgen_subscriptions';
  var res = await fetch(url, {
    method: method,
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify(record),
  });
  if (!res.ok) console.error('[webhook] capgen_subscriptions upsert error:', (await res.text()).slice(0, 200));
}

// ── Existing: auth user + client_onboarding (kept per clarification 2) ────────

async function createSupabaseUser(email, metadata) {
  if (!SERVICE_KEY) return null;
  try {
    var res = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: sbH(),
      body: JSON.stringify({ email: email, email_confirm: true, user_metadata: metadata }),
    });
    var data = await res.json();
    return data.id || null;
  } catch(e) { console.warn('[webhook] auth user:', e.message); return null; }
}

async function logOnboarding(email, firstName, businessName, stripeCustomerId, stripeSessionId) {
  return fetch(SUPABASE_URL + '/rest/v1/client_onboarding', {
    method: 'POST',
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      email: email, first_name: firstName, business_name: businessName,
      pipeline_url: PIPELINE_URL, welcome_sent_at: new Date().toISOString(),
      metadata: { stripe_customer_id: stripeCustomerId, stripe_session_id: stripeSessionId, source: 'stripe_checkout' },
    }),
  }).catch(function(e) { console.warn('[webhook] client_onboarding log:', e.message); });
}

// ── Welcome email ─────────────────────────────────────────────────────────────

async function sendWelcomeEmail(email, firstName, businessName, customerId, onboardingState) {
  if (!RESEND_KEY) return;
  var isNewUser = onboardingState !== 'complete';
  var ctaUrl    = isNewUser ? (ONBOARD_URL + '?state=' + onboardingState) : PIPELINE_URL;
  var ctaLabel  = isNewUser ? 'Complete Your Setup →' : 'Open My Pipeline →';
  var subtitle  = isNewUser
    ? 'Your CapGen subscription is active. Complete your profile to unlock your personalized federal contract pipeline.'
    : 'Your federal contract pipeline is ready. Sign in below to access your dashboard.';

  var html = '<div style="font-family:Arial,sans-serif;background:#0F2A6A;padding:40px 20px;">'
    + '<div style="max-width:520px;margin:0 auto;background:#163472;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:36px 32px;">'
    + '<p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#6EE7A8;font-weight:700;">CapGen Pro · AI4 Businesses</p>'
    + '<h2 style="margin:0 0 16px;font-size:22px;color:#fff;">Welcome to CapGen, ' + firstName + '.</h2>'
    + '<p style="margin:0 0 24px;font-size:14px;color:rgba(255,255,255,.7);line-height:1.7;">' + subtitle + '</p>'
    + '<table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">'
    + '<tr><td style="background:#6EE7A8;border-radius:10px;padding:14px 28px;text-align:center;">'
    + '<a href="' + ctaUrl + '" style="color:#0F2A6A;font-weight:700;font-size:15px;text-decoration:none;">' + ctaLabel + '</a>'
    + '</td></tr></table>'
    + '<p style="margin:0;font-size:11px;color:rgba(255,255,255,.3);">Questions? Reply to this email — we respond same business day.</p>'
    + '<p style="margin:10px 0 0;font-size:11px;color:rgba(255,255,255,.25);font-style:italic;">CapGen intelligence is sourced from official public records.</p>'
    + '<p style="margin:6px 0 0;font-size:10px;color:rgba(255,255,255,.2);">Apropos Group LLC · ' + (process.env.MAILING_ADDRESS || 'Las Vegas, NV') + '</p>'
    + '</div></div>';

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [email],
      subject: 'Welcome to CapGen Pro — ' + (businessName || 'Your Pipeline is Ready'),
      html: html,
    }),
  });
}

// ── checkout.session.completed ────────────────────────────────────────────────

async function handleCheckout(session) {
  var email        = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  var name         = (session.customer_details && session.customer_details.name) || '';
  var firstName    = name.split(' ')[0] || 'there';
  var businessName = (session.metadata && session.metadata.business_name) || name || '';
  var customerId   = session.customer || '';
  var sessionId    = session.id || '';
  var viewToken    = session.client_reference_id || '';
  var subId        = session.subscription || null;

  if (!email) { console.error('[webhook] no email in session'); return; }
  console.log('[webhook] checkout:', businessName, '<' + email + '> view_token=' + (viewToken || 'none'));

  var onboardingState = 'enrichment_pending'; // default
  var snapshotId = null;
  var subRecord = {
    email:                   email.toLowerCase().trim(),
    first_name:              firstName,
    business_name:           businessName || null,
    stripe_customer_id:      customerId || null,
    stripe_subscription_id:  subId,
    status:                  'active',
    updated_at:              new Date().toISOString(),
  };

  // Path A: demo convert — view_token resolves to a complete snapshot
  if (viewToken && viewToken.length > 20) {
    var snapshot = await getSnapshot(viewToken);
    if (snapshot) {
      var p = snapshot.profile || {};
      snapshotId = snapshot.id;
      onboardingState = 'enrichment_pending';
      Object.assign(subRecord, {
        uei:              p.uei || null,
        cage:             p.cage || null,
        naics:            p.naics ? p.naics.map(function(n) { return n.code; }) : null,
        sam_status:       p.sam_status || null,
        address:          (p.city && p.state) ? p.city + ', ' + p.state : null,
        set_asides:       p.set_asides || [],
        demo_snapshot_id: snapshotId,
        onboarding_state: onboardingState,
      });
      console.log('[webhook] Path A: seeded from snapshot', snapshotId, 'uei=' + (p.uei || 'none'));
    }
  }

  // Path B: direct signup — no snapshot → always entity_pending (spec Section 1)
  if (!snapshotId) {
    onboardingState = 'entity_pending';
    subRecord.onboarding_state = onboardingState;
    console.log('[webhook] Path B: entity_pending');
  }

  // 1. Upsert capgen_subscriptions (new)
  await upsertSubscription(subRecord);

  // 2. Create Supabase auth user (existing — kept per clarification 2)
  try { await createSupabaseUser(email, { first_name: firstName, business_name: businessName }); }
  catch(e) { console.warn('[webhook] auth user note:', e.message); }

  // 3. Welcome email
  try { await sendWelcomeEmail(email, firstName, businessName, customerId, onboardingState); }
  catch(e) { console.error('[webhook] welcome email error:', e.message); }

  // 4. Log to client_onboarding (existing — kept per clarification 2)
  await logOnboarding(email, firstName, businessName, customerId, sessionId);
}

// ── customer.subscription.deleted ─────────────────────────────────────────────

async function handleSubscriptionDeleted(subscription) {
  var customerId = subscription.customer;
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?stripe_customer_id=eq.' + encodeURIComponent(customerId) + '&select=email',
    { headers: sbH() }
  );
  if (!res.ok) return;
  var rows = await res.json();
  if (!rows.length) { console.warn('[webhook] no subscriber for customer', customerId); return; }
  var email = rows[0].email;
  await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
    { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }) }
  );
  console.log('[webhook] subscription canceled for', email);
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  var rawBody   = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '');
  var sigHeader = event.headers['stripe-signature'] || '';

  if (WEBHOOK_SEC && !verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SEC)) {
    console.error('[webhook] invalid signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  var stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  var eventId = stripeEvent.id;

  // Idempotency: skip already-processed events
  if (eventId) {
    var processed = await isEventProcessed(eventId);
    if (processed) {
      console.log('[webhook] duplicate event skipped:', eventId);
      return { statusCode: 200, body: 'Duplicate' };
    }
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    await handleCheckout(stripeEvent.data.object);
  } else if (stripeEvent.type === 'customer.subscription.deleted') {
    await handleSubscriptionDeleted(stripeEvent.data.object);
  } else {
    return { statusCode: 200, body: 'Ignored' };
  }

  if (eventId) await markEventProcessed(eventId);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
