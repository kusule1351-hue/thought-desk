-- Row-level security tests for the accounts, friends and sessions schema
-- (supabase/migrations/, as of *_security_audit_fixes.sql).
--
-- Run the whole file as one script against a database that has the
-- migrations: the Supabase SQL editor, psql, or the Supabase MCP execute_sql
-- tool. It runs in one transaction that is rolled back at the end, so the
-- test users and rows never persist. A failed check raises 'FAIL: ...' and
-- stops the run; if every check passes, the last result says so.
--
-- People are signed in the way Clerk signs them in: request.jwt.claims holds
-- a Clerk session token's claims (sub is a Clerk user id like 'user_ana').

begin;


-- Helpers (temporary functions; they disappear with the session) -------------

-- Raise unless `ok` is true.
create function pg_temp.ok(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL: %', what;
  end if;
end;
$$;

-- Run `stmt` and raise unless it fails with SQLSTATE `state` (and, if given,
-- with a message LIKE `message`).
create function pg_temp.fails(stmt text, state text, what text, message text default null) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = state and (message is null or sqlerrm like message) then
      return;
    end if;
    raise exception 'FAIL: % (wanted %, got %: %)', what, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (the statement succeeded)', what;
end;
$$;

-- Run `stmt` and return how many rows it changed.
create function pg_temp.changed(stmt text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The test users' Clerk ids.
create function pg_temp.uid(who text) returns text
language sql immutable as $$
  select 'user_' || who;
$$;

-- The claims of a Clerk session token for `who` from the development
-- instance, with `extra` added or overriding. (The development instance is
-- trusted only for ids in private.dev_accounts: Ana, Ben and Cat are listed
-- below. Production tokens add '{"iss": "https://clerk.thoughtdesk.org"}'.)
create function pg_temp.token(who text, extra jsonb default '{}') returns text
language sql immutable as $$
  select (jsonb_build_object(
            'sub', 'user_' || who,
            'role', 'authenticated',
            'iss', 'https://smiling-sunbird-3571.clerk.accounts.dev',
            'sts', 'active')
          || extra)::text;
$$;

-- Session ids, handed from one user's block to the next.
create function pg_temp.sid(label text) returns uuid
language sql stable as $$
  select current_setting('rls_test.' || label)::uuid;
$$;

-- How many `kind` signals ('friends' or 'sessions') reached someone's inbox.
create function pg_temp.signals(who text, kind text) returns bigint
language sql stable as $$
  select count(*) from realtime.messages m
  where m.topic = 'inbox:' || current_setting('rls_test.inbox_' || who) and m.event = kind;
$$;


-- Setup: Ana, Ben and Cat sign up --------------------------------------------

-- The owner lists the test users as development accounts.
insert into private.dev_accounts (user_id) values ('user_ana'), ('user_ben'), ('user_cat');

-- Signing in makes the profile (ensure_profile), from the name and picture
-- in the token.
set local role authenticated;

select set_config('request.jwt.claims',
  pg_temp.token('ana', '{"name": "Ana Lima", "picture": "https://img.clerk.com/eyJ0eXBlIjoicHJveHkifQ", "has_image": true}'), true);
select public.ensure_profile();

-- Ben's name is blank, and his picture is Clerk's stand-in (has_image false).
select set_config('request.jwt.claims',
  pg_temp.token('ben', '{"name": "  ", "picture": "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCJ9", "has_image": false}'), true);
select public.ensure_profile();

-- Cat has no name, and a picture on some other host.
select set_config('request.jwt.claims',
  pg_temp.token('cat', '{"name": null, "picture": "https://tracker.example.test/cat.png", "has_image": true}'), true);
select public.ensure_profile();

do $$
begin
  perform pg_temp.ok((select count(*) from public.profiles) = 1, 'Cat sees only her own profile after signing up');
  perform pg_temp.ok((select private.me()) = pg_temp.uid('cat'), 'private.me() is the token''s sub');
end;
$$;

reset role;

do $$
begin
  perform pg_temp.ok(
    (select count(*) from public.profiles
     where id in (pg_temp.uid('ana'), pg_temp.uid('ben'), pg_temp.uid('cat'))) = 3,
    'ensure_profile made a profile for each user');
  perform pg_temp.ok(
    (select display_name = 'Ana Lima' and avatar_url = 'https://img.clerk.com/eyJ0eXBlIjoicHJveHkifQ' and username is null
     from public.profiles where id = pg_temp.uid('ana')),
    'Ana: the token''s name and Clerk picture are used; no username yet');
  perform pg_temp.ok(
    (select display_name = '' and avatar_url is null
     from public.profiles where id = pg_temp.uid('ben')),
    'Ben: a blank name is left empty; Clerk''s stand-in picture (has_image false) is dropped');
  perform pg_temp.ok(
    (select display_name = '' and avatar_url is null
     from public.profiles where id = pg_temp.uid('cat')),
    'Cat: no name; a picture on another host is dropped');

  -- A picture on any other host would show its owner the IP addresses of
  -- everyone who sees the profile.
  perform pg_temp.fails($q$update public.profiles set avatar_url = 'https://tracker.example.test/x.png' where id = pg_temp.uid('ana')$q$,
    '23514', 'even the database owner cannot store an avatar on another host');
  perform pg_temp.fails($q$update public.profiles set avatar_url = 'http://img.clerk.com/x' where id = pg_temp.uid('ana')$q$,
    '23514', 'nor an http one');
  perform pg_temp.fails($q$insert into public.profiles (id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$q$,
    '23514', 'a profile id must be a Clerk user id');

  perform pg_temp.ok(
    (select bool_and(relrowsecurity) from pg_class
     where oid in ('public.profiles'::regclass, 'public.friendships'::regclass,
                   'public.presence'::regclass, 'public.cowork_sessions'::regclass,
                   'private.friend_requests_sent'::regclass, 'private.profile_lookups'::regclass)),
    'RLS is on for every table');

  -- Realtime sends a deleted row's key to everyone listening, so a
  -- friendship's key must not be the two people.
  perform pg_temp.ok(
    (select array_agg(a.attname::text) from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = 'public.friendships'::regclass and i.indisprimary) = array['id'],
    'a friendship''s key is an opaque id, not who it is between');
  perform pg_temp.ok(
    not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'),
    'Supabase Auth sign-ups no longer make profiles');
end;
$$;

-- Ana and Ben pick usernames (Cat picks hers further down), and Ben a name.
-- Ben and Cat have been online before; Ana's presence row comes from
-- touch_presence().
update public.profiles set username = 'ana' where id = 'user_ana';
update public.profiles set username = 'ben', display_name = 'Ben Okafor' where id = 'user_ben';
insert into public.presence (user_id) values ('user_ben'), ('user_cat');


-- Inboxes: each person's own, for the signals that changes send -------------

set local role authenticated;

do $$
declare
  who text;
  box uuid;
begin
  foreach who in array array['ana', 'ben', 'cat'] loop
    perform set_config('request.jwt.claims', pg_temp.token(who), true);
    box := public.my_inbox();
    perform pg_temp.ok(box = public.my_inbox(), who || '''s inbox stays the same');
    perform set_config('rls_test.inbox_' || who, box::text, true);
  end loop;
  perform pg_temp.ok(
    (select count(distinct v) from unnest(array[current_setting('rls_test.inbox_ana'), current_setting('rls_test.inbox_ben'), current_setting('rls_test.inbox_cat')]) v) = 3,
    'everyone has an inbox of their own');
  perform pg_temp.fails('select count(*) from private.inboxes', '42501', 'nobody can read the inboxes, so nobody learns another''s');
  perform set_config('request.jwt.claims', pg_temp.token('ana', '{"iss": "https://nbzojbfkkpeisitbkwpg.supabase.co/auth/v1"}'), true);
  perform pg_temp.fails('select public.my_inbox()', '42501', 'a token Clerk didn''t issue gets no inbox');
end;
$$;


-- Tokens Clerk didn't issue get nothing ---------------------------------------

set local role authenticated;

do $$
declare
  claims text;
begin
  foreach claims in array array[
    -- Supabase Auth's own token for the same id
    pg_temp.token('ana', '{"iss": "https://nbzojbfkkpeisitbkwpg.supabase.co/auth/v1"}'),
    -- another Clerk instance
    pg_temp.token('ana', '{"iss": "https://someone-else.clerk.accounts.dev"}'),
    -- no issuer at all
    pg_temp.token('ana', '{"iss": null}'),
    -- a session still waiting on a step (Clerk's "pending")
    pg_temp.token('ana', '{"sts": "pending"}')
  ] loop
    perform set_config('request.jwt.claims', claims, true);
    perform pg_temp.ok((select private.me()) is null, 'private.me() is null for ' || claims);
    perform pg_temp.ok((select count(*) from public.profiles) = 0, 'no profiles for ' || claims);
    perform pg_temp.ok(not exists (select 1 from public.find_profile('ben')), 'find_profile finds nobody for ' || claims);
    perform pg_temp.fails('select public.ensure_profile()', '42501', 'ensure_profile refuses ' || claims);
    perform pg_temp.fails('select public.touch_presence()', '42501', 'touch_presence refuses ' || claims);
    perform pg_temp.ok(pg_temp.changed($q$update public.profiles set display_name = 'x'$q$) = 0, 'no edits for ' || claims);
  end loop;

  -- The right issuer with an id that isn't Clerk's.
  perform set_config('request.jwt.claims', pg_temp.token('ana', '{"sub": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'), true);
  perform pg_temp.fails('select public.ensure_profile()', '23514', 'a profile id must be a Clerk user id, even from Clerk''s issuer');
end;
$$;


-- The development instance counts only for listed accounts ---------------------

reset role;

do $$
begin
  perform pg_temp.fails($q$insert into private.dev_accounts (user_id) values ('not a clerk id')$q$,
    '23514', 'the list holds Clerk user ids only');
end;
$$;

set local role authenticated;

do $$
begin
  perform pg_temp.fails('select * from private.dev_accounts', '42501', 'signed-in people cannot read the development accounts');
  perform pg_temp.fails($q$insert into private.dev_accounts (user_id) values ('user_eve')$q$,
    '42501', 'nor add themselves to it');
  perform pg_temp.fails('delete from private.dev_accounts', '42501', 'nor remove anyone from it');

  -- An unlisted development account gets nothing, with an otherwise valid token.
  perform set_config('request.jwt.claims', pg_temp.token('eve'), true);
  perform pg_temp.ok((select private.me()) is null, 'an unlisted development account is signed out');
  perform pg_temp.fails('select public.ensure_profile()', '42501', 'it cannot make a profile');
  perform pg_temp.fails('select public.my_inbox()', '42501', 'nor an inbox');
  perform pg_temp.ok(not exists (select 1 from public.find_profile('ana')), 'nor look anyone up');

  -- A production token needs no listing.
  perform set_config('request.jwt.claims', pg_temp.token('dan', '{"iss": "https://clerk.thoughtdesk.org"}'), true);
  perform pg_temp.ok((select private.me()) = pg_temp.uid('dan'), 'a production token works without being listed');
  perform pg_temp.ok((select id from public.ensure_profile()) = pg_temp.uid('dan'), 'and makes a profile');
  -- A pending production session still counts for nothing.
  perform set_config('request.jwt.claims', pg_temp.token('dan', '{"iss": "https://clerk.thoughtdesk.org", "sts": "pending"}'), true);
  perform pg_temp.ok((select private.me()) is null, 'a pending production session is signed out');
end;
$$;

-- The owner lists Eve: now she is in. Unlisting her ends it at once.
reset role;
insert into private.dev_accounts (user_id) values ('user_eve');
set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('eve'), true);

do $$
begin
  perform pg_temp.ok((select private.me()) = pg_temp.uid('eve'), 'a listed development account is signed in');
end;
$$;

reset role;
delete from private.dev_accounts where user_id = 'user_eve';
set local role authenticated;

do $$
begin
  perform pg_temp.ok((select private.me()) is null, 'removing her from the list signs her out');
end;
$$;


-- Ana: strangers stay hidden; find_profile matches exact usernames only ------

select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
begin
  perform public.touch_presence();

  perform pg_temp.ok((select count(*) from public.profiles) = 1, 'Ana sees only her own profile');
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = pg_temp.uid('ben')),
    'a stranger''s profile is invisible');
  perform pg_temp.ok((select count(*) from public.presence) = 1,
    'Ana sees only her own presence, which touch_presence() created');

  perform pg_temp.ok((select id from public.find_profile('ben')) = pg_temp.uid('ben'),
    'find_profile finds an exact username');
  perform pg_temp.ok((select id from public.find_profile(' @Ben ')) = pg_temp.uid('ben'),
    'find_profile ignores case, surrounding spaces and a leading @');
  perform pg_temp.ok((select display_name from public.find_profile('ben')) = 'Ben Okafor',
    'find_profile returns the display name');
  perform pg_temp.ok(not exists (select 1 from public.find_profile('be')), 'find_profile does not match a prefix');
  perform pg_temp.ok(not exists (select 1 from public.find_profile('b%')), 'find_profile does not match a pattern');
  perform pg_temp.ok(not exists (select 1 from public.find_profile('Ben Okafor')), 'find_profile does not match display names');
  perform pg_temp.ok(not exists (select 1 from public.find_profile('ana')), 'find_profile never returns yourself');
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = pg_temp.uid('ben')),
    'finding Ben does not make his profile row visible');

  -- Her own profile, and only the editable columns.
  perform pg_temp.ok(
    pg_temp.changed($q$update public.profiles set display_name = 'Ana L.' where id = pg_temp.uid('ana')$q$) = 1,
    'Ana can edit her own profile');
  perform pg_temp.ok(
    pg_temp.changed($q$update public.profiles set display_name = 'Hacked' where id = pg_temp.uid('ben')$q$) = 0,
    'Ana cannot edit Ben''s profile');
  perform pg_temp.fails($q$update public.profiles set created_at = now() where id = pg_temp.uid('ana')$q$,
    '42501', 'created_at cannot be changed');
  perform pg_temp.fails($q$update public.profiles set id = 'user_other' where id = pg_temp.uid('ana')$q$,
    '42501', 'nobody changes their id');
  perform pg_temp.fails($q$update public.profiles set username = 'Ana!' where id = pg_temp.uid('ana')$q$,
    '23514', 'usernames must match ^[a-z0-9_]{3,20}$');
  perform pg_temp.fails($q$update public.profiles set avatar_url = 'https://img.clerk.com/mine' where id = pg_temp.uid('ana')$q$,
    '42501', 'nobody sets their own avatar: only ensure_profile does, from the token');
  perform pg_temp.fails($q$insert into public.profiles (id) values ('user_new')$q$,
    '42501', 'profiles cannot be inserted directly');
  perform pg_temp.fails($q$delete from public.profiles where id = pg_temp.uid('ana')$q$,
    '42501', 'profiles cannot be deleted directly');
  perform pg_temp.fails($q$insert into public.presence (user_id) values (pg_temp.uid('ana'))$q$,
    '42501', 'presence is written only by touch_presence()');

  -- Signing in again keeps the name she chose, and follows Clerk's picture.
  perform set_config('request.jwt.claims',
    pg_temp.token('ana', '{"name": "Ana Lima", "picture": "https://img.clerk.com/new", "has_image": true}'), true);
  perform pg_temp.ok(
    (select display_name = 'Ana L.' and avatar_url = 'https://img.clerk.com/new' from public.ensure_profile()),
    'signing in again keeps her name and takes the new picture');
  perform set_config('request.jwt.claims',
    pg_temp.token('ana', '{"name": "Ana Lima", "picture": "https://img.clerk.com/stand-in", "has_image": false}'), true);
  perform pg_temp.ok((select avatar_url is null from public.ensure_profile()),
    'removing the picture in Clerk removes it here');
  perform set_config('request.jwt.claims', pg_temp.token('ana'), true);

  -- Internal functions are off limits.
  perform pg_temp.fails('select public.rls_auto_enable()', '42501', 'rls_auto_enable() cannot be called');
  perform pg_temp.fails('select private.expire_stale_sessions()', '42501', 'the expiry sweep cannot be called');
  perform pg_temp.fails('select private.limit_friend_requests()', '42501', 'the request limit trigger cannot be called');
  perform pg_temp.fails('select count(*) from private.profile_lookups', '42501', 'the lookup log cannot be read');
  perform pg_temp.fails('select count(*) from private.friend_requests_sent', '42501', 'the request log cannot be read');

  -- Friend requests: as yourself, pending, to someone who has a username.
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ben'), pg_temp.uid('ana'))$q$,
    '42501', 'Ana cannot send a request as Ben');
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee, status) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'accepted')$q$,
    '42501', 'a request cannot start accepted');
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), pg_temp.uid('cat'))$q$,
    '42501', 'a request needs the addressee to have a username');
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), pg_temp.uid('ana'))$q$,
    '23514', 'no requests to yourself');
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee, created_at) values (pg_temp.uid('ana'), pg_temp.uid('ben'), now())$q$,
    '42501', 'created_at cannot be set');

  insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), pg_temp.uid('ben'));
  perform pg_temp.ok((select status = 'pending' and accepted_at is null from public.friendships),
    'Ana''s request to Ben is pending');
  perform pg_temp.ok(exists (select 1 from public.profiles where id = pg_temp.uid('ben')),
    'once there is a request, Ana sees Ben''s profile');
  perform pg_temp.ok(not exists (select 1 from public.presence where user_id = pg_temp.uid('ben')),
    'a pending request does not share presence');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite')$q$,
    '42501', 'someone who hasn''t accepted yet cannot be invited');

  -- The requester can't accept, and can't change anything else.
  perform pg_temp.ok(pg_temp.changed($q$update public.friendships set status = 'accepted'$q$) = 0,
    'the requester cannot accept her own request');
  perform pg_temp.fails($q$update public.friendships set addressee = pg_temp.uid('cat')$q$,
    '42501', 'the requester cannot change the addressee');
  perform pg_temp.fails($q$update public.friendships set requester = pg_temp.uid('cat')$q$,
    '42501', 'the requester cannot change the requester');
  perform pg_temp.fails($q$update public.friendships set accepted_at = now()$q$,
    '42501', 'accepted_at cannot be set directly');
  perform pg_temp.fails($q$update public.friendships set created_at = now()$q$,
    '42501', 'created_at cannot be changed');
  perform pg_temp.ok((select status from public.friendships) = 'pending', 'the request is still pending');
end;
$$;


-- Ben: only the addressee accepts --------------------------------------------

select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
begin
  perform public.touch_presence();

  perform pg_temp.ok(exists (select 1 from public.profiles where id = pg_temp.uid('ana')),
    'Ben sees the profile of the person asking him');
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = pg_temp.uid('cat')),
    'Ben does not see Cat');
  perform pg_temp.ok(not exists (select 1 from public.presence where user_id = pg_temp.uid('ana')),
    'Ben does not see Ana''s presence while the request is pending');

  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ben'), pg_temp.uid('ana'))$q$,
    '23505', 'one row per pair, whichever way it was sent');
  perform pg_temp.fails($q$update public.friendships set requester = pg_temp.uid('cat')$q$,
    '42501', 'the addressee cannot change other columns either');
  perform pg_temp.fails($q$update public.friendships set status = 'pending'$q$,
    '42501', 'the addressee can only set accepted');

  perform pg_temp.ok(
    pg_temp.changed($q$update public.friendships set status = 'accepted' where requester = pg_temp.uid('ana') and addressee = pg_temp.uid('ben')$q$) = 1,
    'the addressee accepts');
  perform pg_temp.ok((select accepted_at is not null from public.friendships where requester = pg_temp.uid('ana')),
    'the trigger set accepted_at');
  perform pg_temp.ok(exists (select 1 from public.presence where user_id = pg_temp.uid('ana')),
    'friends see each other''s presence');
  perform pg_temp.ok(
    public.are_friends(pg_temp.uid('ana'), pg_temp.uid('ben')) and public.are_friends(pg_temp.uid('ben'), pg_temp.uid('ana')),
    'are_friends is true both ways');
end;
$$;


-- Cat: a stranger to both of them --------------------------------------------

select set_config('request.jwt.claims', pg_temp.token('cat'), true);

do $$
begin
  perform pg_temp.ok((select count(*) from public.profiles) = 1, 'Cat sees only her own profile');
  perform pg_temp.ok((select count(*) from public.friendships) = 0, 'Cat cannot see Ana and Ben''s friendship');
  perform pg_temp.ok((select count(*) from public.presence) = 1, 'Cat sees only her own presence');
  perform pg_temp.ok(not public.are_friends(pg_temp.uid('ana'), pg_temp.uid('ben')),
    'are_friends does not reveal other people''s friendships');
  perform pg_temp.ok(pg_temp.changed($q$update public.friendships set status = 'accepted'$q$) = 0,
    'Cat cannot change their friendship');
  perform pg_temp.ok(pg_temp.changed('delete from public.friendships') = 0,
    'Cat cannot remove their friendship');

  perform pg_temp.fails($q$update public.profiles set username = 'ana' where id = pg_temp.uid('cat')$q$,
    '23505', 'usernames are unique');
  perform pg_temp.ok(
    pg_temp.changed($q$update public.profiles set username = 'cat' where id = pg_temp.uid('cat')$q$) = 1,
    'Cat picks a username');
  perform pg_temp.ok((select id from public.find_profile('@ana')) = pg_temp.uid('ana'), 'Cat can look Ana up');
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = pg_temp.uid('ana')),
    'but Ana''s profile row stays hidden from Cat');
end;
$$;


-- Ana invites Ben; nobody else can be invited --------------------------------

select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
declare
  label text;
  new_id uuid;
begin
  perform pg_temp.ok(exists (select 1 from public.presence where user_id = pg_temp.uid('ben')),
    'Ana sees her friend Ben''s presence');
  perform pg_temp.ok(not exists (select 1 from public.presence where user_id = pg_temp.uid('cat')),
    'Ana does not see a stranger''s presence');

  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind, title) values (pg_temp.uid('ana'), pg_temp.uid('cat'), 'invite', 'Plans')$q$,
    '42501', 'a non-friend cannot be invited');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind, title) values (pg_temp.uid('ben'), pg_temp.uid('ana'), 'invite', 'Plans')$q$,
    '42501', 'Ana cannot invite on Ben''s behalf');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'request')$q$,
    '42501', 'a request must come from the guest');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind, status) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite', 'active')$q$,
    '42501', 'a session cannot start active');
  perform pg_temp.fails($q$insert into public.cowork_sessions (id, host, guest, kind) values (gen_random_uuid(), pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite')$q$,
    '42501', 'session ids are made by the database, not chosen');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind, created_at) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite', now() + interval '1 year')$q$,
    '42501', 'created_at cannot be set (it decides expiry)');

  -- Five invites to Ben, one for each path below.
  foreach label in array array['invite', 'cancel_me', 'decline_me', 'expire_me', 'after_unfriend'] loop
    insert into public.cowork_sessions (host, guest, kind, title)
    values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite', 'Plans')
    returning id into new_id;
    perform set_config('rls_test.' || label, new_id::text, true);
  end loop;

  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('invite'), true)$q$,
    '42501', 'the host cannot accept her own invite', 'only the guest%');
  perform pg_temp.fails($q$update public.cowork_sessions set status = 'active'$q$,
    '42501', 'sessions cannot be updated directly');
  perform pg_temp.fails('delete from public.cowork_sessions',
    '42501', 'sessions cannot be deleted directly');
end;
$$;


-- Cat cannot see or touch their sessions -------------------------------------

select set_config('request.jwt.claims', pg_temp.token('cat'), true);

do $$
begin
  perform pg_temp.ok((select count(*) from public.cowork_sessions) = 0, 'Cat cannot see Ana and Ben''s sessions');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('invite'), true)$q$,
    'P0002', 'Cat cannot answer their invite');
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('invite'))$q$,
    'P0002', 'Cat cannot end their session');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('cat'), 'request')$q$,
    '42501', 'Cat cannot ask to join a page of someone who isn''t her friend');
end;
$$;

-- Nor can Ben with a token Clerk didn't issue.
select set_config('request.jwt.claims', pg_temp.token('ben', '{"iss": "https://nbzojbfkkpeisitbkwpg.supabase.co/auth/v1"}'), true);

do $$
begin
  perform pg_temp.ok((select count(*) from public.cowork_sessions) = 0, 'another issuer''s token sees no sessions');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('invite'), true)$q$,
    'P0002', 'another issuer''s token cannot answer an invite');
end;
$$;


-- Ben: only the guest answers an invite; end_session rules -------------------

select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
declare
  s public.cowork_sessions;
  new_id uuid;
begin
  perform pg_temp.ok((select count(*) from public.cowork_sessions) = 5, 'Ben sees the five invites addressed to him');

  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('invite'))$q$,
    '42501', 'the guest cannot cancel a pending invite (he declines it instead)');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('invite'), null)$q$,
    '22004', 'accept must be true or false');

  select * into s from public.respond_session(pg_temp.sid('invite'), true);
  perform pg_temp.ok(s.status = 'active' and s.title = 'Plans', 'the guest accepts the invite');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('invite'), false)$q$,
    'P0001', 'only a pending session can be answered', '%not pending');
  select * into s from public.end_session(pg_temp.sid('invite'));
  perform pg_temp.ok(s.status = 'ended', 'the guest can end an active session');
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('invite'))$q$,
    'P0001', 'an ended session cannot be ended again');

  select * into s from public.respond_session(pg_temp.sid('decline_me'), false);
  perform pg_temp.ok(s.status = 'declined', 'the guest declines an invite');
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('decline_me'))$q$,
    'P0001', 'a declined session cannot be ended');

  -- Ben asks to join two of Ana's pages.
  insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'request')
  returning id into new_id;
  perform set_config('rls_test.request', new_id::text, true);
  insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'request')
  returning id into new_id;
  perform set_config('rls_test.withdraw_me', new_id::text, true);

  -- Only the host names a page: a guest's request starts with no title.
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind, title) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'request', 'Sneaky title')$q$,
    '42501', 'a guest cannot name the host''s page when asking');
  perform pg_temp.fails($q$update public.cowork_sessions set title = 'Sneaky title'$q$,
    '42501', 'nor rename a session afterwards');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('request'), true, 'My page')$q$,
    '42501', 'the guest cannot accept his own request', 'only the host%');
  select * into s from public.end_session(pg_temp.sid('withdraw_me'));
  perform pg_temp.ok(s.status = 'cancelled', 'the guest withdraws his pending request');
end;
$$;


-- Ana: only the host answers a request, and only with a title -----------------

select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
declare
  s public.cowork_sessions;
begin
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('request'))$q$,
    '42501', 'the host cannot cancel a pending request (she declines it instead)');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('request'), true)$q$,
    '22023', 'accepting a request needs a page title');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('request'), true, '   ')$q$,
    '22023', 'a blank page title is not enough');

  select * into s from public.respond_session(pg_temp.sid('request'), true, 'Garden notes');
  perform pg_temp.ok(s.status = 'active' and s.title = 'Garden notes',
    'the host accepts the request and page_title becomes the title');
  select * into s from public.end_session(pg_temp.sid('request'));
  perform pg_temp.ok(s.status = 'ended', 'the host can end an active session too');

  select * into s from public.end_session(pg_temp.sid('cancel_me'));
  perform pg_temp.ok(s.status = 'cancelled', 'the host cancels her pending invite');
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('withdraw_me'))$q$,
    'P0001', 'a cancelled session cannot be ended');
end;
$$;


-- Ben: stale invites, and unfriending -----------------------------------------

-- One invite has been waiting for two hours.
reset role;
update public.cowork_sessions set created_at = now() - interval '2 hours'
where id = current_setting('rls_test.expire_me')::uuid;

set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
begin
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('cancel_me'), true)$q$,
    'P0001', 'a cancelled invite cannot be accepted', '%not pending');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('expire_me'), true)$q$,
    'P0001', 'a pending session older than an hour cannot be answered', 'session expired');
  perform pg_temp.ok((select status from public.cowork_sessions where id = pg_temp.sid('expire_me')) = 'pending',
    'the failed call changed nothing (the sweep cancels it)');

  -- Either person can remove a friendship; a waiting invite then can't be accepted.
  perform pg_temp.ok(pg_temp.changed('delete from public.friendships') = 1, 'Ben removes Ana as a friend');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('after_unfriend'), true)$q$,
    '42501', 'an invite cannot be accepted once the two are no longer friends', 'you are not friends');
end;
$$;

-- The pg_cron sweep cancels pending sessions older than an hour.
reset role;

do $$
begin
  perform pg_temp.ok(private.expire_stale_sessions() = 1, 'the sweep cancels exactly the stale session');
  perform pg_temp.ok((select status from public.cowork_sessions where id = pg_temp.sid('expire_me')) = 'cancelled',
    'the stale invite is now cancelled');
  perform pg_temp.ok((select status from public.cowork_sessions where id = pg_temp.sid('after_unfriend')) = 'pending',
    'newer pending sessions are left alone');
end;
$$;


-- Ana after the unfriending ---------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
begin
  perform pg_temp.ok(not exists (select 1 from public.profiles where id = pg_temp.uid('ben')),
    'after unfriending, Ana no longer sees Ben''s profile');
  perform pg_temp.ok(not exists (select 1 from public.presence where user_id = pg_temp.uid('ben')),
    'nor his presence');
  perform pg_temp.ok(not public.are_friends(pg_temp.uid('ana'), pg_temp.uid('ben')), 'they are no longer friends');
  perform pg_temp.fails($q$insert into public.cowork_sessions (host, guest, kind) values (pg_temp.uid('ana'), pg_temp.uid('ben'), 'invite')$q$,
    '42501', 'an ex-friend cannot be invited');
  perform pg_temp.ok((select count(*) from public.cowork_sessions) = 7, 'Ana still sees her own past sessions');
end;
$$;


-- Requests and lookups have limits -------------------------------------------

-- Twenty-one people with usernames for Ana to ask, Cat with a day's worth of
-- requests already sent, and Ben with an hour's worth of lookups done.
reset role;
insert into public.profiles (id, username)
select 'user_many' || lpad(n::text, 2, '0'), 'many' || lpad(n::text, 2, '0')
from generate_series(1, 21) n;
insert into private.friend_requests_sent (requester) select pg_temp.uid('cat') from generate_series(1, 50);
insert into private.profile_lookups (user_id) select pg_temp.uid('ben') from generate_series(1, 100);

set local role authenticated;
select set_config('request.jwt.claims', pg_temp.token('ana'), true);

do $$
declare
  n int := 0;
begin
  perform pg_temp.ok((select count(*) from public.find_profile('many01')) = 1, 'under the limit, lookups work');

  -- Up to 20 requests may wait at once.
  while (select count(*) from public.friendships where requester = pg_temp.uid('ana') and status = 'pending') < 20 loop
    n := n + 1;
    insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), 'user_many' || lpad(n::text, 2, '0'));
  end loop;
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), 'user_many21')$q$,
    'P0001', 'at most 20 friend requests wait at once', '%20 friend requests waiting%');
end;
$$;

select set_config('request.jwt.claims', pg_temp.token('cat'), true);

do $$
begin
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('cat'), 'user_many21')$q$,
    'P0001', 'at most 50 friend requests a day, cancelled ones included', '%a lot of friend requests%');
end;
$$;

select set_config('request.jwt.claims', pg_temp.token('ben'), true);

do $$
begin
  perform pg_temp.fails($q$select * from public.find_profile('many01')$q$,
    'P0001', 'at most 100 lookups an hour', 'Too many lookups%');
end;
$$;


-- Every change above signalled the inboxes of its two people ----------------

reset role;

do $$
begin
  perform pg_temp.ok(pg_temp.signals('ben', 'friends') = 3,
    'Ben heard of Ana''s request, his own acceptance and his unfriending (deletes included)');
  perform pg_temp.ok(pg_temp.signals('ana', 'friends') >= 3, 'so did Ana, and of her other requests');
  perform pg_temp.ok(pg_temp.signals('ana', 'sessions') > 0 and pg_temp.signals('ben', 'sessions') > 0,
    'both hear of their invites, requests and how they ended');
  perform pg_temp.ok(pg_temp.signals('cat', 'friends') + pg_temp.signals('cat', 'sessions') = 0,
    'nothing reaches someone a change doesn''t concern');
  perform pg_temp.ok(
    (select bool_and(m.payload - 'id' = '{}'::jsonb and not m.private) from realtime.messages m where m.topic like 'inbox:%'),
    'a signal carries nothing but its name, on a public channel');
  perform pg_temp.ok(
    not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('friendships', 'cowork_sessions')),
    'postgres_changes no longer sends these tables'' rows to every listener');
end;
$$;


-- Deleting an account ----------------------------------------------------------

-- Done by hand on request (see the privacy policy): deleting the profile
-- takes their friendships, presence, sessions and inbox with it.
reset role;
delete from public.profiles where id = 'user_ben';

do $$
begin
  perform pg_temp.ok(not exists (select 1 from private.inboxes where user_id = 'user_ben'), 'their inbox goes');
  perform pg_temp.ok(not exists (select 1 from public.presence where user_id = 'user_ben'), 'their presence goes');
  perform pg_temp.ok(not exists (select 1 from public.cowork_sessions where 'user_ben' in (host, guest)), 'their sessions go');
  perform pg_temp.ok(not exists (select 1 from public.friendships where 'user_ben' in (requester, addressee)), 'their friendships go');
end;
$$;


-- Signed out: nothing at all --------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

do $$
begin
  perform pg_temp.fails('select 1 from public.profiles', '42501', 'anon cannot read profiles');
  perform pg_temp.fails('select 1 from public.friendships', '42501', 'anon cannot read friendships');
  perform pg_temp.fails('select 1 from public.presence', '42501', 'anon cannot read presence');
  perform pg_temp.fails('select 1 from public.cowork_sessions', '42501', 'anon cannot read sessions');
  perform pg_temp.fails($q$insert into public.friendships (requester, addressee) values (pg_temp.uid('ana'), pg_temp.uid('cat'))$q$,
    '42501', 'anon cannot send friend requests');
  perform pg_temp.fails('select public.ensure_profile()', '42501', 'anon cannot call ensure_profile');
  perform pg_temp.fails($q$select * from public.find_profile('ana')$q$, '42501', 'anon cannot call find_profile');
  perform pg_temp.fails($q$select public.are_friends(pg_temp.uid('ana'), pg_temp.uid('cat'))$q$,
    '42501', 'anon cannot call are_friends');
  perform pg_temp.fails('select public.touch_presence()', '42501', 'anon cannot call touch_presence');
  perform pg_temp.fails($q$select public.respond_session(pg_temp.sid('after_unfriend'), true)$q$,
    '42501', 'anon cannot call respond_session');
  perform pg_temp.fails($q$select public.end_session(pg_temp.sid('after_unfriend'))$q$,
    '42501', 'anon cannot call end_session');
  perform pg_temp.fails('select private.me()', '42501', 'anon cannot call private.me');
  perform pg_temp.fails('select public.my_inbox()', '42501', 'anon cannot call my_inbox');
  perform pg_temp.fails('select public.rls_auto_enable()', '42501', 'anon cannot call rls_auto_enable');
end;
$$;


reset role;
select 'All RLS tests passed' as result;

rollback;
