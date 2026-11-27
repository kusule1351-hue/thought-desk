# Live-session relay and sync mailbox

The relay that lets two friends write one page together, at **relay.thoughtdesk.org**. It's a Cloudflare Worker with one Durable Object per session. The Durable Object passes both people's edits and cursors between them (Yjs over a WebSocket).

- **It keeps nothing.** When everyone has left, the room is gone. Each person's app keeps the session's state locally, so reconnecting, or restarting mid-session, loses nothing.
- **It's only held open while someone writes.** A room is paid for every second someone is connected, so the app lets go after 10 minutes with no writing and nobody at the page. It reconnects when its person comes back, or when the other one writes or comes back: their app wakes it with an empty broadcast on Supabase Realtime (`nudges` in `src/lib/cloud/`).
- **Only the two people in an active session get in** (`src/auth.ts`):
  1. The app sends the person's Clerk session token as the WebSocket's second subprotocol (`Sec-WebSocket-Protocol: thoughtdesk, <token>`), never in the address, so it stays out of URLs and their logs. The relay answers with `thoughtdesk`.
  2. The relay checks the token against the public keys of the Clerk instance that issued it (RS256, via `jose`). The issuer must be one of `CLERK_ISSUERS`, the page the token was made on (`azp`, when there is one) one of `APP_ORIGINS`, and the session fully signed in. No secret is needed.
  3. It asks Supabase whether that session is active, **using that person's own token**. Row-level security returns the session only to its two people, so the database makes the decision.
- **It keeps asking.** A Clerk token lasts a minute, so while connected the app sends a fresh one every 45 seconds, over the connection (`token:<token>`, a y-partyserver custom message). The room checks each like the first, Supabase included: a session that has ended, or two people who are no longer friends, closes the room. A connection that hasn't shown a fresh token for two minutes is let go, and the app reconnects with a fresh one if it's still signed in.
- **Limits:** a message may be up to 4 MB (a long page pasted at once fits), and one person may have up to 3 connections in a room (the app needs one). Who's connecting reaches the room from the Worker alone, never from the client.
- **Rooms are session IDs** (UUIDs from `cowork_sessions`). Any other path gets a 404.

## The sync mailbox

The same Worker also holds each account's encrypted sync mailbox, under `/sync` (the API is in [docs/sync.md](../docs/sync.md)). It can't read what it stores.

- **One `Vault` Durable Object per account**, named by the Clerk user id (`src/vault.ts`). Numbered items are in its SQLite storage; items over 64 KB, and file chunks, are R2 objects at `v/<user id>/<name>`. The path always comes from the verified token, never from the request.
- **The sign-in** is the Clerk token check from `src/auth.ts`, sent as `Authorization: Bearer <token>` (as the second subprotocol on `/sync/live`). It needs no Supabase lookup. Anything not signed in gets a bare 401. CORS answers only the origins in `APP_ORIGINS`.
- **The vault proof:** a call that changes or deletes something also carries `X-Vault-Proof`, and the Vault keeps only its SHA-256 (set once, with the wrapped key). A bare sign-in token can read only what it can't decrypt.
- **Who may use it:** until sync is opened, only the accounts listed in the `SYNC_TESTERS` secret (`src/access.ts`). The app hides sync, but anyone can build an app from this repository that shows it, so the relay is what decides: a signed-in account that isn't listed gets `403 {"closed": true}` on every `/sync` route, before anything of theirs is read or stored. `SYNC_ACCESS` in `wrangler.jsonc` is `testers`; changing it to `everyone` opens sync. Closed is the default, so a missing or misspelt setting never opens it. List the testers (Clerk user ids, comma-separated) with `npx wrangler secret put SYNC_TESTERS`; it takes effect at once, with no deploy.
- **Quota:** `used` is a counter kept in the same transaction as every change, and `SYNC_LIMIT_BYTES` (1 GiB, in `wrangler.jsonc`) is the most one account may store. Every item costs its data plus 256 bytes plus its key; a blob is reserved in `used` before it is uploaded, so R2 never holds bytes the quota didn't count. A change that doesn't add bytes always goes through.
- **Limits:** 1000 items per push and 6 MiB per body (checked from `Content-Length`, before the body is read), 2 MB per item, 9 MiB per blob (written once). A bucket of 200,000 items per account refills over a day; every call also spends from a per-minute budget (`src/limits.ts`).
- **Live notices** use hibernating WebSockets: an idle connection costs nothing, anything but `ping` closes it, and one is let go after 15 minutes so the app reconnects with a fresh sign-in.

