/**
 * The assistant's way to its model. The app holds no key: it sends what the
 * person asked, the notes it picked and the tools it offers; this checks the
 * sign-in, the account's allowance and the free accounts' daily limit, asks Claude
 * with the key kept here, and passes the answer back as it is written.
 *
 * Nothing that passes through is kept or logged: only what it cost is counted
 * (budget.ts). The tools run in the app, on the person's own computer.
 *
 * The app is open source, so anyone signed in can send anything here. That is
 * why the model, the answer's length and the request's size are set here and
 * not by the request, why only the app's own kind of tool is passed on (no
 * web search or code running on the owner's bill), and why closed is the
 * default, as with sync (access.ts).
 */

import Anthropic from '@anthropic-ai/sdk';
import { listOf, type AuthEnv } from './auth';
import { PER_MINUTE, type Admitted, type Budget } from './budget';
import { BadRequest, readText } from './mailbox';
import { planOf, type PlanEnv } from './plan';
import { accountOf } from './sync';

export interface AssistantEnv extends AuthEnv, PlanEnv {
  BUDGET: DurableObjectNamespace<Budget>;
  /** The key Claude is asked with (`npx wrangler secret put ANTHROPIC_API_KEY`). Without it the assistant is off. */
  ANTHROPIC_API_KEY?: string;
  /** "everyone" once the assistant is open. Anything else, or nothing, means testers only. */
  ASSISTANT_ACCESS?: string;
  /** The Clerk user ids that may use it meanwhile, comma-separated (a secret, like SYNC_TESTERS). */
  ASSISTANT_TESTERS?: string;
  ASSISTANT_MODEL?: string;
  /** The most one account may cost a month, and everybody together a day, in millionths of a dollar. */
  ASSISTANT_MONTHLY_MICROUSD?: string | number;
  ASSISTANT_DAILY_MICROUSD?: string | number;
  /** The same for an account on Pro (plan.ts says who is). */
  ASSISTANT_PRO_MONTHLY_MICROUSD?: string | number;
}

export const DEFAULT_MODEL = 'claude-haiku-5-5';
/** 10 cents a month for one account on the free plan; 10 dollars a day for the free accounts together. */
const DEFAULT_MONTHLY = 100_000;
/** 3 dollars a month for an account on Pro. */
const DEFAULT_PRO_MONTHLY = 3_000_000;
const DEFAULT_DAILY = 10_000_000;
/** The longest answer to one request: a whole note fits. */
export const MAX_TOKENS = 8000;
/** The biggest request (bytes of JSON): about what the model's lower price covers. */
export const MAX_BODY = 400 * 1024;
const MAX_MESSAGES = 400;
const MAX_TOOLS = 48;
const MAX_SYSTEM = 30_000;

/** Dollars per million tokens (so: millionths of a dollar per token). `long`: what a prompt over 100,000 tokens costs. */
interface Price {
  in: number;
  out: number;
  long?: { in: number; out: number };
}
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, long: { in: 0.5, out: 2.5 } },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
/** A model not listed is counted at the dearest price there is, never as free. */
const UNKNOWN: Price = { in: 10, out: 50 };
const LONG_PROMPT = 100_000;
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

