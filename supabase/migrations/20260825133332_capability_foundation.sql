-- Parcel capability foundation.
-- This migration adds durable metadata and security boundaries only. It does
-- not change the public UI until the corresponding API work is implemented.

create extension if not exists pgcrypto;

-- Message workflow and outbox state.
alter table public.messages add column if not exists work_state text not null default 'none';
alter table public.messages add column if not exists follow_up_at timestamptz;
alter table public.messages add column if not exists work_note text not null default '';
alter table public.messages add column if not exists send_after timestamptz;
alter table public.messages add column if not exists send_lease_until timestamptz;
alter table public.messages add column if not exists send_attempts integer not null default 0;
alter table public.messages add column if not exists send_idempotency_key text;
alter table public.messages add column if not exists cancelled_at timestamptz;
alter table public.messages add column if not exists send_warning_acknowledged jsonb not null default '{}'::jsonb;

-- Trust evidence is intentionally separate from the existing spam reasons. The
-- UI can explain evidence without treating it as an identity guarantee.
alter table public.messages add column if not exists trust_score numeric(5,4);
alter table public.messages add column if not exists trust_reasons jsonb not null default '[]'::jsonb;
alter table public.messages add column if not exists trust_evidence jsonb not null default '{}'::jsonb;
alter table public.messages add column if not exists received_auth_at timestamptz;
alter table public.messages add column if not exists sender_first_seen boolean;
alter table public.messages add column if not exists known_contact boolean;
alter table public.messages add column if not exists reply_to_mismatch boolean not null default false;
alter table public.messages add column if not exists link_count integer not null default 0;
alter table public.messages add column if not exists tracking_pixel_count integer not null default 0;

alter table public.messages drop constraint if exists messages_work_state_check;
alter table public.messages add constraint messages_work_state_check
  check (work_state in ('none', 'reply_later', 'waiting_on', 'i_owe'));

create unique index if not exists messages_owner_send_idempotency_idx
  on public.messages(owner_id, send_idempotency_key)
  where send_idempotency_key is not null;
create index if not exists messages_owner_work_queue_idx
  on public.messages(owner_id, work_state, follow_up_at);
create index if not exists messages_owner_outbox_idx
  on public.messages(owner_id, status, send_after);
create index if not exists messages_owner_trust_idx
  on public.messages(owner_id, trust_score, created_at desc);

-- Attachment metadata for previews, deduplication, and layered safety checks.
alter table public.attachments add column if not exists sha256 text;
alter table public.attachments add column if not exists detected_content_type text;
alter table public.attachments add column if not exists preview_state text not null default 'not_available';
alter table public.attachments add column if not exists safety_status text not null default 'unknown';
alter table public.attachments add column if not exists safety_reasons jsonb not null default '[]'::jsonb;

alter table public.attachments drop constraint if exists attachments_preview_state_check;
alter table public.attachments add constraint attachments_preview_state_check
  check (preview_state in ('not_available', 'pending', 'ready', 'failed'));
alter table public.attachments drop constraint if exists attachments_safety_status_check;
alter table public.attachments add constraint attachments_safety_status_check
  check (safety_status in ('unknown', 'clean_static', 'suspicious', 'blocked', 'infected'));

create index if not exists attachments_owner_hash_idx
  on public.attachments(owner_id, sha256)
  where sha256 is not null;
create index if not exists attachments_message_filename_idx
  on public.attachments(message_id, filename);

-- Durable audit records. Inserts are reserved for the trusted Worker/service
-- role; the owner may read their own history through the API.
create table if not exists public.message_audit_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  mailbox_id uuid references public.mailboxes(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  thread_id uuid references public.threads(id) on delete set null,
  action_type text not null,
  target_type text not null,
  target_id uuid,
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists message_audit_owner_created_idx
  on public.message_audit_log(owner_id, created_at desc);
create index if not exists message_audit_message_created_idx
  on public.message_audit_log(message_id, created_at desc);

create table if not exists public.mail_rule_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null references public.mail_rules(id) on delete cascade,
  initiated_by uuid references auth.users(id) on delete set null,
  mode text not null check (mode in ('preview', 'dry_run', 'apply', 'replay')),
  status text not null default 'started' check (status in ('started', 'completed', 'failed', 'cancelled')),
  matched_count integer not null default 0,
  changed_count integer not null default 0,
  sample jsonb not null default '[]'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists mail_rule_runs_owner_started_idx
  on public.mail_rule_runs(owner_id, started_at desc);
create index if not exists mail_rule_runs_rule_started_idx
  on public.mail_rule_runs(rule_id, started_at desc);

alter table public.mail_rules add column if not exists stop_processing boolean not null default false;
alter table public.mail_rules add column if not exists last_run_at timestamptz;
alter table public.mail_rules add column if not exists last_run_count integer not null default 0;
alter table public.mail_rules add column if not exists last_error text;
alter table public.mail_rules add column if not exists version integer not null default 1;
alter table public.mail_rules add column if not exists updated_by uuid references auth.users(id) on delete set null;

-- Sender decisions and the review queue.
create table if not exists public.sender_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid references public.mailboxes(id) on delete cascade,
  match_type text not null check (match_type in ('address', 'domain')),
  match_value text not null,
  action text not null check (action in ('inbox', 'folder', 'label', 'screen', 'spam', 'archive')),
  target_folder_id uuid references public.mail_folders(id) on delete set null,
  target_label_id uuid references public.labels(id) on delete set null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, mailbox_id, match_type, match_value)
);

