/**
 * Deleting an account, the part that lives here.
 *
 *   DELETE /account   stops Pro renewing, removes the synced copy, forgets the assistant's counts
 *
 * The app calls this first, then deletes the profile (Supabase) and the
 * sign-in itself (Clerk), which only it can do. So this must be safe to run
 * twice, and it must finish or change nothing that matters: Pro is stopped
 * first, and if Polar can't be told, nothing else is touched, so nobody is
 * left paying for an account they can't get into.
 *
 * It can't be undone, so a sign-in alone is not enough: the token must say
 * the person proved it in the last few minutes (auth.ts, `freshPersonOf`).
 * The app asks for a code from their email just before. The synced copy goes
 * without its vault proof for the same reason: the owner is here, freshly
 * checked, and a computer that lost its key must still be able to leave.
 */

import { freshPersonOf, isLocal, listOf } from './auth';
import { stopRenewing, type BillingEnv } from './billing';
import { PolarError } from './plan';
import { vaultsIn } from './region';
import type { SyncEnv } from './sync';

export interface AccountEnv extends BillingEnv, SyncEnv {}

const json = (body: unknown, status: number) => Response.json(body, { status });

function corsFor(request: Request, env: AccountEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !listOf(env.APP_ORIGINS).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Max-Age': '600',
  };
}

export async function handleAccount(request: Request, env: AccountEnv): Promise<Response> {
  let res: Response;
  try {
    res = await answer(request, env);
  } catch (e) {
    console.error('Deleting an account failed', e instanceof PolarError ? e.said : e instanceof Error ? e.name : typeof e);
    res = json({ error: 'unavailable' }, 502);
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  out.set('Vary', 'Origin');
  for (const [k, v] of Object.entries(corsFor(request, env))) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

/** Who is asking, and whether their sign-in was proved just now. */
async function asking(request: Request, env: AccountEnv): Promise<{ sub: string; fresh: boolean } | null> {
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return null;
  let who: { sub: string; fresh: boolean } | null;
  if (env.AUTH_MODE === 'test') {
    // Tests only, from this computer alone (the rule of sync.ts): `test.<uuid>` is that account, freshly checked;
    // `test.<uuid>.stale` is the same account signed in a while ago.
    const m = isLocal(request) ? /^test\.([0-9a-f-]{36})(\.stale)?$/.exec(token) : null;
    who = m ? { sub: m[1], fresh: !m[2] } : null;
  } else who = await freshPersonOf(token, env);
  // The id becomes part of an R2 path, so nothing that could pose as another prefix.
  return who && /^[A-Za-z0-9_-]{1,128}$/.test(who.sub) ? who : null;
}

async function answer(request: Request, env: AccountEnv): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (new URL(request.url).pathname !== '/account') return new Response(null, { status: 404 });
  if (request.method !== 'DELETE') return new Response(null, { status: 405, headers: { Allow: 'DELETE' } });

  const who = await asking(request, env);
  if (!who) return json({ error: 'signed-out' }, 401);
  if (!who.fresh) return json({ error: 'verify' }, 403);
  const { sub } = who;

  // 1. Nothing more is charged. If this fails, it stops here, with everything as it was.
  await stopRenewing(sub, env);
  // 2. The synced copy, wherever it is kept.
  const vaults = vaultsIn(env.VAULT, env.VAULT_JURISDICTION);
  await vaults.get(vaults.idFromName(sub)).purge(sub);
  // 3. What the assistant counted, and the plan it remembered.
  await env.BUDGET.get(env.BUDGET.idFromName(`account:${sub}`)).clear();
  return new Response(null, { status: 204 });
}
