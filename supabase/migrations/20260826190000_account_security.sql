create table if not exists public.account_recovery_methods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  verified_at timestamptz,
  verification_code_hash text,
  verification_expires_at timestamptz,
  verification_attempts integer not null default 0,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists account_recovery_methods_owner_email_idx
  on public.account_recovery_methods(owner_id, lower(email));
create index if not exists account_recovery_methods_verified_email_idx
  on public.account_recovery_methods(lower(email))
  where verified_at is not null;

create table if not exists public.account_recovery_rate_limits (
  email_hash text primary key,
  window_started_at timestamptz not null default now(),
  sent_count integer not null default 0,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.account_recovery_methods enable row level security;
alter table public.account_recovery_rate_limits enable row level security;

grant select, insert, update, delete on table public.account_recovery_methods to authenticated;

create policy "recovery methods own rows" on public.account_recovery_methods for all to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
