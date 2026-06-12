'use strict';
// stripe-capgen-webhook.js — Day 1 rewrite
// Dual-mode signature (live + test), idempotency-first, demo-snapshot seeding,
// email-mismatch handling, needs_profile fallback, livemode tagging.
//
// STANDING RULE: no send function may read contractors or email_batch
// as a recipient source (Change Order 1, Section 1).

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'CapGen Reports <reports@aproposgroupllc.com>';
const MAILING_ADDR = process.env.MAILING_ADDRESS   || 'Apropos Group LLC, Las Vegas, NV 89031';
const LIVE_SEC     = process.env.STRIPE_CAPGEN_WEBHOOK_SECRET     || '';
const TEST_SEC     = process.env.STRIPE_WEBHOOK_SECRET_TEST        || '';
const ONBOARD_URL  = 'https://capgen.aproposgroupllc.com/member-home';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sbH(extra) {
  return Object.assign({
    apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function sbGet(path) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: sbH() });
  if (!res.ok) throw new Error('DB GET: ' + (await res.text()).slice(0, 150));
  return res.json();
}

async function sbUpsert(table, row) {
  var email = row.email;
  var check = await fetch(
    SUPABASE_URL + '/rest/v1/' + table + '?email=eq.' + encodeURIComponent(email) + '&select=id',
    { headers: sbH() }
  );
  var existing = check.ok ? await check.json() : [];
  var method   = existing.length > 0 ? 'PATCH' : 'POST';
  var url = method === 'PATCH'
    ? SUPABASE_URL + '/rest/v1/' + table + '?email=eq.' + encodeURIComponent(email)
    : SUPABASE_URL + '/rest/v1/' + table;

  var body;
  if (method === 'PATCH') {
    // Always-safe to overwrite on conflict
    body = {
      stripe_customer_id:     row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      plan_type:              row.plan_type,
      payment_type:           row.payment_type,
      plan_amount:            row.plan_amount,
      current_period_start:   row.current_period_start,
      current_period_end:     row.current_period_end,
      last_payment_at:        row.last_payment_at,
      status:                 row.status,
      onboarding_state:       row.onboarding_state,
      livemode:               row.livemode,
      updated_at:             row.updated_at,
    };
    // Preserve-existing fields: only include if new value is non-null
    // (prevents clobbering populated business_name, uei, naics etc.)
    ['business_name','uei','naics','set_asides','demo_snapshot_id',
     'demo_token','demo_email','first_name'].forEach(function(f) {
      if (row[f] !== null && row[f] !== undefined) body[f] = row[f];
    });
  } else {
    body = row;
  }

  var res = await fetch(url, {
    method: method,
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('[webhook] upsert error:', (await res.text()).slice(0, 200));
}

async function sbInsert(table, row) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) console.error('[webhook] insert error:', (await res.text()).slice(0, 200));
}

// ── Stripe signature ──────────────────────────────────────────────────────────

function verifyStripe(rawBody, sigHeader, secret) {
  try {
    var parts = sigHeader.split(',').reduce(function(a, p) {
      var kv = p.split('='); a[kv[0]] = kv[1]; return a;
    }, {});
    var signed   = parts.t + '.' + rawBody;
    var expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    var expBuf   = Buffer.from(expected, 'hex');
    var recBuf   = Buffer.from(parts.v1 || '', 'hex');
    return expBuf.length === recBuf.length && crypto.timingSafeEqual(expBuf, recBuf);
  } catch(e) { return false; }
}

// ── Idempotency ───────────────────────────────────────────────────────────────

async function alreadyProcessed(eventId) {
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/stripe_events?id=eq.' + encodeURIComponent(eventId) + '&select=id',
    { headers: sbH() }
  );
  return res.ok && (await res.json()).length > 0;
}

async function markProcessed(eventId, livemode, eventType) {
  await fetch(SUPABASE_URL + '/rest/v1/stripe_events', {
    method: 'POST',
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ id: eventId, livemode: livemode, event_type: eventType }),
  });
}

