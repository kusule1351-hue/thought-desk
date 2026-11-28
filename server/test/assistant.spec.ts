// The assistant's route to its model, in the Workers runtime (real Durable Objects, run locally).
// Anthropic is faked: the SDK's fetch to api.anthropic.com is answered by `anthropic.answer`.
// Run with `npm test`. Sign-in tokens are made like sync.spec.ts makes them.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { costOf, MAX_BODY, parseAsk } from '../src/assistant';
import worker from '../src/index';

const ISSUER = env.CLERK_ISSUERS.split(',')[0];
const ORIGIN = 'http://tauri.localhost';
const clerk = await generateKeyPair('RS256');
const stranger = await generateKeyPair('RS256');

/** What the fake Anthropic is asked, and how it answers (a fresh Response each time: the SDK asks twice on a 429 or 5xx). */
const anthropic = {
  calls: [] as { url: string; body: Record<string, any>; headers: Headers }[],
  answer: (() => normal()) as () => Response,
};

// Clerk's public keys, as jose fetches them, and Anthropic's answers.
beforeAll(async () => {
  const jwk = { ...(await exportJWK(clerk.publicKey)), kid: 'ins_1', alg: 'RS256', use: 'sig' };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.startsWith('https://api.anthropic.com/')) {
      const raw = input instanceof Request ? await input.text() : init?.body;
      const headers = new Headers(input instanceof Request ? input.headers : (init?.headers as HeadersInit));
      anthropic.calls.push({ url, body: typeof raw === 'string' ? JSON.parse(raw) : {}, headers });
      return anthropic.answer();
    }
    return real(input, init);
  });
});

beforeEach(() => {
  anthropic.calls = [];
  anthropic.answer = () => normal();
});

function token(sub: string, key: CryptoKey = clerk.privateKey) {
  return new SignJWT({ sid: 'sess_1', sts: 'active', v: 2, azp: ORIGIN })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setExpirationTime('1m')
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(key);
}

let counter = 0;
/** A fresh account, so tests never share an allowance. */
const account = () => `user_a${++counter}x${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ the fake answers

const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (input = 1000) => frame('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
const open = frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const delta = frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
const rest = [
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } }),
  frame('message_stop', { type: 'message_stop' }),
];

/** A whole answer: 1000 tokens in, 200 out. */
const normal = () => new Response([start(), open, delta, ...rest].join(''), { headers: { 'content-type': 'text/event-stream' } });

/** An error answer in Anthropic's own shape. `retry-after-ms` keeps the SDK's one retry quick. */
const failing = (status: number, kind: string, message = 'x') =>
  new Response(JSON.stringify({ type: 'error', error: { type: kind, message } }), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });

/** An answer that breaks off after one word. */
function broken() {
  const enc = new TextEncoder();
  let pulled = 0;
  // Erroring at once would throw away what is queued, so the break comes on the next pull.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) for (const f of [start(), open, delta]) controller.enqueue(enc.encode(f));
      else controller.error(new Error('cut'));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** The events of a server-sent stream, in order. */
function events(text: string) {
  return text
    .split('\n\n')
    .filter((part) => part.trim())
    .map((part) => {
      const name = /^event: (.*)$/m.exec(part)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(part)?.[1];
      return { name, data: data ? JSON.parse(data) : null };
    });
}

// ------------------------------------------------------------------ calling

const VALID = { messages: [{ role: 'user', content: 'Hi' }] };

interface Call {
  method?: string;
  path?: string;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
  /** The account to sign in as; false for no token. */
  as?: string | false;
  /** Signs the token with another key. */
  key?: CryptoKey;
  env?: object;
}

/** Calls the Worker as the app does, reads the whole answer and waits until the cost is counted. */
async function call({ method = 'POST', path = '/v1/messages', body, json = method === 'POST' ? VALID : undefined, headers = {}, as = false, key, env: using = env }: Call = {}) {
  const h = new Headers(headers);
  if (as) h.set('Authorization', `Bearer ${await token(as, key)}`);
  if (json !== undefined && body === undefined) body = JSON.stringify(json);
  if (method === 'POST' && body !== undefined && !h.has('content-length')) h.set('content-length', String(new TextEncoder().encode(body).length));
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://relay.test/assistant${path}`, { method, body: method === 'POST' ? body : undefined, headers: h }), using as never, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, text, reason: res.headers.get('x-td-reason') };
}

