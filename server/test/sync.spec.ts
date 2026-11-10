// The sync mailbox, in the Workers runtime (real Durable Objects and R2, run locally).
// Run with `npm test`. Sign-in tokens are made like auth.test.ts makes them.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { decode, encode } from '../src/mailbox';
import { Vault } from '../src/vault';

const ISSUER = env.CLERK_ISSUERS.split(',')[0];
const ORIGIN = 'http://tauri.localhost';
const clerk = await generateKeyPair('RS256');
const stranger = await generateKeyPair('RS256');

// Clerk's public keys, as jose fetches them.
beforeAll(async () => {
  const jwk = { ...(await exportJWK(clerk.publicKey)), kid: 'ins_1', alg: 'RS256', use: 'sig' };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    return real(input, init);
  });
});

interface Making {
  /** null leaves `exp` out. */
  expires?: string | null;
  key?: CryptoKey;
  iss?: string;
  /** Extra claims, or a claim set to undefined to leave it out. */
  claims?: Record<string, unknown>;
  /** Seconds ago the token was issued; null leaves `iat` out. */
  issued?: number | null;
}

function token(sub: string, { expires = '1m', key = clerk.privateKey, iss = ISSUER, claims = {}, issued = 0 }: Making = {}) {
  const jwt = new SignJWT({ sid: 'sess_1', sts: 'active', v: 2, azp: ORIGIN, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_1' })
    .setSubject(sub)
    .setIssuer(iss);
  if (expires !== null) jwt.setExpirationTime(expires);
  if (issued !== null) jwt.setIssuedAt(Math.floor(Date.now() / 1000) - issued);
  return jwt.sign(key);
}

let counter = 0;
/** A fresh account, so tests never share a vault. */
const account = () => `user_t${++counter}x${Math.random().toString(36).slice(2, 8)}`;

interface Call {
  method?: string;
  body?: BodyInit | null;
  json?: unknown;
  headers?: Record<string, string>;
  /** The account to sign in as; false for no token. */
  as?: string | false;
  /** The vault proof to send: by default the one `open` made for the account; false for none. */
  proof?: string | false;
  /** The Worker's environment, when a test needs R2 to misbehave. */
  worker?: object;
}

/** The proof each account's vault was opened with. */
const proofs = new Map<string, string>();

async function call(path: string, { method = 'GET', body, json, headers = {}, as = false, proof, worker: using = env }: Call = {}) {
  const h = new Headers(headers);
  if (as) h.set('Authorization', `Bearer ${await token(as)}`);
  if (json !== undefined) body = JSON.stringify(json);
  // A client sends the length of what it sends.
  if (!h.has('content-length') && (typeof body === 'string' || body instanceof Uint8Array)) h.set('content-length', String(typeof body === 'string' ? new TextEncoder().encode(body).length : body.length));
  const shown = proof ?? (as ? proofs.get(as) : undefined);
  if (shown) h.set('X-Vault-Proof', shown);
  return worker.fetch(new Request(`https://relay.test/sync${path}`, { method, body, headers: h }), using as never);
}

/** What the app derives from the vault key: 32 bytes, base64url. */
const makeProof = (fill = 5) => b64(32, fill);

/** Sets a wrapped key and a proof, as the app does when it makes the synced copy. */
async function open(sub: string, proof = encode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer)) {
  const res = await call('/key', { method: 'PUT', json: { wrappedKey: `wrapped-${sub}`, proof }, as: sub });
  expect(res.status).toBe(204);
  proofs.set(sub, proof);
  return proof;
}

/** A fresh account with its vault open. */
async function opened() {
  const sub = account();
  await open(sub);
  return sub;
}

/** What a stored item costs in `used`: its data, 256 and its key. */
const cost = (key: string, data = 0) => data + 256 + key.length;

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const b64 = (n: number, fill = 7) => encode(bytes(n, fill).buffer as ArrayBuffer);

type Item = Record<string, unknown>;
const rec = (key: string, base: number, n = 20, fill = 7): Item => ({ key, kind: 'r', data: b64(n, fill), base });
const upd = (key: string, n = 20, extra: Item = {}): Item => ({ key, kind: 'y', data: b64(n), ...extra });

const push = (as: string, items: Item[]) => call('/push', { method: 'POST', json: { items }, as });
const pull = async (as: string, query = '') => (await call(`/pull${query}`, { as })).json() as Promise<{ items: Item[]; seq: number; more: boolean }>;
const info = async (as: string) => (await call('/info', { as })).json() as Promise<{ seq: number; used: number; limit: number; wrappedKey: string | null; format: number }>;
const vaultOf = (sub: string) => env.VAULT.get(env.VAULT.idFromName(sub));
const blobName = (n: number) => n.toString(16).padStart(32, '0');
const putBlob = (as: string, name: string, data: Uint8Array, headers: Record<string, string> = { 'content-length': String(data.length) }) =>
  call(`/blob/${name}`, { method: 'PUT', body: data, headers, as });

/** What the account really stores, counted from the tables. */
function recount(sub: string) {
  return runInDurableObject(vaultOf(sub), (_, state) => {
    const one = (q: string) => Number(state.storage.sql.exec(q).one().n);
    return {
      recounted:
        one(`SELECT COALESCE(SUM(LENGTH(data) + 256 + LENGTH(key)), 0) AS n FROM items WHERE blob IS NULL`) +
        one(`SELECT COALESCE(SUM(256 + LENGTH(key)), 0) AS n FROM items WHERE blob IS NOT NULL`) +
        one(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs`) +
        one(`SELECT COALESCE(SUM(size), 0) AS n FROM holds`),
      counter: one(`SELECT v AS n FROM meta WHERE k = 'used'`),
    };
  });
}

function limitTo(sub: string, bytes: number) {
  return runInDurableObject(vaultOf(sub), (vault) => {
    // This object only: the env itself is shared by every vault.
    Object.defineProperty(vault, 'env', { value: { ...vault.env, SYNC_LIMIT_BYTES: String(bytes) } });
  });
}

/** A record as the vault takes it, for calling the vault directly. */
const direct = (key: string, base = 0) => ({ key, kind: 'r' as const, data: decode(b64(5)), base, first: false, upto: 0 });
/** A body that fails the test if anyone reads it. */
const poison = () => new ReadableStream({ pull() { throw new Error('the body was read'); } });
/** Runs `fn` inside one account's vault, with some of R2's methods replaced. */
const withR2 = <T>(sub: string, patch: Record<string, unknown>, fn: (vault: Vault) => Promise<T>) =>
  runInDurableObject(vaultOf(sub), async (vault) => {
    const real = vault.env;
    const r2 = real.SYNC_BLOBS;
    const patched = { list: r2.list.bind(r2), delete: r2.delete.bind(r2), put: r2.put.bind(r2), get: r2.get.bind(r2), ...patch };
    Object.defineProperty(vault, 'env', { value: { ...real, SYNC_BLOBS: patched }, configurable: true });
    try {
      return await fn(vault);
    } finally {
      Object.defineProperty(vault, 'env', { value: real, configurable: true });
    }
  });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const objectsOf = async (sub: string) => (await env.SYNC_BLOBS.list({ prefix: `v/${sub}/` })).objects.map((o) => o.key);
/** The bytes R2 really holds for the account. */
const storedBytes = async (sub: string) => (await env.SYNC_BLOBS.list({ prefix: `v/${sub}/` })).objects.reduce((sum, o) => sum + o.size, 0);

describe('sign-in and CORS', () => {
  const routes: [string, string][] = [
    ['GET', '/info'],
    ['PUT', '/key'],
    ['POST', '/push'],
    ['GET', '/pull'],
    ['PUT', `/blob/${blobName(1)}`],
    ['GET', `/blob/${blobName(1)}`],
    ['DELETE', `/blob/${blobName(1)}`],
    ['GET', '/live'],
    ['DELETE', '/account'],
    ['GET', '/nonsense'],
  ];

  it('refuses no token, a bad one, an expired one and one signed by someone else, saying nothing', async () => {
    const sub = account();
    const bad = {
      none: undefined,
      garbage: 'Bearer not-a-token',
      expired: `Bearer ${await token(sub, { expires: '-1m' })}`,
      forged: `Bearer ${await token(sub, { key: stranger.privateKey })}`,
      scheme: `Basic ${await token(sub)}`,
    };
    for (const [method, path] of routes)
      for (const [what, auth] of Object.entries(bad)) {
        const res = await call(path, { method, headers: auth ? { Authorization: auth } : {}, body: method === 'GET' || method === 'DELETE' ? null : '{}' });
        expect(res.status, `${method} ${path} ${what}`).toBe(401);
        expect(await res.text()).toBe('');
      }
  });

  it('answers a preflight for the app origins only', async () => {
    const ok = await call('/push', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, X-Vault-Proof');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    const no = await call('/push', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('puts the CORS headers on real answers, errors included', async () => {
    const sub = account();
    expect((await call('/info', { as: sub, headers: { Origin: ORIGIN } })).headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect((await call('/info', { headers: { Origin: ORIGIN } })).headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('keeps answering the old relay paths as before', async () => {
    expect((await worker.fetch(new Request('https://relay.test/'), env as never)).status).toBe(200);
    expect((await worker.fetch(new Request('https://relay.test/syncing'), env as never)).status).toBe(404);
  });

  it('knows nothing of other methods on a route, once signed in', async () => {
    const sub = account();
    expect((await call('/info', { method: 'POST', as: sub, body: '{}' })).status).toBe(405);
    expect((await call('/nonsense', { as: sub })).status).toBe(404);
  });
});

describe('test sign-ins', () => {
  const uuid = () => crypto.randomUUID();
  const asTest = (mode: string | undefined) => ({ ...env, AUTH_MODE: mode }) as never;
  const ask = (testEnv: never, token: string, ip?: string, path = '/info') =>
    worker.fetch(new Request(`https://relay.test/sync${path}`, { headers: { Authorization: `Bearer ${token}`, ...(ip ? { 'CF-Connecting-IP': ip } : {}) } }), testEnv);

  it('are refused when AUTH_MODE is not "test", even from this computer', async () => {
    for (const mode of [undefined, '', 'prod', 'TEST'])
      expect((await ask(asTest(mode), `test.${uuid()}`, '127.0.0.1')).status, String(mode)).toBe(401);
  });

  it('are refused in test mode from anywhere but this computer', async () => {
    const t = `test.${uuid()}`;
    for (const ip of [undefined, '203.0.113.7', '10.0.0.5', '']) expect((await ask(asTest('test'), t, ip)).status, String(ip)).toBe(401);
  });

  it('let the account in, in test mode from this computer, and keep the accounts apart', async () => {
    const [one, two] = [uuid(), uuid()];
    for (const ip of ['127.0.0.1', '::1']) expect((await ask(asTest('test'), `test.${one}`, ip)).status).toBe(200);
    const key = await worker.fetch(new Request('https://relay.test/sync/key', { method: 'PUT', body: JSON.stringify({ wrappedKey: 'k', proof: makeProof() }), headers: { Authorization: `Bearer test.${one}`, 'CF-Connecting-IP': '127.0.0.1' } }), asTest('test'));
    expect(key.status).toBe(204);
    expect(((await (await ask(asTest('test'), `test.${one}`, '127.0.0.1')).json()) as { wrappedKey: string | null }).wrappedKey).toBe('k');
    expect(((await (await ask(asTest('test'), `test.${two}`, '127.0.0.1')).json()) as { wrappedKey: string | null }).wrappedKey).toBeNull();
  });

  it('refuse anything else in test mode: a real token, a malformed one', async () => {
    const bad = [await token(account()), 'test.', 'test.abc', `test.${uuid()}x`, `test.${uuid().toUpperCase()}`, `Test.${uuid()}`, `test.${'a'.repeat(36)}/../x`];
    for (const t of bad) expect((await ask(asTest('test'), t, '127.0.0.1')).status, t).toBe(401);
  });

  it('are refused on the live socket too, unless it is test mode from this computer', async () => {
    const live = (testEnv: never, ip?: string) =>
      worker.fetch(new Request('https://relay.test/sync/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, test.${uuid()}`, ...(ip ? { 'CF-Connecting-IP': ip } : {}) } }), testEnv);
    expect((await live(asTest(undefined), '127.0.0.1')).status).toBe(401);
    expect((await live(asTest('test'))).status).toBe(401);
    const ok = await live(asTest('test'), '127.0.0.1');
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close();
  });
});

describe('info and the wrapped key', () => {
  it('starts empty, with the limit', async () => {
    const sub = account();
    expect(await info(sub)).toEqual({ seq: 0, used: 0, limit: 1073741824, wrappedKey: null, keySetAt: null, empty: true, format: 1 });
  });

  it('is set once', async () => {
    const sub = account();
    expect((await call('/key', { method: 'PUT', json: { wrappedKey: 'AAAA_bbb-1', proof: makeProof(1) }, as: sub })).status).toBe(204);
    expect((await call('/key', { method: 'PUT', json: { wrappedKey: 'CCCC', proof: makeProof(2) }, as: sub })).status).toBe(409);
    expect((await info(sub)).wrappedKey).toBe('AAAA_bbb-1');
  });

  it('refuses a missing or odd key or proof', async () => {
    const sub = account();
    const proof = makeProof();
    const bad = ['{}', '{"wrappedKey":5}', '{"wrappedKey":""}', `{"wrappedKey":"${'a'.repeat(4097)}"}`, 'nope', 'null'];
    for (const body of bad) expect((await call('/key', { method: 'PUT', body, as: sub })).status, body).toBe(400);
    const key = (p: unknown) => JSON.stringify({ wrappedKey: 'k', proof: p });
    // No proof, a short or long one, not base64url, not text, and 43 characters that are not 32 bytes' worth.
    for (const body of [JSON.stringify({ wrappedKey: 'k' }), key(proof.slice(1)), key(`${proof}A`), key(`${proof.slice(1)}+`), key(5), key(null), key('')])
      expect((await call('/key', { method: 'PUT', body, as: sub })).status, body).toBe(400);
    expect((await info(sub)).wrappedKey).toBeNull();
  });

  it('keeps only a hash of the proof', async () => {
    const sub = account();
    const proof = await open(sub);
    const stored = await runInDurableObject(vaultOf(sub), (_, state) => state.storage.sql.exec(`SELECT v FROM meta WHERE k = 'proof'`).one().v as string);
    expect(stored).not.toBe(proof);
    expect(stored).toBe(encode(await crypto.subtle.digest('SHA-256', decode(proof))));
    expect(JSON.stringify(await info(sub))).not.toContain(proof);
  });
});

describe('push and pull', () => {
  it('numbers items, and a record keeps one row: a pull from zero sees only the latest', async () => {
    const sub = await opened();
    const first = await push(sub, [rec('aaa', 0, 10, 1)]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ seq: 1, results: [{ key: 'aaa', seq: 1 }], used: cost('aaa', 10) });
    const second = (await (await push(sub, [rec('aaa', 1, 30, 2)])).json()) as { seq: number; used: number };
    expect(second).toMatchObject({ seq: 2, used: cost('aaa', 30) });
    const page = await pull(sub);
    expect(page.items).toEqual([{ seq: 2, key: 'aaa', kind: 'r', data: b64(30, 2) }]);
    expect(page).toMatchObject({ seq: 2, more: false });
  });

  it('refuses a stale base with the conflicting keys, and a retry after pulling works', async () => {
    const sub = await opened();
    await push(sub, [rec('k1', 0)]);
    const other = await push(sub, [rec('k1', 0), rec('k2', 0), rec('k3', 5)]);
    expect(other.status).toBe(409);
    // Each conflict carries the seq the key has now (k3 is new: 0).
    expect(await other.json()).toEqual({ conflicts: [{ key: 'k1', seq: 1 }, { key: 'k3', seq: 0 }] });
    expect((await info(sub)).seq).toBe(1);
    const current = (await pull(sub)).items[0].seq as number;
    const retry = await push(sub, [rec('k1', current), rec('k2', 0), rec('k3', 0)]);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { seq: number }).seq).toBe(4);
  });

  it('is all or nothing: one bad base stores nothing and seq does not move', async () => {
    const sub = await opened();
    await push(sub, [rec('keep', 0)]);
    const before = await info(sub);
    const res = await push(sub, [rec('new1', 0), upd('textA'), rec('keep', 99), rec('new2', 0)]);
    expect(res.status).toBe(409);
    expect(await info(sub)).toEqual(before);
    expect((await pull(sub)).items).toHaveLength(1);
  });

  it('rolls back a push that fails halfway (a snapshot of a seq that does not exist yet)', async () => {
    const sub = await opened();
    const before = await info(sub);
    const res = await push(sub, [rec('new1', 0), { key: 'textA', kind: 's', data: b64(5), upto: 50 }]);
    expect(res.status).toBe(400);
    expect(await info(sub)).toEqual(before);
    expect((await pull(sub)).items).toHaveLength(0);
    expect(await recount(sub)).toEqual({ recounted: 0, counter: 0 });
  });

  it('answers a stale record, and a first on a text with several items, with the seq each has now', async () => {
    const sub = await opened();
    await push(sub, [upd('doc', 10), upd('doc', 10)]);
    await push(sub, [rec('r', 0)]);
    await push(sub, [rec('r', 3)]);
    const res = await push(sub, [upd('doc', 5, { first: true }), rec('r', 3), rec('fresh', 7)]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ conflicts: [{ key: 'doc', seq: 2 }, { key: 'r', seq: 4 }, { key: 'fresh', seq: 0 }] });
  });

  it('refuses "first" when the key already has items', async () => {
    const sub = await opened();
    expect((await push(sub, [upd('doc', 10, { first: true })])).status).toBe(200);
    const again = await push(sub, [upd('doc', 10, { first: true }), rec('other', 0)]);
    expect(again.status).toBe(409);
    // The seq is the key's newest item.
    expect(await again.json()).toEqual({ conflicts: [{ key: 'doc', seq: 1 }] });
    expect((await pull(sub)).items).toHaveLength(1);
    expect((await push(sub, [upd('doc')])).status).toBe(200);
    expect((await pull(sub)).items.filter((i) => i.key === 'doc')).toHaveLength(2);
  });

  it('pages a pull by count, with `more` and a cursor that continues', async () => {
    const sub = await opened();
    for (let i = 0; i < 5; i++) await push(sub, [rec(`key${i}`, 0)]);
    const one = await pull(sub, '?limit=2');
    expect(one.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(one).toMatchObject({ more: true, seq: 2 });
    const two = await pull(sub, `?after=${one.seq}&limit=2`);
    expect(two.items.map((i) => i.seq)).toEqual([3, 4]);
    expect(two.more).toBe(true);
    const three = await pull(sub, `?after=${two.seq}&limit=2`);
    expect(three.items.map((i) => i.seq)).toEqual([5]);
    expect(three).toMatchObject({ more: false, seq: 5 });
    expect(await pull(sub, '?after=5')).toEqual({ items: [], seq: 5, more: false });
  });

  it('stops a page at about 4 MB', async () => {
    const sub = await opened();
    for (const k of ['big1', 'big2', 'big3']) expect((await push(sub, [rec(k, 0, 1_500_000)])).status).toBe(200);
    const one = await pull(sub);
    expect(one.items).toHaveLength(2);
    expect(one.more).toBe(true);
    const two = await pull(sub, `?after=${one.seq}`);
    expect(two.items).toHaveLength(1);
    expect(two.more).toBe(false);
  });

  it('always sends at least one item, however big', async () => {
    const sub = await opened();
    await push(sub, [rec('huge', 0, 2 * 1024 * 1024)]);
    expect((await pull(sub)).items).toHaveLength(1);
  });

  it('compacts: a snapshot replaces the key\'s updates up to `upto`, shrinks used, and leaves the rest', async () => {
    const sub = await opened();
    await push(sub, [upd('doc', 100), upd('doc', 100), upd('doc', 100), upd('other', 100)]);
    expect((await info(sub)).used).toBe(3 * cost('doc', 100) + cost('other', 100));
    const snap = await push(sub, [{ key: 'doc', kind: 's', data: b64(50), upto: 3 }]);
    expect(((await snap.json()) as { used: number }).used).toBe(cost('doc', 50) + cost('other', 100));
    await push(sub, [upd('doc', 10)]);
    const page = await pull(sub);
    expect(page.items.map((i) => [i.key, i.kind, i.seq])).toEqual([
      ['other', 'y', 4],
      ['doc', 's', 5],
      ['doc', 'y', 6],
    ]);
    // A newer snapshot replaces the old one too.
    await push(sub, [{ key: 'doc', kind: 's', data: b64(20), upto: 6 }]);
    expect((await pull(sub)).items.map((i) => [i.key, i.kind])).toEqual([['other', 'y'], ['doc', 's']]);
    expect(await recount(sub)).toEqual({ recounted: cost('doc', 20) + cost('other', 100), counter: cost('doc', 20) + cost('other', 100) });
  });

  it('takes data up to 2 MB', async () => {
    const sub = await opened();
    expect((await push(sub, [rec('max', 0, 2 * 1024 * 1024)])).status).toBe(200);
  });
});

describe('quota', () => {
  it('refuses what would go over, with used and limit, and stores nothing', async () => {
    const sub = await opened();
    await limitTo(sub, 1000);
    expect((await push(sub, [rec('a', 0, 600)])).status).toBe(200);
    const over = await push(sub, [rec('b', 0, 500)]);
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ used: cost('a', 600), limit: 1000 });
    expect((await info(sub)).seq).toBe(1);
  });

  it('lets a push through that does not add bytes, even full', async () => {
    const sub = await opened();
    await limitTo(sub, 1000);
    await push(sub, [rec('a', 0, 300), rec('b', 0, 186)]);
    expect((await info(sub)).used).toBe(1000);
    expect((await push(sub, [rec('c', 0, 1)])).status).toBe(413);
    // Same size, smaller, and a snapshot that shrinks.
    expect((await push(sub, [rec('b', 2, 186)])).status).toBe(200);
    expect((await push(sub, [rec('a', 1, 10)])).status).toBe(200);
    expect((await info(sub)).used).toBe(710);
    await limitTo(sub, 100);
    expect((await push(sub, [rec('b', 3, 50)])).status, 'over the limit already, but shrinking').toBe(200);
    expect((await push(sub, [rec('b', 5, 91)])).status).toBe(413);
  });

  it('counts a replacement against what it frees in the same push', async () => {
    const sub = await opened();
    await limitTo(sub, 1250);
    await push(sub, [rec('a', 0, 900)]);
    expect((await push(sub, [rec('a', 1, 950)])).status).toBe(200);
    expect((await push(sub, [rec('a', 2, 1001)])).status).toBe(413);
  });

  it('stops a blob that does not fit, before storing any of it', async () => {
    const sub = await opened();
    await limitTo(sub, 1000);
    const res = await putBlob(sub, blobName(1), bytes(2000));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ used: 0, limit: 1000 });
    expect(await objectsOf(sub)).toEqual([]);
  });
});

