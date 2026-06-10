'use strict';

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL     = process.env.RESEND_FROM_EMAIL || 'CapGen Reports <reports@aproposgroupllc.com>';

function sbH() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

exports.handler = async function (event, context) {
  try {
    // 1. Get draft emails
    const draftRes = await fetch(
      `${SUPABASE_URL}/rest/v1/email_batch?status=eq.draft&select=id,to_email,to_name,subject,body&limit=50`,
      { headers: sbH() }
    );
    if (!draftRes.ok) {
      const err = await draftRes.text();
      throw new Error(`Failed to fetch draft emails: ${err}`);
    }
    const drafts = await draftRes.json();

    let sent = 0;
    let failed = 0;
    const total = drafts.length;

    for (const draft of drafts) {
      // 2. Send via Resend
      let resendMessageId = null;
      let sendSuccess = false;

      try {
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [draft.to_email],
            subject: draft.subject,
            text: draft.body
          })
        });

        if (resendRes.ok) {
          const resendData = await resendRes.json();
          resendMessageId = resendData.id || null;
          sendSuccess = true;
        } else {
          const errText = await resendRes.text();
          console.error(`Resend error for batch ${draft.id}:`, errText);
        }
      } catch (resendErr) {
        console.error(`Resend fetch error for batch ${draft.id}:`, resendErr.message);
      }

      // 3. Update email_batch record
      if (sendSuccess) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/email_batch?id=eq.${draft.id}`,
          {
            method: 'PATCH',
            headers: sbH(),
            body: JSON.stringify({
              status: 'sent',
              resend_message_id: resendMessageId,
              sent_at: new Date().toISOString()
            })
          }
        );
        sent++;
      } else {
        await fetch(
          `${SUPABASE_URL}/rest/v1/email_batch?id=eq.${draft.id}`,
          {
            method: 'PATCH',
            headers: sbH(),
            body: JSON.stringify({ status: 'failed' })
          }
        );
        failed++;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sent, failed, total })
    };
  } catch (err) {
    console.error('sender error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
