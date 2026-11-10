/**
 * The mailbox's front door (docs/sync.md, Mailbox API): checks the sign-in,
 * works out whose vault it is from the verified user id alone (never from
 * anything the client sent), spends from the account's budget, and passes the
 * request on to that Vault. Anything not signed in gets a bare 401.
 */

import { clerkKeys, isLocal, listOf, personOf, tokenFrom, type AuthEnv } from './auth';
import { HEAVY, LIGHT } from './limits';
import { BadRequest, BLOB_NAME, contentLength, MAX_BLOB, MAX_BODY, numberParam, parseKey, parsePush, readText } from './mailbox';
import { r2Key, type Check, type Refusal, type Vault, type VaultEnv } from './vault';

export interface SyncEnv extends AuthEnv, VaultEnv {
  VAULT: DurableObjectNamespace<Vault>;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const empty = (status: number, headers: HeadersInit = {}) => new Response(null, { status, headers });

/** The answer to a call the vault turned away. */
function refuse(refusal: Refusal): Response {
  if (refusal.status === 429) return json(null, 429, { 'Retry-After': String(refusal.retryAfter) });
  const { status, ...body } = refusal;
  return json(body, status);
}

/** CORS for the app's own origins only (APP_ORIGINS, the same list a token's `azp` must be in). */
function corsFor(request: Request, env: AuthEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !listOf(env.APP_ORIGINS).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Vault-Proof',
    'Access-Control-Expose-Headers': 'Retry-After, Date',
    'Access-Control-Max-Age': '600',
  };
}

/** The account's Clerk user id, if the request is signed in. */
async function accountOf(request: Request, env: AuthEnv, live: boolean): Promise<string | null> {
  const token = live ? tokenFrom(request.headers.get('Sec-WebSocket-Protocol')) : /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return null;
  // Tests only (the same rule as auth.ts): `test.<uuid>` stands for that account, from this computer
  // alone, and nothing else gets in while the mode is on.
  const sub = env.AUTH_MODE === 'test' ? (isLocal(request) ? /^test\.([0-9a-f-]{36})$/.exec(token)?.[1] : undefined) : await personOf(token, env, clerkKeys, { impersonation: false });
  // The id becomes part of an R2 path, so nothing that could pose as another prefix.
  return sub && /^[A-Za-z0-9_-]{1,128}$/.test(sub) ? sub : null;
}

export async function handleSync(request: Request, env: SyncEnv): Promise<Response> {
  const res = await answer(request, env);
  // A socket's response carries the socket; it can't be rebuilt with extra headers.
  if (res.status === 101) return res;
  // Every answer, empty ones too: nothing here may be cached, and what it says depends on who asks.
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Vary', 'Origin');
  for (const [k, v] of Object.entries(corsFor(request, env))) res.headers.set(k, v);
  return res;
}

async function answer(request: Request, env: SyncEnv): Promise<Response> {
  if (request.method === 'OPTIONS') return empty(204);
  const url = new URL(request.url);
  const route = url.pathname.slice('/sync'.length);
  const sub = await accountOf(request, env, route === '/live');
  if (!sub) return empty(401);

  try {
    return await dispatch(request, env, sub, route, url);
  } catch (e) {
    if (e instanceof BadRequest) return empty(400);
    console.error('Sync failed', e);
    return empty(500);
  }
}

