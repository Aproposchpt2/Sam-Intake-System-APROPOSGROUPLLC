'use strict';

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

function sbH() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

function verifyWebhookSignature(body, headers) {
  if (!RESEND_WEBHOOK_SECRET) return true; // Skip verification if secret not set

  // Svix signature verification
  const svixId = headers['svix-id'] || headers['Svix-Id'];
  const svixTimestamp = headers['svix-timestamp'] || headers['Svix-Timestamp'];
  const svixSignature = headers['svix-signature'] || headers['Svix-Signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  // Build the signed content: "{svix-id}.{svix-timestamp}.{body}"
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const secretBytes = Buffer.from(RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const computedHmac = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // svix-signature can be a comma-separated list of "v1,<sig>" pairs
  const signatures = svixSignature.split(' ');
  for (const sig of signatures) {
    const parts = sig.split(',');
    if (parts.length === 2 && parts[0] === 'v1') {
      if (crypto.timingSafeEqual(
        Buffer.from(computedHmac),
        Buffer.from(parts[1])
      )) {
        return true;
      }
    }
  }
  return false;
}

exports.handler = async function (event, context) {
  // 1. Verify webhook signature
  const rawBody = event.body || '';
  const headers = event.headers || {};

  if (!verifyWebhookSignature(rawBody, headers)) {
    console.error('Webhook signature verification failed');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { type, data } = payload;
  const emailId = data && data.email_id;

  // 2. Only process relevant event types
  const TRACKED_EVENTS = ['email.opened', 'email.clicked', 'email.bounced', 'email.complained'];
  if (!TRACKED_EVENTS.includes(type)) {
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, skipped: true })
    };
  }

  try {
    // 3. Find matching email_batch record
    let emailBatchId = null;
    if (emailId) {
      const batchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/email_batch?resend_message_id=eq.${encodeURIComponent(emailId)}&select=id&limit=1`,
        { headers: sbH() }
      );
      if (batchRes.ok) {
        const batchRows = await batchRes.json();
        if (batchRows.length > 0) {
          emailBatchId = batchRows[0].id;
        }
      }
    }

    // 4. Insert into email_tracking
    await fetch(
      `${SUPABASE_URL}/rest/v1/email_tracking`,
      {
        method: 'POST',
        headers: {
          ...sbH(),
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          email_batch_id: emailBatchId,
          resend_message_id: emailId || null,
          event_type: type,
          event_data: data || {},
          occurred_at: new Date().toISOString()
        })
      }
    );

    // 5. If bounced, update email_batch status
    if (type === 'email.bounced' && emailBatchId) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/email_batch?id=eq.${emailBatchId}`,
        {
          method: 'PATCH',
          headers: sbH(),
          body: JSON.stringify({ status: 'bounced' })
        }
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true, event_type: type, email_batch_id: emailBatchId })
    };
  } catch (err) {
    console.error('webhook-receiver error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