export interface Used {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** What a request cost, in millionths of a dollar. */
export function costOf(model: string, used: Used): number {
  const price = PRICES[model] ?? UNKNOWN;
  const prompt = used.input + used.cacheWrite + used.cacheRead;
  const { in: i, out: o } = prompt > LONG_PROMPT && price.long ? price.long : price;
  return Math.ceil((used.input + used.cacheWrite * CACHE_WRITE + used.cacheRead * CACHE_READ) * i + used.output * o);
}

/** The most a request of `bytes` could cost: every byte a token, and the longest answer. */
export function holdFor(model: string, bytes: number): number {
  const price = PRICES[model] ?? UNKNOWN;
  const { in: i, out: o } = price.long ?? price;
  return Math.ceil(bytes * i * CACHE_WRITE + MAX_TOKENS * o);
}

export function mayUseAssistant(sub: string, env: Pick<AssistantEnv, 'ASSISTANT_ACCESS' | 'ASSISTANT_TESTERS'>): boolean {
  if (env.ASSISTANT_ACCESS === 'everyone') return true;
  return listOf(env.ASSISTANT_TESTERS).includes(sub);
}

const limit = (value: string | number | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The month and the day, by the server's clock in UTC. */
export const periods = (now = new Date()) => ({ month: now.toISOString().slice(0, 7), day: now.toISOString().slice(0, 10) });

// ------------------------------------------------------------------ the request

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The blocks a message may carry: text, the model's own thinking handed back, and tool calls with their results. */
const BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function block(value: unknown): Json {
  if (!isObject(value) || typeof value.type !== 'string' || !BLOCKS.has(value.type)) throw new BadRequest('A message has a part the assistant does not take');
  if (value.type === 'tool_result' && Array.isArray(value.content)) {
    for (const part of value.content) if (!isObject(part) || part.type !== 'text') throw new BadRequest('A tool result may only hold text');
  }
  return value;
}

export interface Asked {
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  tool_choice?: Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceNone;
}

/** What of a request is passed on. Everything else in it (the model, the length, anything new) is dropped. */
export function parseAsk(body: unknown): Asked {
  if (!isObject(body)) throw new BadRequest('Not a request');
  const out: Asked = { messages: [] };

  if (body.system !== undefined) {
    if (typeof body.system !== 'string' || body.system.length > MAX_SYSTEM) throw new BadRequest('The instructions must be text, and shorter');
    if (body.system) out.system = body.system;
  }

  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES) throw new BadRequest('A request needs between 1 and 400 messages');
  for (const m of body.messages) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant')) throw new BadRequest('A message is from the person or the assistant');
    if (typeof m.content === 'string') out.messages.push({ role: m.role, content: m.content });
    else if (Array.isArray(m.content) && m.content.length) out.messages.push({ role: m.role, content: m.content.map(block) as unknown as Anthropic.ContentBlockParam[] });
    else throw new BadRequest('A message needs something in it');
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) throw new BadRequest('Too many tools');
    out.tools = body.tools.map((tool) => {
      // Only tools the app runs itself: one with a `type` is one Anthropic runs, on the owner's bill.
      if (!isObject(tool) || (tool.type !== undefined && tool.type !== 'custom')) throw new BadRequest('Only the app’s own tools are passed on');
      if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw new BadRequest('A tool needs a plain name');
      if (typeof tool.description !== 'string' || tool.description.length > 6000) throw new BadRequest('A tool needs a description, and a shorter one');
      if (!isObject(tool.input_schema) || tool.input_schema.type !== 'object') throw new BadRequest('A tool needs a schema');
      return { name: tool.name, description: tool.description, input_schema: tool.input_schema as Anthropic.Tool.InputSchema };
    });
    if (!out.tools.length) delete out.tools;
  }

  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (!isObject(choice) || (choice.type !== 'auto' && choice.type !== 'none')) throw new BadRequest('The model chooses its own tools');
    out.tool_choice = choice.type === 'none' ? { type: 'none' } : { type: 'auto', ...(choice.disable_parallel_tool_use === true ? { disable_parallel_tool_use: true } : {}) };
  }
  return out;
}

// ------------------------------------------------------------------ the answers

/** Why a request was turned away, for the app (`x-td-reason`). */
type Reason = 'signed-out' | 'closed' | 'off' | 'spent' | 'busy' | 'fast' | 'bad' | 'failed';

/** An answer in the shape Anthropic's own errors have, so the app's client reads it like one. */
function refuse(status: number, kind: string, reason: Reason, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: kind, message } }), { status, headers: { 'content-type': 'application/json', 'x-td-reason': reason, ...headers } });
}

/** CORS for the app's own origins only; the headers it asks to send are let through as asked. */
function corsFor(request: Request, env: AuthEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !listOf(env.APP_ORIGINS).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After, x-td-reason',
    'Access-Control-Max-Age': '600',
  };
}