describe('blobs', () => {
  it('puts, gets and deletes, counting the bytes', async () => {
    const sub = await opened();
    const name = blobName(0xabc);
    const put = await putBlob(sub, name, bytes(5000, 9));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ used: 5000, limit: 1073741824 });
    expect(await objectsOf(sub)).toEqual([`v/${sub}/${name}`]);
    const got = await call(`/blob/${name}`, { as: sub });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes(5000, 9));
    // Written once: the same name again is refused, and nothing changes.
    expect((await putBlob(sub, name, bytes(3000))).status).toBe(409);
    expect(new Uint8Array(await (await call(`/blob/${name}`, { as: sub })).arrayBuffer())).toEqual(bytes(5000, 9));
    expect((await info(sub)).used).toBe(5000);
    expect(await storedBytes(sub)).toBe(5000);
    expect((await call(`/blob/${name}`, { method: 'DELETE', as: sub })).status).toBe(204);
    expect((await call(`/blob/${name}`, { as: sub })).status).toBe(404);
    expect((await info(sub)).used).toBe(0);
    expect((await call(`/blob/${name}`, { method: 'DELETE', as: sub })).status).toBe(204);
  });

  it('wants a lowercase hex name, a Content-Length, and at most 9 MiB', async () => {
    const sub = await opened();
    for (const name of ['abc', blobName(0xabc).toUpperCase(), `${blobName(1)}0`, 'g'.repeat(32)])
      expect((await putBlob(sub, name, bytes(10))).status, name).toBe(400);
    expect((await putBlob(sub, blobName(1), bytes(10), { 'content-length': '' })).status).toBe(400);
    expect((await putBlob(sub, blobName(1), bytes(10), { 'content-length': '0' })).status).toBe(400);
    expect((await putBlob(sub, blobName(1), bytes(10), { 'content-length': 'x' })).status).toBe(400);
    expect((await putBlob(sub, blobName(1), bytes(9 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await putBlob(sub, blobName(1), bytes(9 * 1024 * 1024))).status).toBe(200);
    expect((await call(`/blob/${blobName(1)}x`, { as: sub })).status).toBe(400);
  });

  it('is not counted twice when an item uses it', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(5000));
    const res = await push(sub, [{ key: 'file1', kind: 'r', blob: blobName(1), size: 5000, base: 0 }]);
    expect(await res.json()).toMatchObject({ used: 5000 + cost('file1') });
    expect(await pull(sub)).toMatchObject({ items: [{ seq: 1, key: 'file1', kind: 'r', blob: blobName(1) }] });
    expect(await recount(sub)).toEqual({ recounted: 5000 + cost('file1'), counter: 5000 + cost('file1') });
  });

  it('refuses an item for a blob that was never uploaded, storing nothing', async () => {
    const sub = await opened();
    const res = await push(sub, [rec('a', 0), { key: 'b', kind: 'r', blob: blobName(7), base: 0 }]);
    expect(res.status).toBe(400);
    expect(await info(sub)).toMatchObject({ seq: 0, used: 0 });
  });

  it('deletes the blob of a replaced item, from R2 too, and subtracts it', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(5000));
    await push(sub, [{ key: 'file1', kind: 'r', blob: blobName(1), base: 0 }]);
    const res = await push(sub, [rec('file1', 1, 40)]);
    expect(await res.json()).toMatchObject({ used: cost('file1', 40) });
    expect(await objectsOf(sub)).toEqual([]);
    expect((await call(`/blob/${blobName(1)}`, { as: sub })).status).toBe(404);
    expect(await recount(sub)).toEqual({ recounted: cost('file1', 40), counter: cost('file1', 40) });
  });

  it('keeps a blob that another item, or the replacement itself, still uses', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(500));
    await push(sub, [{ key: 'one', kind: 'r', blob: blobName(1), base: 0 }, { key: 'two', kind: 'r', blob: blobName(1), base: 0 }]);
    await push(sub, [rec('one', 1, 10)]);
    expect(await objectsOf(sub)).toHaveLength(1);
    await push(sub, [{ key: 'two', kind: 'r', blob: blobName(1), base: 2 }]);
    expect(await objectsOf(sub)).toHaveLength(1);
    expect((await info(sub)).used).toBe(500 + cost('one', 10) + cost('two'));
  });

  it('deletes the blobs of updates a snapshot replaces', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(500));
    await push(sub, [{ key: 'doc', kind: 'y', blob: blobName(1) }]);
    await push(sub, [{ key: 'doc', kind: 's', data: b64(30), upto: 1 }]);
    expect(await objectsOf(sub)).toEqual([]);
    expect(await recount(sub)).toEqual({ recounted: cost('doc', 30), counter: cost('doc', 30) });
  });

  it('does not fail the push when the object delete fails, and tries again an hour later', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(500));
    await push(sub, [{ key: 'file1', kind: 'r', blob: blobName(1), base: 0 }]);
    const res = await runInDurableObject(vaultOf(sub), async (vault) => {
      const real = vault.env;
      const broken = { delete: async () => { throw new Error('R2 is down'); } };
      Object.defineProperty(vault, 'env', { value: { ...real, SYNC_BLOBS: broken }, configurable: true });
      try {
        return await vault.push(sub, [{ key: 'file1', kind: 'r', data: decode(b64(5)), base: 1, first: false, upto: 0 }], proofs.get(sub)!);
      } finally {
        Object.defineProperty(vault, 'env', { value: real, configurable: true });
      }
    });
    // The object is still there, so its bytes are still counted.
    expect(res).toMatchObject({ status: 200, used: cost('file1', 5) + 500 });
    expect(await objectsOf(sub)).toHaveLength(1);
    expect(await recount(sub)).toEqual({ recounted: cost('file1', 5) + 500, counter: cost('file1', 5) + 500 });

    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60_000);
    try {
      await runInDurableObject(vaultOf(sub), (vault) => vault.push(sub, [], proofs.get(sub)!));
    } finally {
      later.mockRestore();
    }
    expect(await objectsOf(sub)).toEqual([]);
    expect(await recount(sub)).toEqual({ recounted: cost('file1', 5), counter: cost('file1', 5) });
  });
});

