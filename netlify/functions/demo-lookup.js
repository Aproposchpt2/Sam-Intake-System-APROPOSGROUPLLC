'use strict';
// demo-lookup.js — Entity disambiguation for demo intake
// POST { businessName, state? } → up to 5 candidates; IP rate-limited 10/hr
// NEVER references SAM.gov to the user (internal only)

const SAM_API_KEY  = process.env.SAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_ENTITY   = 'https://api.sam.gov/entity-information/v3/entities';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  // IP rate limit: 10 lookups per hour (use demo_snapshots as proxy)
  const ip    = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const since = new Date(Date.now() - 3600000).toISOString();
  try {
    var rr = await fetch(
      SUPABASE_URL + '/rest/v1/demo_snapshots?requester_ip=eq.' + encodeURIComponent(ip)
        + '&created_at=gte.' + encodeURIComponent(since) + '&select=id',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
    );
    if (rr.ok && (await rr.json()).length >= 10) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'RATE_LIMIT', message: 'Too many requests. Please try again in an hour.' }) };
    }
  } catch(e) { /* non-fatal — proceed */ }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  var businessName = (body.businessName || '').trim();
  var state = (body.state || '').trim().toUpperCase().slice(0, 2) || null;
  if (businessName.length < 2) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Business name too short' }) };
  if (!SAM_API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Configuration error' }) };

  try {
    var params = new URLSearchParams({
      api_key:           SAM_API_KEY,
      legalBusinessName: businessName,
      registrationStatus:'A',
      includeSections:   'entityRegistration,coreData',
    });
    // state used for client-side filtering only — not a SAM entity-search param

    var samRes = await fetch(SAM_ENTITY + '?' + params.toString(), { headers: { Accept: 'application/json' } });
    if (!samRes.ok) throw new Error('Registry ' + samRes.status);
    var data = await samRes.json();

    var all = (data.entityData || []).map(function(e) {
      var reg  = e.entityRegistration || {};
      var core = e.coreData || {};
      var addr = core.physicalAddress || {};
      return {
        uei:                 reg.ueiSAM,
        legal_name:          reg.legalBusinessName || '',
        city:                addr.city || null,
        state:               addr.stateOrProvinceCode || null,
        registration_status: reg.registrationStatus === 'A' ? 'Active' : (reg.registrationStatus || 'Unknown'),
        cage:                reg.cageCode || null,
      };
    }).filter(function(c) { return !!c.uei; });

    // Apply optional state filter client-side
    var candidates = state
      ? all.filter(function(c) { return !c.state || c.state.toUpperCase() === state; }).concat(
          all.filter(function(c) { return c.state && c.state.toUpperCase() !== state; })
        )
      : all;
    candidates = candidates.slice(0, 5);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ total: candidates.length, candidates: candidates }) };
  } catch(err) {
    console.error('[demo-lookup]', err.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Lookup failed' }) };
  }
};