const ask = (as: string, json: unknown = VALID, extra: Call = {}) => call({ as, json, ...extra });
const usage = async (as: string) => JSON.parse((await call({ method: 'GET', path: '/usage', as })).text) as { used: number; limit: number; month: string; on: boolean };
const used = async (as: string) => (await usage(as)).used;

const HAIKU_1000_200 = costOf('claude-haiku-5-5', { input: 1000, cacheWrite: 0, cacheRead: 0, output: 200 });

// ------------------------------------------------------------------ sign-in and access

describe('who may ask', () => {
  it('turns away a request with no sign-in, or one signed with a stranger’s key', async () => {
    const none = await call();
    expect(none.res.status).toBe(401);
    expect(none.reason).toBe('signed-out');
    const forged = await call({ as: account(), key: stranger.privateKey });
    expect(forged.res.status).toBe(401);
    expect(forged.reason).toBe('signed-out');
    const usageOut = await call({ method: 'GET', path: '/usage' });
    expect(usageOut.res.status).toBe(401);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('keeps the assistant closed to accounts that are not listed, and open to those that are', async () => {
    const sub = account();
    const other = account();
    const closed = { ...env, ASSISTANT_ACCESS: 'testers', ASSISTANT_TESTERS: `${other},${sub}x` };
    const no = await ask(sub, VALID, { env: closed });
    expect(no.res.status).toBe(403);
    expect(no.reason).toBe('closed');
    expect(anthropic.calls).toHaveLength(0);

    const listed = await ask(sub, VALID, { env: { ...closed, ASSISTANT_TESTERS: `${other}, ${sub}` } });
    expect(listed.res.status).toBe(200);
    expect(anthropic.calls).toHaveLength(1);
  });

  it('is closed when the access setting is missing', async () => {
    const sub = account();
    const res = await ask(sub, VALID, { env: { ...env, ASSISTANT_ACCESS: undefined, ASSISTANT_TESTERS: undefined } });
    expect(res.res.status).toBe(403);
    expect(res.reason).toBe('closed');
    const usageRes = await call({ method: 'GET', path: '/usage', as: sub, env: { ...env, ASSISTANT_ACCESS: undefined } });
    expect(usageRes.res.status).toBe(403);
  });

  it('is off without a key, but still says so on the usage route', async () => {
    const sub = account();
    const noKey = { ...env, ANTHROPIC_API_KEY: undefined };
    const res = await ask(sub, VALID, { env: noKey });
    expect(res.res.status).toBe(503);
    expect(res.reason).toBe('off');
    const got = await call({ method: 'GET', path: '/usage', as: sub, env: noKey });
    expect(got.res.status).toBe(200);
    expect(JSON.parse(got.text).on).toBe(false);
    expect(anthropic.calls).toHaveLength(0);
    expect((await usage(sub)).on).toBe(true);
  });

  it('answers a wrong method with 405 and an unknown path with 404', async () => {
    const sub = account();
    expect((await call({ method: 'GET', path: '/v1/messages', as: sub })).res.status).toBe(405);
    expect((await call({ method: 'POST', path: '/usage', as: sub, json: VALID })).res.status).toBe(405);
    expect((await call({ method: 'GET', path: '/nothing', as: sub })).res.status).toBe(404);
    expect((await call({ method: 'POST', path: '/v1/other', as: sub })).res.status).toBe(404);
    expect(anthropic.calls).toHaveLength(0);
  });
});

describe('CORS', () => {
  const preflight = (origin: string) =>
    call({ method: 'OPTIONS', path: '/v1/messages', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-stainless-os' } });

  it('lets the app’s own origin in and reflects the headers it asks to send', async () => {
    const { res } = await preflight(ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('authorization, x-stainless-os');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    const plain = await call({ as: account(), headers: { Origin: ORIGIN } });
    expect(plain.res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(plain.res.headers.get('Vary')).toContain('Origin');
  });

  it('gives another origin no CORS headers', async () => {
    const { res } = await preflight('https://evil.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Headers')).toBeNull();
    const answer = await call({ as: account(), headers: { Origin: 'https://evil.example' } });
    expect(answer.res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ------------------------------------------------------------------ the happy path

describe('an answer', () => {
  it('streams the events back in order', async () => {
    const got = await ask(account());
    expect(got.res.status).toBe(200);
    expect(got.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(got.res.headers.get('Cache-Control')).toBe('no-store');
    const list = events(got.text);
    expect(list.map((e) => e.name)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(list[2].data.delta).toEqual({ type: 'text_delta', text: 'Hello' });
    expect(list.at(-1)?.name).toBe('message_stop');
  });

  it('sets the model, the length and the stream itself, whatever the app sent', async () => {
    const sub = account();
    const tool = { name: 'read_note', description: 'Reads a note', input_schema: { type: 'object', properties: { id: { type: 'string' } } }, cache_control: { type: 'ephemeral' }, extra: 'dropped' };
    const messages = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, { role: 'user', content: 'Again' }];
    const clientToken = await token(sub);
    const got = await call({ as: sub, headers: { 'x-client': 'y' }, json: { model: 'claude-opus-5-5', max_tokens: 100000, stream: false, metadata: { user_id: 'x' }, thinking: { type: 'disabled' }, temperature: 0, system: 'Be brief.', messages, tools: [tool] } });
    expect(got.res.status).toBe(200);
    expect(anthropic.calls).toHaveLength(1);
    const { body, headers, url } = anthropic.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(8000);
    expect(body.stream).toBe(true);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.metadata).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    // The instructions carry a cache mark of their own, so a new conversation reads them (and the tools before them) from the cache.
    expect(body.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual(messages);
    expect(body.tools).toEqual([{ name: 'read_note', description: 'Reads a note', input_schema: tool.input_schema }]);
    // This SDK version sends the server's key as a bearer token (not as x-api-key); the person's own token stays here.
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('x-api-key') ?? 'test-key').toBe('test-key');
    expect([...headers.entries()].some(([, v]) => v.includes(clientToken))).toBe(false);
  });

  it('asks the model the server names', async () => {
    await ask(account(), VALID, { env: { ...env, ASSISTANT_MODEL: 'claude-sonnet-5-5' } });
    expect(anthropic.calls[0].body.model).toBe('claude-sonnet-5-5');
  });
});

// ------------------------------------------------------------------ counting

describe('counting', () => {
  it('counts what an answer cost', async () => {
    const sub = account();
    expect(HAIKU_1000_200).toBe(200);
    expect(await used(sub)).toBe(0);
    await ask(sub);
    const got = await usage(sub);
    expect(got.used).toBe(HAIKU_1000_200);
    expect(got.limit).toBe(100000);
    expect(got.month).toBe(new Date().toISOString().slice(0, 7));
    expect(got.on).toBe(true);
  });

  it('prices tokens by model, cache and the length of the prompt', () => {
    const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    // A million tokens is a long prompt (see below), so the plain price is shown on 100,000 and on the output.
    expect(costOf('claude-haiku-5-5', { ...u, input: 100_000 })).toBe(10000);
    expect(costOf('claude-haiku-5-5', { ...u, output: 1_000_000 })).toBe(500000);
    expect(costOf('claude-haiku-5-5', { ...u, input: 1_000_000 })).toBe(500000);
    // Cache reads cost a tenth, cache writes 1.25 times.
    expect(costOf('claude-haiku-5-5', { ...u, cacheRead: 100_000 })).toBe(costOf('claude-haiku-5-5', { ...u, input: 100_000 }) / 10);
    expect(costOf('claude-haiku-5-5', { ...u, cacheWrite: 80_000 })).toBe(costOf('claude-haiku-5-5', { ...u, input: 100_000 }));
    // A Haiku prompt over 100,000 tokens is at the long price: five times.
    expect(costOf('claude-haiku-5-5', { ...u, input: 200_000 })).toBe(100000);
    expect(costOf('claude-haiku-5-5', { ...u, input: 200_000, output: 1000 })).toBe(100000 + 2500);
    // The long price counts the cached part of the prompt too.
    expect(costOf('claude-haiku-5-5', { ...u, input: 50_000, cacheRead: 60_000 })).toBe(Math.ceil(50_000 * 0.5 + 60_000 * 0.1 * 0.5));
    // Sonnet has no long price.
    expect(costOf('claude-sonnet-5-5', { ...u, input: 200_000 })).toBe(400000);
    // A model not listed is counted dear, never free.
    expect(costOf('claude-mystery-9', { ...u, input: 1_000_000 })).toBe(10_000_000);
    expect(costOf('claude-mystery-9', { ...u, output: 1_000_000 })).toBe(50_000_000);
  });

  it('refuses an account that has spent its month, and no one else', async () => {
    const sub = account();
    const small = { ...env, ASSISTANT_MONTHLY_MICROUSD: '100' };
    expect((await ask(sub, VALID, { env: small })).res.status).toBe(200);
    expect(anthropic.calls).toHaveLength(1);
    const next = await ask(sub, VALID, { env: small });
    expect(next.res.status).toBe(429);
    expect(next.reason).toBe('spent');
    expect(anthropic.calls).toHaveLength(1);
    expect((await ask(account(), VALID, { env: small })).res.status).toBe(200);
    expect(anthropic.calls).toHaveLength(2);
  });

  it('turns everyone away when the day is used up, and gives the hold back', async () => {
    const sub = account();
    const got = await ask(sub, VALID, { env: { ...env, ASSISTANT_DAILY_MICROUSD: '0' } });
    expect(got.res.status).toBe(503);
    expect(got.reason).toBe('busy');
    expect(anthropic.calls).toHaveLength(0);
    expect(await used(sub)).toBe(0);
  });

  it('charges nothing for a request that is not valid', async () => {
    const sub = account();
    const got = await ask(sub, { messages: [] });
    expect(got.res.status).toBe(400);
    expect(await used(sub)).toBe(0);
    expect((await call({ as: sub, body: 'not json' })).res.status).toBe(400);
    expect(await used(sub)).toBe(0);
  });

  it('slows one account that asks more than 30 times a minute', async () => {
    const sub = account();
    const roomy = { ...env, ASSISTANT_MONTHLY_MICROUSD: '100000000' };
    for (let i = 0; i < 30; i++) expect((await ask(sub, VALID, { env: roomy })).res.status).toBe(200);
    const slow = await ask(sub, VALID, { env: roomy });
    expect(slow.res.status).toBe(429);
    expect(slow.reason).toBe('fast');
    expect(Number(slow.res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(anthropic.calls).toHaveLength(30);
    // Another account is not slowed.
    expect((await ask(account(), VALID, { env: roomy })).res.status).toBe(200);
  });
});

// ------------------------------------------------------------------ what is refused

describe('what is refused', () => {
  const refused: [string, unknown][] = [
    ['a tool Anthropic runs itself', { messages: VALID.messages, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }],
    ['an image', { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }],
    ['a document', { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }] }] }],
    ['an image in a tool result', { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }] }],
    ['a forced tool', { ...VALID, tool_choice: { type: 'any' } }],
    ['instructions as a list', { ...VALID, system: [{ type: 'text', text: 'Be brief.' }] }],
    ['no messages', { messages: [] }],
    ['no messages key', { system: 'x' }],
  ];

  it.each(refused)('turns away %s', async (_, json) => {
    const got = await ask(account(), json);
    expect(got.res.status).toBe(400);
    expect(got.reason).toBe('bad');
    expect(anthropic.calls).toHaveLength(0);
  });

  it('turns away a body that is not JSON', async () => {
    const got = await call({ as: account(), body: '{"messages": [' });
    expect(got.res.status).toBe(400);
    expect(got.reason).toBe('bad');
    expect(anthropic.calls).toHaveLength(0);
  });

  it('turns away a body over 400 KiB, by its length and by what it holds', async () => {
    const sub = account();
    const big = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(MAX_BODY + 10) }] });
    const real = await call({ as: sub, body: big });
    expect(real.res.status).toBe(400);
    expect(real.reason).toBe('bad');
    // A client that says how long it is, and is believed before a byte is read.
    const said = await call({ as: sub, json: VALID, headers: { 'content-length': String(MAX_BODY + 1) } });
    expect(said.res.status).toBe(400);
    expect(said.reason).toBe('bad');
    // One that says nothing about its length is still stopped.
    const unsaid = await call({ as: sub, body: big, headers: { 'content-length': '10' } });
    expect(unsaid.res.status).toBe(400);
    expect(anthropic.calls).toHaveLength(0);
    expect(await used(sub)).toBe(0);
  });

  it('checks a request the way parseAsk does', () => {
    const ok = [{ role: 'user', content: 'Hi' }];
    expect(() => parseAsk('x')).toThrow();
    expect(() => parseAsk(null)).toThrow();
    expect(() => parseAsk([])).toThrow();
    expect(() => parseAsk({ messages: [] })).toThrow();
    expect(() => parseAsk({ messages: [{ role: 'system', content: 'x' }] })).toThrow();
    expect(() => parseAsk({ messages: [{ role: 'user', content: [] }] })).toThrow();
    expect(() => parseAsk({ messages: [{ role: 'user', content: [{ type: 'image' }] }] })).toThrow();
    expect(() => parseAsk({ messages: [{ role: 'user', content: [{ type: 'document' }] }] })).toThrow();
    expect(() => parseAsk({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image' }] }] }] })).toThrow();
    expect(() => parseAsk({ messages: ok, system: ['x'] })).toThrow();
    expect(() => parseAsk({ messages: ok, tools: [{ type: 'web_search_20260209', name: 'web_search' }] })).toThrow();
    expect(() => parseAsk({ messages: ok, tools: [{ name: 'bad name!', description: 'x', input_schema: { type: 'object' } }] })).toThrow();
    expect(() => parseAsk({ messages: ok, tools: [{ name: 'a', description: 'x', input_schema: { type: 'string' } }] })).toThrow();
    expect(() => parseAsk({ messages: ok, tool_choice: { type: 'any' } })).toThrow();
    expect(() => parseAsk({ messages: ok, tool_choice: { type: 'tool', name: 'a' } })).toThrow();

    // What is kept.
    expect(parseAsk({ messages: ok, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(parseAsk({ messages: ok, tool_choice: { type: 'none' } }).tool_choice).toEqual({ type: 'none' });
    expect(parseAsk({ messages: ok, tool_choice: { type: 'auto' } }).tool_choice).toEqual({ type: 'auto' });
    expect(parseAsk({ messages: ok, tools: [{ type: 'custom', name: 'a', description: 'x', input_schema: { type: 'object' } }] }).tools).toHaveLength(1);
    expect(parseAsk({ model: 'claude-opus-5-5', max_tokens: 9, messages: ok })).toEqual({ messages: ok });
  });
});

// ------------------------------------------------------------------ when Anthropic says no

describe('when Anthropic says no', () => {
  it('tells the app a bad request is bad, in words of its own', async () => {
    const sub = account();
    anthropic.answer = () => failing(400, 'invalid_request_error', 'Your credit balance of the owner is too low');
    const got = await ask(sub);
    expect(got.res.status).toBe(400);
    expect(got.reason).toBe('bad');
    expect(got.text).not.toContain('credit balance');
    expect(await used(sub)).toBe(0);
  });

  it('says the assistant is off when Anthropic refuses the key', async () => {
    const sub = account();
    anthropic.answer = () => failing(401, 'authentication_error', 'invalid x-api-key test-key');
    const got = await ask(sub);
    expect(got.res.status).toBe(503);
    expect(got.reason).toBe('off');
    expect(got.text).not.toContain('test-key');
    expect(await used(sub)).toBe(0);
  });

  it.each([
    [429, 'rate_limit_error'],
    [529, 'overloaded_error'],
  ])('says busy, with a time to wait, on a %i', async (status, kind) => {
    const sub = account();
    anthropic.answer = () => failing(status, kind);
    const got = await ask(sub);
    expect(got.res.status).toBe(503);
    expect(got.reason).toBe('busy');
    expect(got.res.headers.get('Retry-After')).toBeTruthy();
    expect(await used(sub)).toBe(0);
  });

  it('ends the stream with an error and still counts what was read when the answer breaks off', async () => {
    const sub = account();
    anthropic.answer = broken;
    const got = await ask(sub);
    expect(got.res.status).toBe(200);
    const list = events(got.text);
    expect(list.map((e) => e.name)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error']);
    expect(list.at(-1)?.data.error.type).toBe('api_error');
    expect(await used(sub)).toBeGreaterThan(0);
  });
});