A deployer creates the R2 bucket once, before the first deploy (the binding is `SYNC_BLOBS` in `wrangler.jsonc`):

```bash
npx wrangler r2 bucket create thoughtdesk-sync --jurisdiction eu
```

Both places sync keeps things are in Cloudflare's EU jurisdiction, stored and processed in the EU only: the bucket (made that way above, and bound that way in `wrangler.jsonc`) and each account's `Vault` (`VAULT_JURISDICTION`, `src/region.ts`). Neither can be moved later: a bucket's jurisdiction is fixed when it is made, and a vault's id comes from its jurisdiction. On this computer (`npm run dev`, the tests) the setting is off, since the local runtime has no jurisdictions.

## The assistant

The same Worker is also the assistant's way to its model, under `/assistant` (`src/assistant.ts`). The app holds no key: it sends the conversation and the tools it offers, and this asks Claude with a key kept here and passes the answer back as it is written. The tools run in the app, on the person's own computer. Nothing that passes through is stored or logged; only what it cost is counted.

- **The key** is the `ANTHROPIC_API_KEY` secret: `npx wrangler secret put ANTHROPIC_API_KEY` (from the [Claude Console](https://platform.claude.com/); set a spending limit there too). Without it every request is answered "not set up", and nothing else changes. To run it on this computer, put `ANTHROPIC_API_KEY=…` in `server/.dev.vars`, which git ignores.
- **Who may use it:** as with sync, closed is the default. `ASSISTANT_ACCESS` in `wrangler.jsonc` is `testers`: only the Clerk user ids in the `ASSISTANT_TESTERS` secret get in (`npx wrangler secret put ASSISTANT_TESTERS`, comma-separated, no deploy needed). Changing it to `everyone` opens it.
- **What is passed on:** the model (`ASSISTANT_MODEL`), the longest answer and the biggest request (400 KiB) are set here, whatever the request says. Only text, the model's own turns handed back, and the app's own tools are passed on: a request carrying a picture, a document, or a tool Anthropic would run (web search, code) is refused. The app is open source, so anyone signed in can send anything here.
- **What it may cost** (`src/budget.ts`, a `Budget` Durable Object per account and one for everyone): each account has `ASSISTANT_MONTHLY_MICROUSD` a month (300000: 30 cents) and everyone together `ASSISTANT_DAILY_MICROUSD` a day (3000000: 3 dollars), in millionths of a US dollar, counted from the tokens each answer reports at the prices in `src/assistant.ts`. A request holds its worst case before it runs and is settled after, so the limits hold with requests in flight. An account may also start 30 requests a minute. Keep the price table in step with the model you choose: one it doesn't list is counted at the dearest price.
- **What the app is told:** refusals come in the shape of Anthropic's own errors, with an `x-td-reason` header (`signed-out`, `closed`, `off`, `spent`, `busy`, `fast`, `bad`). Nothing about the owner's account is passed on. `GET /assistant/usage` answers `{ used, limit, month, on }` for the signed-in account.

## Pro

Polar (polar.sh) sells Thought Desk Pro for us as the merchant of record; this Worker only learns who has paid (`src/plan.ts`, `src/billing.ts`). No card detail ever comes here.

- **The key** is the `POLAR_ACCESS_TOKEN` secret (`npx wrangler secret put POLAR_ACCESS_TOKEN`), an organisation access token with the scopes `checkouts:write`, `customers:read`, `customer_sessions:write`, `subscriptions:read` and `products:read`. Without it nothing can be bought and every account is on the free plan. On this computer it goes in `server/.dev.vars`, and must be a key from Polar's sandbox (sandbox.polar.sh), which is what `env.dev` points at (`POLAR_API`).
- **Which products are Pro:** `POLAR_PRO_PRODUCTS`, the product ids, comma-separated. Production and the sandbox each have their own.
- **Who is on Pro:** a checkout started here (`POST /billing/checkout`) carries the account's Clerk user id as the customer's external id, so the payment belongs to the account whatever email is typed at Polar. The plan is Polar's "customer state" for that id, kept beside the account's allowance and asked again when Polar says something changed, when the app comes back from paying (`GET /billing/plan?fresh=1`), and when the kept answer is six hours old. A missed notice delays a change; it doesn't lose one.
- **Polar's notices** go to `POST /billing/polar`, at `https://relay.thoughtdesk.org/billing/polar`, signed with the endpoint's secret (`npx wrangler secret put POLAR_WEBHOOK_SECRET`; Standard Webhooks). Send it the subscription events, `order.paid` and `customer.state_changed`. Unsigned or stale notices are refused; every signed one is acknowledged.
- **Deleting an account:** `DELETE /account` (`src/account.ts`) is the server's part of "Delete Account" in the app's Settings: it stops Pro renewing (and deletes nothing if Polar can't be told), removes the synced copy without its vault proof, and clears the assistant's counts. It needs a sign-in proved in the last ten minutes (the token's `fva` claim; the app asks for a code from the person's email first). The app then calls `delete_account()` in Supabase and deletes the Clerk user.
- **Agreeing first:** `POST /billing/checkout` makes no checkout unless the request carries `accepted`, equal to `TERMS_VERSION` (the "last updated" date on `site/public/terms.html` and `privacy.html`, in `src/billing.ts`). The app shows a sheet with a box to tick and sends it; the version and the time go to Polar as the checkout's metadata. Change `TERMS_VERSION` whenever either page changes in a way people must agree to again.
- **What Pro gets:** the assistant's monthly allowance becomes `ASSISTANT_PRO_MONTHLY_MICROUSD` (3 dollars). `POST /billing/portal` opens Polar's own page for the card and receipts. `POST /billing/cancel` stops Pro renewing from inside the app (Pro lasts to the date paid for) and `POST /billing/resume` takes that back; both act as the customer, in a session Polar makes for them, so the key needs no right to change subscriptions.
- It is closed to the same accounts the assistant is closed to (`ASSISTANT_ACCESS`).

## Run it

```bash
cd server
npm install
npm run dev          # ws://localhost:8787, with real sign-in checks (needs internet), `env.dev`
npm test             # the sign-in checks (Node), then the mailbox (Vitest, inside the Workers runtime)
npm run check        # type-checks the Worker
```

The interface tests start the relay themselves with `npm run test-relay`: port 8788, with `AUTH_MODE=test` (also `env.dev`), which accepts the fake cloud's `test.<user id>` tokens. Test mode works only for requests from this computer (`CF-Connecting-IP` is a loopback address, which Cloudflare never lets an outside request claim), whatever the setting says.

## Deploy it

You need a free Cloudflare account. Durable Objects that store data in SQLite are on the free plan, and the relay stores nothing. R2 has a free allowance too, but needs the bucket above.

```bash
cd server
npx wrangler login     # once: approve in the browser
npm run deploy         # relay.thoughtdesk.org (the top level of wrangler.jsonc, as `--env=""`)
```

`wrangler.jsonc` puts it on relay.thoughtdesk.org (a custom domain on the same Cloudflare account) and nowhere else (`workers_dev: false`). The app connects there unless `VITE_COWORK_URL` says otherwise at build time, and its content security policy (`src-tauri/tauri.conf.json`, `connect-src`) allows only `wss://relay.thoughtdesk.org`. The Supabase project's address and publishable key, the Clerk instances' issuers (`CLERK_ISSUERS`) and where the app runs (`APP_ORIGINS`) are in `wrangler.jsonc` (`vars`); all are public by design.

What is deployed trusts only the production Clerk instance (`https://clerk.thoughtdesk.org`) and the desktop app's origins (`http://tauri.localhost`, `tauri://localhost`). The development Clerk instance and the Vite dev server (`http://localhost:1420`) live in `env.dev`, which `npm run dev` and `npm run test-relay` use and `npm run deploy` never does. Wrangler inherits no bindings, migrations or vars into an environment, so `env.dev` repeats them (and sets `routes: []`, or it would inherit the custom domain); keep the two in step when you change either. Check what a deploy would send without sending it: `npx wrangler deploy --dry-run --env=""` and `npx wrangler deploy --dry-run --env dev`. Never run `wrangler deploy --env dev`: it would put a second Worker on your account. `env.dev` also names a bucket of its own (`thoughtdesk-sync-dev`): `wrangler dev` keeps it in a folder on this computer, so nothing run from that environment can reach the real one.
