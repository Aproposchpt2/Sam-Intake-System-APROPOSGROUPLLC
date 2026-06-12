'use strict';
// demo-create-background.js — Netlify BACKGROUND function (-background suffix)
// Pulls entity profile, matches opportunities, runs Stage 1 Claude analysis,
// sends Capability Report email. No Stage 2. Ever.

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SAM_API_KEY   = process.env.SAM_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'CapGen by Apropos Group <jmitchell@ai4websitedesign.com>';
const MAILING_ADDR  = process.env.MAILING_ADDRESS  || 'Apropos Group LLC, North Las Vegas, NV 89031';
const MODEL         = process.env.ANTHROPIC_MODEL  || 'claude-sonnet-4-6';
const SAM_ENTITY    = 'https://api.sam.gov/entity-information/v3/entities';

// ── Supabase ─────────────────────────────────────────────────────────────────

function sbH(extra) {
  return Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, extra || {});
}

async function sbPatch(rowId, update) {
  var res = await fetch(
    SUPABASE_URL + '/rest/v1/demo_snapshots?id=eq.' + rowId,
    { method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(update) }
  );
  if (!res.ok) console.error('[demo-bg] PATCH failed:', await res.text());
}

async function sbGet(path) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: sbH() });
  if (!res.ok) throw new Error('DB: ' + await res.text());
  return res.json();
}

// ── SAM.gov entity pull ───────────────────────────────────────────────────────

