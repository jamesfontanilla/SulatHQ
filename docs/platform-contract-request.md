# Platform contract request (frontend)

The SulatHQ UI now includes domain onboarding, mailbox status, session management, and draft-state surfaces. The following platform endpoints are missing or incomplete. Until they exist, the frontend uses typed stubs in `src/lib/domains.ts` and conservative mailbox status mapping. Do not treat stub DNS values as live provider records.

## Requested endpoints

### Domains

- `GET /api/domains` — list domains for the current user/organization
- `POST /api/domains` — `{ domainName }` creates a pending domain and returns exact DNS instructions
- `POST /api/domains/:id/verify` — retry-safe ownership check; does not mark verified from the client
- `GET /api/domains/:id` — current verification, receiving, and sending status plus `last_checked_at`

Expected domain fields (frontend adapter already accepts these names or camelCase equivalents):

- `id`, `domain_name`
- `verification_status`: `not_started` | `verification_pending` | `verified` | `configuration_required` | `active` | `error`
- `receiving_status`, `sending_status` (same enum)
- `last_checked_at`
- `dns_records[]`: `{ kind, host, value, purpose }`
- `user_message` (human-readable) and optional `technical_details`

The UI will not label a domain or address **Active** unless the platform reports `active` (or both `can_send` and `can_receive` on an existing mailbox).

### Mailboxes

Existing `GET/POST /api/mailboxes` and `PATCH /api/mailboxes/:id` remain in use. Please add, without breaking current fields:

- `domain_id` / domain relationship
- `status` including `disabled`
- disable/enable without deleting stored mail
- default From address (`is_default`) — already partially supported

### Sessions

- `GET /api/sessions` — current sessions
- `DELETE /api/sessions/:id` — revoke a session

### Drafts

Existing `/api/drafts` is used. Please confirm a stable draft `id` on create/update so autosave cannot duplicate drafts, plus an explicit discard endpoint if different from deleting a drafts-folder message.

No backend files were changed in the frontend PR.
