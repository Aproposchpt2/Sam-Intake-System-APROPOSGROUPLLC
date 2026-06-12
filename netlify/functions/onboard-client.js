'use strict';
// onboard-client.js
// Adds a client to Supabase Auth and fires a branded welcome email via Resend.
// POST { email, first_name, business_name, uei? }
// Called from admin-onboard.html or any internal trigger.

const PIPELINE_URL   = 'https://sam-gov-search-engine.netlify.app/pipeline';
const SUPPORT_EMAIL  = 'jmitchell@aproposgroupllc.com';
const BRAND_NAME     = 'CapGen by AI4 Businesses';
const FROM_EMAIL     = process.env.RESEND_FROM_EMAIL || 'alerts@aproposgroupllc.com';
const ADMIN_KEY      = process.env.ONBOARD_ADMIN_KEY || '';  // simple shared secret

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function buildWelcomeEmail(firstName, businessName, pipelineUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0A1A3A;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0A1A3A;padding:40px 20px;">
  <tr><td align="center">
  <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

    <!-- Header -->
    <tr><td style="padding-bottom:28px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="background:#0f2244;border:1px solid rgba(91,211,255,.3);border-radius:10px;padding:8px 14px;display:inline-block;">
          <span style="font-family:monospace;font-weight:900;color:#5BD3FF;font-size:14px;">CG</span>
          <span style="color:#8facd0;font-size:12px;margin-left:8px;letter-spacing:.04em;">CapGen by AI4 Businesses</span>
        </div>
      </div>
    </td></tr>

    <!-- Hero -->
    <tr><td style="background:#0f2244;border:1px solid rgba(91,175,255,.2);border-radius:16px;padding:36px 32px;">

      <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#5BD3FF;font-weight:700;">Your Pipeline is Live</p>
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#f0f6ff;line-height:1.15;">
        Welcome, ${firstName}.<br/>
        <span style="color:#5BD3FF;">${businessName}</span> is ready.
      </h1>
      <p style="margin:0 0 24px;font-size:15px;color:#8facd0;line-height:1.7;">
        Your SAM.gov Opportunity Pipeline is live and pulling active federal contracts
        matched to your NAICS codes — right now. Every contract is open, deadline is
        in the future, and sorted by urgency.
      </p>

      <!-- CTA Button -->
      <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
        <tr><td style="background:#5BD3FF;border-radius:10px;padding:14px 28px;text-align:center;">
          <a href="${pipelineUrl}" style="color:#0A1A3A;font-weight:700;font-size:15px;text-decoration:none;letter-spacing:.02em;">
            Open My Pipeline →
          </a>
        </td></tr>
      </table>

      <!-- How to log in -->
      <div style="background:#132954;border:1px solid rgba(91,175,255,.15);border-radius:10px;padding:18px 20px;margin-bottom:24px;">
        <p style="margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#5a7899;font-weight:700;">How to Access Your Dashboard</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;line-height:1.6;">
            <span style="color:#5BD3FF;font-weight:700;">Step 1</span> &nbsp;
            Click <strong style="color:#f0f6ff;">Open My Pipeline</strong> above.
          </td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;line-height:1.6;">
            <span style="color:#5BD3FF;font-weight:700;">Step 2</span> &nbsp;
            Enter your email address and click <strong style="color:#f0f6ff;">Submit</strong>.
          </td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;line-height:1.6;">
            <span style="color:#5BD3FF;font-weight:700;">Step 3</span> &nbsp;
            Check your inbox — a link to access your dashboard will be emailed to you.
          </td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#8facd0;line-height:1.6;">
            <span style="color:#5BD3FF;font-weight:700;">Step 4</span> &nbsp;
            Click <strong style="color:#f0f6ff;">Confirm your email</strong> in that message — your dashboard opens immediately.
          </td></tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:#3a5470;">No password required. Your email is your key.</p>
      </div>

      <!-- What's inside -->
      <div style="background:#132954;border:1px solid rgba(91,175,255,.15);border-radius:10px;padding:18px 20px;">
        <p style="margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#5a7899;font-weight:700;">What's Inside</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:5px 0;font-size:13px;color:#8facd0;">
              <span style="color:#5BD3FF;margin-right:8px;">●</span> Live SAM.gov contracts matched to your NAICS codes
            </td>
          </tr>
          <tr>
            <td style="padding:5px 0;font-size:13px;color:#8facd0;">
              <span style="color:#5BD3FF;margin-right:8px;">●</span> Deadline urgency — color coded, sorted soonest first
            </td>
          </tr>
          <tr>
            <td style="padding:5px 0;font-size:13px;color:#8facd0;">
              <span style="color:#5BD3FF;margin-right:8px;">●</span> Toggle filters by NAICS code, contract type, time window
            </td>
          </tr>
          <tr>
            <td style="padding:5px 0;font-size:13px;color:#8facd0;">
              <span style="color:#5BD3FF;margin-right:8px;">●</span> One-click CapGen — generate your capability statement for any contract
            </td>
          </tr>
        </table>
      </div>

    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:24px 0 0;text-align:center;">
      <p style="margin:0;font-size:12px;color:#3a5470;line-height:1.6;">
        Questions? Reply to this email or reach us at
        <a href="mailto:${SUPPORT_EMAIL}" style="color:#5BD3FF;text-decoration:none;">${SUPPORT_EMAIL}</a>
      </p>
      <p style="margin:8px 0 0;font-size:11px;color:#2a3d52;">
        ${BRAND_NAME} · Apropos Group LLC
      </p>
    </td></tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  // Simple admin key guard
  const reqKey = event.headers['x-admin-key'] || '';
  if (ADMIN_KEY && reqKey !== ADMIN_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email, first_name, business_name, uei } = body;
  if (!email || !first_name || !business_name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, first_name, business_name required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  const resendKey   = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !serviceKey || !resendKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  // 1. Create Supabase Auth user
  let supabaseResult = null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { first_name, business_name, uei: uei || '' },
      }),
    });
    supabaseResult = await res.json();
    if (!res.ok) throw new Error(supabaseResult.message || 'Supabase user creation failed');
    console.log('Supabase user created:', supabaseResult.id);
  } catch (e) {
    // User might already exist — not fatal, continue to email
    console.warn('Supabase user note:', e.message);
  }

  // 2. Send welcome email
  const html = buildWelcomeEmail(first_name, business_name, PIPELINE_URL);
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [email],
      subject: `Your ${business_name} Opportunity Pipeline is Live`,
      html,
    }),
  });

  const emailData = await emailRes.json();
  if (!emailRes.ok) {
    console.error('Resend error:', emailData);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email failed', detail: emailData }) };
  }

  // 3. Log onboarding to Supabase
  await fetch(`${supabaseUrl}/rest/v1/client_onboarding`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      email, first_name, business_name, uei: uei || null,
      pipeline_url: PIPELINE_URL,
      welcome_sent_at: new Date().toISOString(),
      supabase_user_id: supabaseResult?.id || null,
    }),
  }).catch(e => console.warn('Log error:', e.message));

  console.log(`Onboarded: ${business_name} <${email}>`);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, email, business_name, email_id: emailData.id }),
  };
};
