# SulatHQ Frontend and Product UX Specification

## 1. Purpose

This specification defines the frontend/product work for SulatHQ, a self-service custom-domain email application. It is designed so a frontend-focused Cursor can work in parallel with a platform/backend-focused Cursor without changing backend behavior or inventing incompatible contracts.

The existing codebase is the source of truth. Reuse its framework, routing, components, styling system, authentication flow, and API client. Do not rebuild the application from scratch or replace working integrations without a clear compatibility reason.

## 2. Product definition

SulatHQ lets a user:

1. Create an account.
2. Add a domain they own.
3. Verify ownership through DNS.
4. Create one or more addresses on that domain.
5. Receive and store messages in SulatHQ.
6. Send messages from those addresses.
7. Manage multiple domains and mailboxes from one account.

The UI must make the product feel like a mature, trustworthy webmail application rather than an infrastructure dashboard.

## 3. Ownership boundary

The frontend Cursor owns:

- User-facing routes and components
- SulatHQ branding
- Inbox, reader, thread, compose, settings, and onboarding UX
- Responsive layout and independent scrolling
- Loading, empty, success, error, and retry states
- Accessibility and keyboard behavior
- Browser-level UX tests

The frontend Cursor must not:

- Change Supabase migrations
- Change RLS policies
- Change Cloudflare Workers
- Change Brevo or Backblaze credentials
- Change production deployment configuration
- Change API response shapes without a reviewed contract update

If a backend capability is missing, use a typed stub/mock during UI development and open a contract request for the platform Cursor.

## 4. Brand requirements

Product name: **SulatHQ**

Meaning: a central headquarters for email owned by the user.

User-facing copy must be English-only. Do not use Tagalog or Taglish in the application interface.

Replace old product names in:

- Browser title
- Authenticated shell
- Login and signup
- Onboarding
- Settings
- Empty states
- Error and success messages
- PWA metadata
- Favicon and app manifest labels
- Help and tooltip copy

Do not rename database tables, API fields, environment variables, or internal service names merely for branding.

## 5. Experience principles

### 5.1 Calm and credible

Use restrained neutrals, one clear accent color, strong typography, subtle borders, and consistent spacing. The product should resemble established webmail and productivity software.

Avoid:

- Excessive gradients
- Glowing or futuristic effects
- Glassmorphism
- Decorative dashboard widgets
- Generic AI copy
- Unsupported claims
- Excessive pills, badges, or floating cards
- Huge empty areas inside the application

### 5.2 Familiar actions

Users should recognize Inbox, Sent, Drafts, Archive, Trash, Spam, Search, Compose, Reply, Forward, Move, and More without learning a new interaction model.

### 5.3 Immediate feedback

Every action must show a clear result: loading, saved, sent, moved, restored, failed, or retrying. Never leave the user wondering whether an action worked.

### 5.4 No false certainty

Do not display an address as active until the platform reports that the required verification/configuration succeeded. Do not label a message malicious merely because a low-confidence signal exists.

## 6. Information architecture

Use the existing router where possible. The final route names may differ, but the product must provide equivalent surfaces:

- `/login`
- `/signup`
- `/app/inbox`
- `/app/sent`
- `/app/drafts`
- `/app/archive`
- `/app/trash`
- `/app/spam`
- `/app/search`
- `/app/settings`
- `/app/settings/domains`
- `/app/settings/mailboxes`
- `/app/settings/security`
- `/app/onboarding/domain`

The authenticated shell contains:

- SulatHQ wordmark
- Compose action
- Search
- Mail folders
- Custom folders
- Saved searches if supported
- Settings
- Account/profile menu

Keep Calendar or Work navigation only if it already has a supported product surface. Do not add empty navigation items simply to imitate Outlook.

## 7. Shell and responsive behavior

### F-001: Independent scrolling

The left navigation, message list, reader, settings content, and compose body must scroll independently where the layout has multiple panes.

Acceptance criteria:

- Scrolling the message list does not move the reader or sidebar.
- Scrolling the reader does not move the message list.
- The document body does not create horizontal scrolling.
- Long URLs, tables, email content, and attachment names remain inside their containers.
- On mobile, the app becomes a single-pane flow with an explicit back action.
- On tablet and desktop, the multi-pane layout is retained when there is enough width.

