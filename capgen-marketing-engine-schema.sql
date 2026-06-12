-- CapGen Marketing Engine Schema
-- Creates 5 tables and 1 view for the full email outreach pipeline

-- 1. contractors
CREATE TABLE IF NOT EXISTS contractors (
  id TEXT PRIMARY KEY,                          -- UEI
  legal_name TEXT,
  doing_business_as TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,
  naics_codes TEXT[],
  primary_naics TEXT,
  business_type TEXT,
  sam_status TEXT,
  registration_date TIMESTAMPTZ,
  website_url TEXT,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  enrichment_status TEXT DEFAULT 'pending',
  outreach_status TEXT DEFAULT 'pending'
);

-- 2. contractor_contacts
CREATE TABLE IF NOT EXISTS contractor_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id TEXT REFERENCES contractors(id) ON DELETE CASCADE,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  confidence_score INTEGER,
  source TEXT DEFAULT 'hunter',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contractor_id, email)
);

-- 3. email_campaigns
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  naics_codes TEXT[],
  subject_template TEXT,
  body_template TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. email_batch
CREATE TABLE IF NOT EXISTS email_batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id TEXT REFERENCES contractors(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contractor_contacts(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES email_campaigns(id) ON DELETE SET NULL,
  to_email TEXT,
  to_name TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'draft',
  resend_message_id TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. email_tracking
CREATE TABLE IF NOT EXISTS email_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_batch_id UUID REFERENCES email_batch(id) ON DELETE CASCADE,
  resend_message_id TEXT,
  event_type TEXT,
  event_data JSONB,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_contractors_enrichment ON contractors(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_contractors_outreach ON contractors(outreach_status);
CREATE INDEX IF NOT EXISTS idx_email_batch_status ON email_batch(status);
CREATE INDEX IF NOT EXISTS idx_email_batch_resend_id ON email_batch(resend_message_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_batch ON email_tracking(email_batch_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_resend ON email_tracking(resend_message_id);

-- 6. VIEW: warm_leads
-- Contractors who have opens or clicks from email_tracking
CREATE OR REPLACE VIEW warm_leads AS
SELECT
  c.id AS contractor_id,
  c.legal_name,
  c.primary_naics,
  c.naics_codes,
  c.address_city,
  c.address_state,
  cc.email AS contact_email,
  cc.first_name,
  cc.last_name,
  cc.title,
  MAX(et.occurred_at) AS last_engagement,
  COUNT(CASE WHEN et.event_type = 'email.opened' THEN 1 END) AS open_count,
  COUNT(CASE WHEN et.event_type = 'email.clicked' THEN 1 END) AS click_count
FROM contractors c
JOIN email_batch eb ON eb.contractor_id = c.id
JOIN contractor_contacts cc ON cc.id = eb.contact_id
JOIN email_tracking et ON et.email_batch_id = eb.id
WHERE et.event_type IN ('email.opened', 'email.clicked')
GROUP BY
  c.id, c.legal_name, c.primary_naics, c.naics_codes,
  c.address_city, c.address_state,
  cc.email, cc.first_name, cc.last_name, cc.title
HAVING
  COUNT(CASE WHEN et.event_type IN ('email.opened', 'email.clicked') THEN 1 END) > 0;
