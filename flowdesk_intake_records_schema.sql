-- FlowDesk Pro Step 3: Supabase schema planning
-- Table: public.flowdesk_intake_records
-- Purpose: Store intake form submissions that power the FlowDesk Lead Manager.
-- Status: planning SQL only. Review before running in Supabase.

create extension if not exists pgcrypto;

create table if not exists public.flowdesk_intake_records (
  id uuid primary key default gen_random_uuid(),
  intake_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  full_name text not null,
  email text not null,
  phone text,
  business_name text not null,
  industry text,

  request_type text,
  service_needed text,
  urgency text not null default 'Normal',
  preferred_contact_method text,
  preferred_callback_time text,
  sms_consent boolean not null default false,
  sms_consent_text text,

  details text not null,
  notes text,
  internal_notes text,

  ai_summary text,
  category text,
  lead_status text not null default 'New / Needs Review',
  follow_up_needed boolean not null default true,
  next_action text,

  source_page text default 'flowdesk-intake-engine',
  assigned_to text,
  last_contacted_at timestamptz,
  closed_at timestamptz,

  constraint flowdesk_intake_records_email_check
    check (position('@' in email) > 1),
  constraint flowdesk_intake_records_urgency_check
    check (urgency in ('Low', 'Normal', 'Time-sensitive', 'Urgent')),
  constraint flowdesk_intake_records_status_check
    check (lead_status in ('New / Needs Review', 'New / Priority Review', 'In Progress', 'Closed / Resolved'))
);

create index if not exists flowdesk_intake_records_created_at_idx
  on public.flowdesk_intake_records (created_at desc);

create index if not exists flowdesk_intake_records_lead_status_idx
  on public.flowdesk_intake_records (lead_status);

create index if not exists flowdesk_intake_records_category_idx
  on public.flowdesk_intake_records (category);

create index if not exists flowdesk_intake_records_email_idx
  on public.flowdesk_intake_records (lower(email));

create or replace function public.set_flowdesk_intake_records_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_flowdesk_intake_records_updated_at
  on public.flowdesk_intake_records;

create trigger set_flowdesk_intake_records_updated_at
before update on public.flowdesk_intake_records
for each row
execute function public.set_flowdesk_intake_records_updated_at();

-- RLS planning:
-- 1. Keep RLS enabled before production use.
-- 2. Do not expose the service role key in browser code.
-- 3. Use Netlify Functions for inserts/updates once connected.
-- 4. Public browser inserts should only be allowed through a server-side function.

alter table public.flowdesk_intake_records enable row level security;

-- Example admin/service policy placeholder.
-- Supabase service role bypasses RLS from trusted server-side code.
-- Add authenticated dashboard policies only when login/auth is introduced.
