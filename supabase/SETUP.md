# Turning on sign-in

The database is ready: tables, rules and tests (see [README.md](README.md)). Clerk signs people in; Supabase keeps profiles, friends and invites, and trusts the tokens Clerk issues. The steps below need your accounts, so they're yours unless they say **Done**. The app works without them, except for signing in.

- Clerk application: **Thought Desk**, development instance `smiling-sunbird-3571.clerk.accounts.dev`.
- Supabase project: **thought-desk-europe**, `https://nbzojbfkkpeisitbkwpg.supabase.co`.

## 1. Clerk

**Done** (through the Clerk connection), in the development instance:

- Sign-in with Google, GitHub or a code by email. Passwords are off.
- Session tokens carry `role: authenticated`, which Supabase needs, and the person's name and picture (`name`, `picture`, `has_image`), which their profile starts from.
- Throwaway email domains are blocked. The app signs in through Clerk's Native API, which skips CAPTCHA, so this and Clerk's own rate limits keep out bulk sign-ups.
- The Native API is on (**Configure** → **Native applications**).

**Yours: let the app talk to Clerk.** Clerk takes requests from a signed-in app only if it runs on a page in the instance's list of allowed origins, and only a secret key can set that list. In Clerk → **Configure** → **API keys**, copy a secret key (`sk_test_…`), then run this in PowerShell and paste the key when asked:

```powershell
$key = Read-Host "Clerk secret key" -MaskInput
Invoke-RestMethod -Method Patch -Uri https://api.clerk.com/v1/instance -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json" -Body '{"allowed_origins": ["http://tauri.localhost", "http://localhost:1420"]}'
```

`http://tauri.localhost` is the desktop app; `http://localhost:1420` is the browser preview and the desktop development build. The call replaces the whole list.

## 2. Supabase: trust Clerk

1. Supabase → **Authentication** → **Sign In / Providers** → **Third-Party Auth** → **Add provider** → **Clerk**. Enter the domain with `https://`: `https://smiling-sunbird-3571.clerk.accounts.dev`.
2. The database accepts the development instance only for accounts you list (see **Development accounts** below), so nobody else can use it even though Supabase trusts it. On the same page, under Supabase's own sign-in: turn off **Allow new users to sign up**, and turn off the **Email**, **Google** and **GitHub** providers if they're on. Nobody needs an account with Supabase itself, and the database ignores its tokens anyway (`private.me()` in [README.md](README.md)).

### Development accounts

`private.me()` accepts tokens from the development instance only for Clerk user ids in `private.dev_accounts`, which is empty until you add rows (the API can't read or write it). Anyone can make unlimited accounts on a development instance, so without this every per-account limit could be multiplied. To develop against this project: sign in once from a development build, copy your user id from Clerk's dashboard (**Users**, `user_…`), and run in the Supabase SQL editor:

```sql
insert into private.dev_accounts (user_id) values ('user_2abc…');
-- and to stop: delete from private.dev_accounts where user_id = 'user_2abc…';
```

Production tokens (`https://clerk.thoughtdesk.org`) need no listing. The stricter alternative: remove the development domain from **Third-Party Auth** in the dashboard. Then the database refuses development tokens whatever the list says, and developing against this project ends (use a separate Supabase project for development instead).

## 3. Google and GitHub

**Done** for development: Clerk's development instance uses your own Google client and GitHub OAuth app, both sending people back to Clerk (`https://smiling-sunbird-3571.clerk.accounts.dev/v1/oauth_callback`). The address the app comes back to afterwards, `http://127.0.0.1:47823/auth/callback`, is between Clerk and the app; Google and GitHub never see it.

## 4. Try it

`npm run dev` opens the browser preview at http://localhost:1420, and `npm run app` the desktop app. In development, Clerk's test addresses sign in without a real email: any address ending in `+clerk_test@example.com` (for example `ana+clerk_test@example.com`) takes the code `424242`.

## 5. Before the release: Clerk production

Clerk's development instance is for development: it's marked as such, and anyone can sign up on it with test addresses. Before releasing accounts:

1. **A production instance** for thoughtdesk.org (the Clerk connection can create it). Add the DNS records it lists in Cloudflare, for `clerk.thoughtdesk.org` and its email, with the proxy off (DNS only).
2. **Its settings**, as in step 1: the same session token claims, passwords off, throwaway domains blocked, the Native API on. Allowed origins: just `["http://tauri.localhost"]`, set with the production secret key (`sk_live_…`). Under **Native applications**, add `http://127.0.0.1:47823/auth/callback` to the allowlist for SSO redirects. Production takes it (checked on 2026-10-25): it sends Google and GitHub sign-ins back to exactly that address, refuses any other port, and takes signed-in requests only from `http://tauri.localhost`.
3. **Google:** in your Google OAuth client, add `https://clerk.thoughtdesk.org/v1/oauth_callback` under **Authorized redirect URIs**, and put the client ID and secret in Clerk production's Google settings.
4. **GitHub:** an OAuth app has only one callback, so make a second one for production, with the callback `https://clerk.thoughtdesk.org/v1/oauth_callback`, and put its ID and secret in Clerk production's GitHub settings.
5. **Supabase:** add Clerk again under **Third-Party Auth**, with the domain `https://clerk.thoughtdesk.org`. The development instance stays trusted for the accounts in `private.dev_accounts` only; once nobody develops against this project any more, remove its domain there too, empty the table, and take it out of `private.me()` (in a new migration) and from the relay's `CLERK_ISSUERS`.
6. **The app:** done. Release builds (`npm run build`, `npm run bundle`) use the production key (`pk_live_…`), and development builds (`npm run dev`, `npm run app`) the development one; `VITE_CLERK_KEY` overrides either (`src/lib/cloud/clerk.ts`).
7. **How long a sign-in lasts:** done. Production is on Clerk Pro, and a sign-in lasts 90 days (**Configure** → **Sessions** → maximum lifetime), then people sign in again; signing out ends it at once. Development keeps a week.

## 6. The relay for writing together (Cloudflare)

Done: the relay runs at relay.thoughtdesk.org. Deploy it again after a change to `server/` (moving to Clerk is one: the deployed relay still checks Supabase's tokens):

```bash
cd server
npx wrangler login     # once: approve in the browser
npm run deploy
```

See [server/README.md](../server/README.md).

## Good to know

- **Clerk's bot protection (Protect) doesn't run in the app.** Clerk asks clerk-js to load a script from `cdn.protect.clerk.com` during sign-in; the app's content security policy refuses it (a "Refused to load the script" line in the console), and signing in works without it. Throwaway-domain blocking and Clerk's rate limits stand in.
- **A free Supabase project pauses after a week without use.** Signing in still works, but friends and invites don't until you press **Restore** in the dashboard. Your notes aren't affected: they're on your computer.
- **What's online:** your account with Clerk (email address, name and picture, and sign-in details such as IP address and browser); your profile with Supabase (name, @username, picture), friends list, when you were last here (friends only) and invites. Your pages aren't: a page you write with a friend goes through the relay while you write and isn't kept there.
