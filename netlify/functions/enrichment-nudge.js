'use strict';
// enrichment-nudge.js — One-time 3-day nudge for subscribers stuck in enrichment_pending
// Called by scheduled GitHub Actions workflow. Sent-flag guarded (enrichment_nudge_sent_at).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'CapGen Reports <reports@aproposgroupllc.com>';
const ONBOARD_URL  = 'https://capgen.aproposgroupllc.com/capgen-onboarding';
const MAILING_ADDR = process.env.MAILING_ADDRESS || 'Apropos Group LLC, Las Vegas, NV 89031';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function sbH(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Find subscribers: enrichment_pending, created 3+ days ago, nudge not yet sent
  var cutoff = new Date(Date.now() - 3 * 24 * 3600000).toISOString();
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions'
      + '?onboarding_state=eq.enrichment_pending'
      + '&created_at=lte.' + encodeURIComponent(cutoff)
      + '&enrichment_nudge_sent_at=is.null'
      + '&status=eq.active'
      + '&select=email,first_name,business_name'
      + '&limit=50',
    { headers: sbH() }
  );
  if (!res.ok) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB query failed' }) };

  var subscribers = await res.json();
  console.log('[nudge] Found', subscribers.length, 'subscribers to nudge');

  var sent = 0;
  var errors = 0;

  for (var i = 0; i < subscribers.length; i++) {
    var sub = subscribers[i];
    var email = sub.email;
    var firstName = sub.first_name || 'there';
    var bizName   = sub.business_name || 'your business';

    var html = '<div style="font-family:Arial,sans-serif;background:#0F2A6A;padding:40px 20px;">'
      + '<div style="max-width:520px;margin:0 auto;background:#163472;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:36px 32px;">'
      + '<p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#6EE7A8;font-weight:700;">CapGen Pro</p>'
      + '<h2 style="margin:0 0 14px;font-size:20px;color:#fff;">Your pipeline isn\'t fully set up yet.</h2>'
      + '<p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,.7);line-height:1.7;">'
      + 'Hi ' + firstName + ' — it looks like ' + bizName + '\'s CapGen profile still needs a few details. '
      + 'It only takes 2 minutes, and it\'s what powers your opportunity matching and Analyze Fit scores.</p>'
      + '<table cellpadding="0" cellspacing="0" style="margin-bottom:22px;">'
      + '<tr><td style="background:#6EE7A8;border-radius:10px;padding:13px 26px;text-align:center;">'
      + '<a href="' + ONBOARD_URL + '" style="color:#0F2A6A;font-weight:700;font-size:14px;text-decoration:none;">Complete My Profile →</a>'
      + '</td></tr></table>'
      + '<p style="margin:0;font-size:11px;color:rgba(255,255,255,.3);">Questions? Reply to this email.</p>'
      + '<p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,.22);font-style:italic;">CapGen intelligence is sourced from official public records.</p>'
      + '<p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,.18);">' + MAILING_ADDR + '</p>'
      + '</div></div>';

    try {
      var emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL, to: [email],
          subject: 'Your CapGen profile is almost complete — ' + bizName,
          html: html,
        }),
      });
      if (emailRes.ok) {
        // Mark sent
        await fetch(
          SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
          { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }),
            body: JSON.stringify({ enrichment_nudge_sent_at: new Date().toISOString() }) }
        );
        sent++;
        console.log('[nudge] Sent to', email);
      } else {
        console.error('[nudge] Resend error for', email, ':', await emailRes.text());
        errors++;
      }
    } catch(e) {
      console.error('[nudge] Error for', email, ':', e.message);
      errors++;
    }
  }

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ success: true, eligible: subscribers.length, sent: sent, errors: errors }),
  };
};
