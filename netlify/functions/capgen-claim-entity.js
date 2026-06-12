'use strict';
// capgen-claim-entity.js — First-Run Experience: entity claim (Path B, entity_pending state)
// POST { uei, businessName } — authed via signed OTP session token
// Fetches entity from SAM.gov, writes to capgen_subscriptions, advances to enrichment_pending

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY  = process.env.SAM_API_KEY;
const AUTH_SECRET  = process.env.AUTH_TOKEN_SECRET;
const SAM_ENTITY   = 'https://api.sam.gov/entity-information/v3/entities';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sbH(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ') || !AUTH_SECRET) return null;
  try {
    var raw  = authHeader.slice(7);
    var data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!data.email || !data.ts || !data.sig) return null;
    if (Date.now() - data.ts > 7 * 24 * 3600000) return null;
    var toSign   = JSON.stringify({ email: data.email, ts: data.ts });
    var expected = crypto.createHmac('sha256', AUTH_SECRET).update(toSign).digest('hex');
    var expBuf   = Buffer.from(expected, 'hex');
    var sigBuf   = Buffer.from(data.sig, 'hex');
    if (expBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) return null;
    return data.email.toLowerCase().trim();
  } catch(e) { return null; }
}

async function fetchEntity(uei) {
  var params = new URLSearchParams({
    api_key: SAM_API_KEY, ueiSAM: uei,
    includeSections: 'entityRegistration,coreData,assertions',
  });
  var res  = await fetch(SAM_ENTITY + '?' + params, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Registry ' + res.status);
  var data = await res.json();
  var e    = (data.entityData || [])[0];
  if (!e) return null;
  var reg  = e.entityRegistration || {};
  var core = e.coreData || {};
  var addr = core.physicalAddress || {};
  var gs   = (e.assertions && e.assertions.goodsAndServices) || {};
  var bt   = (core.businessTypes && core.businessTypes.sbaBusinessTypeList) || [];
  var primary = gs.primaryNaics;
  var naicsList = (gs.naicsList || []).map(function(n) { return n.naicsCode; });
  var certs = bt.filter(function(c) {
    var exit = c.certificationExitDate || c.exitDate;
    return !exit || new Date(exit) > new Date();
  }).map(function(c) { return c.sbaBusinessTypeDesc || c.sbaBusinessTypeDescription; }).filter(Boolean);
  var isSmall = (gs.naicsList || []).some(function(n) { return n.sbaSmallBusiness === 'Y'; });
  if (isSmall && !certs.some(function(c) { return /small business/i.test(c); })) certs.push('Small Business');
  return {
    uei: reg.ueiSAM || uei,
    cage: reg.cageCode || null,
    sam_status: reg.registrationStatus === 'A' ? 'Active' : 'Unknown',
    address: [addr.city, addr.stateOrProvinceCode].filter(Boolean).join(', ') || null,
    naics: naicsList,
    primary_naics: primary || naicsList[0] || null,
    set_asides: certs,
    certifications: certs.map(function(c) { return { label: c }; }),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  var email = verifyToken(event.headers.authorization || event.headers.Authorization || '');
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var uei          = (body.uei || '').trim();
  var businessName = (body.businessName || '').trim();

  if (!uei && !businessName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'uei or businessName required' }) };
  }

  // If no UEI but businessName given (not-registered path): write what we have
  if (!uei) {
    await fetch(
      SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
      { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ business_name: businessName, onboarding_state: 'enrichment_pending', updated_at: new Date().toISOString() }) }
    );
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, uei: null, onboarding_state: 'enrichment_pending' }) };
  }

  // Fetch entity from SAM.gov
  var entity;
  try { entity = await fetchEntity(uei); }
  catch(e) {
    console.error('[claim-entity]', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Entity lookup failed: ' + e.message }) };
  }
  if (!entity) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Entity not found' }) };

  // Update capgen_subscriptions
  var patch = Object.assign({ onboarding_state: 'enrichment_pending', updated_at: new Date().toISOString() }, entity);
  if (businessName) patch.business_name = businessName;

  var pRes = await fetch(
    SUPABASE_URL + '/rest/v1/capgen_subscriptions?email=eq.' + encodeURIComponent(email),
    { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) }
  );
  if (!pRes.ok) console.error('[claim-entity] patch error:', await pRes.text());

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, uei: entity.uei, onboarding_state: 'enrichment_pending' }) };
};
