-- SulatHQ self-service tenancy, domain onboarding, jobs, MFA setup, and
-- inbound/outbound idempotency. Existing owner_id columns remain the
-- compatibility key for the current webmail APIs.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create unique index if not exists organization_members_one_owner_org_idx
  on public.organization_members(user_id)
  where role = 'owner';

create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain_name text not null,
  verification_token text not null,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'failed')),
  receiving_status text not null default 'not_started'
    check (receiving_status in ('not_started', 'configuration_required', 'active', 'error')),
  sending_status text not null default 'not_started'
    check (sending_status in ('not_started', 'pending_dns', 'active', 'error')),
  provider_reference text,
  last_checked_at timestamptz,
  verified_at timestamptz,
  receiving_provider_ref text,
  sending_provider_ref text,
  last_error_redacted text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, domain_name)
);

create unique index if not exists domains_domain_name_idx
  on public.domains (domain_name);

create table if not exists public.platform_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  job_type text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error_redacted text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (job_type, dedupe_key)
);

create index if not exists platform_jobs_queue_idx
  on public.platform_jobs (status, available_at)
  where status in ('queued', 'running');

create table if not exists public.mfa_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  factor_id text,
  friendly_name text not null default 'SulatHQ authenticator',
  status text not null default 'pending_verification'
    check (status in ('not_started', 'pending_verification', 'enabled', 'cancelled', 'expired')),
  expires_at timestamptz,
  verified_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mfa_setups_user_status_idx
  on public.mfa_setups (user_id, status, created_at desc);

