/**
 * Paying for Pro. Polar (polar.sh) sells it for us as the merchant of record:
 * it shows the checkout, takes the card, handles tax and refunds, and tells us
 * who has paid. Nothing about a card ever comes here.
 *
 *   GET  /billing/plan      the signed-in account's plan (`?fresh=1` asks Polar now)
 *   POST /billing/checkout  a checkout page for this account, at Polar
 *   POST /billing/portal    Polar's page for managing or cancelling, already signed in
 *   POST /billing/polar     Polar's notices (signed by Polar, not by an account)
 *
 * A checkout started here carries the account's id, so the payment belongs to
 * the account whatever email is typed at Polar. What each plan gets is decided
 * where it is used (assistant.ts reads the plan for the month's allowance).
 *
 * Off until POLAR_ACCESS_TOKEN is set, and closed to the same accounts the
 * assistant is closed to (ASSISTANT_ACCESS), since the assistant is what Pro
 * is for.
 */

import { mayUseAssistant, type AssistantEnv } from './assistant';
import { listOf } from './auth';
import { BadRequest, readText } from './mailbox';
import { billingOn, forgetPlan, keepPlan, planOf, polar, PolarError, proProducts, type Plan, type PlanEnv } from './plan';
import { accountOf } from './sync';

export interface BillingEnv extends PlanEnv, AssistantEnv {
  /** The secret Polar signs its notices with (`npx wrangler secret put POLAR_WEBHOOK_SECRET`). Without it notices are refused. */
  POLAR_WEBHOOK_SECRET?: string;
  /** Where Polar sends someone after they have paid. */
  BILLING_RETURN_URL?: string;
}

const RETURN_URL = 'https://thoughtdesk.org/pro/welcome';
/** The biggest notice read (Polar's are a few kilobytes). */
const MAX_NOTICE = 256 * 1024;
/** How far a notice's time may be from ours, in seconds, before it is taken for a replay. */
const TOLERANCE = 5 * 60;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** Why a request was turned away, for the app. */
const refuse = (status: number, error: 'signed-out' | 'closed' | 'off' | 'already' | 'none' | 'bad' | 'unavailable') => json({ error }, status);