Implementation guidance:

- Give the application shell a viewport-aware height.
- Use `min-height: 0` on nested flex/grid children where required.
- Put `overflow: auto` on the intended pane, not on the global body.
- Test at 320px, 375px, 768px, 1024px, 1280px, and wide desktop widths.

### F-002: No action overflow

Acceptance criteria:

- Reader actions never force horizontal page scroll.
- Primary actions remain visible.
- Secondary actions move into a More menu.
- Icon-only buttons have accessible names and tooltips.
- Touch targets are at least 44px where practical.

## 8. Inbox and message list

### F-010: Message row content

Each row should render, when available:

- Sender display name
- Sender email address as supporting text
- Real stored/available avatar
- Initials fallback only when no real image exists
- Subject
- Body preview
- Timestamp
- Attachment indicator
- Unread state
- Flagged/important state
- Labels/categories
- Selection checkbox

Never invent a sender name or profile image. If the provider does not supply an image, use a deterministic initials fallback.

### F-011: Message list interactions

Support:

- Click/tap to open
- Keyboard open
- Checkbox selection
- Bulk archive, trash, mark read/unread, move, and label actions where supported
- Hover actions on desktop
- Clear selected state
- Optimistic read-state update with rollback on failure

The selected message must remain visually obvious without relying only on color.

### F-012: List states

Implement designed states for:

- First load
- Refreshing
- Empty folder
- Search with no results
- Offline/retry
- Permission error
- Loading next page
- New message arrival

Use skeletons for initial loading and preserve existing content during background refresh.

## 9. Email reader

### F-020: Reader hierarchy

The reader must show:

- Back/navigation action
- Subject
- Sender display name and email
- Sender avatar when available
- Recipient summary
- Date and time
- Labels
- Message body
- Attachment section
- Primary actions

### F-021: Reader actions

Primary actions:

- Reply
- Reply all
- Forward
- Archive
- Trash
- Mark read/unread

Secondary actions in More:

- Spam/not spam
- Snooze
- Move
- Add label
- Block sender
- Print
- View message details

Do not put Trust Lens in the main reader surface. If it exists, expose it through Message details or Security details.

### F-022: Email rendering

Acceptance criteria:

- HTML email is rendered in a constrained, safe container.
- Plain-text fallback is readable.
- Images do not stretch the reader or create horizontal overflow.
- Tables scroll inside the message content area when necessary.
- External links are visibly identifiable and safely handled.
- Malformed HTML cannot escape the reader container.
- Reader loading has a skeleton and reader failure has a retry action.

### F-023: Thread view

Thread cards represent other messages in the same conversation. Make that relationship explicit with a label such as “Messages in this conversation”.

Acceptance criteria:

- Cards show sender, preview, and timestamp.
- The current message is highlighted.
- Cards expand and collapse predictably.
- The UI does not group messages solely by subject.
- Reply/forward preserves the thread context supplied by the platform.
- A thread with one message does not show confusing thread chrome.

## 10. Compose experience

### F-030: Desktop compose

Use a floating compose window on desktop.

Support:

- Minimize
- Maximize
- Close
- From-address selector
- To, CC, and BCC
- Recipient chips and validation
- Subject
- Body editor
- Signature insertion
- Attachment picker
- Drag-and-drop attachments
- Attachment progress and removal
- Autosave status
- Send status
- Retry after failed send
- Discard confirmation when unsaved content exists

### F-031: Mobile compose

Use a full-screen compose view or sheet on mobile. The keyboard must not hide the active field or send controls. The user must be able to leave compose and return to the draft.

### F-032: Draft behavior

Display explicit states:

- New draft
- Saving
- Saved
- Save failed
- Sending
- Sent
- Send failed

Autosave must debounce edits and avoid creating duplicate drafts. The frontend must use the platform’s draft identifier when available.

## 11. Domain and mailbox onboarding UX

### F-040: Guided setup

Create a progressive setup flow:

1. Add your domain
2. Verify ownership
3. Configure receiving
4. Configure sending
5. Create an address
6. Open the inbox