// ── Demo snapshot lookup ──────────────────────────────────────────────────────

async function getSnapshot(viewToken) {
  try {
    var rows = await sbGet(
      'demo_snapshots?view_token=eq.' + encodeURIComponent(viewToken)
      + '&status=eq.complete&limit=1'
    );
    return rows[0] || null;
  } catch(e) { console.warn('[webhook] snapshot by token failed:', e.message); return null; }
}

// Primary: find snapshot by email — token never needs to travel between sites
async function getSnapshotByEmail(email) {
  try {
    var rows = await sbGet(
      'demo_snapshots?requester_email=eq.' + encodeURIComponent(email.toLowerCase().trim())
      + '&status=eq.complete&order=created_at.desc&limit=1'
    );
    return rows[0] || null;
  } catch(e) { console.warn('[webhook] snapshot by email failed:', e.message); return null; }
}

// ── Plan config ───────────────────────────────────────────────────────────────

var PLAN_CONFIG = {
  'individual-monthly': { plan_type:'individual-monthly', payment_type:'subscription',  plan_amount:99.99,   days:30  },
  'individual-yearly':  { plan_type:'individual-yearly',  payment_type:'one_time',       plan_amount:899.99,  days:365 },
  'agency-monthly':     { plan_type:'agency-monthly',     payment_type:'subscription',   plan_amount:499.99,  days:30  },
  'agency-yearly':      { plan_type:'agency-yearly',      payment_type:'one_time',       plan_amount:4999.99, days:365 },
};

// ── Welcome email ─────────────────────────────────────────────────────────────

async function sendWelcomeEmail(opts) {
  if (!RESEND_KEY) return;
  var firstName    = opts.firstName || 'there';
  var businessName = opts.businessName || '';
  var ctaUrl       = opts.ctaUrl || ONBOARD_URL;

  var html = '<div style="font-family:Arial,sans-serif;background:#0F2A6A;padding:40px 20px;">'
    + '<div style="max-width:520px;margin:0 auto;background:#163472;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:36px 32px;">'
    + '<p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#6EE7A8;font-weight:700;">CapGen Pro</p>'
    + '<h2 style="margin:0 0 14px;font-size:22px;color:#fff;">Welcome to CapGen, ' + firstName + '.</h2>'
    + '<p style="margin:0 0 22px;font-size:14px;color:rgba(255,255,255,.7);line-height:1.7;">'
    + (businessName ? 'Your pipeline for <strong style="color:#fff">' + businessName + '</strong> is ready.' : 'Your federal contract pipeline is ready.')
    + ' Sign in below to access your dashboard.</p>'
    + '<table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">'
    + '<tr><td style="background:#6EE7A8;border-radius:10px;padding:13px 26px;text-align:center;">'
    + '<a href="' + ctaUrl + '" style="color:#0F2A6A;font-weight:700;font-size:15px;text-decoration:none;">Open My Dashboard →</a>'
    + '</td></tr></table>'
    + '<p style="margin:0;font-size:11px;color:rgba(255,255,255,.3);">Questions? Reply to this email.</p>'
    + '<p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,.22);font-style:italic;">CapGen intelligence is sourced from official public records.</p>'
    + '<p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,.18);">' + MAILING_ADDR + '</p>'
    + '</div></div>';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [opts.email],
      subject: 'Welcome to CapGen' + (businessName ? ' — ' + businessName : ''),
      html: html,
    }),
  }).catch(function(e) { console.error('[webhook] welcome email error:', e.message); });
}

// ── checkout.session.completed ────────────────────────────────────────────────

