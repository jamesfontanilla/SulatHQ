create extension if not exists pg_trgm;

alter table public.messages drop constraint if exists messages_folder_check;
alter table public.messages add constraint messages_folder_check
  check (folder in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'custom'));
alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('draft', 'queued', 'scheduled', 'sent', 'delivered', 'failed', 'received', 'bounced'));

alter table public.mailboxes add column if not exists reply_to text;
alter table public.mailboxes add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.messages add column if not exists custom_folder_id uuid;
alter table public.messages add column if not exists previous_folder text;
alter table public.messages add column if not exists raw_object_key text;
alter table public.messages add column if not exists scheduled_at timestamptz;
alter table public.messages add column if not exists snoozed_until timestamptz;
alter table public.messages add column if not exists priority smallint not null default 0;
alter table public.messages add column if not exists is_pinned boolean not null default false;
alter table public.messages add column if not exists is_flagged boolean not null default false;
alter table public.messages add column if not exists has_attachment boolean not null default false;
alter table public.messages add column if not exists spam_score numeric(5,4) not null default 0;
alter table public.messages add column if not exists spam_reasons jsonb not null default '[]'::jsonb;
alter table public.messages add column if not exists focused_score numeric(5,4) not null default 0.5;
alter table public.messages add column if not exists focused_category text not null default 'focused';
alter table public.messages add column if not exists auth_results jsonb not null default '{}'::jsonb;
alter table public.messages add column if not exists search_vector tsvector;
alter table public.messages add column if not exists updated_at timestamptz not null default now();

create table if not exists public.mail_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  color text not null default '#6f7d91',
  parent_id uuid references public.mail_folders(id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(owner_id, slug)
);

alter table public.messages drop constraint if exists messages_custom_folder_fk;
alter table public.messages add constraint messages_custom_folder_fk
  foreign key (custom_folder_id) references public.mail_folders(id) on delete set null;

create table if not exists public.labels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#2d5bff',
  created_at timestamptz not null default now(),
  unique(owner_id, name)
);

create table if not exists public.message_labels (
  message_id uuid not null references public.messages(id) on delete cascade,
  label_id uuid not null references public.labels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(message_id, label_id)
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null,
  company text,
  notes text,
  favorite boolean not null default false,
  last_contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, email)
);

create table if not exists public.mail_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  priority integer not null default 100,
  enabled boolean not null default true,
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.signatures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid references public.mailboxes(id) on delete cascade,
  name text not null,
  text_body text not null default '',
  html_body text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auto_replies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  enabled boolean not null default false,
  subject text not null default 'Automatic reply',
  body text not null default '',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, mailbox_id)
);

create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'light',
  density text not null default 'comfortable',
  reading_pane text not null default 'right',
  language text not null default 'en',
  timezone text not null default 'Asia/Manila',
  focused_inbox_enabled boolean not null default true,
  desktop_notifications boolean not null default false,
  push_subscription jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  attendees jsonb not null default '[]'::jsonb,
  recurrence jsonb,
  source_message_id uuid references public.messages(id) on delete set null,
  external_provider text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  notes text not null default '',
  due_at timestamptz,
  priority smallint not null default 0,
  completed boolean not null default false,
  source_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mailbox_members (
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check(role in ('viewer', 'editor', 'delegate')),
  created_at timestamptz not null default now(),
  primary key(mailbox_id, member_id)
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  status text not null default 'not_configured',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, provider)
);

create table if not exists public.spam_feedback (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  feedback text not null check(feedback in ('spam', 'not_spam')),
  created_at timestamptz not null default now()
);

create or replace function public.messages_search_vector_fn()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_vector := to_tsvector('simple', concat_ws(' ', new.subject, new.from_address, new.text_body));
  return new;
end;
$$;

drop trigger if exists messages_search_vector_trigger on public.messages;
create trigger messages_search_vector_trigger
before insert or update of subject, from_address, text_body on public.messages
for each row execute function public.messages_search_vector_fn();

update public.messages
set search_vector = to_tsvector('simple', concat_ws(' ', subject, from_address, text_body))
where search_vector is null;

create index if not exists messages_search_vector_idx on public.messages using gin(search_vector);
create index if not exists messages_owner_custom_folder_idx on public.messages(owner_id, custom_folder_id, created_at desc);
create index if not exists messages_owner_snooze_idx on public.messages(owner_id, snoozed_until);
create index if not exists messages_owner_schedule_idx on public.messages(owner_id, scheduled_at);
create index if not exists messages_sender_trgm_idx on public.messages using gin(from_address gin_trgm_ops);
create index if not exists message_labels_label_idx on public.message_labels(label_id);
create index if not exists contacts_owner_email_idx on public.contacts(owner_id, email);
create index if not exists calendar_events_owner_start_idx on public.calendar_events(owner_id, starts_at);
create index if not exists tasks_owner_due_idx on public.tasks(owner_id, due_at);

alter table public.mail_folders enable row level security;
alter table public.labels enable row level security;
alter table public.message_labels enable row level security;
alter table public.contacts enable row level security;
alter table public.mail_rules enable row level security;
alter table public.signatures enable row level security;
alter table public.auto_replies enable row level security;
alter table public.user_settings enable row level security;
alter table public.calendar_events enable row level security;
alter table public.tasks enable row level security;
alter table public.mailbox_members enable row level security;
alter table public.integrations enable row level security;
alter table public.spam_feedback enable row level security;

drop policy if exists "folders own rows" on public.mail_folders;
create policy "folders own rows" on public.mail_folders for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "labels own rows" on public.labels;
create policy "labels own rows" on public.labels for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "message labels own rows" on public.message_labels;
create policy "message labels own rows" on public.message_labels for all to authenticated
  using (exists(select 1 from public.messages m where m.id = message_id and m.owner_id = (select auth.uid())))
  with check (exists(select 1 from public.messages m where m.id = message_id and m.owner_id = (select auth.uid())));
drop policy if exists "contacts own rows" on public.contacts;
create policy "contacts own rows" on public.contacts for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "rules own rows" on public.mail_rules;
create policy "rules own rows" on public.mail_rules for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "signatures own rows" on public.signatures;
create policy "signatures own rows" on public.signatures for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "auto replies own rows" on public.auto_replies;
create policy "auto replies own rows" on public.auto_replies for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "settings own rows" on public.user_settings;
create policy "settings own rows" on public.user_settings for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "calendar own rows" on public.calendar_events;
create policy "calendar own rows" on public.calendar_events for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "tasks own rows" on public.tasks;
create policy "tasks own rows" on public.tasks for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "members own rows" on public.mailbox_members;
create policy "members own rows" on public.mailbox_members for all to authenticated
  using (exists(select 1 from public.mailboxes m where m.id = mailbox_id and m.owner_id = (select auth.uid())) or (select auth.uid()) = member_id)
  with check (exists(select 1 from public.mailboxes m where m.id = mailbox_id and m.owner_id = (select auth.uid())));
drop policy if exists "integrations own rows" on public.integrations;
create policy "integrations own rows" on public.integrations for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists "spam feedback own rows" on public.spam_feedback;
create policy "spam feedback own rows" on public.spam_feedback for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
