'use strict';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const COMPANY = [
  'Apropos Group LLC | UEI: YVNXN3XBUSD5 | CAGE: 20UQ1',
  'Type: Small Business + WOSB (Women-Owned Small Business)',
  'Location: North Las Vegas, NV',
  'Primary NAICS: 541512 (Computer Systems Design)',
  'Also registered: 541519 (Other IT Services), 541511 (Custom Programming),',
  '                 541611 (Management Consulting), 561210 (Facilities Support)',
  'Core services: IT consulting, custom software development, computer systems',
  '               design and integration, administrative management consulting,',
  '               facilities support services'
].join('\n');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  var opp;
  try { opp = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  if (!opp.title) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing opportunity title' }) };

  var deadlineStr = opp.deadline || 'Not specified';
  if (opp.days_left != null) deadlineStr += ' (' + opp.days_left + ' days remaining)';

  var prompt = 'You are a federal contracting bid/no-bid analyst. Evaluate this opportunity for Apropos Group LLC.\n\n'
    + 'COMPANY PROFILE:\n' + COMPANY + '\n\n'
    + 'OPPORTUNITY:\n'
    + 'Title: ' + opp.title + '\n'
    + 'Agency: ' + (opp.agency || 'Unknown') + '\n'
    + 'Type: ' + (opp.type || 'Unknown') + '\n'
    + 'NAICS Code: ' + (opp.naics || 'Not specified') + '\n'
    + 'Set-Aside: ' + (opp.set_aside || 'Unrestricted') + '\n'
    + 'Deadline: ' + deadlineStr + '\n\n'
    + 'Respond with ONLY valid JSON in this exact structure (no markdown, no explanation):\n'
    + '{\n'
    + '  "fit_score": <integer 0-100>,\n'
    + '  "recommendation": "<BID|CONSIDER|PASS>",\n'
    + '  "naics_match": "<one sentence on how the NAICS aligns with Apropos capabilities>",\n'
    + '  "key_requirements": ["<requirement 1>", "<requirement 2>", "<requirement 3>"],\n'
    + '  "advantages": ["<Apropos advantage 1>", "<Apropos advantage 2>"],\n'
    + '  "watch_outs": ["<risk or gap 1>", "<risk or gap 2>"],\n'
    + '  "checklist": ["<bid prep step 1>", "<bid prep step 2>", "<bid prep step 3>", "<bid prep step 4>", "<bid prep step 5>"],\n'
    + '  "bottom_line": "<2 sentences: fit assessment and recommended action>"\n'
    + '}';

  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 650,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      var errText = await res.text();
      throw new Error('Claude API ' + res.status + ': ' + errText.slice(0, 150));
    }

    var claude = await res.json();
    var text = (claude.content && claude.content[0] && claude.content[0].text) || '';
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Claude response: ' + text.slice(0, 100));

    var analysis = JSON.parse(match[0]);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: true, analysis: analysis })
    };

  } catch(err) {
    console.error('[analyze-fit]', err.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
