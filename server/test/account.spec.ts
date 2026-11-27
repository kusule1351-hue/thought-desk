// Deleting an account: DELETE /account stops Pro renewing, removes the synced copy and forgets the
// assistant's counts, and only for a sign-in proved in the last few minutes. Polar and Clerk's keys are
// faked like billing.spec.ts does. Run with `npm test`.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPersonOf } from '../src/auth';
import { Budget } from '../src/budget';
import worker from '../src/index';
import { encode } from '../src/mailbox';

const ISSUER = env.CLERK_ISSUERS.split(',')[0];
const ORIGIN = 'http://tauri.localhost';
const POLAR = 'https://polar.test';
const PRO = 'prod_pro';
const S1 = '11111111-1111-4111-8111-111111111111';
const clerk = await generateKeyPair('RS256');

const billing = { ...env, POLAR_ACCESS_TOKEN: 'polar_test', POLAR_API: POLAR, POLAR_PRO_PRODUCTS: PRO, ASSISTANT_ACCESS: 'everyone' };

/** What the fake Polar is asked, and what it knows of each account. */
const polar = {
  calls: [] as { url: string; method: string; body: Record<string, any> | null; bearer: string | null }[],
  state: new Map<string, { active_subscriptions: Record<string, unknown>[] }>(),
  /** The status every PATCH gets, when Polar is to fail. */
  failing: 0,
};

beforeAll(async () => {
  const jwk = { ...(await exportJWK(clerk.publicKey)), kid: 'ins_1', alg: 'RS256', use: 'sig' };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.startsWith(POLAR)) {
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      const raw = input instanceof Request ? await input.text() : init?.body;
      const headers = new Headers(input instanceof Request ? input.headers : (init?.headers as HeadersInit));
      const body = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
      polar.calls.push({ url, method, body, bearer: headers.get('authorization') });
      const external = /\/v1\/customers\/external\/([^/]+)\/state$/.exec(url);
      if (external) {
        const state = polar.state.get(decodeURIComponent(external[1]));
        return state ? Response.json(state) : new Response('{}', { status: 404 });
      }
      if (url.endsWith('/v1/customer-sessions/')) return Response.json({ token: 'polar_cst_one' });
      if (method === 'PATCH') {
        if (polar.failing) return new Response('{}', { status: polar.failing });
        for (const state of polar.state.values()) {
          const s = state.active_subscriptions.find((x) => url.endsWith(`/v1/customer-portal/subscriptions/${x.id as string}`));
          if (s) return Response.json(Object.assign(s, { cancel_at_period_end: body.cancel_at_period_end }));
        }
      }
      return new Response('{}', { status: 404 });
    }
    if (/polar\.sh/.test(url)) throw new Error(`a real Polar request: ${url}`);
    return real(input, init);
  });
});

beforeEach(() => {
  polar.calls = [];
  polar.state = new Map();
  polar.failing = 0;
});

