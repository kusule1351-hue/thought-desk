/**
 * Who may join a room: someone signed in to Thought Desk (a Clerk session
 * token, checked against the Clerk instance's public keys) who is one of the
 * two people in that session while it's active. The relay asks Supabase with
 * the person's own token, so the database's row-level security makes the
 * decision.
 *
 * The token comes as the WebSocket's second subprotocol ("thoughtdesk,
 * <token>"), never in the address, so it stays out of URLs and their logs.
 * Clerk's tokens last a minute, so the app sends fresh ones over the open
 * connection, and the room checks those too (index.ts).
 */

import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthEnv {
  /** The Supabase project, e.g. https://nbzojbfkkpeisitbkwpg.supabase.co */
  SUPABASE_URL: string;
  /** Its publishable key (public by design). */
  SUPABASE_KEY: string;
  /** The Clerk instances people sign in with, by issuer, comma-separated (e.g. https://clerk.thoughtdesk.org). */
  CLERK_ISSUERS: string;
  /** Where the app runs, comma-separated (e.g. http://tauri.localhost): a token made on any other page is refused. */
  APP_ORIGINS: string;
  /** "test" lets the interface tests in with fake tokens, on localhost only. */
  AUTH_MODE?: string;
}

export type Verdict = { ok: true; userId: string } | { ok: false; status: 401 | 403; reason: string };

/** What auth needs from outside, so tests can stand in for it. */
export interface AuthDeps {
  /** The public keys of the Clerk instance with this issuer. */
  keys: (issuer: string) => JWTVerifyGetKey;
  fetch: typeof fetch;
}

/** The subprotocol the app offers, and the relay picks. */
export const PROTOCOL = 'thoughtdesk';

/** The token from a Sec-WebSocket-Protocol header ("thoughtdesk, <token>"), or ''. */
export function tokenFrom(protocols: string | null): string {
  const [name, token] = (protocols ?? '').split(',').map((p) => p.trim());
  return name === PROTOCOL && token ? token : '';
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** A Clerk instance's public keys, fetched once per worker and cached by jose. */
export function clerkKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) keySets.set(issuer, (keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))));
  return keys;
}

export const listOf = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** A token older than this (by `iat`) is refused, whatever its `exp` says. Clerk's last a minute. */
const MAX_TOKEN_AGE = '10m';

/** Who a Clerk session token is for, if Clerk signed it, it has an expiry, a
 *  subject and an issue time, it's current and no older than ten minutes, it's
 *  from one of our instances (asked for its keys only then), it was made in
 *  the app (azp, when there is one) and its session is fully signed in.
 *  `impersonation: false` also refuses a token made by someone acting as the
 *  person (an `act` claim); rooms still accept those, the mailbox doesn't. */
export async function personOf(token: string, env: AuthEnv, keys: AuthDeps['keys'] = clerkKeys, { impersonation = true } = {}): Promise<string | null> {
  try {
    const issuer = decodeJwt(token).iss;
    if (!issuer || !listOf(env.CLERK_ISSUERS).includes(issuer)) return null;
    const { payload } = await jwtVerify(token, keys(issuer), { issuer, algorithms: ['RS256'], clockTolerance: 5, requiredClaims: ['exp', 'sub', 'iat'], maxTokenAge: MAX_TOKEN_AGE });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (payload.azp !== undefined && !listOf(env.APP_ORIGINS).includes(String(payload.azp))) return null;
    if (payload.sts === 'pending') return null;
    if (!impersonation && payload.act !== undefined) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** Whether a request came from this computer: a relay run locally. Cloudflare
 *  sets CF-Connecting-IP itself, so a request from outside never claims it. */
export const isLocal = (request: Request) => LOOPBACK.has(request.headers.get('CF-Connecting-IP') ?? '');

/** Whether `token` may be in `room`. `local`: the request came from this computer (isLocal). */
export async function authorize(
  token: string,
  room: string,
  local: boolean,
  env: AuthEnv,
  // fetch called as deps.fetch() would get the wrong `this`, which Workers refuse.
  deps: AuthDeps = { keys: clerkKeys, fetch: (input, init) => fetch(input, init) },
): Promise<Verdict> {
  if (!token) return { ok: false, status: 401, reason: 'Sign in first' };

  if (env.AUTH_MODE === 'test') {
    // Tests only: never from outside this computer, whatever the setting says.
    const id = /^test\.([0-9a-f-]{36})$/.exec(token)?.[1];
    if (local && id) return { ok: true, userId: id };
    return { ok: false, status: 401, reason: 'Test sign-ins only work locally' };
  }

  const userId = await personOf(token, env, deps.keys);
  if (!userId) return { ok: false, status: 401, reason: 'Your sign-in has expired: sign in again' };

  const res = await deps.fetch(`${env.SUPABASE_URL}/rest/v1/cowork_sessions?id=eq.${encodeURIComponent(room)}&status=eq.active&select=id`, {
    headers: { apikey: env.SUPABASE_KEY, authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) return { ok: false, status: 403, reason: 'Could not check the session' };
  const rows = (await res.json()) as unknown[];
  return rows.length === 1 ? { ok: true, userId } : { ok: false, status: 403, reason: "You're not in this session, or it has ended" };
}