describe('used', () => {
  it('equals a recount after a random run of operations', async () => {
    const sub = await opened();
    let seed = 12345;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const seqs = new Map<string, number>();
    const blobs = new Set<string>();
    let latest = 0;
    let pushes = 0;
    let blobCount = 0;

    const send = async (items: Item[]) => {
      pushes++;
      const res = await push(sub, items);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { seq: number; results: { key: string; seq: number }[] };
      latest = body.seq;
      for (const [i, r] of body.results.entries()) if (items[i].kind === 'r') seqs.set(r.key, r.seq);
    };

    for (let step = 0; step < 110 && pushes < 100; step++) {
      const key = `k${rand(8)}`;
      switch (rand(6)) {
        case 0:
        case 1:
          await send([rec(key, seqs.get(key) ?? 0, 1 + rand(3000))]);
          break;
        case 2:
          await send([upd(`t${rand(3)}`, 1 + rand(500))]);
          break;
        case 3:
          if (latest) await send([{ key: `t${rand(3)}`, kind: 's', data: b64(1 + rand(200)), upto: rand(latest + 1) }]);
          break;
        case 4: {
          const name = blobName(++blobCount);
          expect((await putBlob(sub, name, bytes(1 + rand(4000)))).status).toBe(200);
          blobs.add(name);
          if (rand(2)) await send([{ key, kind: 'r', blob: name, base: seqs.get(key) ?? 0 }]);
          break;
        }
        case 5: {
          const name = [...blobs][rand(blobs.size || 1)];
          if (name) {
            expect((await call(`/blob/${name}`, { method: 'DELETE', as: sub })).status).toBe(204);
            blobs.delete(name);
          }
          break;
        }
      }
      if (step % 10 === 0) {
        const { recounted, counter } = await recount(sub);
        expect(counter).toBe(recounted);
        expect((await info(sub)).used).toBe(recounted);
      }
    }
    const { recounted, counter } = await recount(sub);
    expect(counter).toBe(recounted);
    expect((await info(sub)).used).toBe(recounted);
  }, 30_000);
});

