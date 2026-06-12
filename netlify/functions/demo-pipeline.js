'use strict';
// demo-pipeline.js — Live opportunity feed for demo/snapshot users
// GET ?t={view_token}&days={60|30|7}
// Reads NAICS from demo_snapshots.profile, fetches SAM.gov Opportunities API

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY  = process.env.SAM_API_KEY;
const OPP_URL      = 'https://api.sam.gov/opportunities/v2/search';
const PAGE_LIMIT   = 50;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function sbH() {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
}

function mmddyyyy(d) {
  return String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0') + '/' + d.getFullYear();
}

function daysUntil(deadline) {
  if (!deadline) return null;
  return Math.floor((new Date(deadline) - new Date()) / 86400000);
}

function urgencyClass(days) {
  if (days === null || days < 1) return 'none';
  if (days <= 7)  return 'hot';
  if (days <= 30) return 'warm';
  return 'ok';
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const q     = event.queryStringParameters || {};
  const token = q.t || '';
  const days  = Math.min(90, Math.max(1, parseInt(q.days || '60', 10)));

  if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'view_token required' }) };
  if (!SAM_API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SAM_API_KEY not set' }) };

  // Load snapshot
  var snapRes = await fetch(
    SUPABASE_URL + '/rest/v1/demo_snapshots?view_token=eq.' + encodeURIComponent(token) + '&limit=1',
    { headers: sbH() }
  );
  if (!snapRes.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Database error' }) };
  var snaps = await snapRes.json();
  if (!snaps.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Snapshot not found' }) };
  // If still generating — return pending status so dashboard can poll
  if (snaps[0].status === 'pending') {
    return { statusCode: 202, headers: CORS, body: JSON.stringify({ status: 'pending', message: 'Building your dashboard...' }) };
  }

  var snap     = snaps[0];
  var profile  = snap.profile || {};
  var naicsCodes = (profile.naics || []).map(function(n) { return n.code || n; }).filter(Boolean);
  var primaryNaics = profile.primary_naics || (naicsCodes[0] || '');
  var businessName = profile.legal_name || snap.business_name || '';
  var uei = profile.uei || snap.entity_uei || '';

  if (!naicsCodes.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      client: { uei: uei, name: businessName, naics: [] },
      window_days: days, total: 0, opportunities: [],
    })};
  }

  // Fetch opportunities for each NAICS (cap at 8 codes for speed)
  var now  = new Date();
  var from = new Date(now); from.setDate(from.getDate() - days);
  var seen = new Map();

  for (var i = 0; i < Math.min(naicsCodes.length, 8); i++) {
    var naics = naicsCodes[i];
    try {
      var url = new URL(OPP_URL);
      url.searchParams.set('api_key',    SAM_API_KEY);
      url.searchParams.set('postedFrom', mmddyyyy(from));
      url.searchParams.set('postedTo',   mmddyyyy(now));
      url.searchParams.set('ncode',      naics);
      url.searchParams.set('limit',      String(PAGE_LIMIT));
      url.searchParams.set('offset',     '0');
      var res  = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      var data = await res.json();
      for (var j = 0; j < (data.opportunitiesData || []).length; j++) {
        var o = data.opportunitiesData[j];
        if (!o.noticeId || seen.has(o.noticeId)) continue;
        var dl = daysUntil(o.responseDeadLine);
        if (dl !== null && dl < 1) continue;
        seen.set(o.noticeId, {
          notice_id:   o.noticeId,
          title:       o.title,
          agency:      o.fullParentPathName,
          type:        o.type,
          naics:       o.naicsCode,
          set_aside:   o.typeOfSetAsideDescription || o.setAside || 'None',
          posted_date: o.postedDate,
          deadline:    o.responseDeadLine,
          days_left:   dl,
          urgency:     urgencyClass(dl),
          url:         o.uiLink || ('https://sam.gov/opp/' + o.noticeId + '/view'),
        });
      }
    } catch(e) { console.error('[demo-pipeline] NAICS', naics, ':', e.message); }
  }

  var results = [...seen.values()]
    .filter(function(o) { return o.days_left !== null && o.days_left >= 1; })
    .sort(function(a, b) {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      client: {
        uei:            uei,
        name:           businessName,
        naics:          naicsCodes,
        primary_naics:  primaryNaics,
        certifications: profile.set_asides || [],
        city:           profile.city || null,
        state:          profile.state || null,
      },
      view_token:   token,
      window_days:  days,
      total:        results.length,
      opportunities: results,
    }),
  };
};
