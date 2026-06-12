'use strict';
// demo-report.js — Capability Report for demo users
// GET ?t={view_token}
// Fetches snapshot UEI → pulls live entity from SAM.gov → returns capability HTML

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SAM_API_KEY  = process.env.SAM_API_KEY;
const SAM_ENTITY   = 'https://api.sam.gov/entity-information/v3/entities';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function sbH() {
  return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function fetchEntity(uei) {
  var params = new URLSearchParams({
    api_key: SAM_API_KEY, ueiSAM: uei,
    includeSections: 'entityRegistration,coreData,assertions',
  });
  var res = await fetch(SAM_ENTITY + '?' + params, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('SAM API ' + res.status);
  var data = await res.json();
  var e = (data.entityData || [])[0];
  if (!e) return null;

  var reg  = e.entityRegistration || {};
  var core = e.coreData || {};
  var addr = core.physicalAddress || {};
  var gs   = (e.assertions && e.assertions.goodsAndServices) || {};
  var bt   = (core.businessTypes && core.businessTypes.sbaBusinessTypeList) || [];
  var now  = new Date();
  var primary = gs.primaryNaics;

  var naics = (gs.naicsList || []).map(function(n) {
    return { code: n.naicsCode, title: n.naicsDescription || '', primary: n.naicsCode === primary };
  });

  var certs = bt.filter(function(c) {
    var exit = c.certificationExitDate || c.exitDate;
    return !exit || new Date(exit) > now;
  }).map(function(c) { return { label: c.sbaBusinessTypeDesc || c.sbaBusinessTypeDescription, key: true }; })
    .filter(function(c) { return c.label; });

  var isSmall = (gs.naicsList || []).some(function(n) { return n.sbaSmallBusiness === 'Y'; });
  if (isSmall) certs.push({ label: 'Small Business', key: false });

  return {
    legal_name:    reg.legalBusinessName || '',
    logo_text:     (reg.legalBusinessName || '??').replace(/[^A-Za-z ]/g,'').split(/\s+/).filter(Boolean).slice(0,2).map(function(w){return w[0];}).join('').toUpperCase() || 'AG',
    uei:           reg.ueiSAM || '',
    cage:          reg.cageCode || '—',
    sam_status:    reg.registrationStatus === 'A' ? 'Active' : (reg.registrationStatus || 'Unknown'),
    size:          isSmall ? 'Small Business' : 'Business',
    address:       [addr.city, addr.stateOrProvinceCode].filter(Boolean).join(', '),
    naics:         naics,
    socioeconomic: certs,
    tagline_pre:   '', tagline_em: '',
    competencies:  [], differentiators: [],
    contact:       { name: '', title: '', phone: '', email: '', website: '' },
  };
}

function buildHtml(r) {
  var badges = (r.socioeconomic || []).map(function(c) {
    return '<div class="badge' + (c.key ? ' key' : '') + '">' + esc(c.label) + '</div>';
  }).join('');
  var naics = (r.naics || []).map(function(n) {
    return '<div class="row"><span class="code' + (n.primary ? ' pri' : '') + '">' + esc(n.code) + '</span>'
      + '<span class="desc">' + esc(n.title) + (n.primary ? ' <span class="pri">(Primary)</span>' : '') + '</span></div>';
  }).join('');
  var c = r.contact || {};

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + '@page{size:letter;margin:0}*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:Arial,Helvetica,sans-serif;color:#1a2332;font-size:9.3px;line-height:1.4}'
    + '.page{width:8.5in;min-height:11in;padding:.45in .5in .4in;display:flex;flex-direction:column}'
    + '.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0A1A3A;padding-bottom:11px}'
    + '.brand{display:flex;align-items:center;gap:12px}.logo{width:46px;height:46px;background:#0A1A3A;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;border-radius:4px}'
    + '.brand h1{font-size:20px;color:#0A1A3A;line-height:1.05}.brand .sub{font-size:9px;color:#51607a;margin-top:3px;letter-spacing:.5px;text-transform:uppercase;font-weight:600}'
    + '.header-right{text-align:right;font-size:8.6px;color:#51607a;line-height:1.55}.header-right .tag{color:#b5762a;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:.6px}'
    + '.tagline{background:#0A1A3A;color:#fff;padding:7px 12px;margin-top:11px;font-size:11px;font-weight:600;border-radius:3px}'
    + '.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.badge{font-size:9px;font-weight:700;padding:4px 10px;border-radius:20px;background:#fbf2e6;color:#b5762a;border:1px solid #ecd7b3}.badge.key{background:#0A1A3A;color:#fff;border-color:#0A1A3A}'
    + '.body{display:flex;gap:16px;margin-top:13px;flex:1}.col-left{flex:1.55}.col-right{flex:1}'
    + 'h2{font-size:10px;color:#0A1A3A;text-transform:uppercase;letter-spacing:.9px;border-bottom:1.5px solid #d9a45b;padding-bottom:3px;margin-bottom:7px;font-weight:700}.section{margin-bottom:13px}'
    + '.data{background:#f3f5f9;border:1px solid #dfe4ee;border-radius:4px;padding:9px 11px;margin-bottom:12px}.data .row{display:flex;justify-content:space-between;padding:2.6px 0;border-bottom:1px dotted #cfd6e4;font-size:8.7px}.data .row:last-child{border-bottom:none}'
    + '.data .k{color:#51607a;font-weight:600}.data .v{color:#0A1A3A;font-weight:700;text-align:right}.data .v.ok{color:#1d7a4d}'
    + '.naics .row{display:flex;gap:7px;padding:3.2px 0;border-bottom:1px dotted #cfd6e4}.naics .row:last-child{border-bottom:none}.naics .code{font-weight:700;color:#0A1A3A;font-size:9px;min-width:44px}.naics .desc{color:#43506a;font-size:8.5px}.naics .pri{color:#b5762a;font-weight:700}'
    + '.footer{border-top:2px solid #0A1A3A;margin-top:10px;padding-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:8.6px}'
    + '.engine{text-align:center;font-size:6.6px;color:#aeb7c7;margin-top:7px;letter-spacing:.3px}'
    + '.no-data{color:#aeb7c7;font-size:8.5px;font-style:italic}'
    + '</style></head><body><div class="page">'
    + '<div class="header"><div class="brand"><div class="logo">' + esc(r.logo_text) + '</div>'
    + '<div><h1>' + esc(r.legal_name) + '</h1><div class="sub">Federal Contractor &middot; ' + esc(r.address) + '</div></div></div>'
    + '<div class="header-right"><div class="tag">Capability Statement</div><div>SAM Registration ' + esc(r.sam_status) + ' &middot; ' + esc(r.size) + '</div></div></div>'
    + (r.tagline_em ? '<div class="tagline">' + esc(r.tagline_pre) + ' <span style="color:#d9a45b">' + esc(r.tagline_em) + '</span></div>' : '')
    + (badges ? '<div class="badges">' + badges + '</div>' : '')
    + '<div class="body"><div class="col-left">'
    + '<div class="section"><h2>Core Competencies</h2>'
    + (r.competencies && r.competencies.length ? r.competencies.map(function(c){return '<div style="margin-bottom:6px"><span style="font-weight:700;color:#0A1A3A;font-size:9.4px">'+esc(c.title)+'</span><div style="color:#43506a;font-size:8.9px">'+esc(c.desc)+'</div></div>';}).join('') : '<p class="no-data">Update your profile with core capabilities to populate this section.</p>')
    + '</div><div class="section"><h2>Differentiators</h2>'
    + (r.differentiators && r.differentiators.length ? '<ul style="list-style:none">' + r.differentiators.map(function(d){return '<li style="position:relative;padding-left:12px;margin-bottom:4px;color:#2b3852;font-size:8.9px"><span style="position:absolute;left:0;color:#b5762a">&#9656;</span>'+esc(d)+'</li>';}).join('') + '</ul>' : '<p class="no-data">Add differentiators in your profile.</p>')
    + '</div></div><div class="col-right">'
    + '<div class="section"><h2>Company Data</h2><div class="data">'
    + '<div class="row"><span class="k">UEI</span><span class="v">' + esc(r.uei) + '</span></div>'
    + '<div class="row"><span class="k">CAGE Code</span><span class="v">' + esc(r.cage) + '</span></div>'
    + '<div class="row"><span class="k">Registration</span><span class="v ok">' + esc(r.sam_status) + '</span></div>'
    + '<div class="row"><span class="k">Business Type</span><span class="v">' + esc(r.size) + '</span></div>'
    + '<div class="row"><span class="k">Location</span><span class="v">' + esc(r.address) + '</span></div>'
    + '</div></div>'
    + '<div class="section"><h2>NAICS Codes</h2><div class="data naics">' + naics + '</div></div>'
    + '</div></div>'
    + '<div class="footer"><div style="color:#0A1A3A">'
    + (c.name ? '<b>' + esc(c.name) + '</b>' : '<b>' + esc(r.legal_name) + '</b>')
    + '</div><div style="text-align:right;color:#43506a;line-height:1.5">UEI ' + esc(r.uei) + ' &middot; CAGE ' + esc(r.cage) + '</div></div>'
    + '<div class="engine">Generated by CapGen &middot; AI4 Businesses &middot; Sourced from official public records.</div>'
    + '</div></body></html>';
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  var token = (event.queryStringParameters || {}).t || '';
  if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'view_token required' }) };

  // Get snapshot
  var snapRes = await fetch(
    SUPABASE_URL + '/rest/v1/demo_snapshots?view_token=eq.' + encodeURIComponent(token) + '&limit=1',
    { headers: sbH() }
  );
  if (!snapRes.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'DB error' }) };
  var snaps = await snapRes.json();
  if (!snaps.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Snapshot not found' }) };

  var snap    = snaps[0];
  var profile = snap.profile || {};
  var uei     = profile.uei || snap.entity_uei || '';

  if (!uei) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No UEI on this snapshot' }) };
  if (!SAM_API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SAM_API_KEY not set' }) };

  // Fetch live entity from SAM.gov
  var entity;
  try { entity = await fetchEntity(uei); }
  catch(e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'SAM lookup failed: ' + e.message }) }; }
  if (!entity) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Entity not found on SAM.gov' }) };

  // Build HTML
  var html = buildHtml(entity);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ html: html, entity: entity }),
  };
};