describe('accounts are separate', () => {
  it('shows one account nothing of another\'s items or blobs', async () => {
    const [a, b] = [await opened(), await opened()];
    await push(a, [rec('secret', 0)]);
    await putBlob(a, blobName(1), bytes(100));
    expect((await pull(b)).items).toEqual([]);
    expect(await info(b)).toMatchObject({ seq: 0, used: 0 });
    expect((await call(`/blob/${blobName(1)}`, { as: b })).status).toBe(404);
    // B deleting the same name touches nothing of A's.
    await call(`/blob/${blobName(1)}`, { method: 'DELETE', as: b });
    expect((await call(`/blob/${blobName(1)}`, { as: a })).status).toBe(200);
    expect(await objectsOf(a)).toHaveLength(1);
    expect(await objectsOf(b)).toEqual([]);
    // B's own blob under that name is its own.
    await putBlob(b, blobName(1), bytes(7));
    expect((await call(`/blob/${blobName(1)}`, { as: a })).headers.get('content-length')).toBe('100');
    expect((await info(a)).used).toBe(cost('secret', 20) + 100);
  });

  it('cannot name another account\'s path through a blob name', async () => {
    const [a, b] = [await opened(), await opened()];
    await putBlob(a, blobName(1), bytes(100));
    for (const name of [`..%2F${a}%2F${blobName(1)}`, `${a}/${blobName(1)}`])
      expect((await call(`/blob/${name}`, { as: b })).status, name).toBeGreaterThanOrEqual(400);
  });
});

describe('bad input', () => {
  const ok = { key: 'k', kind: 'r', data: 'AAAA', base: 0 };
  const bad: [string, unknown][] = [
    ['an array', []],
    ['no items', {}],
    ['items not an array', { items: 'x' }],
    ['null', null],
    ['an item that is not an object', { items: ['x'] }],
    ['too many items', { items: Array.from({ length: 1001 }, (_, i) => ({ ...ok, key: `k${i}` })) }],
    ['an empty key', { items: [{ ...ok, key: '' }] }],
    ['a long key', { items: [{ ...ok, key: 'a'.repeat(65) }] }],
    ['a key with other characters', { items: [{ ...ok, key: 'a/b' }] }],
    ['a key that is not text', { items: [{ ...ok, key: 5 }] }],
    ['a padded key', { items: [{ ...ok, key: 'abcd=' }] }],
    ['an unknown kind', { items: [{ ...ok, kind: 'x' }] }],
    ['no kind', { items: [{ key: 'k', data: 'AAAA', base: 0 }] }],
    ['data and a blob', { items: [{ ...ok, blob: blobName(1) }] }],
    ['neither data nor blob', { items: [{ key: 'k', kind: 'r', base: 0 }] }],
    ['data that is not text', { items: [{ ...ok, data: 5 }] }],
    ['empty data', { items: [{ ...ok, data: '' }] }],
    ['data with standard base64 characters', { items: [{ ...ok, data: 'ab+/' }] }],
    ['padded data', { items: [{ ...ok, data: 'AAA=' }] }],
    ['data of an impossible length', { items: [{ ...ok, data: 'AAAAA' }] }],
    ['data over 2 MB', { items: [{ ...ok, data: b64(2 * 1024 * 1024 + 1) }] }],
    ['a blob name in capitals', { items: [{ key: 'k', kind: 'r', blob: 'A'.repeat(32), base: 0 }] }],
    ['a short blob name', { items: [{ key: 'k', kind: 'r', blob: 'ab', base: 0 }] }],
    ['a record without its base', { items: [{ key: 'k', kind: 'r', data: 'AAAA' }] }],
    ['a negative base', { items: [{ ...ok, base: -1 }] }],
    ['a fractional base', { items: [{ ...ok, base: 1.5 }] }],
    ['a base as text', { items: [{ ...ok, base: '0' }] }],
    ['a huge base', { items: [{ ...ok, base: 1e30 }] }],
    ['first as text', { items: [{ key: 'k', kind: 'y', data: 'AAAA', first: 'yes' }] }],
    ['upto as text', { items: [{ key: 'k', kind: 's', data: 'AAAA', upto: 'x' }] }],
    ['a record twice', { items: [ok, ok] }],
    ['two firsts for one key', { items: [{ key: 'k', kind: 'y', data: 'AAAA', first: true }, { key: 'k', kind: 'y', data: 'AAAA', first: true }] }],
  ];

  it.each(bad)('refuses %s with 400, storing nothing', async (_, body) => {
    const sub = await opened();
    const res = await call('/push', { method: 'POST', json: body, as: sub });
    expect(res.status).toBe(400);
    expect(await info(sub)).toMatchObject({ seq: 0, used: 0 });
  });

  it('refuses a body that is not JSON, not text, or too big', async () => {
    const sub = await opened();
    for (const body of ['', '{', 'nope', new Uint8Array([0xff, 0xfe, 0x7b])] as BodyInit[])
      expect((await call('/push', { method: 'POST', body, as: sub })).status).toBe(400);
    const big = `{"items":[],"pad":"${'x'.repeat(32 * 1024 * 1024)}"}`;
    expect((await call('/push', { method: 'POST', body: big, as: sub })).status).toBe(400);
    expect(await info(sub)).toMatchObject({ seq: 0 });
  });

  it('accepts exactly 1000 items', async () => {
    const sub = await opened();
    const items = Array.from({ length: 1000 }, (_, i) => ({ ...ok, key: `k${i}` }));
    expect((await call('/push', { method: 'POST', json: { items }, as: sub })).status).toBe(200);
  });

  it('refuses bad pull parameters', async () => {
    const sub = await opened();
    for (const q of ['?after=-1', '?after=abc', '?after=1.5', '?limit=0', '?limit=1001', '?limit=x', '?after=99999999999999999999'])
      expect((await call(`/pull${q}`, { as: sub })).status, q).toBe(400);
  });
});

