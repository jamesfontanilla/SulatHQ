create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  display_name text not null default '',
  is_default boolean not null default false,
  can_send boolean not null default true,
  can_receive boolean not null default true,
  created_at timestamptz not null default now(),
  unique(owner_id, address)
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  subject text not null default '(no subject)',
  subject_normalized text not null default '',
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  mailbox_id uuid references public.mailboxes(id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  folder text not null default 'inbox' check (folder in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam')),
  status text not null default 'received' check (status in ('draft', 'queued', 'sent', 'delivered', 'failed', 'received', 'bounced')),
  from_address text not null,
  to_addresses jsonb not null default '[]'::jsonb,
  cc_addresses jsonb not null default '[]'::jsonb,
  bcc_addresses jsonb not null default '[]'::jsonb,
  reply_to text,
  subject text not null default '(no subject)',
  text_body text not null default '',
  html_body text,
  snippet text not null default '',
  message_id_header text,
  in_reply_to text,
  references_header text,
  provider_message_id text,
  is_read boolean not null default false,
  is_starred boolean not null default false,
  received_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  object_key text not null,
  filename text not null,
  content_type text not null default 'application/octet-stream',
  byte_size bigint not null default 0,
  content_id text,
  disposition text,
  created_at timestamptz not null default now()
);

create table if not exists public.mail_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  provider text not null,
  event_type text not null,
  provider_message_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_owner_folder_idx on public.messages(owner_id, folder, created_at desc);
create index if not exists messages_owner_thread_idx on public.messages(owner_id, thread_id, created_at asc);
create index if not exists messages_external_id_idx on public.messages(owner_id, message_id_header);
create index if not exists messages_provider_id_idx on public.messages(provider_message_id);
create index if not exists attachments_message_idx on public.attachments(message_id);

alter table public.profiles enable row level security;
alter table public.mailboxes enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.mail_events enable row level security;

drop policy if exists "profiles own rows" on public.profiles;
create policy "profiles own rows" on public.profiles for all to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "mailboxes own rows" on public.mailboxes;
create policy "mailboxes own rows" on public.mailboxes for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists "threads own rows" on public.threads;
create policy "threads own rows" on public.threads for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists "messages own rows" on public.messages;
create policy "messages own rows" on public.messages for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists "attachments own rows" on public.attachments;
create policy "attachments own rows" on public.attachments for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

drop policy if exists "events own rows" on public.mail_events;
create policy "events own rows" on public.mail_events for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

insert into storage.buckets (id, name, public)
values ('mail-raw', 'mail-raw', false)
on conflict (id) do update set public = false;

drop policy if exists "mail owner reads files" on storage.objects;
create policy "mail owner reads files" on storage.objects for select to authenticated
  using (bucket_id = 'mail-raw' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "mail owner uploads files" on storage.objects;
create policy "mail owner uploads files" on storage.objects for insert to authenticated
  with check (bucket_id = 'mail-raw' and (storage.foldername(name))[1] = (select auth.uid()::text));
