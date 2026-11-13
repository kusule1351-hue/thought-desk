-- PENDING: private Realtime channels. NOT in migrations/ on purpose, so
-- `supabase db push` cannot apply it by accident.
--
-- Apply ONLY once a production Clerk token (iss https://clerk.thoughtdesk.org)
-- has been verified to join a private Realtime channel: supabase/realtime#1791
-- reports Realtime failing to verify tokens from Clerk custom domains, and
-- the app's earlier notes say the same. Test it first, e.g. by running the
-- client patch (private-realtime-client.patch) against a project with the
-- production Clerk domain and watching a private channel reach SUBSCRIBED.
--
-- Apply it TOGETHER with shipping the client change in
-- supabase/pending/private-realtime-client.patch (git apply; it makes the app
-- join `inbox:` and `nudge:` channels with private: true and the Clerk token).
-- The order matters, both ways:
--   - Migration first, old app still out there: apps that join public
--     channels can no longer listen or send. Inbox signals stop (the app falls
--     back to its once-a-minute refresh) and nudges stop (a session still
--     works while both people are in it, but a closed app is not woken).
--   - New app first, migration not yet applied: its private joins are refused
--     (nothing allows them), with the same fallback. The signals still go out
--     on public channels until the migration runs.
--   Either way nothing breaks hard, but live updates are lost until both are
--   in place. Ship the app, then apply this soon after.
--
-- How to apply: after 20261110155728_security_audit_fixes.sql, as a migration
-- (copy it to supabase/migrations/ with a fresh timestamp and `supabase db
-- push`, or paste it into the SQL editor / apply_migration), then run
-- supabase/pending/private_realtime_channels.test.sql (see its top).
--
-- Docs relied on:
--   Realtime authorization (private channels, realtime.topic(), policies on
--     realtime.messages, `extension`): https://supabase.com/docs/guides/realtime/authorization
--   Sending from the database (realtime.send(payload, event, topic, private)):
--     https://supabase.com/docs/guides/realtime/broadcast#send-messages-from-the-database
--
-- Safe to run again.

-- 2. Private Realtime channels ------------------------------------------------

-- Does the caller own the inbox this topic names ('inbox:<uuid>')? Security
-- definer because private.inboxes is closed to signed-in people. The shape is
-- checked before the cast so a malformed topic is just "no".
create or replace function private.owns_inbox(topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if topic is null or topic !~ '^inbox:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from private.inboxes i
    where i.inbox = substr(owns_inbox.topic, 7)::uuid
      and i.user_id = (select private.me())
  );
end;
$$;

-- Is the caller the host or guest of the active session this topic names
-- ('nudge:<session id>')?
create or replace function private.in_active_session(topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if topic is null or topic !~ '^nudge:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from public.cowork_sessions s
    where s.id = substr(in_active_session.topic, 7)::uuid
      and s.status = 'active'
      and (select private.me()) in (s.host, s.guest)
  );
end;
$$;

revoke execute on function private.owns_inbox(text), private.in_active_session(text) from public, anon;
grant execute on function private.owns_inbox(text), private.in_active_session(text) to authenticated;

-- The signal to an inbox goes out on a private channel now (the last
-- argument of realtime.send). Otherwise as before.
create or replace function private.signal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  if tg_op = 'DELETE' then
    r := to_jsonb(old);
  else
    r := to_jsonb(new);
  end if;
  perform realtime.send('{}'::jsonb, tg_argv[0], 'inbox:' || i.inbox::text, true)
  from private.inboxes i
  where i.user_id in (r ->> tg_argv[1], r ->> tg_argv[2]);
  return null;
end;
$$;
revoke execute on function private.signal_change() from public, anon, authenticated;

-- Signed-in clients need table privileges for the policies to apply to them
-- at all. (Guarded: realtime.messages belongs to Supabase's own role, and a
-- local stack may differ.)
do $$
begin
  grant select, insert on table realtime.messages to authenticated;
exception when insufficient_privilege then
  raise warning 'could not grant select, insert on realtime.messages to authenticated; grant it as the table owner';
end;
$$;

-- No policy exists for anon, nor for presence, so those stay denied.
drop policy if exists "realtime: owner reads own inbox" on realtime.messages;
create policy "realtime: owner reads own inbox"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.owns_inbox((select realtime.topic()))
  );

drop policy if exists "realtime: session members read nudges" on realtime.messages;
create policy "realtime: session members read nudges"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.in_active_session((select realtime.topic()))
  );

drop policy if exists "realtime: session members send nudges" on realtime.messages;
create policy "realtime: session members send nudges"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and private.in_active_session((select realtime.topic()))
  );
