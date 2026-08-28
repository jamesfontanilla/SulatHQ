begin;

select plan(6);

insert into auth.users (id, email)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner-a@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner-b@example.com');

insert into public.organizations (id, name, slug)
values
  ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Org A', 'org-a'),
  ('22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Org B', 'org-b');

insert into public.organization_members (organization_id, user_id, role)
values
  ('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

insert into public.domains (id, organization_id, domain_name, verification_token, verification_status)
values
  ('11111111-aaaa-aaaa-aaaa-aaaaaaaa0001', '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a.example', 'token-a', 'verified'),
  ('22222222-bbbb-bbbb-bbbb-bbbbbbbb0001', '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b.example', 'token-b', 'pending');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.domains),
  1::bigint,
  'an org member cannot read another organization domain'
);

select throws_ok(
  $$insert into public.domains (organization_id, domain_name, verification_token) values ('22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'stolen.example', 'nope')$$,
  'new row violates row-level security policy for table "domains"'
);

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.domains),
  1::bigint,
  'org B can read its own domain'
);

select is(
  (select verification_status from public.domains where domain_name = 'b.example'),
  'pending',
  'pending domains stay pending until a server-side check succeeds'
);

reset role;

select is(
  (select count(*) from public.domains),
  2::bigint,
  'service role can read every tenant domain'
);

select * from finish();
rollback;
