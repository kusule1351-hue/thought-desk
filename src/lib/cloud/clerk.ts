/**
 * Signing in, with Clerk. Its library (clerk-js, without its sign-in screens)
 * runs right here, as in Clerk's Electron SDK: in "native" mode, without
 * cookies, the client token that keeps you signed in going to Clerk in an
 * Authorization header. That token is kept encrypted by Windows in the app's
 * own folder (secrets.rs), or in localStorage in the browser preview
 * (development). Until someone signs in on this computer, nothing is loaded
 * and Clerk hears nothing.
 *
 * Google and GitHub open in the system browser (Google refuses sign-in in an
 * app's own window) and come back to a listener on 127.0.0.1 (auth.rs). An
 * email code works entirely in here, and makes the account if it's new.
 */

import type { Clerk as ClerkJS } from '@clerk/clerk-js/no-rhc';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from '../api';
import { t } from '../i18n';
import { isDesktop } from '../platform';
import type { CloudUser, Provider } from './types';

/** Which Clerk instance: thoughtdesk.org's in releases, the development one
 *  while developing (supabase/SETUP.md), or VITE_CLERK_KEY's. Publishable
 *  keys are public by design. */
const CLERK_KEY =
  (import.meta.env.VITE_CLERK_KEY as string | undefined) ??
  (import.meta.env.DEV ? 'pk_test_c21pbGluZy1zdW5iaXJkLTM1NzEuY2xlcmsuYWNjb3VudHMuZGV2JA' : 'pk_live_Y2xlcmsudGhvdWdodGRlc2sub3JnJA');

/** Where the client token is kept (see secrets.rs). */
const KEY = 'thoughtdesk.clerk';
let token: string | null | undefined;

async function keptToken(): Promise<string | null> {
  if (token === undefined) token = isDesktop() ? await api.secretGet(KEY) : localStorage.getItem(KEY);
  return token;
}

async function keep(value: string | null) {
  if (value === token) return;
  token = value;
  if (isDesktop()) await (value === null ? api.secretRemove(KEY) : api.secretSet(KEY, value));
  else if (value === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, value);
}

const asUser = (u: ClerkJS['user']): CloudUser | null => (u ? { id: u.id, email: u.primaryEmailAddress?.emailAddress ?? null } : null);

const listeners = new Set<(user: CloudUser | null) => void>();
let loading: Promise<ClerkJS> | null = null;

/** Clerk, loaded on first use: two requests, for its settings and this computer's sign-in. */
function clerk(): Promise<ClerkJS> {
  return (loading ??= load().catch((e) => {
    loading = null;
    throw friendly(e);
  }));
}

