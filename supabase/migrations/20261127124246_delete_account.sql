-- Deleting your own account, from the app (2026-11-27).
--
-- Until now an account was deleted by hand, on an emailed request. The app
-- now has "Delete Account" in Settings: it stops the subscription and removes
-- the synced copy (the relay's DELETE /account), calls delete_account() here,
-- and then deletes the sign-in itself at Clerk.
--
-- delete_account() removes the caller's profile, and with it (on delete
-- cascade) their friendships, presence, sessions and inbox, and the rows the
-- request and lookup limits kept about them, which no foreign key reaches.
-- Friends are told by the signals the deletes send, as for any unfriending.
--
-- It can't be undone, so a sign-in alone is not enough: the token must say
-- the sign-in was proved in the last ten minutes. Clerk puts that in `fva`
-- (minutes since the first factor was last verified; -1 for never), and the
-- app asks for a code from the person's email just before. A token without
-- the claim, or with an older one, is refused: one that leaked can't be used
-- to wipe what its owner has. The relay applies the same rule
-- (server/src/auth.ts, freshPersonOf).
--
-- Docs relied on:
--   Third-party auth with Clerk: https://supabase.com/docs/guides/auth/third-party/clerk
--   Clerk session token claims (fva): https://clerk.com/docs/guides/sessions/session-tokens
--   Security definer functions and search_path:
--     https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
--
-- delete_account(true) only checks: it deletes nothing, and fails exactly
-- when the real call would. The app asks that first, before the relay has
-- removed anything, so a database that can't go through with it (this
-- function missing, a token it doesn't find fresh) stops the whole thing with
-- nothing lost.
--
-- Safe to run again.

create or replace function public.delete_account(check_only boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me constant text := (select private.me());
  proved jsonb := auth.jwt() -> 'fva' -> 0;
  age numeric;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Only a number counts: a claim that is missing, or is anything else, is not fresh.
  if proved is not null and jsonb_typeof(proved) = 'number' then
    age := (proved #>> '{}')::numeric;
  end if;
  if age is null or age < 0 or age > 10 then
    raise exception 'confirm your sign-in first' using errcode = '42501';
  end if;

  if check_only then
    return;
  end if;

  delete from private.friend_requests_sent where requester = me;
  delete from private.profile_lookups where user_id = me;
  delete from public.profiles where id = me;
end;
$$;

revoke execute on function public.delete_account(boolean) from public, anon;
grant execute on function public.delete_account(boolean) to authenticated;
