'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;

function sbH() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

function extractDomain(websiteUrl, legalName) {
  if (websiteUrl) {
    try {
      const url = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
      return url.hostname.replace(/^www\./, '');
    } catch (e) {
      // fall through to name-based
    }
  }
  if (legalName) {
    return legalName
      .toLowerCase()
      .replace(/\b(llc|inc|corp|company|co|ltd|group|services|solutions|consulting|technologies|tech)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim() + '.com';
  }
  return null;
}

exports.handler = async function (event, context) {
  try {
    // 1. Get contractors pending enrichment
    const pendingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contractors?enrichment_status=eq.pending&select=id,legal_name,website_url&limit=50`,
      { headers: sbH() }
    );
    if (!pendingRes.ok) {
      const err = await pendingRes.text();
      throw new Error(`Failed to fetch pending contractors: ${err}`);
    }
    const contractors = await pendingRes.json();

    let processed = 0;
    let enriched = 0;
    let skipped = 0;
    let emailsFound = 0;

    for (const contractor of contractors) {
      processed++;
      const domain = extractDomain(contractor.website_url, contractor.legal_name);

      if (!domain) {
        // Mark as skipped
        await fetch(
          `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor.id)}`,
          {
            method: 'PATCH',
            headers: sbH(),
            body: JSON.stringify({ enrichment_status: 'skipped' })
          }
        );
        skipped++;
        continue;
      }

      // 2. Call Hunter.io Domain Search
      let hunterData;
      try {
        const hunterUrl = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&company=${encodeURIComponent(contractor.legal_name || '')}&api_key=${HUNTER_API_KEY}`;
        const hunterRes = await fetch(hunterUrl);
        if (!hunterRes.ok) {
          throw new Error(`Hunter API error: ${hunterRes.status}`);
        }
        hunterData = await hunterRes.json();
      } catch (hunterErr) {
        console.error(`Hunter error for ${contractor.id}:`, hunterErr.message);
        await fetch(
          `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor.id)}`,
          {
            method: 'PATCH',
            headers: sbH(),
            body: JSON.stringify({ enrichment_status: 'skipped' })
          }
        );
        skipped++;
        continue;
      }

      const emails = (hunterData.data && hunterData.data.emails) || [];
      const highConfidence = emails.filter(e => (e.confidence || 0) >= 70);

      if (highConfidence.length === 0) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor.id)}`,
          {
            method: 'PATCH',
            headers: sbH(),
            body: JSON.stringify({ enrichment_status: 'skipped' })
          }
        );
        skipped++;
        continue;
      }

      // 3. Upsert contacts
      const contacts = highConfidence.map(e => ({
        contractor_id: contractor.id,
        email: e.value,
        first_name: e.first_name || null,
        last_name: e.last_name || null,
        title: e.position || null,
        confidence_score: e.confidence || null,
        source: 'hunter'
      }));

      const upsertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/contractor_contacts`,
        {
          method: 'POST',
          headers: {
            ...sbH(),
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(contacts)
        }
      );

      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        console.error(`Contact upsert error for ${contractor.id}:`, errText);
      } else {
        emailsFound += contacts.length;
      }

      // 4. Update contractor enrichment_status
      await fetch(
        `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor.id)}`,
        {
          method: 'PATCH',
          headers: sbH(),
          body: JSON.stringify({ enrichment_status: 'enriched' })
        }
      );
      enriched++;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, processed, enriched, skipped, emailsFound })
    };
  } catch (err) {
    console.error('enricher-hunter error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
