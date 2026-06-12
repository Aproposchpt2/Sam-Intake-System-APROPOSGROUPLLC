# FlowDesk Pro Reuse Map for Intake Engine MVP

Source archive:
C:\Users\Jeff\Desktop\AI WEBSITES\_FLOWDESKPRO_WEBSITE.zip

Review copy:
C:\Users\Jeff\Documents\Codex\2026-05-08\files-mentioned-by-the-user-ai4\flowdeskpro-review\_FLOWDESKPRO_WEBSITE

## Strong Reuse Candidates

### 1. netlify/functions/submit.js
Reusable for: web intake submissions, email alert templates, lead normalization, bilingual confirmation emails.
Useful pieces:
- normalizeLead(raw)
- normalizeUrgency(value)
- normalizeIndustry(value)
- generateLeadId()
- buildInternalAlertHtml(lead)
- buildInternalAlertText(lead)
- buildConfirmationHtml(lead)
- buildConfirmationText(lead)
- Resend notification pattern

Fit for new Intake Engine:
This is the closest backend match to the new model. It already understands multiple input sources and normalizes lead/contact data.

Caution:
It currently sends Resend emails and assumes production environment variables. Do not wire into MVP prototype until explicitly moving from local prototype to connected workflow.

### 2. netlify/functions/demo-request.js
Reusable for: form validation, phone normalization, ref slug generation, Supabase insert pattern.
Useful pieces:
- required-field validation pattern
- normalizedPhone = phone.replace(/\D/g, '').slice(-10)
- refSlug from business name
- supabaseInsert(url, key, table, record)
- owner notification email pattern

Fit for new Intake Engine:
Good template for a future /intake-request function that saves records to Supabase.

Caution:
This is specific to demo_requests and personalized demo links. The table and response object should be redesigned for intake_records or flowdesk_intake_records.

### 3. dashboard.html
Reusable for: future FlowDesk Lead Manager dashboard UI.
Useful pieces:
- Overview tab layout
- Leads tab table
- Call logs tab
- usage cards
- real-time Supabase subscription pattern
- mark-resolved workflow

Fit for new Intake Engine:
Strong foundation for the second prototype: a dashboard list view where multiple intake records are sortable/filterable.

Caution:
It is React/Babel-in-browser and currently connected to Supabase config/auth functions. For a prototype, extract the UI pattern only and keep local mock records.

### 4. demo-dashboard.html
Reusable for: lightweight portfolio/demo dashboard.
Useful pieces:
- compact stat cards
- lead-card layout
- waiting state
- live/demo lead list structure

Fit for new Intake Engine:
Best source for a simple, portfolio-ready dashboard preview. Less complex than dashboard.html.

Caution:
It fetches Supabase config and live leads. For the isolated prototype, keep only visual/card patterns.

### 5. ai-voice-attendant-v2.html
Reusable for: product narrative, visual style, voice-attendant model language.
Useful pieces:
- refined AI Voice Attendant positioning
- call flow explanation
- structured lead record language
- instant alert story
- industry use case cards

Fit for new Intake Engine:
Use as copy/positioning reference for the FlowDesk model library.

Caution:
Marketing page only. It does not contain the backend voice logic.

### 6. ai-helpdesk-intake.html
Reusable for: service-ticket intake model content.
Useful pieces:
- support/service request categories
- urgency and emergency framing
- dispatch-ready ticket language
- service business use cases

Fit for new Intake Engine:
Good source for a specialized future template: AI System Support Intake.

### 7. ai-contact-center.html
Reusable for: future AI Contact Center model.
Useful pieces:
- multi-line/multi-location positioning
- routing concepts
- dashboard and CRM integration language
- after-hours coverage language

Fit for new Intake Engine:
Useful for the roadmap and contact center product model, not the first intake MVP.

### 8. netlify/functions/call.js
Reusable for: AI Voice Attendant V2 and call-to-lead pipeline.
Useful pieces:
- Twilio webhook parsing
- TwiML gather/confirmation flow
- call transcript to lead extraction
- Supabase leads/call_logs writes
- missed call email alert
- urgent SMS alert path
- demo lookup by caller phone

Fit for new Intake Engine:
This is the future bridge between voice calls and the intake record model.

Caution:
It is production-style backend code using Anthropic, Twilio, Supabase, and Resend. Do not merge into the isolated intake MVP. Refactor later into smaller shared modules before production reuse.

## Recommended New Model Mapping

### FlowDesk Intake Engine MVP
Current artifact:
flowdesk-intake-engine.html

Reuse now:
- Visual/product language from ai-helpdesk-intake.html and ai-voice-attendant-v2.html.
- Local dashboard card concepts from demo-dashboard.html.
- Data structure naming inspired by submit.js normalizeLead().

Do not reuse yet:
- call.js live Twilio/Claude pipeline
- submit.js live Resend notification
- dashboard.html live Supabase auth/realtime code
- stripe-webhook.js payment logic

### FlowDesk Lead Manager
Future model should reuse:
- dashboard.html tabs and table structure
- demo-dashboard.html compact lead cards
- submit.js lead status/urgency email semantics

### AI Voice Attendant V2
Future model should reuse:
- call.js Twilio webhook/TwiML flow
- call.js transcript-to-lead extraction pattern
- ai-voice-attendant-v2.html product narrative

### AI Contact Center
Future model should reuse:
- ai-contact-center.html product language
- dashboard.html multi-client/agency concept
- call.js call logging patterns

## Suggested Next Step
Create a second isolated prototype:
flowdesk-lead-manager-dashboard.html

It should use local mock records first, with no Supabase or live auth. Then, once approved, promote the intake prototype and dashboard prototype into a connected Supabase model using a new table such as flowdesk_intake_records.
