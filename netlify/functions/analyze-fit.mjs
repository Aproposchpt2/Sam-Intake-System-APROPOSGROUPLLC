// analyze-fit.mjs — Phase 2 (lightweight orchestrator)
// POST { opportunityId, force?, deep?, opportunity? }
// Auth + cache check + pending-row insert + fire background → 200 (hit) or 202 (miss)

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_SECRET  = process.env.AUTH_TOKEN_SECRET;
const SITE_URL     = process.env.DEPLOY_URL || process.env.URL || '';
const MODEL        = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Supabase helpers ─────────────────────────────────────────────────────────

function sbH(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase insert ${table}: ${(await res.text()).slice(0,200)}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbPatch(table, filter, update) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table}: ${(await res.text()).slice(0,200)}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbDelete(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE', headers: sbH(),
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${table}: ${(await res.text()).slice(0,200)}`);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  if (!AUTH_SECRET) return null;
  try {
    const raw  = authHeader.slice(7);
    const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!data.email || !data.ts || !data.sig) return null;
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    const toSign   = JSON.stringify({ email: data.email, ts: data.ts });
    const expected = createHmac('sha256', AUTH_SECRET).update(toSign).digest('hex');
    const expBuf   = Buffer.from(expected, 'hex');
    const sigBuf   = Buffer.from(data.sig,  'hex');
    if (expBuf.length !== sigBuf.length || !timingSafeEqual(expBuf, sigBuf)) return null;
    return data.email.toLowerCase().trim();
  } catch { return null; }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const accountEmail = verifyToken(event.headers?.authorization || event.headers?.Authorization || '');
  if (!accountEmail) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { opportunityId, force = false, deep = false, opportunity: inlineOpp } = body;
  if (!opportunityId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'opportunityId required' }) };

  // Load profile
  const profiles = await sbGet(`capgen_subscriptions?email=eq.${encodeURIComponent(accountEmail)}&limit=1`);
  if (!profiles.length) return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'PROFILE_REQUIRED' }) };
  const profile = profiles[0];

  // Cache check
  const aeEnc = encodeURIComponent(accountEmail);
  const oidEnc = encodeURIComponent(opportunityId);
  const cached = await sbGet(
    `opportunity_analyses?account_email=eq.${aeEnc}&opportunity_id=eq.${oidEnc}&profile_version=eq.${profile.profile_version}&limit=1`
  );

  if (cached.length && !force) {
    const row = cached[0];
    // Cache hit: any status — return immediately.
    // Special case: deep=true + complete NO_BID with no stage2 → trigger stage2 only.
    if (deep && row.status === 'complete' && !row.stage2 &&
        (row.recommendation === 'NO_BID' || row.recommendation === 'PENDING')) {
      // Re-activate for stage2 run
      await sbPatch('opportunity_analyses', `id=eq.${row.id}`, { status: 'stage1_complete' });
      await fireBackground({ rowId: row.id, accountEmail, opportunityId,
        profileVersion: profile.profile_version, deep: true, skipStage1: true, opportunity: inlineOpp });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...row, status: 'stage1_complete', cached: false }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...row, cached: true }) };
  }

  // Daily limit check (50 fresh analyses per rolling 24 h)
  const since  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await sbGet(
    `opportunity_analyses?account_email=eq.${aeEnc}&created_at=gte.${encodeURIComponent(since)}&select=id,created_at`
  );
  if (recent.length >= 50) {
    const resetAt   = new Date(new Date(recent[0]?.created_at || since).getTime() + 24 * 60 * 60 * 1000);
    const hoursLeft = Math.ceil((resetAt - Date.now()) / 3600000);
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'DAILY_LIMIT', hoursLeft }) };
  }

  // Delete existing row if force=true
  if (force && cached.length) {
    try { await sbDelete('opportunity_analyses', `id=eq.${cached[0].id}`); } catch { /* ignore */ }
  }

  // Insert pending row
  let row;
  try {
    row = await sbInsert('opportunity_analyses', {
      account_email:   accountEmail,
      opportunity_id:  opportunityId,
      profile_version: profile.profile_version,
      stage1:          {},
      recommendation:  'PENDING',
      fit_score:       0,
      model:           MODEL,
      status:          'pending',
    });
  } catch (e) {
    // Unique constraint → another request already in flight, return that row
    const inFlight = await sbGet(
      `opportunity_analyses?account_email=eq.${aeEnc}&opportunity_id=eq.${oidEnc}&profile_version=eq.${profile.profile_version}&limit=1`
    );
    if (inFlight.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...inFlight[0], cached: true }) };
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Insert failed: ' + e.message }) };
  }

  // Await the trigger — MUST await or the fetch is killed when handler returns
  await fireBackground({ rowId: row.id, accountEmail, opportunityId,
    profileVersion: profile.profile_version, deep, skipStage1: false, opportunity: inlineOpp });

  return { statusCode: 202, headers: CORS, body: JSON.stringify({ id: row.id, status: 'pending', opportunity_id: opportunityId, cached: false }) };
};

async function fireBackground(payload) {
  const url = `${SITE_URL}/.netlify/functions/analyze-fit-background`;
  try {
    // Background functions return 202 immediately — await ensures the request is sent
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* ignore — background job accepted */ }
}
