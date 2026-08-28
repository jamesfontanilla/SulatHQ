# SulatHQ Platform and Backend Specification

## 1. Purpose

This specification defines the platform/backend work for SulatHQ, a self-service custom-domain email application. It is designed so a platform-focused Cursor can work in parallel with a frontend-focused Cursor using stable, typed contracts.

The existing codebase and deployed behavior are the source of truth. Inspect and preserve working behavior before changing it. Reuse the current stack and service integrations where possible.

## 2. Product definition

SulatHQ allows a user to:

1. Create an account.
2. Add a custom domain.
3. Prove ownership through DNS.
4. Create one or more addresses on that domain.
5. Receive mail into SulatHQ.
6. Send mail from those addresses.
7. Store messages and attachments.
8. Manage multiple domains and addresses from one account.

SulatHQ is a webmail and mail-control plane. It is not automatically a full IMAP mailbox provider. IMAP/POP support must be treated as a separate capability unless the current backend already provides it.

## 3. Ownership boundary

The platform Cursor owns:

- Supabase schema, migrations, indexes, functions, and RLS
- Authentication and organization membership enforcement
- Domain verification and provisioning state
- Cloudflare inbound email Worker and routing integration
- Brevo outbound delivery adapter and webhooks
- Backblaze B2 attachment adapter
- Background jobs, retries, idempotency, and observability
- API contracts consumed by the frontend
- Staging and production infrastructure changes

The platform Cursor must not:

- Redesign frontend layouts
- Change visible copy unnecessarily
- Commit secrets or local environment files
- Directly mutate production data for testing
- Edit an already-applied migration
- Change a public API response without updating its contract and tests

## 4. Provider responsibilities

### 4.1 Supabase

Use Supabase for:

- Authenticated users
- Organizations and memberships
- Domains and mailboxes
- Messages, threads, recipients, labels, drafts, and events
- Realtime notifications where supported
- Server-side functions and scheduled/background work where appropriate

Every exposed table must have RLS enabled. Policies must scope records through organization membership and mailbox ownership. Never expose a service-role key to the browser.

### 4.2 Cloudflare

Use Cloudflare for:

- Domain/DNS verification where the product has authorized access
- Inbound email routing
- Email Worker processing
- Frontend/Worker hosting where already configured

Cloudflare Email Routing is an inbound route, not the mailbox database. The Worker must hand off parsed mail to SulatHQ storage and processing.

The initial outbound provider remains Brevo. Cloudflare Email Sending may be added later behind the same provider interface if the account and plan support it.

### 4.3 Brevo

Use Brevo as the initial outbound transactional email provider.

The product must:

- Send only from verified/onboarded domains and addresses
- Keep the Brevo key server-side
- Record provider message IDs
- Process delivery, bounce, complaint, and failure events
- Enforce application-level rate limits and abuse controls
- Avoid allowing arbitrary spoofed From addresses

Domain authentication and DNS propagation are asynchronous. The UI must consume persisted status instead of assuming immediate success.

### 4.4 Backblaze B2

Use B2 for attachment/object storage.

Requirements:

- Use a restricted application key
- Store only object keys and metadata in Supabase
- Generate short-lived signed download URLs
- Do not expose bucket credentials to the browser
- Apply size, MIME, filename, and quota validation
- Support deletion/recovery semantics consistent with message retention

## 5. Multi-tenant data model

Adapt names to the existing schema, but preserve these relationships.

### 5.1 Organizations and access

`organizations`

- `id`
- `name`
- `slug`
- `created_at`

`organization_members`

- `organization_id`
- `user_id`
- `role`
- `created_at`

Roles should be explicit, such as `owner`, `admin`, `member`, and `viewer` if needed. Do not infer authorization from email address or frontend state.

### 5.2 Domains and mailboxes

`domains`

- `id`
- `organization_id`
- `domain_name`
- `verification_token`
- `verification_status`
- `receiving_status`
- `sending_status`
- `provider_reference`
- `last_checked_at`
- `verified_at`
- `created_at`
- `updated_at`

`mailboxes`

- `id`
- `organization_id`
- `domain_id`
- `local_part`
- `address`
- `display_name`
- `status`
- `is_default`
- `created_at`
- `updated_at`

Enforce uniqueness for normalized domain names and normalized full addresses within the appropriate tenant scope.

### 5.3 Messages and threads

`messages`

