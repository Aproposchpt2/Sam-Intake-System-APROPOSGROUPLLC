-- FlowDesk Pro SMS consent fields
-- Run this once in Supabase SQL Editor after the original flowdesk_intake_records table exists.

alter table public.flowdesk_intake_records
  add column if not exists sms_consent boolean not null default false,
  add column if not exists sms_consent_text text;