describe('rate limit', () => {
  /** How many calls an account gets through before the first 429. */
  async function until429(sub: string, path: string, init: Call = {}) {
    const Authorization = `Bearer ${await token(sub)}`;
    for (let n = 0; n < 700; n++) {
      const res = await call(path, { ...init, headers: { Authorization, ...init.headers } });
      if (res.status === 429) return { n, res };
    }
    throw new Error('never limited');
  }

  it('answers 429 with Retry-After after about 120 pushes in a minute, storing nothing from the refused one', async () => {
    const sub = await opened();
    const { n, res } = await until429(sub, '/push', { method: 'POST', json: { items: [] }, proof: proofs.get(sub) });
    // The key call that opened the vault spent a little too.
    expect(n).toBeGreaterThanOrEqual(119);
    expect(n).toBeLessThanOrEqual(120);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    expect((await push(sub, [rec('a', 0)])).status).toBe(429);
    expect((await runInDurableObject(vaultOf(sub), (v) => v.info())).seq).toBe(0);
    // Another account is not affected.
    expect((await push(await opened(), [])).status).toBe(200);
  }, 30_000);

  it('limits pulls too, which weigh as much as a push', async () => {
    const sub = await opened();
    const { n, res } = await until429(sub, '/pull');
    expect(n).toBeGreaterThanOrEqual(119);
    expect(n).toBeLessThanOrEqual(120);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('weighs an info call far less than a pull', async () => {
    const sub = await opened();
    const { n } = await until429(sub, '/info');
    expect(n).toBeGreaterThanOrEqual(590);
    expect(n).toBeLessThanOrEqual(599);
  }, 30_000);

  it('shares one budget between every route: blob calls and pulls draw on the same minute', async () => {
    const sub = await opened();
    const Authorization = `Bearer ${await token(sub)}`;
    let n = 0;
    for (; n < 700; n++) {
      const path = n % 2 ? '/pull' : `/blob/${blobName(9)}`;
      if ((await call(path, { headers: { Authorization } })).status === 429) break;
    }
    expect(n).toBeGreaterThanOrEqual(119);
    expect(n).toBeLessThanOrEqual(120);
    // Even the writes: a blob upload and a delete are refused too, before anything is stored.
    expect((await putBlob(sub, blobName(1), bytes(10))).status).toBe(429);
    expect((await call(`/blob/${blobName(1)}`, { method: 'DELETE', as: sub })).status).toBe(429);
    expect((await call('/account', { method: 'DELETE', as: sub })).status).toBe(429);
    expect(await objectsOf(sub)).toEqual([]);
  }, 30_000);

  it('opens the budget again as the minute passes', async () => {
    const sub = await opened();
    const { res } = await until429(sub, '/pull');
    expect(res.status).toBe(429);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      // Straight into the vault: a token made now would be dated in the future.
      expect(await runInDurableObject(vaultOf(sub), (vault) => vault.admit(5))).toBeNull();
    } finally {
      later.mockRestore();
    }
  }, 30_000);
});

describe('the item bucket', () => {
  const bucketOf = (sub: string) =>
    runInDurableObject(vaultOf(sub), (_, state) => JSON.parse(state.storage.sql.exec(`SELECT v FROM meta WHERE k = 'bucket'`).one().v as string) as { tokens: number; at: number });
  const setBucket = (sub: string, tokens: number, at = Date.now()) =>
    runInDurableObject(vaultOf(sub), (_, state) => void state.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bucket', ?)`, JSON.stringify({ tokens, at })));
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => rec(`i${from + i}`, 0, 1));

  it('starts at 200,000 and a push takes one per item', async () => {
    const sub = await opened();
    expect((await push(sub, many(1000))).status).toBe(200);
    const { tokens } = await bucketOf(sub);
    expect(tokens).toBeGreaterThan(199_000 - 1);
    expect(tokens).toBeLessThanOrEqual(199_000);
  });

  it('answers 429 with Retry-After when a push needs more than there is, and stores nothing', async () => {
    const sub = await opened();
    await setBucket(sub, 3);
    const res = await push(sub, many(4));
    expect(res.status).toBe(429);
    // One more item takes 24 h / 200,000 = 0.43 s to come back.
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await info(sub)).toMatchObject({ seq: 0, used: 0 });
    expect((await push(sub, many(3))).status).toBe(200);
    // Empty: refused before the body is read.
    await setBucket(sub, 0);
    expect((await call('/push', { method: 'POST', body: poison(), headers: { 'content-length': '50' }, as: sub })).status).toBe(429);
  });

  it('refills linearly over a day, to 200,000 at most', async () => {
    const sub = await opened();
    await setBucket(sub, 0, Date.now());
    const day = 24 * 60 * 60_000;
    const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);
    let spy = at(day / 2);
    try {
      // Half a day: 100,000 items back, 1000 of them spent.
      await runInDurableObject(vaultOf(sub), async (vault) => {
        const items = Array.from({ length: 1000 }, (_, i) => direct(`h${i}`));
        expect((await vault.push(sub, items, proofs.get(sub)!)).status).toBe(200);
      });
      expect((await bucketOf(sub)).tokens).toBeGreaterThan(98_900);
      expect((await bucketOf(sub)).tokens).toBeLessThan(99_100);
      spy.mockRestore();
      spy = at(10 * day);
      await runInDurableObject(vaultOf(sub), (vault) => vault.push(sub, [direct('last')], proofs.get(sub)!));
      expect((await bucketOf(sub)).tokens).toBe(199_999);
    } finally {
      spy.mockRestore();
    }
  });

  it('survives the object being evicted: a fresh instance over the same storage sees the same bucket', async () => {
    const sub = await opened();
    await push(sub, many(10));
    await setBucket(sub, 2);
    await runInDurableObject(vaultOf(sub), async (vault, state) => {
      const fresh = new Vault(state, vault.env);
      const proof = proofs.get(sub)!;
      expect(await fresh.push(sub, [direct('a1'), direct('a2'), direct('a3')], proof)).toMatchObject({ status: 429 });
      expect(await fresh.push(sub, [direct('a1'), direct('a2')], proof)).toMatchObject({ status: 200 });
      expect(await new Vault(state, vault.env).push(sub, [direct('a3')], proof)).toMatchObject({ status: 429 });
    });
  });

  it('is spent only by a push that is stored: conflicts, quota and bad snapshots cost nothing', async () => {
    const sub = await opened();
    await push(sub, [rec('a', 0)]);
    const before = (await bucketOf(sub)).tokens;
    expect((await push(sub, [rec('a', 0), rec('b', 0)])).status).toBe(409);
    expect((await push(sub, [rec('c', 0), { key: 'd', kind: 's', data: b64(5), upto: 99 }])).status).toBe(400);
    await limitTo(sub, 100);
    expect((await push(sub, [rec('e', 0, 500)])).status).toBe(413);
    // The bucket refills a little between calls, never loses anything to these.
    expect((await bucketOf(sub)).tokens).toBeGreaterThanOrEqual(before);
  });

  it('takes the items of a push that replaces others, not the net', async () => {
    const sub = await opened();
    await push(sub, many(5));
    const before = (await bucketOf(sub)).tokens;
    await push(sub, many(5).map((r, i) => ({ ...r, base: i + 1 })));
    // 5 spent, less what refilled meanwhile (a few tenths); a charge of the net would be 0.
    expect(before - (await bucketOf(sub)).tokens).toBeGreaterThan(3);
  });
});

describe('live', () => {
  const open = async (sub: string) => {
    const res = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(sub)}` } });
    expect(res.status).toBe(101);
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('thoughtdesk');
    const ws = res.webSocket!;
    const seen: unknown[] = [];
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    ws.addEventListener('message', (e) => {
      if (String(e.data).startsWith('{')) seen.push(JSON.parse(e.data as string));
    });
    ws.accept();
    return { ws, seen, closed };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('tells every open socket the new seq after a push', async () => {
    const sub = await opened();
    const one = await open(sub);
    const two = await open(sub);
    await push(sub, [rec('a', 0)]);
    await push(sub, [rec('b', 0)]);
    await until(() => one.seen.length === 2 && two.seen.length === 2);
    expect(one.seen).toEqual([{ seq: 1 }, { seq: 2 }]);
    // A refused push says nothing.
    await push(sub, [rec('a', 0)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(one.seen).toHaveLength(2);
    one.ws.close();
    two.ws.close();
  });

  it('does not tell another account', async () => {
    const [a, b] = [await opened(), await opened()];
    const other = await open(b);
    await push(a, [rec('a', 0)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(other.seen).toEqual([]);
    other.ws.close();
  });

  it('refuses a socket without a good token, and a plain request', async () => {
    const sub = await opened();
    const noToken = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'thoughtdesk' } });
    expect(noToken.status).toBe(401);
    const viaHeader = await call('/live', { as: sub, headers: { Upgrade: 'websocket' } });
    expect(viaHeader.status, 'the token only counts as a subprotocol').toBe(401);
    const plain = await call('/live', { headers: { 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(sub)}` } });
    expect(plain.status).toBe(426);
  });

  it('lets go of a socket 15 minutes old by alarm, and sets no alarm when none are left', async () => {
    const sub = await opened();
    const { seen, closed } = await open(sub);
    expect(await runInDurableObject(vaultOf(sub), (_, state) => state.storage.getAlarm())).not.toBeNull();
    // Too early: nothing closes, and the alarm is set again.
    expect(await runDurableObjectAlarm(vaultOf(sub))).toBe(true);
    expect(await runInDurableObject(vaultOf(sub), (_, state) => state.storage.getAlarm())).not.toBeNull();
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60_000 + 1000);
    await runDurableObjectAlarm(vaultOf(sub));
    later.mockRestore();
    expect(await closed).toBe(4001);
    expect(seen).toEqual([]);
    expect(await runInDurableObject(vaultOf(sub), (_, state) => state.storage.getAlarm())).toBeNull();
  });

  it('answers a ping without waking anything', async () => {
    const sub = await opened();
    const { ws } = await open(sub);
    const pong = new Promise((resolve) => ws.addEventListener('message', (e) => resolve(e.data)));
    ws.send('ping');
    expect(await pong).toBe('pong');
    ws.close();
  });
});