- `id`
- `organization_id`
- `mailbox_id`
- `thread_id`
- `direction`
- `folder`
- `message_id_header`
- `in_reply_to_header`
- `references_header`
- `from_address`
- `from_display_name`
- `to_addresses`
- `cc_addresses`
- `bcc_addresses`
- `reply_to`
- `subject`
- `text_body`
- `html_body`
- `snippet`
- `received_at`
- `sent_at`
- `is_read`
- `is_flagged`
- `is_pinned`
- `is_spam`
- `spam_score`
- `spam_evidence`
- `snoozed_until`
- `deleted_at`
- `provider_message_id`
- `created_at`
- `updated_at`

`threads`

- `id`
- `organization_id`
- `mailbox_id`
- `latest_message_at`
- `subject_preview`
- `message_count`
- `created_at`
- `updated_at`

Threading must use Message-ID, In-Reply-To, and References. Subject matching may be a fallback only, never the primary rule.

### 5.4 Attachments

`attachments`

- `id`
- `organization_id`
- `message_id`
- `storage_provider`
- `bucket_name`
- `object_key`
- `original_filename`
- `content_type`
- `byte_size`
- `sha256`
- `scan_status`
- `created_at`

Never store private object URLs permanently in the database. Generate access URLs on demand.

### 5.5 Labels, drafts, and events

`labels`

- `id`
- `organization_id`
- `name`
- `color`
- `created_at`

`message_labels`

- `message_id`
- `label_id`

`drafts` may reuse `messages` with a draft folder, but preserve a stable draft identifier and revision/version field to prevent concurrent autosave overwrites.

`email_events`

- `id`
- `organization_id`
- `message_id`
- `provider`
- `provider_event_id`
- `event_type`
- `payload_hash`
- `payload_redacted`
- `occurred_at`
- `created_at`

Make provider event IDs idempotent.

### 5.6 Audit and jobs

`audit_logs`

- `id`
- `organization_id`
- `actor_user_id`
- `action`
- `resource_type`
- `resource_id`
- `metadata_redacted`
- `created_at`

`jobs` or the existing queue mechanism should track:

- `job_type`
- `dedupe_key`
- `status`
- `attempts`
- `available_at`
- `locked_at`
- `last_error_redacted`
- `created_at`
- `completed_at`

## 6. Domain onboarding workflow

### B-001: Create domain

1. Authenticated user submits a normalized domain.
2. Server validates syntax and ownership scope.
3. Server creates a pending domain with a cryptographically strong verification token.
4. Server returns the exact DNS record instructions.
5. Server does not mark the domain verified from the frontend response.

### B-002: Verify ownership

1. User requests verification.
2. Server queries the authoritative DNS record or provider API.
3. Server compares the returned value using normalized DNS rules.
4. Server records the check result and timestamp.
5. Server transitions the domain to `verified` only on a successful match.
6. Server emits a status event for the UI.

Provide retry-safe behavior. Repeated checks must not create duplicate domain records or provider rules.

### B-003: Configure receiving

After ownership verification:

1. Create or update the Cloudflare routing/Worker configuration.
2. Map the domain to the SulatHQ inbound Worker.
3. Persist the provider reference and configuration status.
4. Verify the configuration where the provider API permits it.
5. Report `configuration_required`, `active`, or `error` accurately.

If Cloudflare DNS is required by the chosen route, explain that requirement in the frontend contract. Do not silently assume every customer’s DNS provider is Cloudflare.

### B-004: Configure sending

1. Request or create the Brevo sender/domain configuration.
2. Return required DNS records to the UI.
3. Poll or recheck authentication status.
4. Mark sending active only after provider confirmation.
5. Store only nonsecret provider references and statuses.

## 7. Inbound email workflow

### B-010: Receive

Cloudflare inbound flow:

1. Cloudflare routes an inbound message to the Worker.
2. Worker validates the recipient against active mailboxes.
3. Worker computes an idempotency key from provider event/message headers.
4. Worker parses envelope data and safe message headers.
5. Worker stores the canonical message record before nonessential processing.
6. Worker schedules attachment storage, spam analysis, and enrichment.
7. Worker emits a new-message event after the message is queryable.

Do not silently drop mail. Record a redacted failure event and return a provider-appropriate failure response when processing cannot safely continue.

### B-011: Idempotency

Duplicate deliveries must not create duplicate visible messages.

Use a unique constraint or transaction-safe lookup involving the organization/mailbox and stable provider/message identifier. Retried attachment processing must also be idempotent.

### B-012: Parsing

Preserve:

- Original Message-ID
- In-Reply-To
- References
- From
- To
- Cc
- Reply-To
- Subject
- Date
- MIME structure

Sanitize HTML for display while preserving the original message metadata required for sending replies and forwarding.

## 8. Outbound email workflow

### B-020: Send

1. Frontend submits a draft/message ID to the server.
2. Server verifies mailbox ownership and sending status.
3. Server validates recipients, subject, body, attachments, and rate limits.
4. Server persists the outgoing message before calling the provider.
5. Server sends through the Brevo adapter.
6. Server records provider message ID and initial status.
7. Server moves the message from Drafts to Sent only according to the defined send state.
8. Provider webhooks update delivery/bounce/failure state idempotently.

Do not accept a client-supplied From address unless it belongs to an active mailbox controlled by the organization.

### B-021: Provider abstraction

Define an internal interface equivalent to:

```ts
interface MailTransport {
  send(input: SendMessageInput): Promise<SendMessageResult>;
  verifyDomain(input: VerifyDomainInput): Promise<ProviderStatus>;
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatus>;
}
```

The first implementation is Brevo. Keep provider-specific code behind the adapter so Cloudflare Email Sending or another provider can be added later without rewriting message composition or billing logic.

### B-022: Reply and thread headers

For replies:

- Set `In-Reply-To` to the parent Message-ID.
- Append the parent and existing References values according to RFC-compatible limits.
- Generate a new Message-ID for the outbound message.

For forwarding, preserve the original content as quoted/attached content according to the existing product behavior.

## 9. Attachments and storage

Requirements:

- Enforce per-file and per-message limits server-side.
- Reject dangerous or unsupported MIME types according to policy.
- Normalize filenames for storage keys.
- Use a content hash for deduplication where safe.
- Store attachments asynchronously after the message row exists.
- Mark attachment processing status explicitly.
- Generate short-lived signed download URLs only after authorization.
- Support preview only for safe, supported formats.
- Record scan status and make the UI distinguish pending, safe, blocked, and failed.

Never allow a user to retrieve an object by guessing another organization’s key.

## 10. Spam and trust signals

Spam classification should be explainable and conservative.

Persist evidence such as:

- SPF result
- DKIM result
- DMARC result
- Envelope/header mismatch
- Sender reputation signal
- Suspicious URL signal
- Attachment risk
- User feedback

Store a score plus evidence, not only a boolean. Do not automatically delete suspected spam. Place suspected messages in Spam according to a configurable threshold and allow recovery to Inbox.

User feedback must update classification data without allowing a single action to weaken protections globally.

## 11. Realtime and polling

Emit a realtime event after a message is committed and queryable, not before.

Event payloads should contain only the minimum needed for cache invalidation or list updates:

- Event type
- Message ID
- Mailbox ID
- Thread ID
- Folder
- Timestamp
- Small preview metadata if authorized

Never broadcast message bodies to unauthorized subscribers.

If Realtime is unavailable, provide a polling fallback with backoff and visibility-aware intervals.

## 12. API contract

Provide typed/server-validated equivalents for:

### Domain and mailbox

- Create domain
- Get domain status
- Verify domain
- Get DNS instructions
- Create mailbox
- List mailboxes
- Update mailbox
- Disable mailbox

### Messages

- List messages with pagination and filters
- Get message detail
- Get thread
- Mark read/unread
- Move message
- Archive
- Trash
- Restore
- Mark spam/not spam
- Snooze
- Add/remove label

### Compose

- Create draft
- Update draft with revision guard
- Upload attachment
- Remove attachment
- Send draft
- Retry failed send
- Discard draft

### Settings

- Signatures
- Recovery email
- MFA setup/start/restart/verify/cancel
- Session listing and revocation

Return stable error codes, for example:

- `DOMAIN_NOT_VERIFIED`
- `DOMAIN_CONFIGURATION_PENDING`
- `MAILBOX_NOT_ACTIVE`
- `RECIPIENT_INVALID`
- `ATTACHMENT_TOO_LARGE`
- `SEND_RATE_LIMITED`
- `DRAFT_CONFLICT`
- `PROVIDER_TEMPORARY_FAILURE`

The frontend should translate error codes into user-facing copy.

## 13. Security requirements

