# SulatHQ — custom-domain email

SulatHQ is a self-service custom-domain email application: add a domain you own, verify it, create addresses, then send and receive mail from one account.

## Architecture

- Cloudflare Email Routing sends inbound mail to the email Worker.
- The Worker parses MIME messages, stores metadata in Supabase Postgres, and stores raw messages/attachments in a private Backblaze B2 bucket.
- Supabase Auth provides the application session and Row Level Security protects direct database access.
- Brevo sends outbound messages and can call the webhook endpoint with delivery events.
- The same Worker serves the built responsive web app through Cloudflare Workers Assets.

## Local development

1. Copy `.env.example` to `.env.local` and set the two `VITE_` values.
2. Run `npm install`.
3. Run `npm run dev`.

The full server requires the Worker secrets in `wrangler secret` or the Cloudflare dashboard. Never put service keys, Brevo keys, or Backblaze application keys in `VITE_` variables.

## Supabase setup

Run `supabase/migrations/202608250001_initial.sql`, followed by
`supabase/migrations/202608250002_outlook_features.sql` and
`supabase/migrations/20260825133332_capability_foundation.sql` and
`supabase/migrations/20260825140219_sender_identity.sql` in the Supabase
SQL Editor. The second migration adds custom folders, labels, contacts, rules,
signatures, automatic replies, calendar events, tasks, mailbox membership,
integrations, spam feedback, full-text search, threading metadata, scheduled
send, snooze, message flags, and owner-based RLS policies. The capability
foundation adds durable audit records, rule-run metadata, outbox/idempotency
fields, trust and attachment evidence, sender policies, saved searches,
address profiles, collaboration records, push devices, domain checks, and
explicit RLS boundaries for the next application updates. The sender identity
migration preserves display names from incoming `From` headers and adds
optional HTTPS contact avatars.

## Worker secrets

Configure these as Cloudflare Worker secrets:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
BREVO_API_KEY
B2_ENDPOINT
B2_REGION
B2_KEY_ID
B2_APPLICATION_KEY
B2_BUCKET
OWNER_USER_ID
INBOUND_SHARED_SECRET
BREVO_WEBHOOK_SECRET
INTERNAL_TEST_TOKEN
OUTLOOK_FORWARD_TO (optional)
```

The Backblaze bucket should be private. The application uses short-lived signed URLs for attachment downloads and Brevo attachment fetches.

## Routes

- `/api/health` — configuration health check
- `/api/mailboxes` — mailbox list and mailbox settings
- `/api/mail` and `/api/mail/:id` — search, folders, filters, message detail, flags, snooze, spam feedback, and soft-delete state
- `/api/threads/:id` — conversation view
- `/api/folders`, `/api/labels`, `/api/labels/assign` — custom folders and colored labels
- `/api/contacts` — contacts and autocomplete data
- `/api/sender-policies` — trusted and blocked sender/domain decisions
- `/api/rules` — sender/subject/body/attachment rules and actions
- `/api/signatures` — per-mailbox signatures
- `/api/settings` — theme, density, reading pane, notification, timezone, and push settings
- `/api/calendar` — calendar events and attendees
- `/api/tasks` — linked To Do tasks
- `/api/auto-replies` — vacation-response configuration
- `/api/integrations` — provider connection metadata
- `/api/drafts` — autosaved drafts
- `/api/send` — authenticated Brevo send with threading, CC/BCC, attachments, and scheduled send
- `/api/attachments` — private B2 upload and signed download URLs
- `/api/webhooks/brevo` — delivery-status callback
- `/api/internal/send-test` — secret-protected smoke test only

## Current feature boundaries

The application implements the mail workflow, local spam scoring, static
attachment safety checks, custom organization, scheduled send, snooze, PWA
shell, polling, and optional Supabase Realtime updates. Provider-specific
Google/Microsoft calendar, OneDrive, Teams, AI, push delivery, and third-party
antivirus scanning still require provider credentials or a separately operated
service; the UI exposes these as integration points rather than pretending they
are connected.