describe('delete account', () => {
  it('deletes a long list of objects page by page', async () => {
    const [a, b] = [await opened(), await opened()];
    for (let i = 0; i < 10; i++) await env.SYNC_BLOBS.put(`v/${a}/${blobName(i)}`, 'x');
    await env.SYNC_BLOBS.put(`v/${a}x/${blobName(1)}`, 'x');
    await env.SYNC_BLOBS.put(`v/${b}/${blobName(1)}`, 'x');
    await runInDurableObject(vaultOf(a), (vault) => vault.deleteAccount(a, proofs.get(a)!, 3));
    expect(await objectsOf(a)).toEqual([]);
    expect(await objectsOf(`${a}x`)).toHaveLength(1);
    expect(await objectsOf(b)).toHaveLength(1);
  });

  it('removes every object, row and alarm of this account and nothing of another', async () => {
    const [a, b] = [await opened(), await opened()];
    await push(a, [rec('x', 0), upd('y')]);
    await putBlob(a, blobName(1), bytes(100));
    await push(b, [rec('x', 0)]);
    await putBlob(b, blobName(1), bytes(50));
    const { closed } = await (async () => {
      const res = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(a)}` } });
      const ws = res.webSocket!;
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
      ws.accept();
      return { closed };
    })();

    expect((await call('/account', { method: 'DELETE', as: a })).status).toBe(204);
    await closed;

    expect(await objectsOf(a)).toEqual([]);
    const tables = await runInDurableObject(vaultOf(a), (_, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\_cf%' ESCAPE '\' AND name NOT LIKE 'sqlite%'`).toArray(),
    );
    expect(tables).toEqual([]);
    expect(await runInDurableObject(vaultOf(a), (_, state) => state.storage.getAlarm())).toBeNull();
    // Starting again is a clean slate, with no vault until a key is set.
    expect(await info(a)).toEqual({ seq: 0, used: 0, limit: 1073741824, wrappedKey: null, keySetAt: null, empty: true, format: 1 });
    expect((await push(a, [rec('x', 0)])).status).toBe(409);
    await open(a);
    expect((await push(a, [rec('x', 0)])).status).toBe(200);
    // The other account is untouched.
    expect(await objectsOf(b)).toHaveLength(1);
    expect((await info(b)).seq).toBe(1);
  });
});

describe('blobs are reserved, then uploaded, and R2 never holds more than was counted', () => {
  /** What R2 holds, `used` and a recount all agree on, with no item to add overhead. */
  async function agree(sub: string) {
    const { recounted, counter } = await recount(sub);
    expect(counter).toBe(recounted);
    expect((await info(sub)).used).toBe(counter);
    expect(await storedBytes(sub)).toBe(counter);
    return counter;
  }

  it('lets one of several concurrent uploads of a name win, and the rest are refused', async () => {
    const sub = await opened();
    const name = blobName(1);
    const sizes = [1000, 2000, 3000, 4000, 5000];
    const answers = await Promise.all(sizes.map((n, i) => putBlob(sub, name, bytes(n, i + 1))));
    const statuses = answers.map((a) => a.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    const winner = sizes[answers.findIndex((a) => a.status === 200)];
    expect(await agree(sub)).toBe(winner);
    expect((await call(`/blob/${name}`, { as: sub })).headers.get('content-length')).toBe(String(winner));
  });

  it('counts concurrent uploads of different names against the limit before any of them is uploaded', async () => {
    const sub = await opened();
    await limitTo(sub, 20_000);
    const answers = await Promise.all([1, 2, 3, 4, 5].map((i) => putBlob(sub, blobName(i), bytes(9000, i))));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 413, 413, 413]);
    expect(await agree(sub)).toBe(18_000);
    expect(await objectsOf(sub)).toHaveLength(2);
  });

  it('cannot be used to store more than counted: the audit attack (many names, then overwrites) gets nowhere', async () => {
    const sub = await opened();
    await limitTo(sub, 20_000);
    const names = [1, 2, 3, 4, 5].map(blobName);
    for (const name of names) expect((await putBlob(sub, name, bytes(1))).status).toBe(200);
    const overwrites = await Promise.all(names.map((name) => putBlob(sub, name, bytes(9000, 3))));
    expect(overwrites.map((a) => a.status)).toEqual([409, 409, 409, 409, 409]);
    expect(await agree(sub)).toBe(5);
    // Deleting and trying again changes nothing about the bound.
    expect((await call(`/blob/${names[0]}`, { method: 'DELETE', as: sub })).status).toBe(204);
    const again = await Promise.all(names.slice(1).map((name) => putBlob(sub, name, bytes(9000, 3))));
    expect(again.every((a) => a.status === 409)).toBe(true);
    expect(await agree(sub)).toBe(4);
  });

  it('answers 409 for a name that exists, whatever its size, and 413 only for a new name that does not fit', async () => {
    const sub = await opened();
    await limitTo(sub, 1000);
    expect((await putBlob(sub, blobName(1), bytes(500))).status).toBe(200);
    expect((await putBlob(sub, blobName(1), bytes(9000))).status, 'exists, and too big').toBe(409);
    expect((await putBlob(sub, blobName(1), bytes(10))).status).toBe(409);
    const big = await putBlob(sub, blobName(2), bytes(9000));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ used: 500, limit: 1000 });
    expect(await agree(sub)).toBe(500);
  });

  it('counts what R2 really holds, not what the client said it would send', async () => {
    const sub = await opened();
    // Fewer bytes than the Content-Length says: R2 keeps what came, and that is what is counted.
    expect((await putBlob(sub, blobName(1), bytes(10), { 'content-length': '50' })).status).toBe(200);
    expect(await agree(sub)).toBe(10);
  });

  it('releases the bytes, and the object, when the upload fails; the name can be used again', async () => {
    const sub = await opened();
    const name = blobName(1);
    const breaking = { ...env, SYNC_BLOBS: { put: async () => { throw new Error('connection reset'); } } };
    expect((await call(`/blob/${name}`, { method: 'PUT', body: bytes(50), as: sub, worker: breaking })).status).toBe(400);
    expect(await agree(sub)).toBe(0);
    expect(await objectsOf(sub)).toEqual([]);
    expect((await putBlob(sub, name, bytes(50))).status).toBe(200);
    expect(await agree(sub)).toBe(50);
  });

  it('deletes the object and releases the reservation when R2 took the bytes but the vault can no longer note them', async () => {
    const sub = await opened();
    const losing = {
      ...env,
      SYNC_BLOBS: {
        put: async (key: string, value: ReadableStream) => {
          const stored = await env.SYNC_BLOBS.put(key, value);
          // The reservation is gone by the time the upload is done (an hour passed, or the account was deleted).
          await runInDurableObject(vaultOf(sub), (_, state) => void state.storage.sql.exec(`DELETE FROM holds`));
          return stored;
        },
      },
    };
    expect((await call(`/blob/${blobName(1)}`, { method: 'PUT', body: bytes(300), as: sub, worker: losing })).status).toBe(409);
    expect(await objectsOf(sub)).toEqual([]);
  });

  it('drops a reservation nobody finished after an hour, with its object, on the next call', async () => {
    const sub = await opened();
    const name = blobName(1);
    // A Worker cut off mid-upload: a hold, and maybe some bytes in R2.
    await runInDurableObject(vaultOf(sub), (_, state) => {
      state.storage.sql.exec(`INSERT INTO holds (name, id, size, at) VALUES (?, 'lost', 400, ?)`, name, Date.now() - 61 * 60_000);
      state.storage.sql.exec(`UPDATE meta SET v = 400 WHERE k = 'used'`);
    });
    await env.SYNC_BLOBS.put(`v/${sub}/${name}`, bytes(400));
    // Younger than an hour: kept, and the name is taken meanwhile.
    const young = await account_with_hold(sub, blobName(2), 30 * 60_000);
    expect(young).toBe(409);
    // The next call sweeps the old one.
    expect((await putBlob(sub, blobName(3), bytes(10))).status).toBe(200);
    expect(await objectsOf(sub)).toEqual([`v/${sub}/${blobName(3)}`]);
    expect(await recount(sub)).toEqual({ recounted: 10 + 400, counter: 10 + 400 });
    // blobName(2)'s young hold is still counted (400 is its size, there is no object).
    async function account_with_hold(sub: string, n: string, age: number) {
      await runInDurableObject(vaultOf(sub), (_, state) => {
        state.storage.sql.exec(`INSERT INTO holds (name, id, size, at) VALUES (?, 'young', 400, ?)`, n, Date.now() - age);
        state.storage.sql.exec(`UPDATE meta SET v = v + 400 WHERE k = 'used'`);
      });
      return (await putBlob(sub, n, bytes(5))).status;
    }
  });

  it('keeps the name taken while a delete is in progress, so a racing PUT cannot end up counted without its object', async () => {
    for (let round = 0; round < 8; round++) {
      const sub = await opened();
      const name = blobName(1);
      expect((await putBlob(sub, name, bytes(700))).status).toBe(200);
      const [del, put] = await Promise.all([call(`/blob/${name}`, { method: 'DELETE', as: sub }), putBlob(sub, name, bytes(900))]);
      expect(del.status).toBe(204);
      expect([200, 409]).toContain(put.status);
      const counted = await agree(sub);
      expect(counted).toBe(put.status === 200 ? 900 : 0);
      expect(await objectsOf(sub)).toHaveLength(put.status === 200 ? 1 : 0);
    }
  });

  it('keeps R2 and the count in step while uploads, deletes and a push that frees a blob all race', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(600));
    await push(sub, [{ key: 'f', kind: 'r', blob: blobName(1), base: 0 }]);
    await Promise.all([
      push(sub, [rec('f', 1, 5)]),
      putBlob(sub, blobName(2), bytes(300)),
      putBlob(sub, blobName(1), bytes(200)),
      call(`/blob/${blobName(2)}`, { method: 'DELETE', as: sub }),
      putBlob(sub, blobName(3), bytes(100)),
    ]);
    const { recounted, counter } = await recount(sub);
    expect(counter).toBe(recounted);
    // Items are counted in the tables only; R2 holds exactly the blobs.
    const blobBytes = await runInDurableObject(vaultOf(sub), (_, state) => Number(state.storage.sql.exec(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs`).one().n));
    expect(await storedBytes(sub)).toBe(blobBytes);
  });
});

describe('the vault proof', () => {
  const mutating: [string, (sub: string, proof: string | false | undefined) => Promise<Response>][] = [
    ['POST /push', (sub, proof) => call('/push', { method: 'POST', json: { items: [rec('p', 0)] }, as: sub, proof })],
    ['PUT /blob', (sub, proof) => call(`/blob/${blobName(5)}`, { method: 'PUT', body: bytes(20), as: sub, proof })],
    ['DELETE /blob', (sub, proof) => call(`/blob/${blobName(5)}`, { method: 'DELETE', as: sub, proof })],
    ['DELETE /account', (sub, proof) => call('/account', { method: 'DELETE', as: sub, proof })],
  ];

  it.each(mutating)('%s: refused without the right proof (403 { proof: false }), and does nothing', async (_, go) => {
    const sub = await opened();
    await putBlob(sub, blobName(5), bytes(20)).then((r) => expect(r.status).toBe(200));
    await push(sub, [rec('keep', 0)]);
    const before = await info(sub);
    const own = proofs.get(sub)!;
    // Differing in its first character; another spelling of the same bytes (the last character's spare bits flipped); short, long, empty, noise.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = own.slice(0, 42) + alphabet[alphabet.indexOf(own[42]) ^ 1];
    const wrong = [false, makeProof(251), `${own[0] === 'A' ? 'B' : 'A'}${own.slice(1)}`, alias, own.slice(1), `${own}A`, '', 'x'.repeat(43)];
    for (const proof of wrong) {
      const res = await go(sub, proof);
      expect(res.status, String(proof)).toBe(403);
      expect(await res.json()).toEqual({ proof: false });
    }
    expect(await info(sub)).toEqual(before);
    expect(await objectsOf(sub)).toHaveLength(1);
  });

  it('works with the right proof on each route', async () => {
    const sub = await opened();
    expect((await call('/push', { method: 'POST', json: { items: [rec('p', 0)] }, as: sub })).status).toBe(200);
    expect((await putBlob(sub, blobName(5), bytes(20))).status).toBe(200);
    expect((await call(`/blob/${blobName(5)}`, { method: 'DELETE', as: sub })).status).toBe(204);
    expect((await call('/account', { method: 'DELETE', as: sub })).status).toBe(204);
    expect(await info(sub)).toMatchObject({ seq: 0, wrappedKey: null });
  });

  it("refuses another account's proof", async () => {
    const [a, b] = [await opened(), await opened()];
    const res = await call('/push', { method: 'POST', json: { items: [rec('p', 0)] }, as: a, proof: proofs.get(b) });
    expect(res.status).toBe(403);
  });

  it('is not needed to read: info, pull, blob GET and the socket only need the sign-in', async () => {
    const sub = await opened();
    await push(sub, [rec('p', 0)]);
    await putBlob(sub, blobName(5), bytes(20));
    expect((await call('/info', { as: sub, proof: false })).status).toBe(200);
    expect((await call('/pull', { as: sub, proof: false })).status).toBe(200);
    expect((await call(`/blob/${blobName(5)}`, { as: sub, proof: false })).status).toBe(200);
    const live = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(sub)}` } });
    expect(live.status).toBe(101);
    live.webSocket!.accept();
    live.webSocket!.close();
  });

  it('answers 409 { noVault: true } to a push or blob call while no wrapped key is set, and stores nothing', async () => {
    const sub = account();
    for (const proof of [makeProof(), undefined]) {
      const pushed = await call('/push', { method: 'POST', json: { items: [rec('p', 0)] }, as: sub, proof });
      expect(pushed.status).toBe(409);
      expect(await pushed.json()).toEqual({ noVault: true });
      const put = await call(`/blob/${blobName(5)}`, { method: 'PUT', body: bytes(20), as: sub, proof });
      expect(put.status).toBe(409);
      expect(await put.json()).toEqual({ noVault: true });
      const del = await call(`/blob/${blobName(5)}`, { method: 'DELETE', as: sub, proof });
      expect(del.status).toBe(409);
      expect(await del.json()).toEqual({ noVault: true });
    }
    expect(await objectsOf(sub)).toEqual([]);
    expect(await info(sub)).toMatchObject({ seq: 0, used: 0 });
    // Deleting a copy that is gone is simply done.
    expect((await call('/account', { method: 'DELETE', as: sub })).status).toBe(204);
    expect((await call('/account', { method: 'DELETE', as: sub, proof: makeProof() })).status).toBe(204);
  });

  it('after DELETE /account the key can be set again, and the old proof no longer deletes or pushes', async () => {
    const sub = await opened();
    const old = proofs.get(sub)!;
    await push(sub, [rec('p', 0)]);
    expect((await call('/account', { method: 'DELETE', as: sub })).status).toBe(204);
    expect((await call('/key', { method: 'PUT', json: { wrappedKey: 'second', proof: makeProof(99) }, as: sub, proof: false })).status).toBe(204);
    proofs.set(sub, makeProof(99));
    expect(await info(sub)).toMatchObject({ wrappedKey: 'second', seq: 0 });
    // The new copy gets its first notes (an empty one could go without any proof).
    expect((await call('/push', { method: 'POST', json: { items: [rec('p', 0)] }, as: sub })).status).toBe(200);
    // A computer of the first copy:
    expect((await call('/account', { method: 'DELETE', as: sub, proof: old })).status).toBe(403);
    expect((await call('/push', { method: 'POST', json: { items: [rec('q', 0)] }, as: sub, proof: old })).status).toBe(403);
    expect(await info(sub)).toMatchObject({ wrappedKey: 'second', empty: false });
  });
});