/** A Clerk session token. `fva`: minutes since the sign-in was last proved (first factor, second factor); null leaves it out. */
function token(sub: string, fva: unknown = [1, -1], claims: Record<string, unknown> = {}) {
  return new SignJWT({ sid: 'sess_1', sts: 'active', v: 2, azp: ORIGIN, ...(fva === null ? {} : { fva }), ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setExpirationTime('1m')
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(clerk.privateKey);
}

let counter = 0;
const account = () => `user_d${++counter}x${Math.random().toString(36).slice(2, 8)}`;

const send = (path: string, init: RequestInit, using: object = billing) => worker.fetch(new Request(`https://relay.test${path}`, init), using as never, { waitUntil() {}, passThroughOnException() {} } as never);
/** Asks for the account to be deleted. */
async function remove(sub: string | null, { fva = [1, -1] as unknown, method = 'DELETE', using = billing as object, claims = {} as Record<string, unknown>, origin = '' } = {}) {
  const headers = new Headers();
  if (sub) headers.set('Authorization', `Bearer ${await token(sub, fva, claims)}`);
  if (origin) headers.set('Origin', origin);
  const res = await send('/account', { method, headers }, using);
  return { res, json: (await res.json().catch(() => null)) as { error?: string } | null };
}

/** Gives the account a synced copy with a key, an item and a file in it. */
async function sync(sub: string) {
  const auth = { Authorization: `Bearer ${await token(sub)}`, 'Content-Type': 'application/json' };
  const proof = encode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  expect((await send('/sync/key', { method: 'PUT', headers: auth, body: JSON.stringify({ wrappedKey: `wrapped-${sub}`, proof }) })).status).toBe(204);
  const item = { key: 'x', kind: 'r', data: encode(new Uint8Array(20).fill(7).buffer as ArrayBuffer), base: 0 };
  const body = JSON.stringify({ items: [item] });
  expect((await send('/sync/push', { method: 'POST', headers: { ...auth, 'X-Vault-Proof': proof, 'content-length': String(body.length) }, body })).status).toBe(200);
  await env.SYNC_BLOBS.put(`v/${sub}/${'0'.repeat(32)}`, 'bytes');
}
const synced = async (sub: string) => ((await (await send('/sync/info', { headers: { Authorization: `Bearer ${await token(sub)}` } })).json()) as { wrappedKey: string | null; used: number });
const objectsOf = async (sub: string) => (await env.SYNC_BLOBS.list({ prefix: `v/${sub}/` })).objects.map((o) => o.key);
const budgetOf = (sub: string) => env.BUDGET.get(env.BUDGET.idFromName(`account:${sub}`));
const subscription = (over: Record<string, unknown> = {}) => ({ id: S1, product_id: PRO, status: 'active', current_period_end: '2030-01-01T00:00:00.000Z', cancel_at_period_end: false, ends_at: null, ...over });

describe('who may delete an account', () => {
  it('turns away a request with no sign-in, and anything but DELETE', async () => {
    expect((await remove(null)).res.status).toBe(401);
    const got = await remove(account(), { method: 'POST' });
    expect(got.res.status).toBe(405);
    expect(got.res.headers.get('Allow')).toBe('DELETE');
  });

  it('asks for a sign-in proved in the last ten minutes: an older one, or one that does not say, changes nothing', async () => {
    const sub = account();
    await sync(sub);
    polar.state.set(sub, { active_subscriptions: [subscription()] });
    for (const fva of [[11, -1], [600, 2], [-1, -1], null, 'now', [null, 1], []]) {
      const got = await remove(sub, { fva });
      expect(got.res.status, JSON.stringify(fva)).toBe(403);
      expect(got.json).toEqual({ error: 'verify' });
    }
    expect(polar.calls).toHaveLength(0);
    expect((await synced(sub)).wrappedKey).toBe(`wrapped-${sub}`);
    expect(await objectsOf(sub)).toHaveLength(1);
    // Exactly ten minutes is still in time; so is just now.
    expect((await remove(account(), { fva: [10, -1] })).res.status).toBe(204);
    expect((await remove(account(), { fva: [0, 0] })).res.status).toBe(204);
  });

  it('never deletes for someone acting as the person', async () => {
    const got = await remove(account(), { claims: { act: { sub: 'user_support' } } });
    expect(got.res.status).toBe(401);
    expect(await freshPersonOf(await token('user_a', [1, -1], { act: { sub: 'user_support' } }), env)).toBeNull();
    expect(await freshPersonOf(await token('user_a', [3, -1]), env)).toEqual({ sub: 'user_a', fresh: true });
    expect(await freshPersonOf(await token('user_a', [30, -1]), env)).toEqual({ sub: 'user_a', fresh: false });
    expect(await freshPersonOf('nonsense', env)).toBeNull();
  });

  it('lets the app’s origin in, gives another none, and is never cached', async () => {
    const ours = await remove(account(), { origin: ORIGIN });
    expect(ours.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ours.res.headers.get('Cache-Control')).toBe('no-store');
    expect((await remove(account(), { origin: 'https://evil.example' })).res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const pre = await send('/account', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});

describe('what goes with the account', () => {
  it('stops Pro renewing, as the customer, before anything else', async () => {
    const sub = account();
    polar.state.set(sub, { active_subscriptions: [subscription()] });
    expect((await remove(sub)).res.status).toBe(204);
    const patched = polar.calls.filter((c) => c.method === 'PATCH');
    expect(patched.map((c) => [c.url, c.body, c.bearer])).toEqual([[`${POLAR}/v1/customer-portal/subscriptions/${S1}`, { cancel_at_period_end: true }, 'Bearer polar_cst_one']]);
  });

  it('deletes nothing when Polar cannot be told, so nobody keeps paying for an account they cannot open', async () => {
    const sub = account();
    await sync(sub);
    polar.state.set(sub, { active_subscriptions: [subscription()] });
    polar.failing = 500;
    const got = await remove(sub);
    expect(got.res.status).toBe(502);
    expect(got.json).toEqual({ error: 'unavailable' });
    expect((await synced(sub)).wrappedKey).toBe(`wrapped-${sub}`);
    expect(await objectsOf(sub)).toHaveLength(1);
    // Tried again once Polar is back: it goes through.
    polar.failing = 0;
    expect((await remove(sub)).res.status).toBe(204);
    expect((await synced(sub)).wrappedKey).toBeNull();
  });

  it('removes the synced copy without its proof, files too, and nothing of another account', async () => {
    const [sub, other] = [account(), account()];
    await sync(sub);
    await sync(other);
    expect((await synced(sub)).used).toBeGreaterThan(0);
    expect((await remove(sub)).res.status).toBe(204);
    expect(await synced(sub)).toMatchObject({ wrappedKey: null, used: 0 });
    expect(await objectsOf(sub)).toEqual([]);
    expect((await synced(other)).wrappedKey).toBe(`wrapped-${other}`);
    expect(await objectsOf(other)).toHaveLength(1);
  });

  it('forgets what the assistant counted and the plan it kept', async () => {
    const sub = account();
    await runInDurableObject(budgetOf(sub), (b: Budget) => {
      b.admit('2026-11', 1_000_000, 0);
      b.settle('2026-11', 0, 1234);
      b.setPlan(true, Date.parse('2030-01-01'), false);
    });
    expect(await runInDurableObject(budgetOf(sub), (b: Budget) => [b.spent('2026-11'), b.plan()?.pro])).toEqual([1234, true]);
    expect((await remove(sub)).res.status).toBe(204);
    expect(await runInDurableObject(budgetOf(sub), (b: Budget) => [b.spent('2026-11'), b.plan()])).toEqual([0, null]);
    // And the store still works afterwards, should a late request arrive.
    expect(await runInDurableObject(budgetOf(sub), (b: Budget) => b.admit('2026-11', 1_000_000, 10).ok)).toBe(true);
  });

  it('is safe to ask twice, and for an account that never had any of it, with nothing to sell', async () => {
    const sub = account();
    expect((await remove(sub)).res.status).toBe(204);
    expect((await remove(sub)).res.status).toBe(204);
    expect((await remove(account(), { using: { ...billing, POLAR_ACCESS_TOKEN: '' } })).res.status).toBe(204);
  });
});
