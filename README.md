# SulatHQ — custom-domain email

SulatHQ is a self-service custom-domain email application: add a domain you own, verify it, create addresses, then send and receive mail from one account. Existing owner-scoped APIs remain compatible. New self-service tenants use organizations, verified domains, and mailboxes created on those domains.

## Architecture

- Cloudflare Email Routing sends inbound mail to the email Worker.
- The Worker parses MIME messages, stores metadata in Supabase Postgres, and stores raw messages/attachments in a private Backblaze B2 bucket.
- Supabase Auth provides the application session and Row Level Security protects direct database access.
- Organizations and memberships isolate tenants. Domains stay pending until DNS matches.
- Brevo sends outbound messages through an internal `MailTransport` adapter and can call the webhook endpoint with delivery events.
- The same Worker serves the built responsive web app through Cloudflare Workers Assets.

Shared frontend/platform types live in `src/contracts/platform.ts`.

## Local development

1. Copy `.env.example` to `.env.local` and set the two `VITE_` values.
2. Run `npm install`.
3. Run `npm run dev`.

The full server requires the Worker secrets in `wrangler secret` or the Cloudflare dashboard. Never put service keys, Brevo keys, or Backblaze application keys in `VITE_` variables.

## Supabase setup

Apply every file in `supabase/migrations/` in timestamp order, including
`20260828124700_platform_tenancy.sql`. That migration adds organizations,
memberships, domains, jobs, MFA setup rows, mailbox events, and RLS. Do not
edit migrations that have already been applied.

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
CF_API_TOKEN (optional)
CF_ACCOUNT_ID (optional)
```

The Backblaze bucket should be private. The application uses short-lived signed URLs for attachment downloads and Brevo attachment fetches.

## Routes

- `/api/health` — configuration health check
- `/api/me` — current user and organization
- `/api/organizations` — memberships
- `/api/domains` — create/list domains
- `/api/domains/:id` — domain status
- `/api/domains/:id/dns` — DNS instructions (`cloudflare_dns_required` is true for receiving)
- `/api/domains/:id/verify` — ownership check (does not trust the frontend)
- `/api/domains/:id/receiving` — persist receiving status after MX observation
- `/api/domains/:id/sending` — Brevo domain authentication
- `/api/mailboxes` — mailbox list; POST with `domainId` + `localPart` for self-service addresses
- `/api/mailboxes/:id/disable` — disable an address
- `/api/mfa` — MFA state machine (`not_started` / `pending_verification` / `enabled` / `cancelled` / `expired`)
- `/api/mfa/start`, `/api/mfa/restart`, `/api/mfa/verify`, `/api/mfa/cancel`
- `/api/sessions` — current session listing
- `/api/events` — authorized polling fallback for mailbox events
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
- `/api/drafts` — autosaved drafts with `draft_revision` conflict detection
- `/api/drafts/:id` DELETE — discard draft
- `/api/send` — authenticated send only from an owned mailbox
- `/api/send/:id/retry` — retry a failed send
- `/api/attachments` — private B2 upload and signed download URLs
- `/api/webhooks/brevo` — delivery-status callback (idempotent on `provider_event_id`)
- `/api/internal/send-test` — secret-protected smoke test only

Stable error codes include `DOMAIN_NOT_VERIFIED`, `DOMAIN_CONFIGURATION_PENDING`, `MAILBOX_NOT_ACTIVE`, `RECIPIENT_INVALID`, `ATTACHMENT_TOO_LARGE`, `SEND_RATE_LIMITED`, `DRAFT_CONFLICT`, and `PROVIDER_TEMPORARY_FAILURE`.

## Current feature boundaries

The application implements the mail workflow, local spam scoring, static
attachment safety checks, custom organization, scheduled send, snooze, PWA
shell, polling, and optional Supabase Realtime updates via `mailbox_events`.
Provider-specific Google/Microsoft calendar, OneDrive, Teams, AI, push
delivery, and third-party antivirus scanning still require provider credentials
or a separately operated service; the UI exposes these as integration points
rather than pretending they are connected.
Receiving for custom domains requires Cloudflare Email Routing (and usually
Cloudflare DNS). The API reports that requirement instead of assuming every
customer already uses Cloudflare.
