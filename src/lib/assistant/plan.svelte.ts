/**
 * The account's plan: free, or Pro. Polar sells Pro and the app's server knows
 * who has it (server/src/billing.ts); this asks the server, and sends the
 * person to Polar's pages to pay or to manage what they pay for. Those pages
 * open in the browser: nothing about a card passes through the app.
 *
 * After a visit to Polar the plan is looked at again when the app comes back
 * into view, and for a while after, since a payment takes a moment to land.
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { account } from '../account.svelte';
import { isDesktop } from '../platform';
import { base, token } from './client';

export const plan = $state({
  /** There is something to buy on this server. */
  on: false,
  pro: false,
  /** When what is paid for ends or renews (ISO), if known. */
  until: null as string | null,
  /** Cancelled: Pro until `until`, then not. */
  ending: false,
  /** A page at Polar is being opened. */
  busy: false,
});

/** How long after a visit to Polar the plan is looked at again, and how often. */
const WATCH = 10 * 60 * 1000;
const EVERY = 5000;
let watching: ReturnType<typeof setInterval> | null = null;
let watchUntil = 0;

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base()}/billing${path}`, { ...init, headers: { Authorization: `Bearer ${await token()}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
}

/** Looks the plan up. `fresh` has the server ask Polar now. Quietly keeps what it had if it can't be asked. */
export async function refreshPlan(fresh = false): Promise<void> {
  if (!account.signedIn) {
    Object.assign(plan, { on: false, pro: false, until: null, ending: false });
    return;
  }
  try {
    const res = await call(`/plan${fresh ? '?fresh=1' : ''}`);
    if (!res.ok) return;
    const said = (await res.json()) as { on?: unknown; plan?: unknown; until?: unknown; ending?: unknown };
    Object.assign(plan, { on: said.on === true, pro: said.plan === 'pro', until: typeof said.until === 'string' ? said.until : null, ending: said.ending === true });
  } catch {
    /* offline, or signed out meanwhile */
  }
}

function open(url: string) {
  // Only Polar's own pages are opened, whatever the server said.
  if (!/^https:\/\/([a-z0-9-]+\.)*polar\.sh\//.test(url)) throw new Error('Not a Polar page');
  return isDesktop() ? openUrl(url) : void window.open(url, '_blank', 'noopener');
}

/** Looks again for a while: the person is at Polar, and what they do there shows up here. */
function watch() {
  watchUntil = Date.now() + WATCH;
  watching ??= setInterval(() => {
    if (Date.now() > watchUntil) {
      clearInterval(watching!);
      watching = null;
      return;
    }
    if (document.visibilityState === 'visible') void refreshPlan(true);
  }, EVERY);
}

/** Why a visit to Polar could not start. */
export type PlanError = 'already' | 'none' | 'failed';

async function visit(path: '/checkout' | '/portal', body?: unknown): Promise<PlanError | null> {
  if (plan.busy) return null;
  plan.busy = true;
  try {
    const res = await call(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const said = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!res.ok || typeof said.url !== 'string') {
      if (said.error === 'already') void refreshPlan(true);
      return said.error === 'already' || said.error === 'none' ? said.error : 'failed';
    }
    await open(said.url);
    watch();
    return null;
  } catch {
    return 'failed';
  } finally {
    plan.busy = false;
  }
}

/** Opens Polar's checkout for Pro, for this account. */
export const upgrade = () => visit('/checkout', { email: account.user?.email ?? undefined });
/** Opens Polar's page for managing or cancelling what this account pays for. */
export const manage = () => visit('/portal');
