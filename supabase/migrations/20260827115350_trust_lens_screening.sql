-- Trust Lens adds queryable authentication results and a reversible review state.
-- The existing evidence JSON remains the detailed, advisory record.
alter table public.messages add column if not exists auth_spf text;
alter table public.messages add column if not exists auth_dkim text;
alter table public.messages add column if not exists auth_dmarc text;
alter table public.messages add column if not exists auth_arc text;
alter table public.messages add column if not exists auth_tls text;
alter table public.messages add column if not exists screening_status text not null default 'none';
alter table public.messages add column if not exists screening_policy_id uuid references public.sender_policies(id) on delete set null;

alter table public.messages drop constraint if exists messages_screening_status_check;
alter table public.messages add constraint messages_screening_status_check
  check (screening_status in ('none', 'review', 'approved', 'blocked', 'rerouted'));

alter table public.screening_events drop constraint if exists screening_events_decision_check;
alter table public.screening_events add constraint screening_events_decision_check
  check (decision in ('screened', 'allowed', 'blocked', 'restored', 'rerouted'));

create index if not exists messages_owner_screening_queue_idx
  on public.messages(owner_id, screening_status, created_at desc)
  where screening_status = 'review';
create index if not exists messages_owner_auth_status_idx
  on public.messages(owner_id, auth_spf, auth_dkim, auth_dmarc, auth_arc, auth_tls);