async function dispatch(request: Request, env: SyncEnv, sub: string, route: string, url: URL): Promise<Response> {
  const method = request.method;
  const vault = env.VAULT.get(env.VAULT.idFromName(sub));
  const allowed = (...methods: string[]) => (methods.includes(method) ? null : empty(405, { Allow: methods.join(', ') }));
  const proof = request.headers.get('X-Vault-Proof');
  // Every call spends from the account's budget before anything is read, parsed or stored.
  const admit = async (weight: number, check?: Check) => {
    const refused = await vault.admit(weight, check);
    return refused ? refuse(refused) : null;
  };

  switch (route) {
    case '/info':
      return allowed('GET') ?? (await admit(LIGHT)) ?? json(await vault.info());
    case '/key': {
      const refused = allowed('PUT') ?? (await admit(LIGHT));
      if (refused) return refused;
      const body = parseKey(parseJson(await readText(request, 8192)));
      if (!(await vault.setWrappedKey(body.wrappedKey, body.proof))) return empty(409);
      // Kept in the logs: a key set from a sign-in that leaked can be told from the owner's.
      console.log(JSON.stringify({ event: 'sync-key-set', account: sub, at: new Date().toISOString() }));
      return empty(204);
    }
    case '/push': {
      const refused = allowed('POST') ?? (await admit(HEAVY, { proof, push: true }));
      if (refused) return refused;
      // The size is known before a byte is read: a body that doesn't say, or is too big, is never read.
      const length = contentLength(request);
      if (length === null || length > MAX_BODY) throw new BadRequest('A push needs a Content-Length of at most 6 MiB');
      const out = await vault.push(sub, parsePush(parseJson(await readText(request, MAX_BODY))), proof);
      if (out.status === 429) return refuse(out);
      if (out.status === 400) throw new BadRequest('Refused');
      const { status, ...body } = out;
      return json(body, status);
    }
    case '/pull': {
      const refused = allowed('GET') ?? (await admit(HEAVY));
      if (refused) return refused;
      const after = numberParam(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = numberParam(url.searchParams.get('limit'), 1000, 1, 1000);
      return json(await vault.pull(after, limit));
    }
    case '/live': {
      const refused = allowed('GET') ?? (await admit(HEAVY));
      if (refused) return refused;
      const res = await vault.fetch(request);
      // A refusal is rebuilt, so it can carry the CORS headers.
      return res.status === 101 ? res : empty(res.status);
    }
    case '/account': {
      const refused = allowed('DELETE') ?? (await admit(HEAVY));
      if (refused) return refused;
      const denied = await vault.deleteAccount(sub, proof);
      return denied ? refuse(denied) : empty(204);
    }
  }

  const name = /^\/blob\/([^/]+)$/.exec(route)?.[1];
  if (name === undefined) return empty(404);
  if (!BLOB_NAME.test(name)) throw new BadRequest('Bad blob name');

  const refused = allowed('GET', 'PUT', 'DELETE') ?? (await admit(HEAVY, method === 'GET' ? undefined : { proof }));
  if (refused) return refused;
  if (method === 'PUT') return putBlob(request, env, vault, sub, name, proof);
  if (method === 'GET') {
    const got = await env.SYNC_BLOBS.get(r2Key(sub, name));
    if (!got) return empty(404);
    return new Response(got.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(got.size), 'x-content-type-options': 'nosniff' } });
  }
  const denied = await vault.deleteBlob(sub, name, proof);
  return denied ? refuse(denied) : empty(204);
}

/**
 * A blob is written once. Its bytes are reserved first (the quota check and the
 * reservation are one step in the vault), so however the upload ends, R2 holds
 * only what was counted: if anything fails, the object and the reservation go.
 */
async function putBlob(request: Request, env: SyncEnv, vault: DurableObjectStub<Vault>, sub: string, name: string, proof: string | null): Promise<Response> {
  const size = contentLength(request) ?? 0;
  if (size < 1 || size > MAX_BLOB || !request.body) throw new BadRequest('A blob needs a Content-Length of at most 9 MiB');
  const held = await vault.reserveBlob(sub, name, size, proof);
  if (held.status === 413) return json({ used: held.used, limit: held.limit }, 413);
  if (held.status === 409 && 'exists' in held) return empty(409);
  if (held.status !== 200) return refuse(held);

  let done = false;
  try {
    let stored: R2Object;
    try {
      stored = (await env.SYNC_BLOBS.put(r2Key(sub, name), request.body)) as R2Object;
    } catch (e) {
      // An upload that broke off, or didn't match its Content-Length.
      console.error('Blob upload failed', e);
      throw new BadRequest('Upload failed');
    }
    // Counted by what R2 holds, not by what the client said.
    const noted = await vault.commitBlob(name, held.id, stored.size);
    done = noted.ok;
    // Not counted any more (the account was deleted meanwhile, say): the object goes in `finally`.
    return json({ used: noted.used, limit: noted.limit }, noted.ok ? 200 : 409);
  } finally {
    if (!done) await vault.abandonBlob(sub, name, held.id).catch((e) => console.error('Could not release a blob', e));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('Not JSON');
  }
}
