'use strict';
// importer-sam.js — CapGen Marketing Engine
// NAICS-based search (SAM v3 does not support date-range filtering).
// Three-layer deduplication: DB UEI check, within-batch Set, upsert merge.
// TARGET_NAICS derived dynamically from active capgen_subscriptions at run time.

const FALLBACK_NAICS = ['541519', '541512', '541511', '541611', '561210', '238210'];

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

async function fetchTargetNaics() {
  try {
    var res = await fetch(
      SUPABASE_URL + '/rest/v1/capgen_subscriptions?select=naics&status=eq.active&limit=500',
      { headers: sbH() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var rows = await res.json();
    var naicsSet = new Set();
    rows.forEach(function(r) {
      (r.naics || []).forEach(function(n) { if (n) naicsSet.add(n); });
    });
    if (naicsSet.size === 0) {
      console.log('[importer] No subscriber NAICS found, using fallback');
      return FALLBACK_NAICS;
    }
    var list = [...naicsSet];
    console.log('[importer] Dynamic NAICS from', rows.length, 'subscriber(s):', list.join(', '));
    return list;
  } catch(e) {
    console.error('[importer] fetchTargetNaics failed, using fallback:', e.message);
    return FALLBACK_NAICS;
  }
}

async function fetchNaicsPage(naicsCode, page) {
  var params = new URLSearchParams({
    api_key:           SAM_API_KEY,
    naicsCode:         naicsCode,
    registrationStatus:'A',
    includeSections:   'entityRegistration,coreData,assertions',
    page:              String(page),
    size:              '100'
  });
  var res = await fetch(SAM_BASE + '?' + params.toString());
  if (!res.ok) {
    var t = await res.text();
    throw new Error('SAM ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.json();
}

function isSmallBusiness(entity) {
  var core     = entity.coreData || {};
  var bt       = core.businessTypes || {};
  var sbaList  = bt.sbaBusinessTypeList || [];
  var gs       = (entity.assertions && entity.assertions.goodsAndServices) || {};
  var naicsList = gs.naicsList || [];
  return sbaList.length > 0 ||
    naicsList.some(function(n) { return n.sbaSmallBusiness === 'Y'; });
}

function mapEntity(entity, naicsCode) {
  var reg  = entity.entityRegistration || {};
  var core = entity.coreData || {};
  var addr = core.physicalAddress || {};
  var gs   = (entity.assertions && entity.assertions.goodsAndServices) || {};
  var naicsList = gs.naicsList || [];
  return {
    id:                reg.ueiSAM,
    legal_name:        reg.legalBusinessName || '',
    doing_business_as: reg.dbaName || null,
    cage:              reg.cageCode || null,
    address_street:    addr.addressLine1 || null,
    address_city:      addr.city || null,
    address_state:     addr.stateOrProvinceCode || null,
    address_zip:       addr.zipCode || null,
    naics_codes:       naicsList.map(function(n) { return n.naicsCode; }),
    primary_naics:     gs.primaryNaics || naicsCode,
    business_type:     'Small Business',
    sam_status:        reg.registrationStatus === 'A' ? 'Active' : (reg.registrationStatus || ''),
    registration_date: reg.registrationDate || null,
    website_url:       core.entityURL || null,
    imported_at:       new Date().toISOString(),
    enrichment_status: 'pending',
    outreach_status:   'pending'
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  if (!SAM_API_KEY)  return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'SAM_API_KEY not set' }) };
  if (!SUPABASE_URL) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'SUPABASE_URL not set' }) };

  try {
    // Derive TARGET_NAICS dynamically from active subscriber profiles
    var TARGET_NAICS = await fetchTargetNaics();

    // Layer 1: load existing UEIs from DB for deduplication
    var existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/contractors?select=id&limit=50000',
      { headers: sbH() }
    );
    if (!existingRes.ok) throw new Error('Supabase read failed: ' + await existingRes.text());
    var existingRows = await existingRes.json();
    var existingUEIs = new Set(existingRows.map(function(r) { return r.id; }));
    console.log('[importer] Existing in DB:', existingUEIs.size);

    // Fetch from SAM.gov per NAICS (3 pages × 100 records = up to 300 per NAICS)
    var newEntities = [];
    var seenUEIs    = new Set(); // Layer 2: within-batch dedup
    var samTotal    = 0;

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

        if (entities.length < 100) break;
      }
    }

    console.log('[importer] SAM total fetched:', samTotal, '| New unique:', newEntities.length);

    // Layer 3: upsert with merge-duplicates as final safety net
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

  } catch(err) {
    console.error('[importer] Fatal:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
