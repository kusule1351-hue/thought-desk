-- Fixes from the 0.8.3 security audit (2026-11-08).
--
-- 1. The Clerk development instance was trusted for everyone. Anyone can
--    make unlimited accounts on a development instance (test addresses, a
--    fixed code), which multiplies every per-account limit. private.me()
--    now accepts the development issuer only for user ids the owner has
--    listed in private.dev_accounts (empty by default), and production as
--    before.
-- 2. cowork_sessions.id is made by the database (no longer in the insert
--    grant), and only the host names a session: a guest's request must start
--    with an empty title, which the host fills in when accepting
--    (respond_session). The host of an invite names it at creation, since
--    the host is the one creating the row.
--
-- (Making the Realtime channels private is held back: see
-- supabase/pending/20261108_private_realtime_channels.sql.)
--
-- Docs relied on:
--   Third-party auth with Clerk: https://supabase.com/docs/guides/auth/third-party/clerk
--   Security definer functions and search_path:
--     https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
--   Column privileges: https://www.postgresql.org/docs/current/sql-revoke.html
--
-- Safe to run again.


-- 1. The development instance, for listed accounts only -----------------------

-- Clerk user ids allowed to sign in from the development instance. Only the
-- owner adds rows, in the SQL editor (see SETUP.md); the API can't touch it.
create table if not exists private.dev_accounts (
  user_id text primary key
    constraint dev_accounts_id_format check (user_id ~ '^user_[A-Za-z0-9]{1,64}$')
);
alter table private.dev_accounts enable row level security;
revoke all on table private.dev_accounts from public, anon, authenticated;

-- The signed-in person's Clerk user id: the token's sub, if the token is
-- from our production instance, or from the development instance and the
-- user is in private.dev_accounts, and its session is fully signed in;
-- otherwise null. Security definer so it can read dev_accounts, which
-- signed-in people can't (it only ever answers about the caller's token).
create or replace function private.me()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select auth.jwt() ->> 'sub'
  where coalesce(auth.jwt() ->> 'sts', 'active') <> 'pending'
    and (
      auth.jwt() ->> 'iss' = 'https://clerk.thoughtdesk.org'
      or (
        auth.jwt() ->> 'iss' = 'https://smiling-sunbird-3571.clerk.accounts.dev'
        and exists (select 1 from private.dev_accounts d where d.user_id = auth.jwt() ->> 'sub')
      )
    );
$$;

revoke execute on function private.me() from public, anon;
grant execute on function private.me() to authenticated;


-- 2. Session ids and titles ---------------------------------------------------

-- The database makes session ids.
revoke insert (id) on table public.cowork_sessions from authenticated;

-- A request is made by the guest, and only the host names the page (when
-- accepting, in respond_session), so a request starts with an empty title.
-- An invite is made by the host, who names it.
drop policy if exists "cowork_sessions: start with a friend" on public.cowork_sessions;
create policy "cowork_sessions: start with a friend"
  on public.cowork_sessions for insert to authenticated
  with check (
    status = 'pending'
    and (   (kind = 'invite' and host = (select private.me()))
         or (kind = 'request' and guest = (select private.me()) and title = ''))
    and public.are_friends(host, guest)
  );
