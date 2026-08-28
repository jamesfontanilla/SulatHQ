alter table public.messages add column if not exists from_name text not null default '';
alter table public.contacts add column if not exists avatar_url text;

alter table public.contacts drop constraint if exists contacts_avatar_url_https_check;
alter table public.contacts add constraint contacts_avatar_url_https_check
  check (avatar_url is null or avatar_url ~ '^https://');

create or replace function public.messages_search_vector_fn()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_vector := to_tsvector('simple', concat_ws(' ', new.subject, new.from_name, new.from_address, new.text_body));
  return new;
end;
$$;

drop trigger if exists messages_search_vector_trigger on public.messages;
create trigger messages_search_vector_trigger
before insert or update of subject, from_name, from_address, text_body on public.messages
for each row execute function public.messages_search_vector_fn();

update public.messages
set from_name = split_part(from_address, '@', 1)
where from_name is null or from_name = '';

update public.messages
set search_vector = to_tsvector('simple', concat_ws(' ', subject, from_name, from_address, text_body));

create index if not exists contacts_avatar_lookup_idx on public.contacts(owner_id, email);