export interface AssistantDeps {
  /** The client Claude is asked with (tests hand in their own). */
  client: (key: string) => Pick<Anthropic, 'messages'>;
  now: () => Date;
}

const DEPS: AssistantDeps = { client: (key) => new Anthropic({ apiKey: key, maxRetries: 1 }), now: () => new Date() };

export async function handleAssistant(request: Request, env: AssistantEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, deps: AssistantDeps = DEPS): Promise<Response> {
  let res: Response;
  try {
    res = await answer(request, env, ctx, deps);
  } catch (e) {
    if (e instanceof BadRequest) res = refuse(400, 'invalid_request_error', 'bad', e.message);
    else {
      console.error('The assistant failed', e instanceof Error ? e.name : typeof e);
      res = refuse(500, 'api_error', 'failed', 'Something went wrong. Try again in a moment.');
    }
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  out.set('Vary', 'Origin');
  for (const [k, v] of Object.entries(corsFor(request, env))) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

async function answer(request: Request, env: AssistantEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, deps: AssistantDeps): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const route = new URL(request.url).pathname.slice('/assistant'.length);
  if (route !== '/usage' && route !== '/v1/messages') return new Response(null, { status: 404 });
  if (request.method !== (route === '/usage' ? 'GET' : 'POST')) return new Response(null, { status: 405 });

  const sub = await accountOf(request, env, false);
  if (!sub) return refuse(401, 'authentication_error', 'signed-out', 'Sign in to use the assistant.');
  if (!mayUseAssistant(sub, env)) return refuse(403, 'permission_error', 'closed', 'The assistant is not open to this account yet.');

  const model = env.ASSISTANT_MODEL || DEFAULT_MODEL;
  // What the account may spend this month goes by its plan.
  const plan = await planOf(sub, env);
  const monthly = plan.pro ? limit(env.ASSISTANT_PRO_MONTHLY_MICROUSD, DEFAULT_PRO_MONTHLY) : limit(env.ASSISTANT_MONTHLY_MICROUSD, DEFAULT_MONTHLY);
  const daily = limit(env.ASSISTANT_DAILY_MICROUSD, DEFAULT_DAILY);
  const { month, day } = periods(deps.now());
  const mine = env.BUDGET.get(env.BUDGET.idFromName(`account:${sub}`));
  const everyone = env.BUDGET.get(env.BUDGET.idFromName('everyone'));

  if (route === '/usage') {
    const used = await mine.spent(month);
    return Response.json({ used: Math.min(used, monthly), limit: monthly, month, on: !!env.ANTHROPIC_API_KEY, plan: plan.pro ? 'pro' : 'free' });
  }

  if (!env.ANTHROPIC_API_KEY) return refuse(503, 'api_error', 'off', 'The assistant is not set up on this server.');

  // The size is checked before a byte is read, the limits before anything is parsed.
  const text = await readText(request, MAX_BODY);
  const hold = holdFor(model, new TextEncoder().encode(text).length);
  const own: Admitted = await mine.admit(month, monthly, hold, PER_MINUTE);
  if (!own.ok) {
    if (own.reason === 'fast') return refuse(429, 'rate_limit_error', 'fast', 'That was a lot at once. Try again in a moment.', { 'Retry-After': String(own.retryAfter) });
    return refuse(429, 'rate_limit_error', 'spent', 'This month’s assistant allowance is used up.');
  }
  // The day's limit is the free plan's: it keeps what the accounts that pay nothing cost, together, in bounds.
  // An account on Pro has paid for its own allowance, and that is its only limit: a busy day among the free
  // accounts never closes it out, and what it spends is not taken from theirs.
  const shared = !plan.pro;
  const all: Admitted = shared ? await everyone.admit(day, daily, hold) : { ok: true, spent: 0 };
  let settled = false;
  /** Counts what the request cost (once): in the account's own budget, and in the day's if it draws on that. */
  const settle = async (cost: number) => {
    if (settled) return;
    settled = true;
    await Promise.all([mine.settle(month, hold, cost), shared && all.ok ? everyone.settle(day, hold, cost) : null]);
  };
  if (!all.ok) {
    await settle(0);
    return refuse(503, 'overloaded_error', 'busy', 'The assistant has answered as much as it can today. Try again tomorrow.');
  }

  let asked: Asked;
  try {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BadRequest('Not JSON');
    }
    asked = parseAsk(body);
  } catch (e) {
    await settle(0);
    throw e;
  }

  const upstream = new AbortController();
  request.signal.addEventListener('abort', () => upstream.abort());
  let events: AsyncIterable<Anthropic.RawMessageStreamEvent>;
  try {
    events = await deps.client(env.ANTHROPIC_API_KEY).messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        stream: true,
        // The conversation so far is the same from one step of a task to the next: read from the cache, it costs a tenth.
        cache_control: { type: 'ephemeral' },
        ...asked,
        // The tools and instructions are the same for every conversation, and most of a request (about 6,800
        // tokens, measured). Marked on their own, a new conversation reads them from the cache too, whoever
        // started the last one; left to the mark above, each new conversation paid to write them again.
        ...(asked.system ? { system: [{ type: 'text' as const, text: asked.system, cache_control: { type: 'ephemeral' as const } }] } : {}),
      },
      { signal: upstream.signal },
    );
  } catch (e) {
    await settle(0);
    return upstreamRefusal(e);
  }

  const used: Used = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  /** Characters written so far, for an answer cut off before its count came. */
  let written = 0;
  let counted = false;
  const note = (event: Anthropic.RawMessageStreamEvent) => {
    const usage = event.type === 'message_start' ? event.message.usage : event.type === 'message_delta' ? event.usage : null;
    if (usage) {
      if (typeof usage.input_tokens === 'number') used.input = usage.input_tokens;
      if (typeof usage.cache_creation_input_tokens === 'number') used.cacheWrite = usage.cache_creation_input_tokens;
      if (typeof usage.cache_read_input_tokens === 'number') used.cacheRead = usage.cache_read_input_tokens;
      if (typeof usage.output_tokens === 'number') used.output = usage.output_tokens;
      if (event.type === 'message_delta') counted = true;
    }
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      written += d.type === 'text_delta' ? d.text.length : d.type === 'input_json_delta' ? d.partial_json.length : d.type === 'thinking_delta' ? d.thinking.length : 0;
    }
  };
  const bill = () => {
    // Cut off before the count came: what was written, at three characters a token.
    if (!counted) used.output = Math.max(used.output, Math.ceil(written / 3));
    return settle(costOf(model, used));
  };

  const encoder = new TextEncoder();
  const frame = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let finish!: () => void;
  // The count is settled even if the app goes away before the answer ends.
  ctx.waitUntil(new Promise<void>((done) => (finish = done)));
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          note(event);
          controller.enqueue(frame(event.type, event));
        }
      } catch (e) {
        if (!upstream.signal.aborted) {
          console.error('The assistant’s answer broke off', e instanceof Error ? e.name : typeof e);
          try {
            controller.enqueue(frame('error', { type: 'error', error: { type: 'api_error', message: 'The answer broke off. Try again.' } }));
          } catch {
            /* the app has gone */
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        await bill().catch((e) => console.error('Could not count an answer', e instanceof Error ? e.name : typeof e));
        finish();
      }
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

/** What the app is told when Claude turned the request away. Nothing about the owner's account is passed on. */
function upstreamRefusal(e: unknown): Response {
  if (e instanceof Anthropic.BadRequestError) return refuse(400, 'invalid_request_error', 'bad', 'The model could not take that request.');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    console.error('The assistant’s key was refused');
    return refuse(503, 'api_error', 'off', 'The assistant is not set up on this server.');
  }
  if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && typeof e.status === 'number' && e.status >= 500)) {
    return refuse(503, 'overloaded_error', 'busy', 'The assistant is busy. Try again in a moment.', { 'Retry-After': '20' });
  }
  console.error('Could not reach the model', e instanceof Error ? e.name : typeof e);
  return refuse(503, 'api_error', 'busy', 'The assistant could not be reached. Try again in a moment.', { 'Retry-After': '20' });
}