async function fetchEntity(uei) {
  var params = new URLSearchParams({
    api_key: SAM_API_KEY, ueiSAM: uei,
    includeSections: 'entityRegistration,coreData,assertions',
  });
  var res = await fetch(SAM_ENTITY + '?' + params, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Entity API ' + res.status);
  var data  = await res.json();
  var e     = (data.entityData || [])[0];
  if (!e) return null;

  var reg   = e.entityRegistration || {};
  var core  = e.coreData || {};
  var addr  = core.physicalAddress || {};
  var bt    = (core.businessTypes && core.businessTypes.sbaBusinessTypeList) || [];
  var gs    = (e.assertions && e.assertions.goodsAndServices) || {};
  var primary = gs.primaryNaics;
  var now   = new Date();

  var naicsList = (gs.naicsList || []).map(function(n) {
    return { code: n.naicsCode, title: n.naicsDescription || '', primary: n.isPrimary === 'Y' || n.naicsCode === primary };
  });
  if (primary && !naicsList.some(function(n) { return n.primary; })) {
    var m = naicsList.find(function(n) { return n.code === primary; });
    if (m) m.primary = true;
  }

  var certs = bt.filter(function(c) {
    var exit = c.certificationExitDate || c.exitDate;
    return !exit || new Date(exit) > now;
  }).map(function(c) { return c.sbaBusinessTypeDesc || c.sbaBusinessTypeDescription || ''; }).filter(Boolean);

  var isSmall = (gs.naicsList || []).some(function(n) { return n.sbaSmallBusiness === 'Y'; });
  var setAsides = certs.slice();
  if (isSmall && !setAsides.some(function(c) { return /small business/i.test(c); })) setAsides.push('Small Business');

  return {
    legal_name:  reg.legalBusinessName || '',
    uei:         reg.ueiSAM || '',
    cage:        reg.cageCode || null,
    sam_status:  reg.registrationStatus === 'A' ? 'Active' : (reg.registrationStatus || 'Unknown'),
    city:        addr.city || null,
    state:       addr.stateOrProvinceCode || null,
    naics:       naicsList,
    set_asides:  setAsides,
    primary_naics: primary || (naicsList[0] && naicsList[0].code) || null,
  };
}

// ── Opportunity matching from sam_opportunities ───────────────────────────────

// ── 7-criteria scoring ───────────────────────────────────────────────────────
// Criteria: NAICS alignment, past performance, capability, location,
//           set-aside, certifications, risk factors

function scoreOpportunity(row, naicsCodes, primaryNaics, setAsides) {
  var score = 0;
  var criteria = {};
  var today = new Date();

  // 1. NAICS alignment (30 pts)
  if (row.naics_code === primaryNaics) {
    score += 30; criteria.naics = 'primary';
  } else if (naicsCodes.includes(row.naics_code)) {
    score += 20; criteria.naics = 'secondary';
  } else {
    score += 0; criteria.naics = 'none';
  }

  // 2. Set-aside / certifications (25 pts)
  var sa = (row.set_aside || '').toLowerCase();
  if (!sa || sa === 'none' || sa === 'unrestricted') {
    score += 15; criteria.setaside = 'open';
  } else {
    var eligible = (setAsides || []).some(function(cert) {
      return sa.includes(cert.toLowerCase().split(' ')[0].toLowerCase());
    });
    if (eligible) { score += 25; criteria.setaside = 'eligible'; }
    else           { score += 0;  criteria.setaside = 'ineligible'; }
  }

  // 3. Risk factors / timeline (20 pts)
  var days = row.response_deadline
    ? Math.ceil((new Date(row.response_deadline) - today) / 86400000)
    : null;
  if (days === null)   { score += 12; criteria.risk = 'no_deadline'; }
  else if (days >= 30) { score += 20; criteria.risk = 'low'; }
  else if (days >= 14) { score += 13; criteria.risk = 'medium'; }
  else if (days >= 7)  { score += 6;  criteria.risk = 'high'; }
  else                 { score += 2;  criteria.risk = 'critical'; }

  // 4. Capability alignment (15 pts) — NAICS match implies capability
  if (naicsCodes.includes(row.naics_code)) {
    score += 15; criteria.capability = 'aligned';
  } else {
    score += 5; criteria.capability = 'partial';
  }

  // 5. Past performance alignment (5 pts) — estimated from NAICS history
  criteria.past_performance = naicsCodes.includes(row.naics_code) ? 'relevant' : 'adjacent';
  score += naicsCodes.includes(row.naics_code) ? 5 : 2;

  // 6. Location requirements (3 pts) — SAM.gov opps are typically national
  criteria.location = 'national';
  score += 3;

  // 7. Certifications required (2 pts)
  criteria.certifications = (setAsides || []).length > 0 ? 'verified' : 'basic';
  score += (setAsides || []).length > 0 ? 2 : 1;

  return {
    score: Math.min(score, 100),
    criteria: criteria,
    days_left: days,
    urgency: days === null ? 'none' : days <= 7 ? 'hot' : days <= 30 ? 'warm' : 'ok',
  };
}

async function matchOpportunities(naicsCodes, primaryNaics, setAsides) {
  if (!naicsCodes.length) return { top5: [], remaining: 0 };
  var today = new Date();
  var minDeadline = new Date(today.getTime() + 7 * 24 * 3600000).toISOString();

  var inClause = naicsCodes.slice(0, 10).map(function(c) { return encodeURIComponent(c); }).join(',');
  var rows = await sbGet(
    'sam_opportunities?naics_code=in.(' + inClause + ')'
    + '&response_deadline=gte.' + encodeURIComponent(minDeadline)
    + '&select=notice_id,title,agency,naics_code,set_aside,response_deadline,ui_link'
    + '&order=response_deadline.asc&limit=100'
  );

  // Score every opportunity against all 7 criteria
  var scored = rows.map(function(r) {
    var s = scoreOpportunity(r, naicsCodes, primaryNaics, setAsides);
    return {
      notice_id:         r.notice_id,
      title:             r.title,
      agency:            r.agency,
      naics:             r.naics_code,
      set_aside:         r.set_aside || 'Unrestricted',
      response_deadline: r.response_deadline,
      url:               r.ui_link || '',
      match_score:       s.score,
      match_criteria:    s.criteria,
      days_left:         s.days_left,
      urgency:           s.urgency,
    };
  });

  // Sort by match score descending
  scored.sort(function(a, b) { return b.match_score - a.match_score; });

  var top5 = scored.slice(0, 20); // store top 20 — paginated on client
  return { top5: top5, remaining: Math.max(0, scored.length - 20) };
}

// ── Claude Stage 1 (verbatim prompts from Phase II spec) ─────────────────────

var STAGE1_SYSTEM = 'You are CapGen\'s federal contract fit analyst. You assess whether a specific\n'
  + 'small business contractor should pursue a specific federal opportunity.\n'
  + 'Be direct and honest — a wrong BID recommendation costs the contractor weeks\n'
  + 'of wasted proposal effort. NO_BID is a valid and often correct answer.\n'
  + 'Respond with ONLY a single valid JSON object. No markdown, no code fences,\n'
  + 'no commentary before or after the JSON.';

var STAGE1_SCHEMA = 'Return JSON matching exactly this schema:\n'
  + '{\n'
  + '  "opportunity_summary": "3-4 sentence plain-English summary of what the government is buying",\n'
  + '  "match": {\n'
  + '    "naics_match": true,\n'
  + '    "naics_detail": "1-2 sentences",\n'
  + '    "set_aside_eligible": true,\n'
  + '    "set_aside_detail": "1-2 sentences",\n'
  + '    "capability_alignment": "HIGH",\n'
  + '    "capability_detail": "2-3 sentences"\n'
  + '  },\n'
  + '  "recommendation": "BID",\n'
  + '  "fit_score": 85,\n'
  + '  "rationale": "3-5 sentences explaining the recommendation",\n'
  + '  "conditions": []\n'
  + '}';

async function runStage1(profile, opp) {
  var naicsStr = profile.naics.map(function(n) { return n.code + (n.title ? ' (' + n.title + ')' : '') + (n.primary ? ' [Primary]' : ''); }).join(', ');
  var profileBlock = 'CONTRACTOR PROFILE:\n'
    + 'Company: ' + profile.legal_name + '\n'
    + 'UEI: ' + (profile.uei || 'N/A') + ' | CAGE: ' + (profile.cage || 'N/A') + '\n'
    + 'Location: ' + [profile.city, profile.state].filter(Boolean).join(', ') + '\n'
    + 'NAICS codes: ' + naicsStr + '\n'
    + 'Set-aside eligibilities: ' + (profile.set_asides.join(', ') || 'None listed') + '\n'
    + 'Capabilities: Derived from registered NAICS codes and business type';

  var oppBlock = 'OPPORTUNITY:\n'
    + 'Title: ' + opp.title + '\n'
    + 'Agency: ' + (opp.agency || 'Unknown') + '\n'
    + 'Notice ID: ' + opp.notice_id + '\n'
    + 'NAICS: ' + (opp.naics || 'Not specified') + '\n'
    + 'Set-aside: ' + (opp.set_aside || 'Unrestricted') + '\n'
    + 'Response deadline: ' + (opp.response_deadline || 'Not specified');

  var userMsg = profileBlock + '\n\n' + oppBlock + '\n\n' + STAGE1_SCHEMA;

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: STAGE1_SYSTEM, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!res.ok) throw new Error('Claude ' + res.status + ': ' + (await res.text()).slice(0, 100));

  var data = await res.json();
  var text = ((data.content && data.content[0] && data.content[0].text) || '').trim();
  var clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try { return JSON.parse(clean); }
  catch(e) {
    // One retry
    var retryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: STAGE1_SYSTEM, messages: [
        { role: 'user', content: userMsg },
        { role: 'assistant', content: text },
        { role: 'user', content: 'Return ONLY valid JSON. No prose, no fences.' },
      ]}),
    });
    var retryData = await retryRes.json();
    var retryText = ((retryData.content && retryData.content[0] && retryData.content[0].text) || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(retryText);
  }
}