describe('a key someone else set', () => {
  it('an empty copy can be deleted without the proof, so a planted key costs the owner nothing', async () => {
    const sub = account();
    // A sign-in that leaked sets a key and a proof the owner will never have.
    const planted = await call('/key', { method: 'PUT', json: { wrappedKey: 'planted', proof: makeProof(9) }, as: sub, proof: false });
    expect(planted.status).toBe(204);
    const seen = await info(sub);
    expect(seen.wrappedKey).toBe('planted');
    expect(seen).toMatchObject({ empty: true });
    expect(typeof (seen as { keySetAt?: unknown }).keySetAt).toBe('number');
    // The owner, without that proof: the empty copy goes, and their own can be made.
    expect((await call('/account', { method: 'DELETE', as: sub, proof: false })).status).toBe(204);
    expect((await info(sub)).wrappedKey).toBeNull();
    await open(sub);
    expect((await info(sub)).wrappedKey).toBe(`wrapped-${sub}`);
  });

  it('a copy with anything in it still needs the proof to be deleted', async () => {
    const withItem = await opened();
    expect((await push(withItem, [rec('k', 0)])).status).toBe(200);
    expect(await info(withItem)).toMatchObject({ empty: false });
    expect((await call('/account', { method: 'DELETE', as: withItem, proof: false })).status).toBe(403);
    expect((await call('/account', { method: 'DELETE', as: withItem, proof: makeProof(3) })).status).toBe(403);
    expect((await info(withItem)).wrappedKey).not.toBeNull();

    const withBlob = await opened();
    await putBlob(withBlob, blobName(4), bytes(10));
    expect(await info(withBlob)).toMatchObject({ empty: false });
    expect((await call('/account', { method: 'DELETE', as: withBlob, proof: false })).status).toBe(403);
  });
});

describe('deleting an account', () => {
  it('refuses new pushes, uploads and keys while the objects are being listed and deleted', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(100));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const deleting = withR2(
      sub,
      {
        list: async (options: R2ListOptions) => {
          await hold;
          return env.SYNC_BLOBS.list(options);
        },
      },
      (vault) => vault.deleteAccount(sub, proofs.get(sub)!),
    );
    await tick(30);
    const pushed = await push(sub, [rec('late', 0)]);
    expect(pushed.status).toBe(409);
    expect(await pushed.json()).toEqual({ noVault: true });
    expect((await putBlob(sub, blobName(2), bytes(10))).status).toBe(409);
    expect((await call('/key', { method: 'PUT', json: { wrappedKey: 'x', proof: makeProof(7) }, as: sub, proof: false })).status).toBe(409);
    release();
    expect(await deleting).toBeNull();
    expect(await objectsOf(sub)).toEqual([]);
    expect(await info(sub)).toEqual({ seq: 0, used: 0, limit: 1073741824, wrappedKey: null, keySetAt: null, empty: true, format: 1 });
  });

  it('can be started again with the proof after it was cut off', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(100));
    await expect(
      withR2(sub, { list: async () => { throw new Error('R2 is down'); } }, (vault) => vault.deleteAccount(sub, proofs.get(sub)!)),
    ).rejects.toThrow('R2 is down');
    // Locked meanwhile: nothing is accepted.
    expect((await push(sub, [rec('late', 0)])).status).toBe(409);
    expect((await call('/account', { method: 'DELETE', as: sub, proof: makeProof(200) })).status, 'not without the proof').toBe(403);
    expect((await call('/account', { method: 'DELETE', as: sub })).status).toBe(204);
    expect(await objectsOf(sub)).toEqual([]);
    expect((await info(sub)).wrappedKey).toBeNull();
  });

  it('leaves nothing behind when uploads and pushes race the delete', async () => {
    for (let round = 0; round < 6; round++) {
      const sub = await opened();
      await putBlob(sub, blobName(1), bytes(100));
      const answers = await Promise.all([
        call('/account', { method: 'DELETE', as: sub }),
        putBlob(sub, blobName(2), bytes(5000)),
        putBlob(sub, blobName(3), bytes(5000)),
        push(sub, [rec('x', 0)]),
        call(`/blob/${blobName(1)}`, { method: 'DELETE', as: sub }),
      ]);
      expect(answers[0].status).toBe(204);
      for (const a of answers.slice(1)) expect([200, 204, 409]).toContain(a.status);
      expect(await objectsOf(sub), `round ${round}`).toEqual([]);
      const after = await info(sub);
      expect(after).toMatchObject({ seq: 0, used: 0, wrappedKey: null });
      expect(await recount(sub)).toEqual({ recounted: 0, counter: 0 });
    }
  });
});