async function handleCheckout(session, livemode) {
  var email       = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  var name        = (session.customer_details && session.customer_details.name)  || '';
  var firstName   = name.split(' ')[0] || 'there';
  var customerId  = session.customer   || '';
  var subId       = session.subscription || null;
  var refId       = session.client_reference_id || '';
  var parts       = refId.split(',');
  var viewToken   = parts[0] || '';
  var planKey     = parts[1] || '';

  if (!email) { console.error('[webhook] no email in session'); return; }
  console.log('[webhook] checkout email=' + email + ' token=' + (viewToken || 'none') + ' plan=' + (planKey || 'none'));

  // ── Snapshot lookup (Path A) ──────────────────────────────────────────────
  var onboardingState = 'needs_profile'; // default: no snapshot
  var demoEmail       = null;
  var demoBusinessName= null;
  var demoUei         = null;
  var demoNaics       = null;
  var demoSetAsides   = [];
  var demoSnapshotId  = null;

  // Look up snapshot by EMAIL first (primary — token never needs to travel)
  // Fall back to token if provided (legacy / direct link clicks)
  var snapshot = null;
  if (email) {
    snapshot = await getSnapshotByEmail(email);
    if (snapshot) console.log('[webhook] snapshot found by email, uei=' + ((snapshot.profile || {}).uei || 'none'));
  }
  if (!snapshot && viewToken && viewToken.length > 20) {
    snapshot = await getSnapshot(viewToken);
    if (snapshot) console.log('[webhook] snapshot found by token, uei=' + ((snapshot.profile || {}).uei || 'none'));
  }

  if (snapshot) {
    var p         = snapshot.profile || {};
    demoEmail     = snapshot.requester_email || null;
    demoBusinessName = p.legal_name || snapshot.business_name || null;
    demoUei       = p.uei || null;
    demoNaics     = p.naics ? p.naics.map(function(n) { return n.code || n; }) : null;
    demoSetAsides = p.set_asides || [];
    demoSnapshotId = snapshot.id;
    viewToken     = snapshot.view_token; // always use the canonical token from DB
    onboardingState = 'enrichment_pending';
  }

  // Option A: no snapshot found → generate token for direct subscriber
  if (!demoSnapshotId) {
    var generatedToken = crypto.randomBytes(32).toString('hex');
    try {
      await sbInsert('demo_snapshots', {
        entity_uei:        '',
        business_name:     name || email,
        requester_email:   email,
        requester_name:    firstName,
        profile:           {},
        view_token:        generatedToken,
        status:            'complete',
        generated_at:      new Date().toISOString(),
      });
      viewToken       = generatedToken;
      demoSnapshotId  = generatedToken; // used as placeholder
      onboardingState = 'needs_profile';
      console.log('[webhook] Option A: generated token for no-demo subscriber');
    } catch(e) {
      console.error('[webhook] Option A token generation failed:', e.message);
    }
  }

  // ── Plan config ───────────────────────────────────────────────────────────
  var planCfg   = PLAN_CONFIG[planKey] || PLAN_CONFIG['individual-monthly'];
  var now       = new Date();
  var periodEnd = new Date(now.getTime() + planCfg.days * 24 * 3600000);

  // ── Build subscription row ────────────────────────────────────────────────
  // Keyed on checkout email (source of truth for OTP login — per spec Q6)
  var subRow = {
    email:                  email.toLowerCase().trim(),
    first_name:             firstName,
    // business_name only from snapshot — never Stripe customer name (spec Issue 3)
    business_name:          demoBusinessName || null,
    uei:                    demoUei,
    naics:                  demoNaics,
    set_asides:             demoSetAsides,
    demo_snapshot_id:       demoSnapshotId,
    demo_token:             viewToken || null,
    // Store demo email only if it differs from checkout email (mismatch case)
    demo_email:             (demoEmail && demoEmail.toLowerCase() !== email.toLowerCase())
                              ? demoEmail.toLowerCase() : null,
    stripe_customer_id:     customerId || null,
    stripe_subscription_id: subId,
    plan_type:              planCfg.plan_type,
    payment_type:           planCfg.payment_type,
    plan_amount:            planCfg.plan_amount,
    current_period_start:   now.toISOString(),
    current_period_end:     periodEnd.toISOString(),
    last_payment_at:        now.toISOString(),
    onboarding_state:       onboardingState,
    status:                 'active',
    livemode:               livemode,
    updated_at:             now.toISOString(),
  };

  await sbUpsert('capgen_subscriptions', subRow);
  console.log('[webhook] capgen_subscriptions upserted for ' + email
    + ' (' + (livemode ? 'LIVE' : 'TEST') + ') state=' + onboardingState);

  // ── Welcome email — CTA links to their dashboard via token ───────────────
  var dashboardUrl = viewToken
    ? 'https://capgen.aproposgroupllc.com/demo/snapshot?t=' + viewToken
    : ONBOARD_URL;
  try {
    await sendWelcomeEmail({
      email: email, firstName: firstName,
      businessName: demoBusinessName || null,
      ctaUrl: dashboardUrl,
    });
  } catch(e) { console.error('[webhook] welcome email failed:', e.message); }

  // ── Legacy: client_onboarding log (kept per clarification 2) ─────────────
  try {
    await sbInsert('client_onboarding', {
      email: email, first_name: firstName,
      business_name: demoBusinessName || name || '',
      pipeline_url: ONBOARD_URL, welcome_sent_at: now.toISOString(),
      metadata: {
        stripe_customer_id: customerId, stripe_session_id: session.id,
        source: 'stripe_checkout', livemode: livemode, plan: planKey,
      },
    });
  } catch(e) { console.warn('[webhook] client_onboarding log failed:', e.message); }

  // ── Auth user (legacy — kept per clarification 2) ─────────────────────────
  if (SERVICE_KEY) {
    try {
      await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
        method: 'POST',
        headers: sbH(),
        body: JSON.stringify({ email: email, email_confirm: true,
          user_metadata: { first_name: firstName, business_name: demoBusinessName || name } }),
      });
    } catch(e) { console.warn('[webhook] auth user note:', e.message); }
  }
}