create table if not exists public.screening_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  policy_id uuid references public.sender_policies(id) on delete set null,
  decision text not null check (decision in ('screened', 'allowed', 'blocked', 'restored')),
  previous_folder text,
  created_at timestamptz not null default now(),
  restored_at timestamptz
);

create index if not exists sender_policies_owner_match_idx
  on public.sender_policies(owner_id, mailbox_id, match_type, match_value);
create index if not exists screening_owner_created_idx
  on public.screening_events(owner_id, created_at desc);
create index if not exists screening_message_idx
  on public.screening_events(message_id, created_at desc);

-- Address-level purpose and operational state.
create table if not exists public.address_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  purpose text not null default 'personal',
  description text not null default '',
  color text not null default '#3156d8',
  receiving_paused boolean not null default false,
  sending_paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, mailbox_id)
);

create index if not exists address_profiles_owner_idx
  on public.address_profiles(owner_id, mailbox_id);
create index if not exists messages_mailbox_activity_idx
  on public.messages(owner_id, mailbox_id, created_at desc);
create index if not exists mail_events_owner_created_idx
  on public.mail_events(owner_id, created_at desc);

-- Saved views are virtual; they never duplicate or move messages.
create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  query text not null,
  color text not null default '#3156d8',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, name)
);

create index if not exists saved_searches_owner_order_idx
  on public.saved_searches(owner_id, sort_order, name);

-- Improve the existing search document with recipients and attachment names.
create or replace function public.messages_search_vector_fn()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  attachment_names text;
begin
  select coalesce(string_agg(a.filename, ' '), '')
    into attachment_names
    from public.attachments a
   where a.message_id = new.id;

  new.search_vector := to_tsvector(
    'simple',
    concat_ws(
      ' ',
      new.subject,
      new.from_address,
      new.reply_to,
      new.text_body,
      new.to_addresses::text,
      new.cc_addresses::text,
      new.bcc_addresses::text,
      attachment_names
    )
  );
  return new;
end;
$$;

drop trigger if exists messages_search_vector_trigger on public.messages;
create trigger messages_search_vector_trigger
before insert or update of subject, from_address, reply_to, text_body, to_addresses, cc_addresses, bcc_addresses
on public.messages
for each row execute function public.messages_search_vector_fn();

create or replace function public.refresh_message_search_vector_from_attachment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_message_id uuid;
  attachment_names text;
  message_row public.messages%rowtype;
begin
  if tg_op = 'DELETE' then
    target_message_id := old.message_id;
  else
    target_message_id := new.message_id;
  end if;

  select * into message_row from public.messages where id = target_message_id;
  if message_row.id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select coalesce(string_agg(a.filename, ' '), '')
    into attachment_names
    from public.attachments a
   where a.message_id = target_message_id;

  update public.messages
     set search_vector = to_tsvector(
       'simple',
       concat_ws(
         ' ',
         message_row.subject,
         message_row.from_address,
         message_row.reply_to,
         message_row.text_body,
         message_row.to_addresses::text,
         message_row.cc_addresses::text,
         message_row.bcc_addresses::text,
         attachment_names
       )
     )
   where id = target_message_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_search_vector_trigger on public.attachments;
create trigger attachments_search_vector_trigger
after insert or update of filename or delete on public.attachments
for each row execute function public.refresh_message_search_vector_from_attachment();

update public.messages m
set search_vector = to_tsvector(
  'simple',
  concat_ws(
    ' ',
    m.subject,
    m.from_address,
    m.reply_to,
    m.text_body,
    m.to_addresses::text,
    m.cc_addresses::text,
    m.bcc_addresses::text,
    coalesce((select string_agg(a.filename, ' ') from public.attachments a where a.message_id = m.id), '')
  )
)
where m.search_vector is null;

create index if not exists messages_search_vector_idx
  on public.messages using gin(search_vector);

-- Export/version metadata and optional push devices.
alter table public.user_settings add column if not exists schema_version integer not null default 1;

create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(owner_id, endpoint)
);

create index if not exists push_devices_owner_active_idx
  on public.push_devices(owner_id, last_seen_at desc)
  where revoked_at is null;

-- Domain checks are advisory evidence written by the Worker.
create table if not exists public.domain_checks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  check_type text not null check (check_type in ('mx', 'spf', 'dmarc', 'dkim', 'mta_sts', 'tls_rpt')),
  selector text,
  hostname text not null,
  status text not null check (status in ('pass', 'fail', 'missing', 'invalid', 'timeout', 'not_configured')),
  observed_summary text not null default '',
  recommendation text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  unique(owner_id, domain, check_type, selector)
);