create table if not exists public.mailbox_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  mailbox_id uuid references public.mailboxes(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete set null,
  event_type text not null,
  folder text,
  preview jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mailbox_events_mailbox_created_idx
  on public.mailbox_events (mailbox_id, created_at desc);

create table if not exists public.platform_rate_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  hit_count integer not null default 0,
  last_hit_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  metadata_redacted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_org_created_idx
  on public.audit_logs (organization_id, created_at desc);

create table if not exists public.inbound_failures (
  id uuid primary key default gen_random_uuid(),
  envelope_to text not null,
  reason_code text not null,
  detail_redacted text not null default '',
  created_at timestamptz not null default now()
);

alter table public.mailboxes add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.mailboxes add column if not exists domain_id uuid references public.domains(id) on delete set null;
alter table public.mailboxes add column if not exists local_part text;
alter table public.mailboxes add column if not exists status text not null default 'active';
alter table public.mailboxes add column if not exists updated_at timestamptz not null default now();

alter table public.mailboxes drop constraint if exists mailboxes_status_check;
alter table public.mailboxes add constraint mailboxes_status_check
  check (status in ('pending', 'active', 'disabled'));

alter table public.messages add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.messages add column if not exists inbound_idempotency_key text;
alter table public.messages add column if not exists draft_revision integer not null default 1;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.messages add column if not exists spam_evidence jsonb not null default '{}'::jsonb;

alter table public.threads add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.threads add column if not exists mailbox_id uuid references public.mailboxes(id) on delete set null;
alter table public.threads add column if not exists message_count integer not null default 0;
alter table public.threads add column if not exists subject_preview text;
alter table public.threads add column if not exists updated_at timestamptz not null default now();

alter table public.attachments add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.attachments add column if not exists storage_provider text not null default 'b2';
alter table public.attachments add column if not exists bucket_name text;
alter table public.attachments add column if not exists original_filename text;
alter table public.attachments add column if not exists scan_status text not null default 'pending';

alter table public.attachments drop constraint if exists attachments_scan_status_check;
alter table public.attachments add constraint attachments_scan_status_check
  check (scan_status in ('pending', 'safe', 'blocked', 'failed'));

alter table public.mail_events add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.mail_events add column if not exists provider_event_id text;
alter table public.mail_events add column if not exists payload_hash text;
alter table public.mail_events add column if not exists occurred_at timestamptz not null default now();

alter table public.labels add column if not exists organization_id uuid references public.organizations(id) on delete set null;

-- Personal organization per existing profile/mailbox owner.
insert into public.organizations (id, name, slug)
select gen_random_uuid(),
       coalesce(nullif(p.display_name, ''), 'Personal workspace'),
       'user-' || p.id::text
  from public.profiles p
 where not exists (
   select 1 from public.organization_members m where m.user_id = p.id
 )
on conflict (slug) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select o.id, p.id, 'owner'
  from public.profiles p
  join public.organizations o on o.slug = 'user-' || p.id::text
on conflict do nothing;

update public.mailboxes mb
   set organization_id = m.organization_id,
       local_part = split_part(mb.address, '@', 1),
       updated_at = now()
  from public.organization_members m
 where m.user_id = mb.owner_id
   and m.role = 'owner'
   and mb.organization_id is null;

update public.attachments a
   set original_filename = coalesce(a.original_filename, a.filename),
       scan_status = case
         when a.safety_status in ('blocked', 'infected') then 'blocked'
         when a.safety_status in ('clean_static') then 'safe'
         when a.safety_status in ('suspicious') then 'failed'
         else 'pending'
       end
 where a.original_filename is null or a.scan_status = 'pending';

update public.messages msg
   set organization_id = mb.organization_id,
       spam_evidence = case
         when msg.spam_evidence = '{}'::jsonb then jsonb_build_object('reasons', coalesce(msg.spam_reasons, '[]'::jsonb), 'trust', coalesce(msg.trust_evidence, '{}'::jsonb))
         else msg.spam_evidence
       end
  from public.mailboxes mb
 where msg.mailbox_id = mb.id
   and msg.organization_id is null;

update public.threads t
   set organization_id = m.organization_id
  from public.organization_members m
 where m.user_id = t.owner_id
   and m.role = 'owner'
   and t.organization_id is null;

create unique index if not exists mailboxes_address_idx
  on public.mailboxes (lower(address));

create unique index if not exists messages_inbound_idempotency_idx
  on public.messages (mailbox_id, inbound_idempotency_key)
  where inbound_idempotency_key is not null;

create unique index if not exists mail_events_provider_event_idx
  on public.mail_events (provider, provider_event_id)
  where provider_event_id is not null;

create index if not exists messages_org_mailbox_folder_idx
  on public.messages (organization_id, mailbox_id, folder, created_at desc);

create index if not exists domains_org_status_idx
  on public.domains (organization_id, verification_status, updated_at desc);

create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.organization_members
     where organization_id = org_id
       and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_org_manager(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.organization_members
     where organization_id = org_id
       and user_id = (select auth.uid())
       and role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.is_org_manager(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_manager(uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.domains enable row level security;
alter table public.platform_jobs enable row level security;
alter table public.mfa_setups enable row level security;
alter table public.mailbox_events enable row level security;
alter table public.platform_rate_limits enable row level security;
alter table public.audit_logs enable row level security;
alter table public.inbound_failures enable row level security;

revoke all on table public.organizations, public.organization_members, public.domains,
  public.platform_jobs, public.mfa_setups, public.mailbox_events,
  public.platform_rate_limits, public.audit_logs, public.inbound_failures
  from anon, authenticated;

grant select on table public.organizations, public.organization_members, public.domains,
  public.mailbox_events, public.audit_logs to authenticated;
grant select, insert, update on table public.domains to authenticated;
grant select, insert, update, delete on table public.organization_members to authenticated;
grant select, insert, update on table public.organizations to authenticated;
grant select, insert, update, delete on table public.mfa_setups to authenticated;

drop policy if exists "org members read organizations" on public.organizations;
create policy "org members read organizations" on public.organizations for select to authenticated
  using (public.is_org_member(id));
drop policy if exists "org managers update organizations" on public.organizations;
create policy "org managers update organizations" on public.organizations for update to authenticated
  using (public.is_org_manager(id)) with check (public.is_org_manager(id));

drop policy if exists "members read memberships" on public.organization_members;
create policy "members read memberships" on public.organization_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(organization_id));
drop policy if exists "managers write memberships" on public.organization_members;
create policy "managers write memberships" on public.organization_members for all to authenticated
  using (public.is_org_manager(organization_id))
  with check (public.is_org_manager(organization_id));

drop policy if exists "members read domains" on public.domains;
create policy "members read domains" on public.domains for select to authenticated
  using (public.is_org_member(organization_id));
drop policy if exists "managers write domains" on public.domains;
create policy "managers insert domains" on public.domains for insert to authenticated
  with check (public.is_org_manager(organization_id));
drop policy if exists "managers update domains" on public.domains;
create policy "managers update domains" on public.domains for update to authenticated
  using (public.is_org_manager(organization_id))
  with check (public.is_org_manager(organization_id));

drop policy if exists "members read mailbox events" on public.mailbox_events;
create policy "members read mailbox events" on public.mailbox_events for select to authenticated
  using (
    public.is_org_member(organization_id)
    or exists (
      select 1 from public.mailboxes mb
       where mb.id = mailbox_id and mb.owner_id = (select auth.uid())
    )
  );

drop policy if exists "members read audit logs" on public.audit_logs;
create policy "members read audit logs" on public.audit_logs for select to authenticated
  using (public.is_org_member(organization_id) or actor_user_id = (select auth.uid()));

drop policy if exists "mfa setups own rows" on public.mfa_setups;
create policy "mfa setups own rows" on public.mfa_setups for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Jobs, rate limits, and inbound failures stay service-role writable.
revoke all on table public.platform_jobs, public.platform_rate_limits, public.inbound_failures from authenticated, anon;