// ── Capability Report email ───────────────────────────────────────────────────

function recBadgeHtml(rec, score) {
  var colors = { BID: '#6EE7A8', CONDITIONAL: '#F59E0B', NO_BID: '#F87171' };
  var c = colors[rec] || '#F87171';
  return '<span style="display:inline-block;background:' + c + ';color:#0F2A6A;font-weight:700;padding:3px 10px;border-radius:4px;font-size:13px">'
    + rec + ' ' + score + '</span>';
}

async function sendEmail(opts) {
  // opts: { email, firstName, businessName, viewToken, profile, opp, analysis, snapshotUrl }
  var rec  = opts.analysis ? (opts.analysis.recommendation || 'NO_BID') : null;
  var score = opts.analysis ? (opts.analysis.fit_score || 0) : null;
  var oppTitle  = opts.opp ? opts.opp.title : null;
  var oppAgency = opts.opp ? opts.opp.agency : null;

  var htmlBody = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">'
    + '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;margin-top:20px">'
    + '<div style="background:#0F2A6A;padding:28px 32px">'
    + '<p style="color:#fff;font-size:22px;font-weight:700;margin:0">CapGen</p>'
    + '<p style="color:rgba(255,255,255,.6);font-size:12px;margin:4px 0 0">by Apropos Group</p>'
    + '</div>'
    + '<div style="padding:32px">'
    + '<p style="color:#1a2332;font-size:16px">Hi ' + (opts.firstName || 'there') + ',</p>'
    + '<p style="color:#43506a">Your capability snapshot for <strong>' + opts.businessName + '</strong> is ready.</p>'

    + (opts.profile ? (
      '<div style="background:#f3f5f9;border-radius:8px;padding:16px 20px;margin:20px 0">'
      + '<p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8292aa;margin:0 0 8px;font-weight:700">Profile</p>'
      + '<p style="margin:0;color:#0F2A6A;font-weight:700;font-size:16px">' + opts.profile.legal_name + '</p>'
      + '<p style="margin:4px 0 0;color:#43506a;font-size:13px">'
      + [opts.profile.city, opts.profile.state].filter(Boolean).join(', ')
      + ' · Registration: <span style="color:#1d7a4d;font-weight:700">' + (opts.profile.sam_status || 'Active') + '</span>'
      + '</p>'
      + '</div>'
    ) : '')

    + (opts.opp && opts.analysis ? (
      '<p style="color:#1a2332;font-weight:700;margin:24px 0 8px">Top Matched Opportunity</p>'
      + '<div style="border:1px solid #dfe4ee;border-radius:8px;padding:16px 20px">'
      + '<p style="font-weight:700;color:#0F2A6A;margin:0 0 4px;font-size:14px">' + opts.opp.title + '</p>'
      + '<p style="color:#43506a;font-size:12px;margin:0 0 12px">' + (opts.opp.agency || '') + '</p>'
      + '<div>' + recBadgeHtml(rec, score) + '</div>'
      + '<p style="color:#43506a;font-size:13px;margin:12px 0 0">' + (opts.analysis.rationale || '') + '</p>'
      + '</div>'
    ) : '')

    + '<div style="margin:28px 0;padding:16px 20px;border-left:3px solid #6EE7A8;background:#f3f5f9">'
    + '<p style="margin:0;color:#1a2332;font-size:13px">Your snapshot also includes the full analysis package — requirements, staffing, proposal checklist, and pricing guidance — <strong>locked for subscribers only.</strong></p>'
    + '</div>'

    + '<p style="text-align:center;margin:28px 0">'
    + '<a href="' + opts.snapshotUrl + '" style="display:inline-block;background:#0F2A6A;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">View My Full Snapshot →</a>'
    + '</p>'

    + '<p style="font-size:12px;color:#8292aa;text-align:center;font-style:italic">Sourced from official public records.</p>'

    + '<div style="border-top:1px solid #eee;margin-top:28px;padding-top:20px">'
    + '<p style="font-size:11px;color:#aeb7c7;margin:0">Want a weekly digest of opportunities matched to your profile?</p>'
    + '<p style="font-size:11px;color:#aeb7c7;margin:4px 0 0">'
    + '<a href="' + opts.snapshotUrl + '#subscribe" style="color:#0F2A6A">Confirm here</a> — you\'ll receive a confirmation email first. No signup = no emails.</p>'
    + '</div>'

    + '</div>'
    + '<div style="background:#f4f6f9;padding:16px 32px">'
    + '<p style="font-size:11px;color:#aeb7c7;margin:0">CapGen intelligence is sourced from official public records. · ' + MAILING_ADDR + '</p>'
    + '<p style="font-size:11px;color:#aeb7c7;margin:4px 0 0">CapGen by Apropos Group · You received this because you requested a snapshot at capgen.aproposgroupllc.com</p>'
    + '</div>'
    + '</div></body></html>';

  var r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [opts.email],
      subject: 'Your Capability Snapshot — ' + opts.businessName,
      html:    htmlBody,
    }),
  });
  if (!r.ok) console.error('[demo-bg] Resend error:', await r.text());
  else console.log('[demo-bg] Email sent to', opts.email);
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  var SITE_URL = process.env.DEPLOY_URL || process.env.URL || '';

  // Email-only path (entity snapshot already exists, just sending email)
  if (body.emailOnly) {
    try {
      var rows = await sbGet('demo_snapshots?view_token=eq.' + encodeURIComponent(body.viewToken) + '&limit=1');
      if (rows.length) {
        var r = rows[0];
        var topOpp = r.opportunities && r.opportunities[0]; // #1 best match for email
        await sendEmail({
          email: body.email, firstName: body.firstName, businessName: body.businessName,
          viewToken: body.viewToken, profile: r.profile, opp: topOpp, analysis: r.analysis,
          snapshotUrl: SITE_URL + '/demo/snapshot?t=' + body.viewToken,
        });
      }
    } catch(e) { console.error('[demo-bg] emailOnly error:', e.message); }
    return { statusCode: 200, body: 'ok' };
  }

  var rowId       = body.rowId;
  var uei         = body.uei;
  var businessName = body.businessName;
  var firstName   = body.firstName;
  var lastName    = body.lastName;
  var email       = body.email;
  var viewToken   = body.viewToken;

  if (!rowId || !uei) return { statusCode: 400, body: 'rowId and uei required' };
  console.log('[demo-bg] Starting snapshot rowId=' + rowId + ' uei=' + uei);

  try {
    // 1. Pull entity profile from federal registry
    var profile = await fetchEntity(uei);
    if (!profile) {
      await sbPatch(rowId, { status: 'not_registered', profile: { uei: uei, legal_name: businessName } });
      console.log('[demo-bg] Entity not found, status=not_registered');
      return { statusCode: 200, body: 'not_registered' };
    }
    console.log('[demo-bg] Entity:', profile.legal_name, '| NAICS:', profile.naics.length);

    // 2. Match opportunities
    var naicsCodes = profile.naics.map(function(n) { return n.code; });
    var matchResult = await matchOpportunities(naicsCodes, profile.primary_naics, profile.set_asides || []);
    var top5       = matchResult.top5;
    var remaining  = matchResult.remaining;
    console.log('[demo-bg] Opportunities: top5=' + top5.length + ' remaining=' + remaining);

    // 3. Stage 1 analysis on #1 opportunity (if one exists)
    var analysis = null;
    if (top5.length > 0) {
      try {
        analysis = await runStage1(profile, top5[0]);
        console.log('[demo-bg] Stage 1 complete: ' + (analysis && analysis.recommendation) + ' ' + (analysis && analysis.fit_score));
      } catch(e) {
        console.error('[demo-bg] Stage 1 failed:', e.message);
        // Non-fatal — snapshot still completes without analysis
      }
    }

    // 4. Persist and mark complete
    await sbPatch(rowId, {
      profile:                profile,
      opportunities:          top5.length > 0 ? top5 : null,
      additional_match_count: remaining,
      analysis:               analysis,
      status:                 'complete',
      generated_at:           new Date().toISOString(),
    });
    console.log('[demo-bg] Row marked complete');

    // 5. Send Capability Report email
    var snapshotUrl = SITE_URL + '/demo/snapshot?t=' + viewToken;
    try {
      await sendEmail({
        email: email, firstName: firstName, businessName: businessName,
        viewToken: viewToken, profile: profile,
        opp: top3[0] || null, analysis: analysis,
        snapshotUrl: snapshotUrl,
      });
    } catch(e) { console.error('[demo-bg] Email failed:', e.message); }

    return { statusCode: 200, body: 'complete' };

  } catch(err) {
    console.error('[demo-bg] Fatal:', err.message);
    try { await sbPatch(rowId, { status: 'failed' }); } catch(e) { /* ignore */ }
    return { statusCode: 200, body: 'failed' };
  }
};
