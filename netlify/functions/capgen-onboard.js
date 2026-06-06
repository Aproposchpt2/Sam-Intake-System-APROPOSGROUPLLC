'use strict';
// capgen-onboard.js
// POST { first_name, last_name, business_name, email, phone, plan_type, plan_amount }
// 1. SAM.gov lookup by business name
// 2. Create Supabase user + subscription record
// 3. Send welcome email with onboarding link

const SUPABASE_URL  = 'https://judislfknmhofcgzyozc.supabase.co';
const ANON_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1ZGlzbGZrbm1ob2ZjZ3p5b3pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMDI3ODAsImV4cCI6MjA5Mjc3ODc4MH0.Kxpe0kJt0k7ZchYu70BOwm4KdT0C5aSsyeR1ov6NlQ0';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'alerts@aproposgroupllc.com';
const SAM_API_KEY   = process.env.SAM_API_KEY;
const SITE_URL      = 'https://capgen.aproposgroupllc.com';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

async function samLookup(businessName) {
  if (!SAM_API_KEY || !businessName) return null;
  try {
    const url = new URL('https://api.sam.gov/entity-information/v3/entities');
    url.searchParams.set('api_key', SAM_API_KEY);
    url.searchParams.set('legalBusinessName', businessName);
    url.searchParams.set('registrationStatus', 'A');
    url.searchParams.set('includeSections', 'entityRegistration,coreData,assertions');
    const res  = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const e    = (data.entityData || [])[0];
    if (!e) return null;
    const reg  = e.entityRegistration || {};
    const core = e.coreData || {};
    const addr = core.physicalAddress || {};
    const gs   = (e.assertions && e.assertions.goodsAndServices) || {};
    const bt   = (core.businessTypes && core.businessTypes.sbaBusinessTypeList) || [];
    return {
      uei:            reg.ueiSAM || null,
      cage:           reg.cageCode || null,
      sam_status:     reg.registrationStatus === 'A' ? 'Active' : 'Unknown',
      address:        [addr.city, addr.stateOrProvinceCode].filter(Boolean).join(', '),
      naics:          (gs.naicsList || []).map(n => n.naicsCode).filter(Boolean),
      certifications: bt.filter(c => !c.certificationExitDate || new Date(c.certificationExitDate) > new Date())
                       .map(c => ({ label: c.sbaBusinessTypeDesc || c.sbaBusinessTypeDescription }))
                       .filter(c => c.label),
    };
  } catch (e) { console.warn('SAM lookup error:', e.message); return null; }
}

async function createAuthUser(email, metadata) {
  if (!SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, email_confirm: true, user_metadata: metadata }),
    });
    const data = await res.json();
    return data.id || null;
  } catch (e) { console.warn('Auth user create:', e.message); return null; }
}

async function upsertSubscription(record) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/capgen_subscriptions?email=eq.${encodeURIComponent(record.email)}`, {
    method: 'GET',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  const existing = await res.json();
  const method   = Array.isArray(existing) && existing.length > 0 ? 'PATCH' : 'POST';
  const url      = method === 'PATCH'
    ? `${SUPABASE_URL}/rest/v1/capgen_subscriptions?email=eq.${encodeURIComponent(record.email)}`
    : `${SUPABASE_URL}/rest/v1/capgen_subscriptions`;
  const saveRes = await fetch(url, {
    method,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(record),
  });
  return saveRes.json();
}

async function sendWelcomeEmail(email, firstName, businessName) {
  if (!RESEND_KEY) return;
  const onboardingUrl = `${SITE_URL}/onboarding.html`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [email],
      subject: `${businessName} — Your CapGen Dashboard is Being Built`,
      html: `
      <div style="font-family:Arial,sans-serif;background:#0A1A3A;padding:40px 20px;">
        <div style="max-width:520px;margin:0 auto;background:#0f2244;border:1px solid rgba(91,175,255,.25);border-radius:18px;padding:36px 32px;">
          <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#5BD3FF;font-weight:700;">CapGen Pro · AI4 Businesses</p>
          <h2 style="margin:0 0 16px;font-size:22px;color:#f0f6ff;">Welcome, ${firstName}. Your pipeline is being built.</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#8facd0;line-height:1.7;">
            We pulled your SAM.gov registration and are configuring your live federal contract pipeline for <strong style="color:#f0f6ff;">${businessName}</strong>. It will be ready within minutes.
          </p>
          <div style="background:#132954;border:1px solid rgba(91,175,255,.15);border-radius:10px;padding:18px 20px;margin-bottom:24px;">
            <p style="margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#5a7899;font-weight:700;">Your Onboarding Steps</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;"><span style="color:#5BD3FF;font-weight:700;">Step 1</span> &nbsp; Click the button below to verify your email</td></tr>
              <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;"><span style="color:#5BD3FF;font-weight:700;">Step 2</span> &nbsp; Enter your email address and click Submit</td></tr>
              <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;"><span style="color:#5BD3FF;font-weight:700;">Step 3</span> &nbsp; Check your inbox for a 6-digit access code</td></tr>
              <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;"><span style="color:#5BD3FF;font-weight:700;">Step 4</span> &nbsp; Enter the code — your dashboard opens instantly</td></tr>
            </table>
          </div>
          <table cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr><td style="background:#5BD3FF;border-radius:10px;padding:14px 28px;text-align:center;">
              <a href="${onboardingUrl}" style="color:#0A1A3A;font-weight:700;font-size:15px;text-decoration:none;">Access My Dashboard →</a>
            </td></tr>
          </table>
          <p style="margin:0;font-size:12px;color:#3a5470;">Questions? Reply to this email.<br/>CapGen Pro · AI4 Businesses · Apropos Group LLC</p>
        </div>
      </div>`,
    }),
  }).catch(e => console.error('Email error:', e.message));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { first_name, last_name, business_name, email, phone, plan_type = 'monthly', plan_amount } = body;
  if (!first_name || !last_name || !business_name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'First name, last name, business name, and email are required.' }) };
  }

  console.log(`CapGen onboard: ${business_name} <${email}> plan=${plan_type}`);

  // 1. SAM.gov lookup
  const sam = await samLookup(business_name);
  console.log('SAM lookup:', sam ? `found UEI=${sam.uei}` : 'not found');

  // 2. Create auth user
  const userId = await createAuthUser(email, { first_name, last_name, business_name });

  // 3. Save subscription record
  const record = {
    email: email.toLowerCase().trim(),
    first_name, last_name, business_name, phone: phone || null,
    plan_type, plan_amount: plan_amount || null,
    status: 'active',
    updated_at: new Date().toISOString(),
    supabase_user_id: userId || null,
    ...(sam || {}),
  };
  await upsertSubscription(record);

  // 4. Send welcome email
  await sendWelcomeEmail(email, first_name, business_name);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, uei: sam?.uei || null, naics: sam?.naics || [] }),
  };
};
