'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const NAICS_DESCRIPTIONS = {
  '541519': 'IT and Computer Services',
  '541512': 'Computer Systems Design',
  '541511': 'Custom Computer Programming',
  '541611': 'Administrative Management and General Management Consulting',
  '561210': 'Facilities Support Services'
};

function sbH() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

exports.handler = async function (event, context) {
  try {
    // 1. Get contacts ready for outreach
    const query = [
      'contractor_contacts?select=id,email,first_name,last_name,title,contractor_id,contractors(id,legal_name,primary_naics,naics_codes,address_city,address_state)',
      'contractors.enrichment_status=eq.enriched',
      'contractors.outreach_status=eq.pending',
      'limit=20'
    ].join('&');

    const contactsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/${query}`,
      { headers: sbH() }
    );
    if (!contactsRes.ok) {
      const err = await contactsRes.text();
      throw new Error(`Failed to fetch contacts: ${err}`);
    }
    const contacts = await contactsRes.json();

    let processed = 0;
    let drafted = 0;
    let errors = 0;

    for (const contact of contacts) {
      processed++;
      const contractor = contact.contractors;
      if (!contractor) { errors++; continue; }

      const naicsCode = contractor.primary_naics || (contractor.naics_codes && contractor.naics_codes[0]) || 'N/A';
      const naicsDesc = NAICS_DESCRIPTIONS[naicsCode] || 'Government Contracting';
      const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'there';
      const companyName = contractor.legal_name || 'your company';
      const location = [contractor.address_city, contractor.address_state].filter(Boolean).join(', ') || '';

      // 2. Call Claude API for personalized email
      let subject, body;
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [
              {
                role: 'user',
                content: `You are an outreach specialist for CapGen, an AI tool that generates professional federal contractor capability statements in minutes.

Write a personalized cold email to ${contactName} at ${companyName}${location ? ' in ' + location : ''}, which is registered in NAICS ${naicsCode} (${naicsDesc}).

Requirements:
- Subject line: under 50 characters
- Email body: 120-150 words
- Be specific to their industry (${naicsDesc})
- Mention CapGen helps federal contractors create SAM.gov-verified capability statements quickly
- CTA: try CapGen free at capgen.aproposgroupllc.com
- Professional, warm tone — not spammy

Return ONLY valid JSON with this exact structure:
{"subject": "...", "body": "..."}`
              }
            ]
          })
        });

        if (!claudeRes.ok) {
          const errText = await claudeRes.text();
          throw new Error(`Claude API error: ${claudeRes.status} - ${errText}`);
        }

        const claudeData = await claudeRes.json();
        const rawContent = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
        if (!rawContent) throw new Error('No content from Claude');

        // Parse JSON from Claude response
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in Claude response');
        const parsed = JSON.parse(jsonMatch[0]);
        subject = parsed.subject;
        body = parsed.body;

        if (!subject || !body) throw new Error('Missing subject or body in Claude response');
      } catch (claudeErr) {
        console.error(`Claude error for contact ${contact.id}:`, claudeErr.message);
        errors++;
        continue;
      }

      // 3. Insert into email_batch
      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/email_batch`,
        {
          method: 'POST',
          headers: {
            ...sbH(),
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            contractor_id: contact.contractor_id,
            contact_id: contact.id,
            to_email: contact.email,
            to_name: contactName,
            subject,
            body,
            status: 'draft'
          })
        }
      );

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        console.error(`email_batch insert error for contact ${contact.id}:`, errText);
        errors++;
        continue;
      }

      // 4. Update contractor outreach_status to 'queued'
      await fetch(
        `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contact.contractor_id)}`,
        {
          method: 'PATCH',
          headers: sbH(),
          body: JSON.stringify({ outreach_status: 'queued' })
        }
      );

      drafted++;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, processed, drafted, errors })
    };
  } catch (err) {
    console.error('personalizer error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