async function load(): Promise<ClerkJS> {
  const { Clerk } = await import('@clerk/clerk-js/no-rhc');
  const c = new Clerk(CLERK_KEY);
  c.__internal_onBeforeRequest(async (request) => {
    request.credentials = 'omit';
    request.url?.searchParams.append('_is_native', '1');
    const kept = await keptToken();
    if (kept) {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${kept}`);
      request.headers = headers;
    }
  });
  // Clerk sends the client token back renewed, now and then.
  c.__internal_onAfterResponse(async (_request, response) => {
    const renewed = response?.headers.get('Authorization');
    if (renewed) await keep(renewed.replace(/^Bearer /, ''));
  });
  // Nowhere to navigate: everything happens in this window.
  const stay = () => {};
  await c.load({ standardBrowser: false, telemetry: false, routerPush: stay, routerReplace: stay });
  c.addListener(({ user }) => {
    const u = asUser(user);
    for (const cb of listeners) cb(u);
  });
  return c;
}

/** Clerk if someone has signed in on this computer, else null without loading it. */
async function clerkIfSignedIn(): Promise<ClerkJS | null> {
  return loading || (await keptToken()) ? clerk() : null;
}

/** Who's signed in on this computer, or null. */
export async function user(): Promise<CloudUser | null> {
  return asUser((await clerkIfSignedIn())?.user);
}

/** Called when someone signs in or out. Returns a function that stops it. */
export function onAuth(cb: (user: CloudUser | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Seconds until a token expires (0 if it can't be read). */
function secondsLeft(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp - Date.now() / 1000;
  } catch {
    return 0;
  }
}

/** A session token (they last a minute) with at least `minLeft` seconds to
 *  go, or null when signed out. */
export async function sessionToken(minLeft = 30): Promise<string | null> {
  const session = (await clerkIfSignedIn())?.session;
  if (!session) return null;
  try {
    const jwt = await session.getToken();
    return jwt && secondsLeft(jwt) < minLeft ? await session.getToken({ skipCache: true }) : jwt;
  } catch (e) {
    throw friendly(e);
  }
}

/** Codes Clerk sends back that only mean "new here: make the account". */
const TRANSFER = new Set(['external_account_not_found', 'external_account_exists']);

/** Finishes a Google or GitHub sign-in from what came back with the browser. */
async function finish(c: ClerkJS, back: URLSearchParams) {
  const failed = back.get('__clerk_error_code') ?? '';
  if (back.get('__clerk_status') === 'failed' && !TRANSFER.has(failed))
    throw new Error(failed === 'oauth_access_denied' ? t('social.cloud.signInCancelled') : t('social.cloud.signInUnfinished'));
  const signIn = c.client!.signIn;
  const nonce = back.get('rotating_token_nonce');
  await signIn.reload(nonce ? { rotatingTokenNonce: nonce } : undefined);
  let session = signIn.createdSessionId;
  if (signIn.firstFactorVerification.status === 'transferable') {
    // New here: the sign-in becomes a sign-up, with what Google or GitHub said.
    const signUp = await c.client!.signUp.create({ transfer: true });
    if (signUp.status !== 'complete') throw new Error(t('social.cloud.accountNotMadeOauth'));
    session = signUp.createdSessionId;
  }
  if (!session) throw new Error(t('social.cloud.signInUnfinished'));
  await c.setActive({ session });
}

let cancel: (() => void) | null = null;

/** Signs in with Google or GitHub in the browser; resolves once signed in. */
export async function signInWith(provider: Provider) {
  try {
    const c = await clerk();
    // The desktop listens on 127.0.0.1; the browser preview comes back to this page (finishRedirect).
    const port = isDesktop() ? await api.authListen().catch((e) => Promise.reject(new Error(String(e)))) : 0;
    const redirectUrl = port ? `http://127.0.0.1:${port}/auth/callback` : location.origin + location.pathname;
    const signIn = await c.client!.signIn.create({ strategy: `oauth_${provider}`, redirectUrl });
    const url = signIn.firstFactorVerification.externalVerificationRedirectURL;
    if (!url) throw new Error(t('social.cloud.signInNotStarted'));
    if (!port) {
      location.href = url.href;
      return new Promise<void>(() => {});
    }
    let stop: (() => void) | undefined;
    const back = new Promise<string>((resolve, reject) => {
      // A marker, never shown: the account sheet says nothing for it.
      cancel = () => reject(new Error('cancelled'));
      void listen<string>('auth-callback', (e) => resolve(e.payload)).then((unlisten) => (stop = unlisten));
    });
    try {
      await openUrl(url.href);
      await finish(c, new URLSearchParams(await back));
    } finally {
      stop?.();
      cancel = null;
    }
  } catch (e) {
    throw friendly(e);
  }
}

/** Stops waiting for a Google or GitHub sign-in. */
export function cancelSignIn() {
  cancel?.();
}

/** In a browser (development): finishes a Google or GitHub sign-in that came back to this page. */
export async function finishRedirect() {
  const back = new URLSearchParams(location.search);
  if (!back.has('rotating_token_nonce') && !back.has('__clerk_status')) return;
  history.replaceState(null, '', location.pathname);
  try {
    await finish(await clerk(), back);
  } catch (e) {
    throw friendly(e);
  }
}

/** Emails a 6-digit code (a new address gets an account once it's checked). */
export async function sendEmailCode(email: string) {
  try {
    const signIn = await (await clerk()).client!.signIn.create({ identifier: email, signUpIfMissing: true });
    const factor = signIn.supportedFirstFactors?.find((f) => f.strategy === 'email_code');
    if (!factor || !('emailAddressId' in factor)) throw new Error(t('social.cloud.emailUnavailable'));
    await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
  } catch (e) {
    throw friendly(e);
  }
}

export async function verifyEmailCode(code: string) {
  try {
    const c = await clerk();
    const signIn = c.client!.signIn;
    if (signIn.status !== 'needs_first_factor') throw new Error(t('social.cloud.askNewCode'));
    let session: string | null;
    try {
      session = (await signIn.attemptFirstFactor({ strategy: 'email_code', code })).createdSessionId;
    } catch (e) {
      if (codeOf(e) !== 'sign_up_if_missing_transfer') throw e;
      // New here: the code checked the address, so the sign-in becomes a sign-up.
      const signUp = await c.client!.signUp.create({ transfer: true });
      if (signUp.status !== 'complete') throw new Error(t('social.cloud.accountNotMadeEmail'));
      session = signUp.createdSessionId;
    }
    if (!session) throw new Error(t('social.cloud.signInUnfinished'));
    await c.setActive({ session });
  } catch (e) {
    throw friendly(e);
  }
}

/** Signs out on this computer, and forgets the client token, so Clerk hears
 *  nothing more until someone signs in again. */
export async function signOut() {
  try {
    if (loading) await (await clerk()).signOut();
  } catch (e) {
    console.warn('Clerk: could not end the session', e);
  } finally {
    await keep(null);
  }
}

/** The first Clerk error code in `e`, if any. */
function codeOf(e: unknown): string {
  const errors = (e as { errors?: { code?: string }[] } | null)?.errors;
  return errors?.[0]?.code ?? (e as { code?: string } | null)?.code ?? '';
}

/** An error as something to show people. */
export function friendly(e: unknown): Error {
  const first = (e as { errors?: { message?: string; longMessage?: string }[] } | null)?.errors?.[0];
  const code = codeOf(e);
  const message = e instanceof Error ? e.message : String(e);
  if (code === 'form_code_incorrect') return new Error(t('social.cloud.codeWrong'));
  if (code === 'verification_expired') return new Error(t('social.cloud.codeExpired'));
  if (code === 'verification_failed') return new Error(t('social.cloud.tooManyCodes'));
  if (code === 'too_many_requests' || (e as { status?: number } | null)?.status === 429) return new Error(t('social.cloud.tooManyTries'));
  if (code === 'form_param_format_invalid' || code === 'form_identifier_invalid') return new Error(t('social.cloud.notEmail'));
  if (code === 'native_api_disabled' || code.startsWith('origin_')) {
    console.warn('Clerk refused this app:', code);
    return new Error(t('social.cloud.notSetUp'));
  }
  if (code === 'clerk_offline' || code === 'network_error' || e instanceof TypeError || /failed to fetch|network/i.test(message))
    return new Error(t('social.cloud.signInOffline'));
  // Anything else: Clerk's own explanation, or the error's, as it comes.
  if (first) return new Error(first.longMessage || first.message || t('social.cloud.somethingWrong'));
  return e instanceof Error ? e : new Error(message || t('social.cloud.somethingWrong'));
}
