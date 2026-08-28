begin;

select plan(8);

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'parcel-owner-test@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'parcel-member-test@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'parcel-other-test@example.com');

insert into public.saved_searches (id, owner_id, name, query)
values
  ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111111', 'Owner search', 'is:unread'),
  ('22222222-2222-2222-2222-222222222202', '22222222-2222-2222-2222-222222222222', 'Other search', 'is:starred');

insert into public.message_audit_log (id, owner_id, action_type, target_type)
values
  ('11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111111', 'test', 'message');

insert into public.mailboxes (id, owner_id, address, display_name)
values
  ('11111111-1111-1111-1111-111111111103', '11111111-1111-1111-1111-111111111111', 'owner-test@jamesfontanilla.com', 'Owner test');

insert into public.mailbox_members (mailbox_id, member_id, role)
values
  ('11111111-1111-1111-1111-111111111103', '22222222-2222-2222-2222-222222222222', 'viewer');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select is(
  (select count(*) from public.saved_searches),
  1::bigint,
  'an owner can read only their saved searches'
);
select is(
  (select count(*) from public.message_audit_log),
  1::bigint,
  'an owner can read their audit entries'
);
select is(
  (select count(*) from public.mailbox_members),
  1::bigint,
  'a mailbox owner can read membership rows'
);

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

select is(
  (select count(*) from public.saved_searches),
  0::bigint,
  'an unrelated user cannot read saved searches'
);
select is(
  (select count(*) from public.message_audit_log),
  0::bigint,
  'an unrelated user cannot read audit entries'
);
select is(
  (select count(*) from public.mailbox_members),
  0::bigint,
  'an unrelated user cannot read mailbox memberships'
);

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

select is(
  (select count(*) from public.mailbox_members),
  1::bigint,
  'a member can read their own membership row'
);
select is(
  (select count(*) from public.mailbox_invitations),
  0::bigint,
  'a member cannot read the owners invitation records'
);

select * from finish();
rollback;