Each step must display:

- What is required
- Why it is required
- Exact DNS record details when applicable
- Copy controls
- Current status
- Last checked time
- Retry action
- Next step

### F-041: Domain status

Render these states:

- Not started
- Verification pending
- Verified
- Configuration required
- Active
- Error

Do not show raw provider errors as the primary explanation. Translate them into useful human-readable guidance while retaining expandable technical details.

### F-042: Multiple addresses

The mailbox management view must allow:

- Create address
- Rename display name
- Choose default From address
- Disable address
- View address status
- View domain relationship
- Open inbox for an address

Do not imply that an alias is a separate mailbox unless the backend says it has independent storage and credentials.

## 12. Settings, recovery, and MFA UX

Provide clear sections for:

- Profile
- Domains
- Mailboxes
- Signatures
- Recovery email
- Sessions
- Two-step verification

MFA setup requirements:

- The QR code is generated each time setup is intentionally restarted.
- An unfinished factor can be continued or discarded.
- A factor is not active until the verification code succeeds.
- Closing and reopening settings does not create duplicate setup buttons or leave the user trapped behind a duplicate-factor error.
- The user can clearly distinguish “setup started” from “two-step verification enabled”.

## 13. Spam and security presentation

Spam controls must be understandable and conservative.

The main reader should show only a concise status when needed. Detailed evidence belongs in a secondary panel.

Support:

- Why this was flagged
- Not spam
- Report spam
- View authentication details
- User feedback confirmation

Do not claim certainty when the system has only a risk score.

## 14. Accessibility

Acceptance criteria:

- All interactive controls have accessible names.
- Dialogs expose title, description, and focus behavior.
- Focus is returned to the launching control after closing a dialog.
- Escape closes dismissible dialogs and menus.
- Keyboard users can navigate folders, rows, reader actions, compose fields, and thread cards.
- Focus indicators are visible.
- Color is not the sole indication of unread, selected, spam, or error status.
- Reduced-motion preference disables nonessential transitions.
- Screen readers receive meaningful status updates for save, send, move, and error events.

## 15. Performance and perceived latency

Implement:

- Immediate selected-row feedback
- Reader skeleton instead of a blank panel
- Optimistic read-state updates only where rollback is reliable
- Request cancellation or stale-response protection when switching messages quickly
- Prefetch of adjacent messages only when safe
- Realtime/polling UI refresh using the platform contract
- No duplicate fetches caused by route and component effects

The frontend must not promise sub-second email delivery. It should show “Checking for new mail” or equivalent when the backend is still processing.

## 16. Frontend-to-platform contract

The frontend expects typed equivalents of these concepts:

- Current user and organization
- Mailbox and domain status
- Paginated message list
- Message details and headers
- Thread members
- Attachment metadata and signed download URL
- Draft create/update/send state
- Domain verification status
- Provider configuration status
- Spam evidence summary
- Realtime message event

If the actual API uses different names, create an adapter in the frontend rather than spreading provider-specific fields throughout components.

## 17. Testing plan

Automated tests:

- Component tests for shell, list rows, reader, compose, onboarding, and MFA states
- Accessibility assertions for dialogs, menus, buttons, and forms
- Responsive layout tests
- API loading/error/empty-state tests
- Draft autosave debounce tests
- Duplicate-click protection tests

Browser UX checks:

- Open inbox, select a message, navigate between messages
- Scroll list and reader independently
- Open and close compose
- Drag an attachment into compose
- Save and reopen a draft
- Switch From address
- Open thread cards
- Move message to Trash and restore it
- Open domain onboarding and retry verification
- Cancel MFA setup, reopen settings, and restart setup
- Verify no horizontal overflow at all target viewports

## 18. Definition of done

The frontend work is complete only when:

- SulatHQ is visible consistently throughout the product.
- Existing supported email flows still work.
- The UI has no accidental horizontal scrolling.
- Each major pane scrolls independently.
- Reader, thread, compose, onboarding, and settings flows have complete states.
- The UI is keyboard and screen-reader usable.
- Tests and production build pass.
- No secrets or environment files were added.
- Backend contract changes, if any, are documented for the platform Cursor.
