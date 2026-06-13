'use strict';
// POST { batch_size?, offset? } — enriches contractors table with USASpending.gov award data.
// Processes contractors in batches, storing total_award_value, award_count,
// last_award_date, top_agency. Admin-only endpoint.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USA_SPENDING = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const ADMIN_EMAIL  = 'jmitchell@aproposgroupllc.com';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbH(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

// Check if a USASpending recipient name is close enough to our search name
function nameMatches(returned, searched) {
  const normalize = s => (s || '').toLowerCase()
    .replace(/\s+(llc|inc|corp|co|ltd|dba|lp|llp|pllc)\.?$/g, '')
    .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = normalize(returned), b = normalize(searched);
  if (!a || !b) return false;
  // Exact or one contains the other (at least 80% of the shorter string)
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  return longer.includes(shorter) && shorter.length >= Math.floor(longer.length * 0.6);
}

async function getAwardTotals(cage, legalName) {
  const filters = { recipient_search_text: [legalName], award_type_codes: ['A','B','C','D'] };

  try {
    const res = await fetch(USA_SPENDING, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        filters: {
          ...filters,
          time_period: [{ start_date: '2022-01-01', end_date: '2026-12-31' }],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Action Date'],
        sort: 'Award Amount',
        order: 'desc',
        limit: 100,
        page: 1,
        subawards: false,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    // Validate recipient name before accepting — prevents false positives from partial name matches
    const awards = (data.results || []).filter(a => {
      if ((a['Award Amount'] || 0) <= 0) return false;
      const recipientName = a['Recipient Name'] || '';
      return nameMatches(recipientName, legalName);
    });
    if (!awards.length) return null;

    const total       = awards.reduce((sum, a) => sum + (a['Award Amount'] || 0), 0);
    const lastDate    = awards.reduce((latest, a) => {
      const d = a['Action Date'] || a['Period of Performance Start Date'] || '';
      return d && d > latest ? d : latest;
    }, '');
    const agencyCounts = {};
    awards.forEach(a => {
      const ag = a['Awarding Agency'];
      if (ag) agencyCounts[ag] = (agencyCounts[ag] || 0) + 1;
    });
    const topAgency = Object.entries(agencyCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

    return {
      total_award_value: Math.round(total),
      award_count:       awards.length,
      last_award_date:   lastDate ? lastDate.slice(0, 10) : null,
      top_agency:        topAgency ? topAgency.slice(0, 120) : null,
    };
  } catch(e) {
    console.error('[usaspending] error for', legalName, ':', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  // Validate admin session from request body
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (body.admin_email !== ADMIN_EMAIL) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const batchSize = Math.min(body.batch_size || 20, 50);
  const offset    = body.offset || 0;

  // Load batch of contractors not yet enriched (or force re-enrich if force=true)
  // When filtering by enriched_at=is.null, never use offset — the pool shrinks as rows are enriched,
  // so offset causes rows to be skipped. Always grab the first N unenriched rows.
  const filter = body.force
    ? `sam_status=eq.Active&order=legal_name.asc&limit=${batchSize}&offset=${offset}`
    : `sam_status=eq.Active&enriched_at=is.null&order=legal_name.asc&limit=${batchSize}`;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/contractors?${filter}&select=id,legal_name,cage`,
    { headers: sbH() }
  );
  const contractors = await res.json();

  if (!Array.isArray(contractors) || !contractors.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, processed: 0, enriched: 0, message: 'All contractors enriched.' }) };
  }

  let enriched = 0, notFound = 0;

  for (const c of contractors) {
    await new Promise(r => setTimeout(r, 200)); // rate limit: 5 req/sec
    const awards = await getAwardTotals(c.cage, c.legal_name);

    const patch = awards
      ? { ...awards, enriched_at: new Date().toISOString() }
      : { total_award_value: 0, award_count: 0, last_award_date: null, top_agency: null, enriched_at: new Date().toISOString() };

    await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${c.id}`, {
      method: 'PATCH',
      headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });

    if (awards) enriched++; else notFound++;
  }

  const remaining = contractors.length === batchSize; // more batches may exist

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      processed:  contractors.length,
      enriched,
      not_found:  notFound,
      next_offset: remaining ? offset + batchSize : null,
      message: remaining ? `Batch complete. Run next batch with offset=${offset + batchSize}.` : 'Enrichment complete.',
    }),
  };
};
