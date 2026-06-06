// client-pipeline.js
// Pulls live SAM.gov contract opportunities for a client's NAICS codes.
// GET ?uei=C13JZV6AY6L4&days=90
// Returns opportunities sorted by response deadline ascending.
'use strict';

const OPP_URL = 'https://api.sam.gov/opportunities/v2/search';
const PAGE_LIMIT = 100;

// NAICS code map — add clients here
const CLIENT_NAICS = {
  'C13JZV6AY6L4': {              // Custom IT Services LLC
    name: 'CUSTOM IT SERVICES LLC',
    naics: ['541519','541511','541512','541513','541990','541690','541370'],
  },
  'YVNXN3XBUSD5': {              // Apropos Group LLC
    name: 'Apropos Group LLC',
    naics: ['541512','541519','541511','518210','561421','561499'],
  },
};

function mmddyyyy(d) {
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function daysUntil(deadline) {
  if (!deadline) return null;
  const ms = new Date(deadline) - new Date();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function urgencyClass(days) {
  if (days === null) return 'none';
  if (days <= 7)  return 'hot';
  if (days <= 30) return 'warm';
  return 'ok';
}

async function fetchOpps(naics, postedFrom, postedTo) {
  const url = new URL(OPP_URL);
  url.searchParams.set('api_key', process.env.SAM_API_KEY);
  url.searchParams.set('postedFrom', postedFrom);
  url.searchParams.set('postedTo', postedTo);
  url.searchParams.set('ncode', naics);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('offset', '0');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SAM opp ${res.status} (${naics})`);
  const data = await res.json();
  return data.opportunitiesData || [];
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const uei           = (event.queryStringParameters || {}).uei || 'C13JZV6AY6L4';
  const includeClosed = (event.queryStringParameters || {}).include_closed === '1';
  // days=0 means "All Open" — use 365-day window to capture everything still active.
  // days=30 means "Posted within 30 days".
  const rawDays = parseInt((event.queryStringParameters || {}).days || '0', 10);
  const days    = rawDays === 0 ? 365 : rawDays;

  const client = CLIENT_NAICS[uei];
  if (!client) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Client not found' }) };

  if (!process.env.SAM_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SAM_API_KEY not set' }) };

  const now  = new Date();
  const from = new Date(now); from.setDate(from.getDate() - days);
  const postedFrom = mmddyyyy(from);
  const postedTo   = mmddyyyy(now);

  // Fetch across all client NAICS codes
  const seen = new Map();
  for (const naics of client.naics) {
    try {
      const opps = await fetchOpps(naics, postedFrom, postedTo);
      for (const o of opps) {
        if (o.noticeId && !seen.has(o.noticeId)) seen.set(o.noticeId, o);
      }
    } catch (e) {
      console.error(e.message);
    }
  }

  const mapped = [...seen.values()].map(o => {
    const days_left = daysUntil(o.responseDeadLine);
    return {
      notice_id:    o.noticeId,
      title:        o.title,
      agency:       o.fullParentPathName,
      type:         o.type,
      naics:        o.naicsCode,
      set_aside:    o.typeOfSetAsideDescription || o.setAside || 'None',
      posted_date:  o.postedDate,
      deadline:     o.responseDeadLine,
      days_left,
      urgency:      urgencyClass(days_left),
      url:          o.uiLink || `https://sam.gov/opp/${o.noticeId}/view`,
    };
  });

  // Active = has a deadline AND that deadline is today or future.
  // Pass ?include_closed=1 to see everything including expired/no-deadline.
  const results = mapped
    .filter(o => includeClosed || (o.days_left !== null && o.days_left >= 0))
    .sort((a, b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      client: { uei, name: client.name, naics: client.naics },
      window_days: days,
      total: results.length,
      opportunities: results,
    }),
  };
};
