-- Tests for supabase/pending/20261108_private_realtime_channels.sql, which is
-- NOT applied yet (see that file's header for when to apply it).
--
-- How to run: apply that file first (the migrations, then the pending file),
-- then run this whole script like tests/rls.sql: as postgres, in the SQL
-- editor or `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f <this file>`. It is
-- self-contained (it makes its own test users, the way rls.sql's setup does)
-- and runs in one transaction that is rolled back. Failures raise 'FAIL: ...'.
-- tests/rls.sql still expects public signals, so do not run the two against
-- the same database state without deciding which is current: once the pending
-- file is applied, change rls.sql's signal check back to require
-- `m.private` (it says `not m.private` while signals are public).

begin;

create function pg_temp.ok(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL: %', what;
  end if;
end;
$$;

create function pg_temp.token(who text, extra jsonb default '{}') returns text
language sql immutable as $$
  select (jsonb_build_object(
            'sub', 'user_' || who,
            'role', 'authenticated',
            'iss', 'https://smiling-sunbird-3571.clerk.accounts.dev',
            'sts', 'active')
          || extra)::text;
$$;

-- Ana, Ben and Cat are listed development accounts; Eve is not.
insert into private.dev_accounts (user_id) values ('user_ana'), ('user_ben'), ('user_cat');
insert into public.profiles (id, username) values ('user_ana', 'ana'), ('user_ben', 'ben'), ('user_cat', 'cat'), ('user_eve', 'eve');

set local role authenticated;
do $$
declare
  who text;
begin
  foreach who in array array['ana', 'ben', 'cat'] loop
    perform set_config('request.jwt.claims', pg_temp.token(who), true);
    perform set_config('rls_test.inbox_' || who, public.my_inbox()::text, true);
  end loop;
end;
$$;
reset role;

-- A change that signals Ana's and Ben's inboxes (Cat's stays quiet).
insert into public.friendships (requester, addressee) values ('user_ana', 'user_ben');
do $$
begin
  perform pg_temp.ok(
    exists (select 1 from realtime.messages m where m.topic = 'inbox:' || current_setting('rls_test.inbox_ana')),
    'the change signalled Ana''s inbox');
  perform pg_temp.ok(
    (select bool_and(m.payload - 'id' = '{}'::jsonb and m.private) from realtime.messages m where m.topic like 'inbox:%'),
    'a signal carries nothing but its name, on a private channel');
end;
$$;

-- Private channels: who may listen and send ----------------------------------

-- Realtime checks the policies on realtime.messages with the channel's name in
-- realtime.topic() (https://supabase.com/docs/guides/realtime/authorization);
-- these tests set it the same way. Ana hosts an active session with Ben, and
-- has a pending one and an ended one.
reset role;
insert into public.cowork_sessions (id, host, guest, kind, status)
values ('00000000-0000-4000-8000-000000000001', 'user_ana', 'user_ben', 'invite', 'active'),
       ('00000000-0000-4000-8000-000000000002', 'user_ana', 'user_ben', 'invite', 'pending'),
       ('00000000-0000-4000-8000-000000000003', 'user_ana', 'user_ben', 'invite', 'ended');
-- A nudge already sent on the active session, and one on the ended one.
insert into realtime.messages (topic, extension, payload, event, private)
values ('nudge:00000000-0000-4000-8000-000000000001', 'broadcast', '{}'::jsonb, 'nudge', true),
       ('nudge:00000000-0000-4000-8000-000000000003', 'broadcast', '{}'::jsonb, 'nudge', true);

-- How many broadcast messages on this topic the caller may listen to.
create function pg_temp.hears(topic text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  perform set_config('realtime.topic', topic, true);
  select count(*) into n from realtime.messages m where m.extension = 'broadcast' and m.topic = hears.topic;
  return n;
end;
$$;

-- Can the caller send on this topic?
create function pg_temp.can_send(topic text, ext text default 'broadcast') returns boolean
language plpgsql as $$
begin
  perform set_config('realtime.topic', topic, true);
  begin
    insert into realtime.messages (topic, extension, payload, event, private)
    values (can_send.topic, can_send.ext, '{}'::jsonb, 'nudge', true);
  exception when insufficient_privilege then
    return false;
  end;
  return true;
end;
$$;

do $$
begin
  perform pg_temp.ok((select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass),
    'row-level security is on for realtime.messages');
  perform pg_temp.ok(
    not exists (select 1 from realtime.messages where private is not true and topic like 'inbox:%'),
    'no signal is on a public channel');
end;
$$;

-- Ana: her own inbox, and the nudges of an active session of hers.
set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
begin
  perform pg_temp.ok(pg_temp.hears('inbox:' || current_setting('rls_test.inbox_ana')) > 0, 'Ana listens to her own inbox');
  perform pg_temp.ok(pg_temp.hears('inbox:' || current_setting('rls_test.inbox_ben')) = 0, 'but not to Ben''s');
  perform pg_temp.ok(not pg_temp.can_send('inbox:' || current_setting('rls_test.inbox_ana')), 'no client sends to an inbox, not even its owner');
  perform pg_temp.ok(not pg_temp.can_send('inbox:' || current_setting('rls_test.inbox_ben')), 'nor to someone else''s');

  perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000001') >= 1, 'the host listens to an active session''s nudges');
  perform pg_temp.ok(pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'and nudges it');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001', 'presence'), 'only as a broadcast');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000002'), 'not a pending session');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000003'), 'not an ended one');
  perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000003') = 0, 'nor listens to an ended one');
  perform pg_temp.ok(not pg_temp.can_send('nudge:not-a-session'), 'not a malformed name');
  perform pg_temp.ok(not pg_temp.can_send('room:anything'), 'not any other topic');
end;
$$;

-- Ben, the guest: nudges the same, and nothing of Ana's inbox.
select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
begin
  perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000001') >= 1, 'the guest listens to an active session''s nudges');
  perform pg_temp.ok(pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'and sends them');
  perform pg_temp.ok(pg_temp.hears('inbox:' || current_setting('rls_test.inbox_ana')) = 0, 'but not Ana''s inbox');
  perform pg_temp.ok(not pg_temp.can_send('inbox:' || current_setting('rls_test.inbox_ana')), 'nor sends to it');
end;
$$;

-- Cat, a stranger.
select set_config('request.jwt.claims', pg_temp.token('cat'), true);

do $$
begin
  perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000001') = 0, 'a stranger hears no nudges');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'and sends none');
  perform pg_temp.ok(pg_temp.hears('inbox:' || current_setting('rls_test.inbox_ana')) = 0, 'nor hears Ana''s inbox');
end;
$$;

-- A token Clerk didn't issue, and a development account that isn't listed.
do $$
declare
  claims text;
begin
  foreach claims in array array[
    pg_temp.token('ben', '{"iss": "https://nbzojbfkkpeisitbkwpg.supabase.co/auth/v1"}'),
    pg_temp.token('eve')
  ] loop
    perform set_config('request.jwt.claims', claims, true);
    perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000001') = 0, 'no nudges for ' || claims);
    perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'no sending for ' || claims);
  end loop;
end;
$$;

-- When the session ends, so does the access: an ex-guest can't wake the host.
reset role;
update public.cowork_sessions set status = 'ended' where id = '00000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
begin
  perform pg_temp.ok(pg_temp.hears('nudge:00000000-0000-4000-8000-000000000001') = 0, 'after the session ends, the guest hears nothing');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'and cannot nudge');
end;
$$;

-- Signed out.
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

do $$
declare
  heard bigint := 0;
begin
  begin
    heard := pg_temp.hears('inbox:' || current_setting('rls_test.inbox_ana'));
  exception when insufficient_privilege then
    heard := 0;
  end;
  perform pg_temp.ok(heard = 0, 'signed out, nobody listens to an inbox');
  perform pg_temp.ok(not pg_temp.can_send('nudge:00000000-0000-4000-8000-000000000001'), 'nor nudges');
end;
$$;

reset role;

reset role;
select 'All private-channel tests passed' as result;

rollback;
