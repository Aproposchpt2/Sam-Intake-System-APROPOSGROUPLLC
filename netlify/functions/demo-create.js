'use strict';
// demo-create.js — Snapshot orchestrator
// POST { uei, businessName, firstName, lastName, email, hp? }
// Enforces 90-day entity cache, 90-day email cap, 100/day global cap.
// Inserts pending row, fires background, returns 202 + view_token.

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL     = process.env.DEPLOY_URL || process.env.URL || '';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbH(extra) {
  return Object.assign({
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json',
  }, extra || {});
}

async function sbGet(path) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: sbH() });
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (await res.text()).slice(0, 100));
  return res.json();
}

async function sbInsert(table, row) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('Insert ' + res.status + ': ' + (await res.text()).slice(0, 100));
  var rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Honeypot
  if (body.hp) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

  var uei          = (body.uei          || '').trim();
  var businessName = (body.businessName || '').trim();
  var firstName    = (body.firstName    || '').trim();
  var lastName     = (body.lastName     || '').trim();
  var email        = (body.email        || '').trim().toLowerCase();
  var ip           = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';

  // uei is optional — empty on zero-match / not-registered path
  if (!businessName || !email || !firstName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid email' }) };
  }

  var since90 = new Date(Date.now() - 90 * 24 * 3600000).toISOString();
  var since24 = new Date(Date.now() -      24 * 3600000).toISOString();

  // 1. Per-email 90-day cap — returning email → show existing snapshot, no new email
  var emailRows = await sbGet(
    'demo_snapshots?requester_email=eq.' + encodeURIComponent(email)
    + '&created_at=gte.' + encodeURIComponent(since90)
    + '&status=neq.failed&order=created_at.desc&limit=1&select=view_token,generated_at,business_name'
  );
  if (emailRows.length) {
    var ex = emailRows[0];
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        view_token: ex.view_token,
        cached: true,
        cached_date: ex.generated_at,
        message: 'Your snapshot from ' + new Date(ex.generated_at || ex.created_at || Date.now()).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
      }),
    };
  }

  // 2. Per-entity 90-day cache — reuse snapshot payload, email to this new requester
  var entityRows = await sbGet(
    'demo_snapshots?entity_uei=eq.' + encodeURIComponent(uei)
    + '&created_at=gte.' + encodeURIComponent(since90)
    + '&status=eq.complete&order=created_at.desc&limit=1'
  );
  if (entityRows.length) {
    var src = entityRows[0];
    var reuseToken = crypto.randomBytes(32).toString('hex');
    await sbInsert('demo_snapshots', {
      entity_uei: uei, business_name: businessName,
      requester_email: email, requester_name: firstName + ' ' + lastName,
      requester_ip: ip, profile: src.profile,
      opportunities: src.opportunities, additional_match_count: src.additional_match_count,
      analysis: src.analysis, status: 'complete', view_token: reuseToken,
      generated_at: src.generated_at,
    });
    // Email-only background fire
    fetch(SITE_URL + '/.netlify/functions/demo-create-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOnly: true, email: email, firstName: firstName, businessName: businessName, viewToken: reuseToken }),
    }).catch(function() {});
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ view_token: reuseToken, cached: true }) };
  }

  // 3. Global daily cap: 100 fresh generations per 24h
  var dailyRows = await sbGet(
    'demo_snapshots?created_at=gte.' + encodeURIComponent(since24)
    + '&status=in.(pending,complete,not_registered)&select=id'
  );
  if (dailyRows.length >= 100) {
    // Queue intent row so we can follow up tomorrow
    var qToken = crypto.randomBytes(32).toString('hex');
    try {
      await sbInsert('demo_snapshots', {
        entity_uei: uei, business_name: businessName,
        requester_email: email, requester_name: firstName + ' ' + lastName,
        requester_ip: ip, profile: {}, view_token: qToken, status: 'failed',
      });
    } catch(e) { /* ignore */ }
    return {
      statusCode: 429, headers: CORS,
      body: JSON.stringify({ error: 'DAILY_CAP', message: "Demo slots for today are full. Leave your email and we'll send your report tomorrow." }),
    };
  }

  // 4. Fresh generation
  var viewToken = crypto.randomBytes(32).toString('hex');
  var row;
  try {
    row = await sbInsert('demo_snapshots', {
      entity_uei: uei, business_name: businessName,
      requester_email: email, requester_name: firstName + ' ' + lastName,
      requester_ip: ip, profile: {}, view_token: viewToken, status: 'pending',
    });
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create snapshot: ' + e.message }) };
  }

  // Fire background (awaited so request is sent before handler returns)
  try {
    await fetch(SITE_URL + '/.netlify/functions/demo-create-background', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId: row.id, uei: uei, businessName: businessName, firstName: firstName, lastName: lastName, email: email, viewToken: viewToken }),
    });
  } catch(e) { /* ignore — background will run */ }

  return { statusCode: 202, headers: CORS, body: JSON.stringify({ view_token: viewToken, status: 'pending' }) };
};
