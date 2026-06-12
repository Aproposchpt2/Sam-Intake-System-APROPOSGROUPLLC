// analyze-fit-background.mjs — Phase 2 (Netlify background function)
// Invoked by analyze-fit.mjs. Runs Stage 1 → stage1_complete, then Stage 2 → complete.
// No external auth required — only called server-to-server by analyze-fit.mjs.

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ── Supabase helpers ─────────────────────────────────────────────────────────

function sbH(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() });
  if (!res.ok) throw new Error(`Supabase GET: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

async function sbPatch(filter, update) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/opportunity_analyses?${filter}`, {
    method: 'PATCH',
    headers: sbH({ Prefer: 'return=minimal' }),
    body: JSON.stringify(update),
  });
  if (!res.ok) console.error('[bg] Supabase PATCH failed:', await res.text());
}

// ── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data  = await res.json();
  const text  = (data.content?.[0]?.text || '').trim();
  const usage = data.usage || {};
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try { parsed = JSON.parse(clean); }
  catch { throw { retryable: true, raw: text, usage }; }
  return { parsed, usage };
}

async function callClaudeWithRetry(system, user, maxTokens) {
  try { return await callClaude(system, user, maxTokens); }
  catch (e) {
    if (e && e.retryable) {
      return await callClaude(system, user + '\n\nReturn ONLY valid JSON. No prose, no fences.', maxTokens);
    }
    throw e;
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const STAGE1_SYSTEM = `You are CapGen's federal contract fit analyst. You assess whether a specific
small business contractor should pursue a specific federal opportunity.
Be direct and honest — a wrong BID recommendation costs the contractor weeks
of wasted proposal effort. NO_BID is a valid and often correct answer.
Respond with ONLY a single valid JSON object. No markdown, no code fences,
no commentary before or after the JSON.`;

const STAGE2_SYSTEM = `You are CapGen's federal proposal strategist. The contractor has decided to
evaluate this opportunity seriously. Produce a concrete, actionable pursuit
package. Be specific to THIS opportunity and THIS contractor — no generic
boilerplate. Respond with ONLY a single valid JSON object. No markdown,
no code fences, no commentary.`;

function buildProfileBlock(p) {
  return `CONTRACTOR PROFILE:
Company: ${p.business_name || 'Unknown'}
UEI: ${p.uei || 'N/A'} | CAGE: ${p.cage || 'N/A'}
NAICS codes: ${(p.naics || []).join(', ') || 'None listed'}
Set-aside statuses: ${(p.set_asides || []).join(', ') || 'None listed'}
Certifications: ${JSON.stringify(p.certifications || [])}
Team size: ${p.team_size || 'Not specified'}
Capabilities: ${p.capabilities || 'Not specified'}
Past performance: ${p.past_performance || 'Not specified'}
Keywords: ${(p.keywords || []).join(', ') || 'None'}`;
}

function buildOppBlock(o) {
  const raw  = o.raw || {};
  const desc = (raw.description || raw.fullParentPathName || '').toString().slice(0, 6000);
  const pop  = raw.placeOfPerformance?.city?.name
    ? `${raw.placeOfPerformance.city.name}, ${raw.placeOfPerformance.state?.code || ''}`
    : 'Not specified';
  return `OPPORTUNITY:
Title: ${o.title || 'Unknown'}
Agency: ${o.agency || 'Unknown'}
Notice ID: ${o.notice_id}
NAICS: ${o.naics_code || 'Not specified'}
Set-aside: ${o.set_aside || 'Unrestricted'}
Response deadline: ${o.response_deadline || 'Not specified'}
Place of performance: ${pop}
Description: ${desc || 'Not provided'}`;
}

const STAGE1_SCHEMA = `Return JSON matching exactly this schema:
{
  "opportunity_summary": "3-4 sentence plain-English summary of what the government is buying",
  "match": {
    "naics_match": true,
    "naics_detail": "1-2 sentences",
    "set_aside_eligible": true,
    "set_aside_detail": "1-2 sentences",
    "capability_alignment": "HIGH",
    "capability_detail": "2-3 sentences"
  },
  "recommendation": "BID",
  "fit_score": 85,
  "rationale": "3-5 sentences explaining the recommendation",
  "conditions": []
}`;

const STAGE2_SCHEMA = `Return JSON matching exactly this schema:
{
  "required_work": ["bullet list of actual work scope items"],
  "staffing_delivery": ["roles, certifications, clearances, delivery requirements"],
  "documents_needed": ["every document required to respond"],
  "proposal_checklist": [{"item": "...", "owner_hint": "...", "deadline_hint": "..."}],
  "draft_technical_approach": "4-6 paragraphs tailored to the contractor's capabilities",
  "pricing_considerations": ["contract type implications, competitive range, cost drivers"],
  "questions_for_co": ["specific, well-formed questions for the contracting officer"]
}`;

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event) => {
  // Background functions return 202 immediately — Netlify keeps running this handler
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { rowId, accountEmail, opportunityId, profileVersion, deep = false, skipStage1 = false, opportunity: inlineOpp } = body;
  if (!rowId) return { statusCode: 400, body: 'rowId required' };

  console.log(`[bg] Starting analysis rowId=${rowId} skipStage1=${skipStage1} deep=${deep}`);

  // Mark as started (prevents duplicate background runs from picking up the same row)
  const markFilter = `id=eq.${rowId}`;

  try {
    // Load profile from demo_snapshots
    const snaps = await sbGet(`demo_snapshots?requester_email=eq.${encodeURIComponent(accountEmail)}&order=created_at.desc&limit=1`);
    if (!snaps.length) {
      await sbPatch(markFilter, { status: 'failed', stage1: { error: 'Profile not found' } });
      return { statusCode: 200, body: 'no profile' };
    }
    const snap    = snaps[0];
    const rawProf = snap.profile || {};
    const profile = {
      business_name:  rawProf.legal_name || snap.business_name || '',
      uei:            rawProf.uei  || '',
      cage:           rawProf.cage || '',
      naics:          (rawProf.naics || []).map(n => n.code || n),
      set_asides:     rawProf.set_asides || [],
      certifications: rawProf.set_asides || [],
      capabilities:   rawProf.capabilities || 'IT services, computer programming, systems design',
      past_performance: rawProf.past_performance || 'Not specified',
      team_size:      rawProf.team_size || 'Not specified',
      keywords:       rawProf.keywords || [],
    };

    // Load existing row (to get stage1 if skipStage1)
    const existingRows = await sbGet(`opportunity_analyses?id=eq.${rowId}&limit=1`);
    const existingRow  = existingRows[0] || {};

    // Load opportunity
    let opp;
    const opps = await sbGet(`sam_opportunities?notice_id=eq.${encodeURIComponent(opportunityId)}&limit=1`);
    if (opps.length) {
      opp = opps[0];
    } else if (inlineOpp) {
      opp = {
        notice_id:         opportunityId,
        title:             inlineOpp.title || '',
        agency:            inlineOpp.agency || '',
        naics_code:        inlineOpp.naics || '',
        set_aside:         inlineOpp.set_aside || '',
        response_deadline: inlineOpp.deadline || '',
        raw:               {},
      };
    } else {
      await sbPatch(markFilter, { status: 'failed', stage1: { error: 'Opportunity not found' } });
      return { statusCode: 200, body: 'opp not found' };
    }

    const profileBlock = buildProfileBlock(profile);
    const oppBlock     = buildOppBlock(opp);

    // ── Stage 1 ──────────────────────────────────────────────────────────────
    let stage1, recommendation, fitScore, s1Usage = {};

    if (skipStage1 && existingRow.stage1 && existingRow.recommendation !== 'PENDING') {
      stage1         = existingRow.stage1;
      recommendation = existingRow.recommendation;
      fitScore       = existingRow.fit_score;
      console.log(`[bg] Skipping Stage 1 — using cached: ${recommendation} ${fitScore}`);
    } else {
      console.log('[bg] Running Stage 1…');
      const stage1User = `${profileBlock}\n\n${oppBlock}\n\n${STAGE1_SCHEMA}`;
      try {
        const r1   = await callClaudeWithRetry(STAGE1_SYSTEM, stage1User, 1200);
        stage1     = r1.parsed;
        s1Usage    = r1.usage;
        recommendation = stage1.recommendation || 'NO_BID';
        fitScore       = stage1.fit_score || 0;
        console.log(`[bg] Stage 1 complete: ${recommendation} ${fitScore} (${s1Usage.input_tokens}in/${s1Usage.output_tokens}out)`);
      } catch (err) {
        console.error('[bg] Stage 1 failed:', err.message || err);
        await sbPatch(markFilter, { status: 'failed', stage1: { error: String(err.message || err) } });
        return { statusCode: 200, body: 'stage1 failed' };
      }

      // Persist Stage 1
      await sbPatch(markFilter, {
        stage1,
        recommendation,
        fit_score:    fitScore,
        input_tokens: s1Usage.input_tokens || 0,
        output_tokens: s1Usage.output_tokens || 0,
        status:       'stage1_complete',
      });
    }

    // ── Stage 2 gate ─────────────────────────────────────────────────────────
    const runStage2 = deep || recommendation === 'BID' || recommendation === 'CONDITIONAL';
    if (!runStage2) {
      await sbPatch(markFilter, { status: 'complete' });
      console.log('[bg] Stage 2 skipped (NO_BID, deep=false). Done.');
      return { statusCode: 200, body: 'complete' };
    }

    console.log('[bg] Running Stage 2…');
    const stage2User = `${profileBlock}\n\n${oppBlock}\n\nSTAGE 1 ANALYSIS:\n${JSON.stringify(stage1, null, 2)}\n\n${STAGE2_SCHEMA}`;
    let stage2, s2Usage = {};
    try {
      const r2 = await callClaudeWithRetry(STAGE2_SYSTEM, stage2User, 3000);
      stage2   = r2.parsed;
      s2Usage  = r2.usage;
      console.log(`[bg] Stage 2 complete (${s2Usage.input_tokens}in/${s2Usage.output_tokens}out)`);
    } catch (err) {
      // Stage 2 failure → mark complete with stage2=null, log error
      console.error('[bg] Stage 2 failed (non-fatal):', err.message || err);
      await sbPatch(markFilter, {
        status:        'complete',
        input_tokens:  (existingRow.input_tokens || s1Usage.input_tokens || 0),
        output_tokens: (existingRow.output_tokens || s1Usage.output_tokens || 0),
      });
      return { statusCode: 200, body: 'complete (stage2 failed)' };
    }

    await sbPatch(markFilter, {
      stage2,
      status:        'complete',
      input_tokens:  (s1Usage.input_tokens  || 0) + (s2Usage.input_tokens  || 0),
      output_tokens: (s1Usage.output_tokens || 0) + (s2Usage.output_tokens || 0),
    });

    console.log(`[bg] All done. rowId=${rowId}`);
    return { statusCode: 200, body: 'complete' };

  } catch (err) {
    console.error('[bg] Fatal error:', err.message || err);
    try {
      await sbPatch(markFilter, { status: 'failed', stage1: { error: String(err.message || err) } });
    } catch { /* ignore secondary failure */ }
    return { statusCode: 200, body: 'failed' };
  }
};