// ── customer.subscription.deleted ────────────────────────────────────────────

async function handleSubscriptionDeleted(subscription) {
  var customerId = subscription.customer;
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?stripe_customer_id=eq.'
    + encodeURIComponent(customerId) + '&select=email',
    { headers: sbH() }
  );
  if (!res.ok) return;
  var rows = await res.json();
  if (!rows.length) { console.warn('[webhook] deleted sub: customer not found', customerId); return; }
  var email = rows[0].email;
  await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
    { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }) }
  );
  console.log('[webhook] subscription canceled for', email);
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  var rawBody   = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');
  var sigHeader = event.headers['stripe-signature'] || '';

  // ── Dual-mode signature verification ─────────────────────────────────────
  var verified = false;
  if (LIVE_SEC && verifyStripe(rawBody, sigHeader, LIVE_SEC)) {
    verified = true;
  } else if (TEST_SEC && verifyStripe(rawBody, sigHeader, TEST_SEC)) {
    verified = true;
  }
  if (!verified && (LIVE_SEC || TEST_SEC)) {
    console.error('[webhook] signature invalid');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  var stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  var eventId   = stripeEvent.id;
  var livemode  = stripeEvent.livemode === true;
  var eventType = stripeEvent.type;

  // ── Idempotency: check BEFORE any processing ──────────────────────────────
  if (eventId && await alreadyProcessed(eventId)) {
    console.log('[webhook] duplicate event skipped:', eventId);
    return { statusCode: 200, body: 'Duplicate' };
  }

  // ── Route ─────────────────────────────────────────────────────────────────
  if (eventType === 'checkout.session.completed') {
    await handleCheckout(stripeEvent.data.object, livemode);
  } else if (eventType === 'customer.subscription.deleted') {
    await handleSubscriptionDeleted(stripeEvent.data.object);
  } else {
    return { statusCode: 200, body: 'Ignored' };
  }

  // ── Mark processed ────────────────────────────────────────────────────────
  if (eventId) await markProcessed(eventId, livemode, eventType);

  return { statusCode: 200, body: JSON.stringify({ ok: true, livemode: livemode }) };
};
