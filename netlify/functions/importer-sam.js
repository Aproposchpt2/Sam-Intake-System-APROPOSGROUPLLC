'use strict';
// importer-sam.js — CapGen Marketing Engine
// Fetches active small business federal contractors for target NAICS codes.
// Uses NAICS-based search (date range not supported in SAM v3 API).
// Deduplication against existing DB ensures only NEW contractors are imported each run.

const TARGET_NAICS = ['541519', '541512', '541511', '541611', '561210'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY  = process.env.SAM_API_KEY;
const SAM_BASE     = 'https://api.sam.gov/entity-information/v3/entities';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

function sbH() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

async function fetchNaicsPage(naicsCode, page) {
  const params = new URLSearchParams({
    api_key:           SAM_API_KEY,
    naicsCode:         naicsCode,
    registrationStatus:'A',
    includeSections:   'entityRegistration,coreData,assertions',
    page:              String(page),
    size:              '100'
  });
  const res = await fetch(SAM_BASE + '?' + params.toString());
  if (!res.ok) {
    const t = await res.text();
    throw new Error('SAM ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.json();
}

function isSmallBusiness(entity) {
  const core        = entity.coreData || {};
  const bt          = core.businessTypes || {};
  const sbaList     = bt.sbaBusinessTypeList || [];
  const assertions  = entity.assertions || {};
  const gs          = assertions.goodsAndServices || {};
  const naicsList   = gs.naicsList || [];
  // Check SBA type list OR small business flag on any NAICS
  return sbaList.length > 0 ||
    naicsList.some(function(n) { return n.sbaSmallBusiness === 'Y'; });
}

function mapEntity(entity, naicsCode) {
  const reg  = entity.entityRegistration || {};
  const core = entity.coreData || {};
  const addr = core.physicalAddress || {};
  const gs   = (entity.assertions && entity.assertions.goodsAndServices) || {};
  const naicsList = gs.naicsList || [];
  return {
    id:                reg.ueiSAM,
    legal_name:        reg.legalBusinessName || '',
    doing_business_as: reg.dbaName || null,
    address_street:    addr.addressLine1 || null,
    address_city:      addr.city || null,
    address_state:     addr.stateOrProvinceCode || null,
    address_zip:       addr.zipCode || null,
    naics_codes:       naicsList.map(function(n) { return n.naicsCode; }),
    primary_naics:     gs.primaryNaics || naicsCode,
    business_type:     'Small Business',
    sam_status:        reg.registrationStatus === 'A' ? 'Active' : (reg.registrationStatus || ''),
    registration_date: reg.registrationDate || null,
    website_url:       (core.entityURL) || null,
    imported_at:       new Date().toISOString(),
    enrichment_status: 'pending',
    outreach_status:   'pending'
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  if (!SAM_API_KEY)  return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'SAM_API_KEY not set' }) };
  if (!SUPABASE_URL) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'SUPABASE_URL not set' }) };

  try {
    // 1. Load existing UEIs from Supabase for dedup
    const existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/contractors?select=id&limit=50000',
      { headers: sbH() }
    );
    if (!existingRes.ok) throw new Error('Supabase read failed: ' + await existingRes.text());
    const existingRows = await existingRes.json();
    const existingUEIs = new Set(existingRows.map(function(r) { return r.id; }));
    console.log('[importer] Existing in DB:', existingUEIs.size);

    // Diagnostic mode: return raw SAM response to debug param issues
    var isDiag = (event.queryStringParameters && event.queryStringParameters.diag === '1');
    if (isDiag) {
      try {
        var diagData = await fetchNaicsPage(TARGET_NAICS[0], 0);
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ diag: true, naics: TARGET_NAICS[0], raw: diagData }) };
      } catch(e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ diag: true, error: e.message }) }; }
    }

    // 2. Fetch from SAM.gov per NAICS code (max 3 pages each = 300 per NAICS)
    const newEntities = [];
    const seenUEIs    = new Set();
    let   samTotal    = 0;

    for (var ni = 0; ni < TARGET_NAICS.length; ni++) {
      var naicsCode = TARGET_NAICS[ni];
      console.log('[importer] Fetching NAICS:', naicsCode);

      for (var page = 0; page < 3; page++) {
        var data;
        try {
          data = await fetchNaicsPage(naicsCode, page);
        } catch(e) {
          console.error('[importer] SAM error NAICS', naicsCode, 'page', page, ':', e.message);
          break;
        }

        var entities = data.entityData || [];
        samTotal += entities.length;
        console.log('[importer] NAICS', naicsCode, 'page', page, ': got', entities.length);

        for (var i = 0; i < entities.length; i++) {
          var entity = entities[i];
          var reg    = entity.entityRegistration || {};
          var uei    = reg.ueiSAM;
          if (!uei || existingUEIs.has(uei) || seenUEIs.has(uei)) continue;
          if (!isSmallBusiness(entity)) continue;
          seenUEIs.add(uei);
          newEntities.push(mapEntity(entity, naicsCode));
        }

        if (entities.length < 100) break; // no more pages
      }
    }

    console.log('[importer] SAM total fetched:', samTotal, '| New unique:', newEntities.length);

    // 3. Upsert new contractors to Supabase in chunks of 50
    var inserted = 0;
    var errors   = 0;
    var CHUNK    = 50;

    for (var ci = 0; ci < newEntities.length; ci += CHUNK) {
      var chunk = newEntities.slice(ci, ci + CHUNK);
      var upsertRes = await fetch(SUPABASE_URL + '/rest/v1/contractors', {
        method:  'POST',
        headers: Object.assign({}, sbH(), { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body:    JSON.stringify(chunk)
      });
      if (upsertRes.ok) {
        inserted += chunk.length;
      } else {
        var errT = await upsertRes.text();
        console.error('[importer] Upsert error:', errT.slice(0, 200));
        errors += chunk.length;
      }
    }

    console.log('[importer] Done. Inserted:', inserted, 'Errors:', errors);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success:             true,
        samTotalFetched:     samTotal,
        matchedFilters:      newEntities.length,
        dedupedUnique:       newEntities.length,
        contractorsImported: inserted,
        contractorsSkipped:  errors,
        alreadyInDatabase:   samTotal - newEntities.length,
        naicsSearched:       TARGET_NAICS
      })
    };

  } catch (err) {
    console.error('[importer] Fatal:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
