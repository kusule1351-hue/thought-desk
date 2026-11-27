// Paying for Pro: which plan an account is on, checkout and portal, and Polar's signed notices.
// Polar is faked: every request to POLAR_API is answered by `polar` below, so nothing real is asked.
// Clerk's keys are faked like assistant.spec.ts does. Run with `npm test`.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedByPolar, TERMS_VERSION as TERMS } from '../src/billing';
import { keepPlan, planIn, planOf } from '../src/plan';
import worker from '../src/index';

const ISSUER = env.CLERK_ISSUERS.split(',')[0];
const ORIGIN = 'http://tauri.localhost';
const POLAR = 'https://polar.test';
const PRO = 'prod_pro';
const clerk = await generateKeyPair('RS256');

// A secret the way Polar hands it out: "whsec_" and then base64 of the key.
const KEY_BYTES = crypto.getRandomValues(new Uint8Array(32));
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;

const billing = {
  ...env,
  POLAR_ACCESS_TOKEN: 'polar_test',
  POLAR_API: POLAR,
  POLAR_PRO_PRODUCTS: PRO,
  POLAR_WEBHOOK_SECRET: SECRET,
  ASSISTANT_ACCESS: 'everyone',
};

/** What the fake Polar is asked, and how it answers. */
const polar = {
  calls: [] as { url: string; method: string; body: Record<string, any> | null; headers: Headers }[],
  /** Customer state by external id; an account that is missing is a 404. */
  state: new Map<string, unknown>(),
  /** Overrides the answer for a path (a function so each answer is a fresh Response). */
  answer: null as null | ((url: string, method: string) => Response),
};
const asked = (part: string) => polar.calls.filter((c) => c.url.includes(part));

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
      polar.calls.push({ url, method, body: typeof raw === 'string' && raw ? JSON.parse(raw) : null, headers });
      if (polar.answer) return polar.answer(url, method);
      const external = /\/v1\/customers\/external\/([^/]+)\/state$/.exec(url);
      if (external) {
        const state = polar.state.get(decodeURIComponent(external[1]));
        return state === undefined ? new Response('{}', { status: 404 }) : Response.json(state);
      }
      return new Response('{}', { status: 404 });
    }
    // Anything else must not leave the test: Polar is never reached for real.
    if (/polar\.sh/.test(url)) throw new Error(`a real Polar request: ${url}`);
    return real(input, init);
  });
});

beforeEach(() => {
  polar.calls = [];
  polar.state = new Map();
  polar.answer = null;
});

function token(sub: string) {
  return new SignJWT({ sid: 'sess_1', sts: 'active', v: 2, azp: ORIGIN })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setExpirationTime('1m')
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(clerk.privateKey);
}

let counter = 0;
/** A fresh account, so tests never share a plan. */
const account = () => `user_b${++counter}x${Math.random().toString(36).slice(2, 8)}`;

/** Polar's customer state with one running subscription. */
const subscription = (over: Record<string, unknown> = {}) => ({ product_id: PRO, status: 'active', current_period_end: '2030-01-01T00:00:00.000Z', cancel_at_period_end: false, ends_at: null, ...over });
const stateOf = (sub: string, subs: unknown[] = [subscription()]) => ({ external_id: sub, active_subscriptions: subs });
const pro = (sub: string, subs?: unknown[]) => polar.state.set(sub, stateOf(sub, subs));

interface Call {
  method?: string;
  path?: string;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  as?: string | false;
  env?: object;
}

async function call({ method = 'GET', path = '/plan', json, body, headers = {}, as = false, env: using = billing }: Call = {}) {
  const h = new Headers(headers);
  if (as) h.set('Authorization', `Bearer ${await token(as)}`);
  if (json !== undefined && body === undefined) body = JSON.stringify(json);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://relay.test/billing${path}`, { method, body: method === 'POST' ? body : undefined, headers: h }), using as never, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { res, text, json: parsed };
}

const plan = (as: string, query = '', using: object = billing) => call({ path: `/plan${query}`, as, env: using });

// ------------------------------------------------------------------ signing Polar's notices

