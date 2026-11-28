/**
 * Which plan an account is on. Polar sells Pro for us (it is the merchant of
 * record) and knows who has paid; this asks it, by the account's own id (the
 * Clerk user id, which a checkout started here carries as the customer's
 * "external id"), and keeps the answer beside the account's allowance
 * (budget.ts) so the assistant doesn't ask Polar on every question.
 *
 * What is kept is refreshed three ways: Polar tells us when something changes
 * (billing.ts), the app asks for a fresh look when the person comes back from
 * paying, and an answer older than a few hours is asked for again. So a
 * missed notice only delays a change, it never loses one.
 *
 * Without Polar's key (POLAR_ACCESS_TOKEN) there are no plans: everyone is on
 * the free one and nothing is asked of anyone.
 */

import { listOf, type AuthEnv } from './auth';
import type { Budget, Kept } from './budget';

export interface PlanEnv extends AuthEnv {
  BUDGET: DurableObjectNamespace<Budget>;
  /** Polar's key for our organisation (`npx wrangler secret put POLAR_ACCESS_TOKEN`). Without it there is nothing to buy. */
  POLAR_ACCESS_TOKEN?: string;
  /** Polar's API: https://api.polar.sh, or https://sandbox-api.polar.sh while developing. */
  POLAR_API?: string;
  /** The ids of the Polar products that are Pro, comma-separated (a monthly one, later a yearly one). */
  POLAR_PRO_PRODUCTS?: string;
}

export interface Plan {
  pro: boolean;
  /** When what is paid for ends or renews (milliseconds), if Polar said. */
  until: number | null;
  /** Cancelled: Pro until `until`, then not. */
  ending: boolean;
}

export const FREE: Plan = { pro: false, until: null, ending: false };

/** How old an answer may be before Polar is asked again. */
const STALE = 6 * 60 * 60 * 1000;
/** Past the paid-for date, it is asked again this often: a renewal is usually minutes late, not hours. */
const LAPSED = 10 * 60 * 1000;
/** A fresh look (the app asks for one after a payment) at most this often. */
const FRESH = 10 * 1000;
/** A renewal that hasn't shown up yet doesn't take Pro away for this long. */
const GRACE = 2 * 24 * 60 * 60 * 1000;
const TIMEOUT = 8000;

export const proProducts = (env: PlanEnv) => listOf(env.POLAR_PRO_PRODUCTS);
/** Whether there is anything to buy on this server. */
export const billingOn = (env: PlanEnv) => !!env.POLAR_ACCESS_TOKEN && proProducts(env).length > 0;

const base = (env: PlanEnv) => (env.POLAR_API || 'https://api.polar.sh').replace(/\/$/, '');

export class PolarError extends Error {
  /**
   * `code`: Polar's own short name for what went wrong ("insufficient_scope", "Unauthorized"), when it gave one.
   * Only that name is kept: the rest of its answer can quote what was sent, and nothing of that is logged.
   */
  constructor(
    readonly status: number,
    readonly code = '',
  ) {
    super(`Polar answered ${status}${code ? ` (${code})` : ''}`);
  }
  /** For the log: the status, and Polar's name for it. */
  get said(): string {
    return this.code ? `${this.status} ${this.code}` : String(this.status);
  }
}

/** Polar's short name for an error, from its answer: a plain word or two, or nothing. */
async function codeOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const name = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_ -]{0,48}$/.test(name) ? name : '';
  } catch {
    return '';
  }
}

/**
 * One request to Polar, as us, or (`as`) as one customer, with the short-lived token of a session Polar made for
 * them. A 404 is `null` (no such customer); anything else that isn't a success throws.
 */
export async function polar<T>(env: PlanEnv, path: string, init: { method?: string; body?: unknown; as?: string } = {}): Promise<T | null> {
  const res = await fetch(base(env) + path, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${init.as ?? env.POLAR_ACCESS_TOKEN}`, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new PolarError(res.status, await codeOf(res));
  return (await res.json()) as T;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown) => {
  const at = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** The running subscriptions to a Pro product in what Polar says of a customer, as Polar gives them. */
export function proSubscriptions(state: unknown, env: PlanEnv): Json[] {
  const subscriptions = isObject(state) && Array.isArray(state.active_subscriptions) ? state.active_subscriptions : [];
  const ours = new Set(proProducts(env));
  return subscriptions.filter((s): s is Json => isObject(s) && typeof s.product_id === 'string' && ours.has(s.product_id) && (s.status === 'active' || s.status === 'trialing'));
}

/**
 * The plan in what Polar says of a customer (its "customer state", from the
 * API or in a notice): Pro if one of their running subscriptions is for a Pro
 * product. Polar lists only subscriptions that are active or in a trial.
 */
export function planIn(state: unknown, env: PlanEnv): Plan {
  let best: Plan | null = null;
  for (const s of proSubscriptions(state, env)) {
    const plan: Plan = { pro: true, until: time(s.ends_at) ?? time(s.current_period_end), ending: s.cancel_at_period_end === true };
    // Two at once (a mistake, or a yearly bought over a monthly): the one that runs longest counts.
    if (!best || (plan.until ?? Infinity) > (best.until ?? Infinity)) best = plan;
  }
  return best ?? FREE;
}

/** What a kept answer is worth now: Pro lasts to its date, and a little past it while a renewal catches up. */
const worth = (kept: Kept, now: number): Plan => (kept.pro && (kept.until === null || now < kept.until + GRACE) ? { pro: true, until: kept.until, ending: kept.ending } : FREE);

const boxOf = (env: PlanEnv, sub: string) => env.BUDGET.get(env.BUDGET.idFromName(`account:${sub}`));

/** The account's plan. `fresh` asks Polar unless it was asked seconds ago. */
export async function planOf(sub: string, env: PlanEnv, { fresh = false, now = Date.now() } = {}): Promise<Plan> {
  if (!billingOn(env)) return FREE;
  const box = boxOf(env, sub);
  const kept = await box.plan();
  if (kept) {
    const lapsed = kept.pro && kept.until !== null && now > kept.until;
    if (now - kept.checked < (fresh ? FRESH : lapsed ? LAPSED : STALE)) return worth(kept, now);
  }
  try {
    const plan = planIn(await polar(env, `/v1/customers/external/${encodeURIComponent(sub)}/state`), env);
    return worth(await box.setPlan(plan.pro, plan.until, plan.ending, now), now);
  } catch (e) {
    // Polar can't be reached: what was known stands, and it is asked again next time.
    console.error('Could not ask Polar for a plan', e instanceof PolarError ? e.said : e instanceof Error ? e.name : typeof e);
    return kept ? worth(kept, now) : FREE;
  }
}

/** Polar said what this account has now. */
export async function keepPlan(sub: string, state: unknown, env: PlanEnv, now = Date.now()): Promise<void> {
  const plan = planIn(state, env);
  await boxOf(env, sub).setPlan(plan.pro, plan.until, plan.ending, now);
}

/** Something about this account changed at Polar: the next look asks it again. */
export async function forgetPlan(sub: string, env: PlanEnv): Promise<void> {
  await boxOf(env, sub).stalePlan();
}