- Enable RLS on every exposed Supabase table.
- Test positive and negative tenant-access cases.
- Keep service keys server-side.
- Use least-privilege provider credentials.
- Redact message bodies, tokens, and keys from logs.
- Validate all mailbox/domain ownership server-side.
- Rate-limit domain checks, sends, MFA operations, password recovery, and webhook endpoints.
- Verify webhook signatures where supported.
- Use idempotency keys for send, inbound processing, domain provisioning, and webhooks.
- Maintain audit logs for security-sensitive actions.
- Use secure, expiring signed URLs for attachments.
- Do not let email HTML execute scripts or escape the reader sandbox.

## 14. MFA and recovery backend behavior

MFA setup is a state machine, not a single button:

- `not_started`
- `pending_verification`
- `enabled`
- `cancelled`
- `expired`

When setup is restarted:

- Reuse a valid pending setup only when safe, or revoke it and create a new one.
- Do not create duplicate active factors with the same friendly name.
- Remove or expire abandoned pending factors through a cleanup path.
- Require a valid authenticator code before enabling MFA.

Recovery email changes require verification before becoming active. Password reset tokens must expire, be single-use, and never be written to logs.

## 15. Background processing

Use the existing queue/job mechanism where available. Jobs should cover:

- Attachment persistence
- Malware scanning
- Spam enrichment
- Domain status polling
- Provider webhook reconciliation
- Snooze release
- Draft cleanup
- Abandoned MFA cleanup
- Retention cleanup

Every job must be retry-safe, bounded, observable, and idempotent.

## 16. Environment separation

Maintain distinct development, staging, and production resources.

Development/staging should use:

- Separate Supabase project or branch
- Separate storage bucket
- Separate Cloudflare Worker or test domain
- Brevo test sender/domain or isolated account
- Test mailbox addresses

Commit `.env.example` with names and safe placeholders only. Never commit actual `.env` files, service-role keys, provider keys, or copied browser credentials.

Production deployment must be performed only from the protected release branch after CI and staging verification.

## 17. Migration and collaboration rules

- Inspect the current schema before adding tables.
- Use one forward-only migration per schema change.
- Do not edit migrations already applied to shared environments.
- Use unique migration timestamps.
- Add indexes based on actual query patterns.
- Add RLS policies in the same change as exposed tables.
- Update typed contracts and tests with schema changes.
- Tell the frontend Cursor which fields are new, changed, or deprecated.

The platform Cursor must not modify frontend files except for generated/shared contract types agreed by both developers.

## 18. Testing plan

### Database and security

- Migration applies to a clean database.
- Migration applies to a copy of current staging.
- RLS denies cross-organization reads and writes.
- Organization roles are enforced server-side.
- Unique constraints prevent duplicate domains, mailboxes, and events.
- Attachment access cannot cross tenants.

### Inbound

- Valid inbound message is stored once.
- Duplicate inbound delivery is idempotent.
- Unknown recipient is rejected or handled by the configured catch-all policy.
- Malformed MIME does not crash the Worker.
- Message headers are preserved.
- Large or blocked attachments receive an explicit status.

### Outbound

- Only active verified mailboxes can send.
- Invalid recipients are rejected before provider submission.
- Provider temporary failure produces a retryable state.
- Provider permanent failure produces a visible failure state.
- Webhook replay does not duplicate events.
- Reply headers produce a correct thread.

### Domain onboarding

- Pending domain remains pending until DNS matches.
- Incorrect DNS value does not verify.
- Retry does not create duplicate provider rules.
- Provider partial failure is recoverable.
- Multiple domains and mailboxes remain isolated.

### MFA and jobs

- Cancelled MFA setup can be restarted.
- Abandoned pending factors expire or are cleaned up.
- Cleanup jobs are idempotent.
- Recovery email verification is required.

## 19. Observability

Track redacted metrics for:

- Inbound accepted/rejected/failed
- Processing latency
- Outbound queued/sent/delivered/bounced/failed
- Domain verification success/failure
- Provider API latency and errors
- Attachment processing status
- Queue age and retry count
- Realtime delivery failures

Use correlation IDs across Worker, API, job, and provider calls. Never log full message bodies, credentials, recovery tokens, or raw authentication secrets.

## 20. Definition of done

The platform work is complete only when:

- Domain verification is real and stateful.
- Multiple domains and mailboxes are tenant-isolated.
- Inbound email is stored idempotently.
- Outbound email is sent only from authorized addresses.
- Brevo is behind a provider adapter.
- Attachments use private object storage and signed access.
- RLS and security tests pass.
- Realtime/polling updates are authorized and reliable.
- MFA setup can be safely restarted.
- Migrations, API contracts, and tests are documented.
- Staging behavior is verified before production deployment.
- No secrets or local credentials are committed.