const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function sign(body: string, { id = 'msg_1', timestamp = String(Math.floor(Date.now() / 1000)), keyBytes = KEY_BYTES as Uint8Array }: { id?: string; timestamp?: string; keyBytes?: Uint8Array } = {}) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${toBase64(mac)}` };
}

/** Sends Polar's notice, signed unless told otherwise. */
async function notify(event: unknown, { headers, using = billing, method = 'POST' }: { headers?: Record<string, string>; using?: object; method?: string } = {}) {
  const body = JSON.stringify(event);
  return call({ method, path: '/polar', body, headers: headers ?? (await sign(body)), env: using });
}

const stateChanged = (sub: string, subs: unknown[]) => ({ type: 'customer.state_changed', data: { external_id: sub, active_subscriptions: subs } });

// ------------------------------------------------------------------ plans

describe('which plan an account is on', () => {
  it('says there are no plans, and asks no one, when Polar has no key', async () => {
    const sub = account();
    pro(sub);
    const got = await plan(sub, '', { ...billing, POLAR_ACCESS_TOKEN: undefined });
    expect(got.res.status).toBe(200);
    expect(got.json).toMatchObject({ on: false, plan: 'free' });
    expect(polar.calls).toHaveLength(0);
  });

  it('turns away a request with no sign-in, and an account that is not let in', async () => {
    const out = await call({ path: '/plan' });
    expect(out.res.status).toBe(401);
    expect(out.json).toEqual({ error: 'signed-out' });
    const sub = account();
    const closed = await plan(sub, '', { ...billing, ASSISTANT_ACCESS: 'testers', ASSISTANT_TESTERS: undefined });
    expect(closed.res.status).toBe(403);
    expect(closed.json).toEqual({ error: 'closed' });
    expect(polar.calls).toHaveLength(0);
  });

  it('says free when Polar has never heard of the account, and keeps that answer', async () => {
    const sub = account();
    const first = await plan(sub);
    expect(first.res.status).toBe(200);
    expect(first.json).toEqual({ on: true, plan: 'free', until: null, ending: false, terms: TERMS });
    expect(asked('/state')).toHaveLength(1);
    expect(asked('/state')[0].url).toBe(`${POLAR}/v1/customers/external/${sub}/state`);
    expect(asked('/state')[0].headers.get('authorization')).toBe('Bearer polar_test');
    await plan(sub);
    await plan(sub);
    expect(asked('/state')).toHaveLength(1);
  });

  it('says pro, with its date and whether it is ending, for a subscription to a Pro product', async () => {
    const sub = account();
    pro(sub, [subscription({ current_period_end: '2031-03-04T05:06:07.000Z', cancel_at_period_end: true })]);
    const got = await plan(sub);
    expect(got.json).toEqual({ on: true, plan: 'pro', until: '2031-03-04T05:06:07.000Z', ending: true, terms: TERMS });

    const renewing = account();
    pro(renewing);
    expect((await plan(renewing)).json).toMatchObject({ plan: 'pro', until: '2030-01-01T00:00:00.000Z', ending: false });
  });

  it('says free for a subscription to some other product, or one that is not running', async () => {
    const other = account();
    pro(other, [subscription({ product_id: 'prod_other' })]);
    expect((await plan(other)).json.plan).toBe('free');
    const canceled = account();
    pro(canceled, [subscription({ status: 'canceled' })]);
    expect((await plan(canceled)).json.plan).toBe('free');
  });

  it('asks Polar again for a fresh look, but not twice within ten seconds', async () => {
    const sub = account();
    await plan(sub);
    expect(asked('/state')).toHaveLength(1);
    // Asked just now: a fresh look is answered from what is kept.
    await plan(sub, '?fresh=1');
    expect(asked('/state')).toHaveLength(1);
    // Asked a minute ago: a fresh look asks again, and a plain one does not.
    await keepPlan(sub, stateOf(sub, []), billing as never, Date.now() - 60_000);
    await plan(sub);
    expect(asked('/state')).toHaveLength(1);
    pro(sub);
    const fresh = await plan(sub, '?fresh=1');
    expect(asked('/state')).toHaveLength(2);
    expect(fresh.json.plan).toBe('pro');
  });

  it.each([
    ['answers with an error', () => new Response('{}', { status: 500 })],
    ['cannot be reached', () => Promise.reject(new TypeError('network down')) as never],
  ])('keeps what it knew when Polar %s, and says free when it knew nothing', async (_, answer) => {
    const sub = account();
    const known = account();
    // `known` has a Pro plan kept a minute past the six hours.
    await keepPlan(known, stateOf(known), billing as never, Date.now() - 7 * 60 * 60 * 1000);
    polar.answer = answer as never;
    const kept = await plan(known);
    expect(kept.res.status).toBe(200);
    expect(kept.json.plan).toBe('pro');
    const none = await plan(sub);
    expect(none.res.status).toBe(200);
    expect(none.json.plan).toBe('free');
    expect(asked('/state').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps Pro for two days past its date, then lets it go', async () => {
    const sub = account();
    const DAY = 24 * 60 * 60 * 1000;
    const until = Date.parse('2030-01-01T00:00:00.000Z');
    polar.answer = () => new Response('{}', { status: 500 });
    await keepPlan(sub, stateOf(sub, [subscription({ current_period_end: new Date(until).toISOString() })]), billing as never, until - 1000);
    expect((await planOf(sub, billing as never, { now: until - 1000 + 1000 })).pro).toBe(true);
    // A renewal that is late: Polar can't say, and Pro stands for the grace.
    expect((await planOf(sub, billing as never, { now: until + DAY })).pro).toBe(true);
    expect((await planOf(sub, billing as never, { now: until + 2 * DAY - 1000 })).pro).toBe(true);
    expect((await planOf(sub, billing as never, { now: until + 2 * DAY + 1000 })).pro).toBe(false);
    // Kept as of a moment ago, it needs no asking either way.
    const later = account();
    await keepPlan(later, stateOf(later, [subscription({ current_period_end: new Date(until).toISOString() })]), billing as never, until + 3 * DAY);
    expect((await planOf(later, billing as never, { now: until + 3 * DAY + 1000 })).pro).toBe(false);
    const inGrace = account();
    await keepPlan(inGrace, stateOf(inGrace, [subscription({ current_period_end: new Date(until).toISOString() })]), billing as never, until + DAY);
    expect((await planOf(inGrace, billing as never, { now: until + DAY + 1000 })).pro).toBe(true);
  });

  it('takes the subscription that runs longest when there are two', () => {
    const state = { active_subscriptions: [subscription({ current_period_end: '2030-01-01T00:00:00.000Z' }), subscription({ current_period_end: '2031-01-01T00:00:00.000Z' })] };
    expect(planIn(state, billing as never).until).toBe(Date.parse('2031-01-01T00:00:00.000Z'));
    expect(planIn(null, billing as never).pro).toBe(false);
    expect(planIn({ active_subscriptions: 'x' }, billing as never).pro).toBe(false);
  });
});

// ------------------------------------------------------------------ checkout and portal

describe('checkout', () => {
  it('asks Polar for a checkout carrying the account, and hands back its address', async () => {
    const sub = account();
    polar.answer = (url) => (url.includes('/v1/checkouts/') ? Response.json({ url: 'https://polar.test/checkout/abc' }) : new Response('{}', { status: 404 }));
    const got = await call({ method: 'POST', path: '/checkout', as: sub, json: { email: 'me@example.com', accepted: TERMS } });
    expect(got.res.status).toBe(200);
    expect(got.json).toEqual({ url: 'https://polar.test/checkout/abc' });
    const made = asked('/v1/checkouts/');
    expect(made).toHaveLength(1);
    expect(made[0].method).toBe('POST');
    expect(made[0].headers.get('authorization')).toBe('Bearer polar_test');
    expect(made[0].body).toMatchObject({ products: [PRO], external_customer_id: sub, success_url: 'https://thoughtdesk.org/pro/welcome', customer_email: 'me@example.com' });
    // What was agreed to, and when, goes with the purchase.
    expect(made[0].body?.metadata.terms_version).toBe(TERMS);
    expect(Math.abs(Date.parse(made[0].body?.metadata.terms_accepted_at) - Date.now())).toBeLessThan(60_000);
  });

  it('makes no checkout for someone who has not agreed to the terms in force, and says which those are', async () => {
    polar.answer = (url) => (url.includes('/v1/checkouts/') ? Response.json({ url: 'https://polar.test/checkout/abc' }) : new Response('{}', { status: 404 }));
    const sub = account();
    for (const json of [{}, { accepted: true }, { accepted: '2020-01-01' }, { accepted: '' }, { email: 'me@example.com' }]) {
      const got = await call({ method: 'POST', path: '/checkout', as: sub, json });
      expect(got.res.status, JSON.stringify(json)).toBe(400);
      expect(got.json).toEqual({ error: 'terms' });
    }
    expect((await call({ method: 'POST', path: '/checkout', as: sub })).json).toEqual({ error: 'terms' });
    expect(asked('/v1/checkouts/')).toHaveLength(0);
    // The plan says which version there is to agree to; a server may name another.
    expect((await call({ as: sub })).json).toMatchObject({ terms: TERMS });
    expect(TERMS).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const later = { ...billing, TERMS_VERSION: '2030-01-01' };
    expect((await call({ as: sub, env: later })).json).toMatchObject({ terms: '2030-01-01' });
    expect((await call({ method: 'POST', path: '/checkout', as: sub, json: { accepted: TERMS }, env: later })).json).toEqual({ error: 'terms' });
    expect((await call({ method: 'POST', path: '/checkout', as: sub, json: { accepted: '2030-01-01' }, env: later })).res.status).toBe(200);
  });

  it('starts the checkout without the email when Polar turns the address away', async () => {
    // Polar refuses an address it thinks can't get mail (seen in its sandbox with example.com): 422.
    polar.answer = (url, method) => {
      if (!url.includes('/v1/checkouts/') || method !== 'POST') return new Response('{}', { status: 404 });
      const last = polar.calls[polar.calls.length - 1];
      return last.body?.customer_email ? Response.json({ detail: [] }, { status: 422 }) : Response.json({ url: 'https://polar.test/checkout/plain' });
    };
    const sub = account();
    const got = await call({ method: 'POST', path: '/checkout', as: sub, json: { email: 'ana@example.com', accepted: TERMS } });
    expect(got.res.status).toBe(200);
    expect(got.json).toEqual({ url: 'https://polar.test/checkout/plain' });
    const made = asked('/v1/checkouts/');
    expect(made).toHaveLength(2);
    expect(made[0].body?.customer_email).toBe('ana@example.com');
    expect(made[1].body).not.toHaveProperty('customer_email');
    expect(made[1].body?.external_customer_id).toBe(sub);
    // Refused for another reason, it is not tried again.
    polar.calls = [];
    polar.answer = (url) => (url.includes('/v1/checkouts/') ? Response.json({ detail: [] }, { status: 422 }) : new Response('{}', { status: 404 }));
    expect((await call({ method: 'POST', path: '/checkout', as: account(), json: { accepted: TERMS } })).res.status).toBe(502);
    expect(asked('/v1/checkouts/')).toHaveLength(1);
  });

  it('sends the email only when it looks like one, and uses the return address the server names', async () => {
    polar.answer = (url) => (url.includes('/v1/checkouts/') ? Response.json({ url: 'https://polar.test/c' }) : new Response('{}', { status: 404 }));
    const using = { ...billing, BILLING_RETURN_URL: 'https://example.org/back' };
    for (const json of [{ email: 'not an email' }, { email: 42 }, {}, { email: 'a@b c' }]) {
      const got = await call({ method: 'POST', path: '/checkout', as: account(), json: { ...json, accepted: TERMS }, env: using });
      expect(got.res.status).toBe(200);
    }
    const none = await call({ method: 'POST', path: '/checkout', as: account(), json: { accepted: TERMS }, env: using });
    expect(none.res.status).toBe(200);
    const made = asked('/v1/checkouts/');
    expect(made).toHaveLength(5);
    for (const m of made) {
      expect(m.body).not.toHaveProperty('customer_email');
      expect(m.body?.success_url).toBe('https://example.org/back');
    }
  });

  it('turns away an account that is already on Pro, and makes no checkout', async () => {
    const sub = account();
    pro(sub);
    const got = await call({ method: 'POST', path: '/checkout', as: sub, json: { accepted: TERMS } });
    expect(got.res.status).toBe(409);
    expect(got.json).toEqual({ error: 'already' });
    expect(asked('/v1/checkouts/')).toHaveLength(0);
  });

  it('says off with billing off, and unavailable when Polar fails', async () => {
    const off = await call({ method: 'POST', path: '/checkout', as: account(), json: {}, env: { ...billing, POLAR_ACCESS_TOKEN: undefined } });
    expect(off.res.status).toBe(503);
    expect(off.json).toEqual({ error: 'off' });
    expect(polar.calls).toHaveLength(0);

    polar.answer = (url) => (url.includes('/v1/checkouts/') ? new Response('{}', { status: 500 }) : new Response('{}', { status: 404 }));
    const failed = await call({ method: 'POST', path: '/checkout', as: account(), json: { accepted: TERMS } });
    expect(failed.res.status).toBe(502);
    expect(failed.json).toEqual({ error: 'unavailable' });

    polar.answer = (url) => (url.includes('/v1/checkouts/') ? Response.json({ nothing: 1 }) : new Response('{}', { status: 404 }));
    const odd = await call({ method: 'POST', path: '/checkout', as: account(), json: { accepted: TERMS } });
    expect(odd.res.status).toBe(502);
  });

  it('turns away a wrong method and a body that is not JSON', async () => {
    const sub = account();
    expect((await call({ method: 'GET', path: '/checkout', as: sub })).res.status).toBe(405);
    expect((await call({ method: 'POST', path: '/nothing', as: sub })).res.status).toBe(404);
    const bad = await call({ method: 'POST', path: '/checkout', as: sub, body: '{"email":' });
    expect(bad.res.status).toBe(400);
    expect(bad.json).toEqual({ error: 'bad' });
    expect(asked('/v1/checkouts/')).toHaveLength(0);
  });
});

describe('the customer portal', () => {
  it('hands back the address Polar gives for this account', async () => {
    const sub = account();
    polar.answer = (url) => (url.includes('/v1/customer-sessions/') ? Response.json({ customer_portal_url: 'https://polar.test/portal/xyz' }) : new Response('{}', { status: 404 }));
    const got = await call({ method: 'POST', path: '/portal', as: sub, json: {} });
    expect(got.res.status).toBe(200);
    expect(got.json).toEqual({ url: 'https://polar.test/portal/xyz' });
    const made = asked('/v1/customer-sessions/');
    expect(made).toHaveLength(1);
    expect(made[0].body).toEqual({ external_customer_id: sub });
    expect(made[0].headers.get('authorization')).toBe('Bearer polar_test');
  });

  it.each([404, 422])('says there is none when Polar answers %i', async (status) => {
    polar.answer = () => new Response('{}', { status });
    const got = await call({ method: 'POST', path: '/portal', as: account(), json: {} });
    expect(got.res.status).toBe(404);
    expect(got.json).toEqual({ error: 'none' });
  });

  it('says unavailable when Polar fails', async () => {
    polar.answer = () => new Response('{}', { status: 500 });
    const got = await call({ method: 'POST', path: '/portal', as: account(), json: {} });
    expect(got.res.status).toBe(502);
    expect(got.json).toEqual({ error: 'unavailable' });
  });
});

describe('cancelling from the app', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';
  /** A Polar that changes a subscription as asked and answers with it. */
  const changing = (sub: string) => {
    polar.answer = (url, method) => {
      const state = polar.state.get(sub) as { active_subscriptions: Record<string, unknown>[] };
      if (url.endsWith('/v1/customer-sessions/')) return Response.json({ token: 'polar_cst_one', customer_portal_url: 'https://polar.test/portal/xyz' });
      if (method === 'PATCH') {
        const s = state.active_subscriptions.find((x) => url.endsWith(`/v1/customer-portal/subscriptions/${x.id as string}`));
        if (!s) return new Response('{}', { status: 404 });
        const body = polar.calls.at(-1)!.body!;
        Object.assign(s, { cancel_at_period_end: body.cancel_at_period_end, ends_at: body.cancel_at_period_end ? s.current_period_end : null });
        return Response.json(s);
      }
      return url.endsWith(`/v1/customers/external/${sub}/state`) ? Response.json(state) : new Response('{}', { status: 404 });
    };
  };

  it('stops Pro renewing: Pro stays to its date, and the plan says so at once', async () => {
    const sub = account();
    pro(sub, [subscription({ id: S1 })]);
    changing(sub);
    const got = await call({ method: 'POST', path: '/cancel', as: sub });
    expect(got.res.status).toBe(200);
    expect(got.json).toEqual({ on: true, plan: 'pro', until: '2030-01-01T00:00:00.000Z', ending: true, terms: TERMS });
    const patched = polar.calls.filter((c) => c.method === 'PATCH');
    expect(patched).toHaveLength(1);
    expect(patched[0].url).toBe(`${POLAR}/v1/customer-portal/subscriptions/${S1}`);
    expect(patched[0].body).toEqual({ cancel_at_period_end: true });
    // Done as the customer, in a session Polar made for this account: our own key is not what changes it.
    expect(patched[0].headers.get('authorization')).toBe('Bearer polar_cst_one');
    expect(asked('/v1/customer-sessions/').map((c) => [c.body, c.headers.get('authorization')])).toEqual([[{ external_customer_id: sub }, 'Bearer polar_test']]);
    // Kept: the next look doesn't need Polar.
    polar.calls = [];
    expect((await call({ as: sub })).json).toMatchObject({ plan: 'pro', ending: true });
    expect(polar.calls).toHaveLength(0);
  });

  it('takes a cancellation back, and a second click either way changes nothing more', async () => {
    const sub = account();
    pro(sub, [subscription({ id: S1, cancel_at_period_end: true, ends_at: '2030-01-01T00:00:00.000Z' })]);
    changing(sub);
    const back = await call({ method: 'POST', path: '/resume', as: sub });
    expect(back.json).toEqual({ on: true, plan: 'pro', until: '2030-01-01T00:00:00.000Z', ending: false, terms: TERMS });
    expect(polar.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ cancel_at_period_end: false }]);
    polar.calls = [];
    const again = await call({ method: 'POST', path: '/resume', as: sub });
    expect(again.res.status).toBe(200);
    expect(again.json).toMatchObject({ plan: 'pro', ending: false });
    expect(polar.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('stops every Pro subscription the account has, and leaves another product alone', async () => {
    const sub = account();
    pro(sub, [subscription({ id: S1 }), subscription({ id: S2, current_period_end: '2031-01-01T00:00:00.000Z' }), subscription({ id: '33333333-3333-4333-8333-333333333333', product_id: 'prod_other' })]);
    changing(sub);
    const got = await call({ method: 'POST', path: '/cancel', as: sub });
    expect(got.json).toEqual({ on: true, plan: 'pro', until: '2031-01-01T00:00:00.000Z', ending: true, terms: TERMS });
    expect(polar.calls.filter((c) => c.method === 'PATCH').map((c) => c.url.split('/').pop())).toEqual([S1, S2]);
  });

  it('says there is none for an account with nothing running, and changes nothing', async () => {
    const got = await call({ method: 'POST', path: '/cancel', as: account() });
    expect(got.res.status).toBe(404);
    expect(got.json).toEqual({ error: 'none' });
    expect(polar.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('never takes a subscription id that is not one into a request, and says unavailable when Polar refuses', async () => {
    const odd = account();
    pro(odd, [subscription({ id: '../customers' })]);
    expect((await call({ method: 'POST', path: '/cancel', as: odd })).res.status).toBe(200);
    expect(polar.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    const sub = account();
    pro(sub, [subscription({ id: S1 })]);
    polar.answer = (url, method) => (method === 'PATCH' ? new Response('{}', { status: 403 }) : url.endsWith('/v1/customer-sessions/') ? Response.json({ token: 'polar_cst_one' }) : Response.json(polar.state.get(sub)));
    const got = await call({ method: 'POST', path: '/cancel', as: sub });
    expect(got.res.status).toBe(502);
    expect(got.json).toEqual({ error: 'unavailable' });
  });

  it('needs a sign-in, and POST', async () => {
    expect((await call({ method: 'POST', path: '/cancel' })).res.status).toBe(401);
    expect((await call({ method: 'GET', path: '/cancel', as: account() })).res.status).toBe(405);
  });
});

describe('CORS and caching', () => {
  it('lets the app’s origin in, gives another none, and never lets an answer be cached', async () => {
    const sub = account();
    const mine = await call({ path: '/plan', as: sub, headers: { Origin: ORIGIN } });
    expect(mine.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(mine.res.headers.get('Vary')).toContain('Origin');
    expect(mine.res.headers.get('Cache-Control')).toBe('no-store');
    const other = await call({ path: '/plan', as: sub, headers: { Origin: 'https://evil.example' } });
    expect(other.res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(other.res.headers.get('Cache-Control')).toBe('no-store');
    const signedOut = await call({ path: '/plan' });
    expect(signedOut.res.headers.get('Cache-Control')).toBe('no-store');
    const preflight = await call({ method: 'OPTIONS', path: '/checkout', headers: { Origin: ORIGIN } });
    expect(preflight.res.status).toBe(204);
    expect(preflight.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(preflight.res.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ------------------------------------------------------------------ Polar's notices

describe('notices from Polar', () => {
  it('makes an account Pro when a signed notice says so, without asking Polar, and answers 202', async () => {
    const sub = account();
    const got = await notify(stateChanged(sub, [subscription()]));
    expect(got.res.status).toBe(202);
    const seen = await plan(sub);
    expect(seen.json).toMatchObject({ plan: 'pro', until: '2030-01-01T00:00:00.000Z' });
    expect(polar.calls).toHaveLength(0);
  });

  it('makes it free again when a later notice says there is nothing running', async () => {
    const sub = account();
    await notify(stateChanged(sub, [subscription()]));
    expect((await plan(sub)).json.plan).toBe('pro');
    const got = await notify(stateChanged(sub, []), { headers: await sign(JSON.stringify(stateChanged(sub, [])), { id: 'msg_2' }) });
    expect(got.res.status).toBe(202);
    expect((await plan(sub)).json.plan).toBe('free');
    expect(polar.calls).toHaveLength(0);
  });

  it('marks the plan out of date on any other signed notice that names the account', async () => {
    const sub = account();
    await plan(sub);
    expect(asked('/state')).toHaveLength(1);
    await plan(sub);
    expect(asked('/state')).toHaveLength(1);
    pro(sub);
    const got = await notify({ type: 'subscription.updated', data: { customer: { external_id: sub }, status: 'active' } });
    expect(got.res.status).toBe(202);
    const seen = await plan(sub);
    expect(asked('/state')).toHaveLength(2);
    expect(seen.json.plan).toBe('pro');
  });

  it('refuses a wrong signature and changes nothing', async () => {
    const sub = account();
    const body = JSON.stringify(stateChanged(sub, [subscription()]));
    const wrong = await sign(body, { keyBytes: crypto.getRandomValues(new Uint8Array(32)) });
    const got = await call({ method: 'POST', path: '/polar', body, headers: wrong });
    expect(got.res.status).toBe(403);
    // A signature for another body does not do either.
    const other = await sign(JSON.stringify(stateChanged(sub, [])));
    expect((await call({ method: 'POST', path: '/polar', body, headers: other })).res.status).toBe(403);
    // No signature headers at all.
    expect((await call({ method: 'POST', path: '/polar', body })).res.status).toBe(403);
    expect((await plan(sub)).json.plan).toBe('free');
    expect(asked('/state')).toHaveLength(1);
  });

  it('refuses a notice more than five minutes old, or as far ahead', async () => {
    const sub = account();
    const body = JSON.stringify(stateChanged(sub, [subscription()]));
    const old = String(Math.floor(Date.now() / 1000) - 6 * 60);
    expect((await call({ method: 'POST', path: '/polar', body, headers: await sign(body, { timestamp: old }) })).res.status).toBe(403);
    const ahead = String(Math.floor(Date.now() / 1000) + 6 * 60);
    expect((await call({ method: 'POST', path: '/polar', body, headers: await sign(body, { timestamp: ahead }) })).res.status).toBe(403);
    const recent = String(Math.floor(Date.now() / 1000) - 4 * 60);
    expect((await call({ method: 'POST', path: '/polar', body, headers: await sign(body, { timestamp: recent }) })).res.status).toBe(202);
  });

  it('answers 503 with no secret, and 405 to anything but POST', async () => {
    const sub = account();
    const noSecret = await notify(stateChanged(sub, [subscription()]), { using: { ...billing, POLAR_WEBHOOK_SECRET: undefined } });
    expect(noSecret.res.status).toBe(503);
    const get = await call({ method: 'GET', path: '/polar' });
    expect(get.res.status).toBe(405);
    expect((await plan(sub)).json.plan).toBe('free');
  });

  it('acknowledges a signed notice it cannot use, so Polar does not send it again', async () => {
    expect((await notify({ type: 'order.created', data: {} })).res.status).toBe(202);
    expect((await notify({ type: 'customer.state_changed', data: { external_id: 'bad id!' } })).res.status).toBe(202);
    const body = 'not json';
    expect((await call({ method: 'POST', path: '/polar', body, headers: await sign(body) })).res.status).toBe(202);
    expect(polar.calls).toHaveLength(0);
  });

  it('also accepts the older scheme, keyed with the whole secret string', async () => {
    const body = '{"type":"x"}';
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const legacy = await sign(body, { timestamp, keyBytes: new TextEncoder().encode(SECRET) });
    expect(await signedByPolar(SECRET, legacy['webhook-id'], timestamp, legacy['webhook-signature'], body, now)).toBe(true);
    const current = await sign(body, { timestamp });
    expect(await signedByPolar(SECRET, current['webhook-id'], timestamp, current['webhook-signature'], body, now)).toBe(true);
    // A list of signatures, one good: accepted. A different secret: not.
    expect(await signedByPolar(SECRET, current['webhook-id'], timestamp, `v1,AAAA ${current['webhook-signature']}`, body, now)).toBe(true);
    expect(await signedByPolar(`whsec_${btoa('another secret entirely, 32 bytes!!')}`, current['webhook-id'], timestamp, current['webhook-signature'], body, now)).toBe(false);
    expect(await signedByPolar(SECRET, current['webhook-id'], timestamp, current['webhook-signature'], `${body} `, now)).toBe(false);
    expect(await signedByPolar(SECRET, null, timestamp, current['webhook-signature'], body, now)).toBe(false);
    expect(await signedByPolar('', current['webhook-id'], timestamp, current['webhook-signature'], body, now)).toBe(false);
    // Through the route, too.
    const through = await call({ method: 'POST', path: '/polar', body, headers: await sign(body, { keyBytes: new TextEncoder().encode(SECRET) }) });
    expect(through.res.status).toBe(202);
  });
});

// ------------------------------------------------------------------ the assistant's allowance

describe('the assistant’s allowance goes by plan', () => {
  const limits = { ...billing, ASSISTANT_MONTHLY_MICROUSD: '300000', ASSISTANT_PRO_MONTHLY_MICROUSD: '777000' };
  const usage = async (as: string, using: object = limits) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://relay.test/assistant/usage', { headers: { Authorization: `Bearer ${await token(as)}` } }), using as never, ctx);
    const body = (await res.json()) as { limit: number; plan: string };
    await waitOnExecutionContext(ctx);
    return body;
  };

  it('gives a Pro account the Pro allowance and any other the free one', async () => {
    const paid = account();
    pro(paid);
    expect(await usage(paid)).toMatchObject({ limit: 777000, plan: 'pro' });
    expect(await usage(account())).toMatchObject({ limit: 300000, plan: 'free' });
    // With billing off, everyone is free whatever Polar would say.
    const quiet = account();
    pro(quiet);
    expect(await usage(quiet, { ...limits, POLAR_ACCESS_TOKEN: undefined })).toMatchObject({ limit: 300000, plan: 'free' });
  });
});