function corsFor(request: Request, env: BillingEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !listOf(env.APP_ORIGINS).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

const said = (plan: Plan, env: BillingEnv) => ({ on: billingOn(env), plan: plan.pro ? 'pro' : 'free', until: plan.until === null ? null : new Date(plan.until).toISOString(), ending: plan.ending });

export async function handleBilling(request: Request, env: BillingEnv, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const route = new URL(request.url).pathname.slice('/billing'.length);
  // Polar's own requests: no account, no CORS, and an answer only Polar reads.
  if (route === '/polar') return notice(request, env, ctx);

  let res: Response;
  try {
    res = await answer(request, env, route);
  } catch (e) {
    if (e instanceof BadRequest) res = refuse(400, 'bad');
    else {
      console.error('Billing failed', e instanceof PolarError ? e.status : e instanceof Error ? e.name : typeof e);
      res = refuse(502, 'unavailable');
    }
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  out.set('Vary', 'Origin');
  for (const [k, v] of Object.entries(corsFor(request, env))) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

async function answer(request: Request, env: BillingEnv, route: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (route !== '/plan' && route !== '/checkout' && route !== '/portal') return new Response(null, { status: 404 });
  if (request.method !== (route === '/plan' ? 'GET' : 'POST')) return new Response(null, { status: 405 });

  const sub = await accountOf(request, env, false);
  if (!sub) return refuse(401, 'signed-out');
  if (!mayUseAssistant(sub, env)) return refuse(403, 'closed');

  if (route === '/plan') return json(said(await planOf(sub, env, { fresh: new URL(request.url).searchParams.get('fresh') === '1' }), env));
  if (!billingOn(env)) return refuse(503, 'off');

  if (route === '/checkout') {
    let email: string | undefined;
    const text = await readText(request, 2048).catch(() => '');
    if (text) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new BadRequest('Not JSON');
      }
      // Only a start for the form at Polar: the payment belongs to the account either way.
      if (isObject(body) && typeof body.email === 'string' && EMAIL.test(body.email)) email = body.email;
    }
    // Paying twice for one account helps nobody: a fresh look first.
    if ((await planOf(sub, env, { fresh: true })).pro) return refuse(409, 'already');
    const start = (withEmail: boolean) =>
      polar<{ url?: unknown }>(env, '/v1/checkouts/', {
        method: 'POST',
        body: {
          products: proProducts(env),
          external_customer_id: sub,
          success_url: env.BILLING_RETURN_URL || RETURN_URL,
          ...(withEmail ? { customer_email: email } : {}),
          // Polar would otherwise take this server for the customer, and guess the wrong country and tax.
          ...(request.headers.get('CF-Connecting-IP') ? { customer_ip_address: request.headers.get('CF-Connecting-IP') } : {}),
        },
      });
    let checkout: { url?: unknown } | null;
    try {
      checkout = await start(!!email);
    } catch (e) {
      // Polar turns away an address it thinks can't get mail. The email only fills in the form, so without it then.
      if (!email || !(e instanceof PolarError) || e.status !== 422) throw e;
      checkout = await start(false);
    }
    if (!checkout || typeof checkout.url !== 'string') return refuse(502, 'unavailable');
    return json({ url: checkout.url });
  }

  // The portal: only for someone Polar knows, which a customer becomes at their first checkout.
  try {
    const session = await polar<{ customer_portal_url?: unknown }>(env, '/v1/customer-sessions/', { method: 'POST', body: { external_customer_id: sub } });
    if (!session || typeof session.customer_portal_url !== 'string') return refuse(404, 'none');
    return json({ url: session.customer_portal_url });
  } catch (e) {
    // Polar answers "not valid" for an id it has no customer for.
    if (e instanceof PolarError && (e.status === 422 || e.status === 409)) return refuse(404, 'none');
    throw e;
  }
}

// ------------------------------------------------------------------ Polar's notices

const utf8 = new TextEncoder();
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Whether Polar signed this: Standard Webhooks (HMAC-SHA256 over
 * "id.timestamp.body", keyed with the bytes after `whsec_`). Secrets made
 * before September 2026 were keyed with the whole string instead, so that key
 * is tried too. The comparison is the platform's own, in constant time.
 */
export async function signedByPolar(secret: string, id: string | null, timestamp: string | null, signatures: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!secret || !id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE) return false;
  const keys: Uint8Array[] = [];
  try {
    keys.push(fromBase64(secret.replace(/^whsec_/, '')));
  } catch {
    /* not base64: only the older scheme can match */
  }
  keys.push(utf8.encode(secret));
  const given: Uint8Array[] = [];
  for (const part of signatures.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    try {
      given.push(fromBase64(value));
    } catch {
      /* not a signature */
    }
  }
  const data = utf8.encode(`${id}.${timestamp}.${body}`);
  for (const raw of keys) {
    if (!raw.length) continue;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const signature of given) if (await crypto.subtle.verify('HMAC', key, signature, data)) return true;
  }
  return false;
}

/**
 * A notice from Polar. `customer.state_changed` says everything the customer
 * has now, so it is kept as it is. Any other notice that names one of our
 * accounts only marks its plan out of date, and Polar is asked at the next
 * look. Everything signed is acknowledged, or Polar would send it again and
 * in the end switch the notices off.
 */
async function notice(request: Request, env: BillingEnv, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!env.POLAR_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  let text: string;
  try {
    text = await readText(request, MAX_NOTICE);
  } catch {
    return new Response(null, { status: 400 });
  }
  const h = request.headers;
  if (!(await signedByPolar(env.POLAR_WEBHOOK_SECRET, h.get('webhook-id'), h.get('webhook-timestamp'), h.get('webhook-signature'), text))) return new Response(null, { status: 403 });

  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return new Response(null, { status: 202 });
  }
  if (!isObject(event) || !isObject(event.data)) return new Response(null, { status: 202 });
  const data = event.data;
  const customer = isObject(data.customer) ? data.customer : null;
  const sub = event.type === 'customer.state_changed' ? data.external_id : (customer?.external_id ?? data.external_customer_id);
  if (typeof sub !== 'string' || !ACCOUNT.test(sub)) return new Response(null, { status: 202 });
  // Answered at once; the keeping finishes behind it (Polar waits ten seconds at most).
  ctx.waitUntil(
    (event.type === 'customer.state_changed' ? keepPlan(sub, data, env) : forgetPlan(sub, env)).catch((e) => console.error('Could not keep a plan', e instanceof Error ? e.name : typeof e)),
  );
  return new Response(null, { status: 202 });
}