create index if not exists domain_checks_owner_checked_idx
  on public.domain_checks(owner_id, domain, checked_at desc);

-- Collaboration records are owner-managed in this foundation migration. Phase
-- 8 can add delegated reads/writes only after the membership matrix is tested.
create table if not exists public.thread_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.thread_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.thread_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  assignee_id uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, thread_id)
);

create table if not exists public.mailbox_invitations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  email text not null,
  role text not null check (role in ('viewer', 'editor', 'delegate')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists thread_shares_owner_expiry_idx
  on public.thread_shares(owner_id, expires_at);
create index if not exists thread_comments_thread_created_idx
  on public.thread_comments(thread_id, created_at asc);
create index if not exists thread_assignments_owner_status_idx
  on public.thread_assignments(owner_id, status, due_at);
create index if not exists mailbox_invitations_owner_status_idx
  on public.mailbox_invitations(owner_id, status, expires_at);

-- Explicit grants and RLS for every new public table. The audit/event tables
-- are readable by the owner but writable only by the trusted Worker role.
alter table public.message_audit_log enable row level security;
alter table public.mail_rule_runs enable row level security;
alter table public.sender_policies enable row level security;
alter table public.screening_events enable row level security;
alter table public.address_profiles enable row level security;
alter table public.saved_searches enable row level security;
alter table public.push_devices enable row level security;
alter table public.domain_checks enable row level security;
alter table public.thread_shares enable row level security;
alter table public.thread_comments enable row level security;
alter table public.thread_assignments enable row level security;
alter table public.mailbox_invitations enable row level security;

revoke all on table public.message_audit_log, public.mail_rule_runs, public.screening_events, public.domain_checks from anon, authenticated;
grant select on table public.message_audit_log, public.mail_rule_runs, public.screening_events, public.domain_checks to authenticated;

revoke all on table public.sender_policies, public.address_profiles, public.saved_searches, public.push_devices, public.thread_shares, public.thread_comments, public.thread_assignments, public.mailbox_invitations from anon, authenticated;
grant select, insert, update, delete on table public.sender_policies, public.address_profiles, public.saved_searches, public.push_devices, public.thread_shares, public.thread_comments, public.thread_assignments, public.mailbox_invitations to authenticated;

drop policy if exists "audit owner reads" on public.message_audit_log;
create policy "audit owner reads" on public.message_audit_log for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists "rule runs owner reads" on public.mail_rule_runs;
create policy "rule runs owner reads" on public.mail_rule_runs for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists "screening owner reads" on public.screening_events;
create policy "screening owner reads" on public.screening_events for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists "domain checks owner reads" on public.domain_checks;
create policy "domain checks owner reads" on public.domain_checks for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "sender policies own rows" on public.sender_policies;
create policy "sender policies own rows" on public.sender_policies for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "address profiles own rows" on public.address_profiles;
create policy "address profiles own rows" on public.address_profiles for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "saved searches own rows" on public.saved_searches;
create policy "saved searches own rows" on public.saved_searches for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "push devices own rows" on public.push_devices;
create policy "push devices own rows" on public.push_devices for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "thread shares own rows" on public.thread_shares;
create policy "thread shares own rows" on public.thread_shares for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "thread comments own rows" on public.thread_comments;
create policy "thread comments own rows" on public.thread_comments for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "thread assignments own rows" on public.thread_assignments;
create policy "thread assignments own rows" on public.thread_assignments for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "mailbox invitations own rows" on public.mailbox_invitations;
create policy "mailbox invitations own rows" on public.mailbox_invitations for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- Membership management is owner-only; members can see only their own
-- membership row. This prevents a delegated user from changing their role or
-- granting access to another account.
drop policy if exists "members own rows" on public.mailbox_members;
drop policy if exists "members can view memberships" on public.mailbox_members;
drop policy if exists "owners can add memberships" on public.mailbox_members;
drop policy if exists "owners can update memberships" on public.mailbox_members;
drop policy if exists "owners can delete memberships" on public.mailbox_members;

create policy "members can view memberships" on public.mailbox_members for select to authenticated
  using (
    member_id = (select auth.uid())
    or exists (
      select 1 from public.mailboxes m
       where m.id = mailbox_id and m.owner_id = (select auth.uid())
    )
  );
create policy "owners can add memberships" on public.mailbox_members for insert to authenticated
  with check (
    exists (
      select 1 from public.mailboxes m
       where m.id = mailbox_id and m.owner_id = (select auth.uid())
    )
  );
create policy "owners can update memberships" on public.mailbox_members for update to authenticated
  using (
    exists (
      select 1 from public.mailboxes m
       where m.id = mailbox_id and m.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.mailboxes m
       where m.id = mailbox_id and m.owner_id = (select auth.uid())
    )
  );
create policy "owners can delete memberships" on public.mailbox_members for delete to authenticated
  using (
    exists (
      select 1 from public.mailboxes m
       where m.id = mailbox_id and m.owner_id = (select auth.uid())
    )
  );
