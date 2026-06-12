# FlowDesk Pro A2P 10DLC Remediation Notes

## Scope

Twilio A2P 10DLC compliance remediation for FlowDesk Pro public website pages and visible SMS opt-in flow.

## Files Created

- `sms-consent.html`
- `sandbox-a2p-remediation-notes.md`

## Files Updated

- `privacy.html`
- `terms.html`
- `index.html`
- `flowdesk-intake-engine.html`
- `flowdesk-intake-engine-product.html`
- `flowdesk-lead-manager-dashboard.html`
- `netlify.toml`

## Consent Path

The public intake form includes an optional SMS checkbox. The checkbox is not pre-checked. The visible consent text states:

- transactional SMS notifications
- message frequency varies
- message/data rates may apply
- STOP opt-out
- HELP help
- consent is not required for purchase, account creation, or primary service use
- links to Privacy Policy, Terms & Conditions, and SMS Consent / Messaging Terms

## Backend Notes

No database schema migration was applied. The existing intake submission flow already supports `sms_consent` and `sms_consent_text`, with fallback behavior if those columns are not present.

## Live Deployment Checklist

After deployment, verify:

- `/privacy.html`
- `/terms.html`
- `/sms-consent.html`
- `/flowdesk-intake-engine.html`
- optional SMS checkbox is visible and unchecked
- intake submission still saves
- Resend notification still sends
- Lead Manager still loads records