describe('what a push may be', () => {
  const pushBody = (extra = '') => JSON.stringify({ items: [rec('a', 0)], pad: extra });

  it('costs 256 bytes and the key length per item, whatever its data', async () => {
    const sub = await opened();
    const items = Array.from({ length: 1000 }, (_, i) => ({ key: `${'k'.repeat(60)}${String(i).padStart(4, '0')}`, kind: 'r', data: b64(1), base: 0 }));
    const res = await push(sub, items);
    expect(((await res.json()) as { used: number }).used).toBe(1000 * (1 + 256 + 64));
    expect(await recount(sub)).toEqual({ recounted: 321_000, counter: 321_000 });
    // 1000 one-byte items to a 100 kB account are refused for what they really cost.
    const small = await opened();
    await limitTo(small, 100_000);
    expect((await push(small, items)).status).toBe(413);
  });

  it('is refused unread when it does not say how long it is, or says more than 6 MiB', async () => {
    const sub = await opened();
    expect((await call('/push', { method: 'POST', body: poison(), as: sub })).status, 'no Content-Length').toBe(400);
    expect((await call('/push', { method: 'POST', body: poison(), headers: { 'content-length': String(6 * 1024 * 1024 + 1) }, as: sub })).status).toBe(400);
    expect((await call('/push', { method: 'POST', body: poison(), headers: { 'content-length': 'many' }, as: sub })).status).toBe(400);
    expect(await info(sub)).toMatchObject({ seq: 0 });
  });

  it('takes a body of exactly 6 MiB and not a byte more', async () => {
    const sub = await opened();
    const exact = (n: number) => {
      const base = pushBody('').length;
      return pushBody('x'.repeat(n - base));
    };
    const six = 6 * 1024 * 1024;
    expect((await call('/push', { method: 'POST', body: exact(six), as: sub })).status).toBe(200);
    expect((await call('/push', { method: 'POST', body: exact(six + 1), as: sub })).status).toBe(400);
  });

  it('is turned away by the limiter before its body is touched', async () => {
    const sub = await opened();
    const Authorization = `Bearer ${await token(sub)}`;
    for (let n = 0; n < 130; n++) await call('/pull', { headers: { Authorization } });
    const res = await call('/push', { method: 'POST', body: poison(), headers: { Authorization, 'content-length': '100' }, proof: proofs.get(sub) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  }, 30_000);

  it('is turned away for a missing vault or proof before its body is touched', async () => {
    const sub = account();
    expect((await call('/push', { method: 'POST', body: poison(), headers: { 'content-length': '100' }, as: sub })).status).toBe(409);
    await open(sub);
    expect((await call('/push', { method: 'POST', body: poison(), headers: { 'content-length': '100' }, as: sub, proof: false })).status).toBe(403);
  });
});

describe('sockets', () => {
  const connect = async (sub: string, headers: Record<string, string> = {}) => {
    const res = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(sub)}`, ...headers } });
    if (res.status !== 101) return { res };
    const ws = res.webSocket!;
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    ws.accept();
    return { res, ws, closed };
  };

  it('lets 10 sockets in and turns the 11th away', async () => {
    const sub = await opened();
    const open = [];
    for (let i = 0; i < 10; i++) {
      const c = await connect(sub);
      expect(c.res.status).toBe(101);
      open.push(c);
    }
    expect((await connect(sub)).res.status).toBe(429);
    // Another account has its own.
    const other = await connect(await opened());
    expect(other.res.status).toBe(101);
    for (const c of [...open, other]) c.ws!.close();
  }, 30_000);

  it('closes on any message but the exact ping, and answers a ping', async () => {
    const sub = await opened();
    for (const message of ['hello', 'ping ', 'PING', ' ping', '{"seq":1}', '', new Uint8Array([1, 2, 3]).buffer, new TextEncoder().encode('ping').buffer]) {
      const { ws, closed } = await connect(sub);
      ws!.send(message);
      expect(await closed, String(message)).toBe(1008);
    }
    const { ws } = await connect(sub);
    const pong = new Promise((resolve) => ws!.addEventListener('message', (e) => resolve(e.data)));
    ws!.send('ping');
    expect(await pong).toBe('pong');
    ws!.close();
  });

  it('is cut off for flooding: a stream of junk ends at the first message', async () => {
    const sub = await opened();
    const { ws, closed } = await connect(sub);
    try {
      for (let i = 0; i < 200; i++) ws!.send(`junk ${i}`);
    } catch {
      // Closed while sending.
    }
    expect(await closed).toBe(1008);
  });
});

describe('answer headers', () => {
  const routes: [string, string, number][] = [
    ['GET', '/info', 200],
    ['GET', '/pull', 200],
    ['PUT', '/key', 409],
    ['POST', '/push', 200],
    ['DELETE', `/blob/${blobName(1)}`, 204],
    ['GET', `/blob/${blobName(1)}`, 404],
    ['GET', '/nonsense', 404],
    ['POST', '/info', 405],
    ['GET', '/pull?after=x', 400],
  ];

  it.each(routes)('%s %s (%i) is not cacheable and varies by origin', async (method, path, status) => {
    const sub = await opened();
    const body = method === 'POST' ? { items: [] } : method === 'PUT' ? { wrappedKey: 'a', proof: makeProof() } : undefined;
    for (const origin of [ORIGIN, 'https://evil.example', undefined]) {
      const res = await call(path, { method, json: body, as: sub, headers: origin ? { Origin: origin } : {} });
      expect(res.status).toBe(status);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Vary')).toBe('Origin');
    }
  });

  it('also on a refusal to sign in, a preflight and an empty answer', async () => {
    for (const res of [await call('/info'), await call('/push', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), await call('/push', { method: 'OPTIONS' })]) {
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Vary')).toBe('Origin');
    }
    const sub = await opened();
    const del = await call('/account', { method: 'DELETE', as: sub });
    expect(del.status).toBe(204);
    expect(del.headers.get('Cache-Control')).toBe('no-store');
  });

  it('marks a blob download nosniff', async () => {
    const sub = await opened();
    await putBlob(sub, blobName(1), bytes(10));
    const res = await call(`/blob/${blobName(1)}`, { as: sub });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('sign-in checks on the mailbox', () => {
  const asks = async (t: string, path = '/info') => (await call(path, { headers: { Authorization: `Bearer ${t}` } })).status;
  const sub = 'user_jwtcases';

  it('production config trusts one Clerk instance and not the browser preview', () => {
    expect(env.CLERK_ISSUERS).toBe('https://clerk.thoughtdesk.org');
    expect(env.APP_ORIGINS.split(',')).not.toContain('http://localhost:1420');
  });

  it('accepts a good token, and one made without a page (no azp)', async () => {
    expect(await asks(await token(sub))).toBe(200);
    expect(await asks(await token(sub, { claims: { azp: undefined } }))).toBe(200);
  });

  it('refuses a token made on another page', async () => {
    expect(await asks(await token(sub, { claims: { azp: 'https://evil.example' } }))).toBe(401);
    expect(await asks(await token(sub, { claims: { azp: 'http://localhost:1420' } }))).toBe(401);
  });

  it('refuses the development Clerk instance against the production config', async () => {
    expect(await asks(await token(sub, { iss: 'https://smiling-sunbird-3571.clerk.accounts.dev' }))).toBe(401);
    expect(await asks(await token(sub, { iss: 'https://someone-else.clerk.accounts.dev' }))).toBe(401);
  });

  it('refuses unsigned tokens (alg none), pending sessions, and impersonation', async () => {
    const unsigned = new UnsecuredJWT({ sid: 'sess_1', sts: 'active', azp: ORIGIN }).setIssuer(ISSUER).setSubject(sub).setIssuedAt().setExpirationTime('1m').encode();
    expect(await asks(unsigned)).toBe(401);
    expect(await asks(await token(sub, { claims: { sts: 'pending' } }))).toBe(401);
    expect(await asks(await token(sub, { claims: { act: { sub: 'user_support' } } }))).toBe(401);
    const live = await call('/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `thoughtdesk, ${await token(sub, { claims: { act: { sub: 'user_support' } } })}` } });
    expect(live.status).toBe(401);
  });

  it('refuses a token with no expiry, no issue time, or issued more than ten minutes ago', async () => {
    expect(await asks(await token(sub, { expires: null }))).toBe(401);
    expect(await asks(await token(sub, { issued: null }))).toBe(401);
    expect(await asks(await token(sub, { issued: 11 * 60, expires: '5m' }))).toBe(401);
    expect(await asks(await token(sub, { issued: 9 * 60, expires: '5m' }))).toBe(200);
  });

  it('refuses a token with no subject', async () => {
    const noSub = new SignJWT({ sid: 'sess_1', sts: 'active', azp: ORIGIN }).setProtectedHeader({ alg: 'RS256', kid: 'ins_1' }).setIssuer(ISSUER).setIssuedAt().setExpirationTime('1m').sign(clerk.privateKey);
    expect(await asks(await noSub)).toBe(401);
  });
});
