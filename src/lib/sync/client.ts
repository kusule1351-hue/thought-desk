/**
 * The mailbox over `fetch` (docs/sync.md, Mailbox API). It knows nothing of
 * what the items are: the engine hands it sealed items and gets answers back.
 * Big items travel as blobs, and the server's clock is compared with ours.
 *
 * Every call takes a `Call`: a signal that cancels it (one per epoch of the
 * engine, so stopping stops what is in flight) and, for calls that change or
 * delete, the vault proof (docs/sync.md, Vault proof).
 */

import { cloud } from '../cloud';
import { decodedSize, fromB64, toB64 } from './bytes';

/** The server's address: VITE_COWORK_URL, a local one while developing, the
 *  one a test sets (`window.__syncUrl`, with its scheme, development builds only), or ours. */
function base(): { http: string; ws: string } {
  const test = import.meta.env.DEV ? (window as { __syncUrl?: string }).__syncUrl : undefined;
  if (test) {
    const http = test.replace(/\/$/, '');
    return { http, ws: http.replace(/^http/, 'ws') };
  }
  const host = ((import.meta.env.VITE_COWORK_URL as string | undefined) ?? (import.meta.env.DEV ? 'localhost:8787' : 'relay.thoughtdesk.org')).replace(/^\w+:\/\//, '').replace(/\/$/, '');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  return { http: `${local ? 'http' : 'https'}://${host}`, ws: `${local ? 'ws' : 'wss'}://${host}` };
}

/** The subprotocol the server picks; the sign-in rides as the second one. */
const PROTOCOL = 'thoughtdesk';
/** Items whose data is bigger than this go up as blobs first (Durable Object storage costs far more than R2's). */
export const BLOB_OVER = 64 * 1024;
/** More than this off the server's clock and syncing stops (a wrong clock wins every merge). */
export const MAX_SKEW = 10 * 60_000;
/** The most blob bytes held in memory for one pull; the rest comes in the next round. */
export const MAX_PULL_BLOBS = 16 * 1024 * 1024;
/** The only shape a blob's name has. */
const BLOB_NAME = /^[0-9a-f]{32}$/;

/** No network, or the server can't be reached. */
export class Offline extends Error {}
/** The server answered, but not with what a working mailbox says. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
/** Not signed in (or the sign-in was refused). */
export class SignedOut extends Error {}
/** The request was cancelled because sync was stopped. */
export class Aborted extends Error {}
/** The vault proof isn't the one of the synced copy that is there now: this computer's copy was replaced. */
export class ProofRefused extends Error {}
/** The synced copy was deleted: there is no vault to write to. */
export class NoVault extends Error {}
/** Sync is not open to this account yet (the relay's list of testers). */
export class SyncClosed extends Error {}
/** This computer's clock is far from the server's. */
export class ClockOff extends Error {
  constructor(readonly skewMs: number) {
    super('The clock is off');
  }
}
/** Too many pushes a minute, and the wait is still on. */
export class RateLimited extends Error {
  constructor(readonly seconds: number) {
    super('Slow down');
  }
}

/** What a call needs besides its arguments: a way to cancel it, and the vault proof for calls that change or delete. */
export interface Call {
  signal?: AbortSignal;
  proof?: string;
}

export interface Info {
  seq: number;
  used: number;
  limit: number;
  wrappedKey: string | null;
  /** When the key was set (ms), if the relay says. */
  keySetAt?: number | null;
  /** Nothing in it but its key: it can be deleted without the recovery key. */
  empty?: boolean;
  format: number;
}

/** An item as it goes up: `data` (base64url) or, for a big one, `blob` and `size`. */
export interface Item {
  key: string;
  kind: 'r' | 'y' | 's';
  data?: string;
  blob?: string;
  size?: number;
  base?: number;
  first?: boolean;
  upto?: number;
}

/** A key a push was refused for, with the seq that key has on the server now. */
export interface Conflict {
  key: string;
  seq: number;
}

export type PushAnswer = { ok: true; results: { key: string; seq: number }[]; used: number; limit: number } | { conflict: Conflict[] } | { full: true; used: number; limit: number };

export interface Pulled {
  items: { seq: number; key: string; kind: string; data: string }[];
  seq: number;
  more: boolean;
}

/** The server's clock minus ours, from its last answer (null until it has sent one we could read). */
let skew: number | null = null;
export const clockSkew = () => skew;

async function token(): Promise<string> {
  let jwt: string | null;
  try {
    jwt = await (await cloud()).accessToken();
  } catch (e) {
    // Offline, Clerk can't be reached: the same as the mailbox being away.
    throw new Offline(String(e));
  }
  if (!jwt) throw new SignedOut('Not signed in');
  return jwt;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => (done(), reject(new Aborted()));
    const timer = setTimeout(() => (done(), resolve()), ms);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });

/** A refusal's JSON body (an empty object when it has none). The response stays readable. */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.clone().json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One request; network failures are Offline, a bad clock is ClockOff. The answer is checked by the caller. */
async function send(method: string, path: string, body?: BodyInit | null, headers: Record<string, string> = {}, call: Call = {}): Promise<Response> {
  const { signal } = call;
  if (signal?.aborted) throw new Aborted();
  const auth = await token();
  if (signal?.aborted) throw new Aborted();
  const sent: Record<string, string> = { Authorization: `Bearer ${auth}`, ...headers };
  if (call.proof) sent['X-Vault-Proof'] = call.proof;
  let res: Response;
  try {
    res = await fetch(base().http + '/sync' + path, { method, body, headers: sent, cache: 'no-store', signal });
  } catch (e) {
    if (signal?.aborted) throw new Aborted();
    throw new Offline(String(e));
  }
  // The server's `Date` is only readable across origins when it is exposed; if not, it's unknown, never a reason to stop.
  const date = res.headers.get('Date');
  const theirs = date ? Date.parse(date) : NaN;
  if (Number.isFinite(theirs)) {
    skew = theirs - Date.now();
    if (Math.abs(skew) > MAX_SKEW) throw new ClockOff(skew);
  }
  // `403 { proof: false }`: the proof belongs to another copy. `403 { closed: true }`: sync is not open to
  // this account yet. Any other 401/403: the sign-in.
  const refused = res.status === 403 ? await bodyOf(res) : {};
  if (refused.proof === false) throw new ProofRefused('The vault proof was refused');
  if (refused.closed === true) throw new SyncClosed('Sync is not open to this account');
  if (res.status === 401 || res.status === 403) throw new SignedOut('The sign-in was refused');
  if (res.status === 409 && (await bodyOf(res)).noVault === true) throw new NoVault('The synced copy is gone');
  return res;
}

/** The body of a refusal that carries numbers (413 says how full the account is). */
async function numbers(res: Response): Promise<{ used: number; limit: number }> {
  const body = (await res.json().catch(() => ({}))) as { used?: number; limit?: number };
  return { used: Number(body.used) || 0, limit: Number(body.limit) || 0 };
}

/** A 429 on any call: the wait the relay asks for. */
function tooMany(res: Response) {
  if (res.status === 429) throw new RateLimited(Math.min(60, Math.max(1, Number(res.headers.get('Retry-After')) || 5)));
}

async function json<T>(res: Response): Promise<T> {
  tooMany(res);
  if (!res.ok) throw new ServerError(`Sync answered ${res.status}`, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ServerError('Sync answered something unreadable', res.status);
  }
}

export async function info(call: Call = {}): Promise<Info> {
  return json<Info>(await send('GET', '/info', undefined, {}, call));
}

/**
 * Stores the wrapped vault key and the proof that goes with it (the body carries
 * the proof here: this call creates the vault). False if one is already set (it's set once).
 */
export async function setKey(wrappedKey: string, proof: string, call: Call = {}): Promise<boolean> {
  const res = await send('PUT', '/key', JSON.stringify({ wrappedKey, proof }), { 'Content-Type': 'application/json' }, call);
  if (res.status === 409) return false;
  if (!res.ok) throw new ServerError(`Sync answered ${res.status}`, res.status);
  return true;
}

function randomName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Uploads a blob. Names are written once: `exists` means the name is taken (by an earlier try that got there, or by
 * an upload still being counted), which the caller must not take for "the bytes are there" without looking.
 */
export async function putBlob(name: string, bytes: Uint8Array, call: Call = {}): Promise<{ used: number; limit: number } | { full: true; used: number; limit: number } | { exists: true }> {
  const res = await send('PUT', `/blob/${name}`, bytes as BodyInit, { 'Content-Type': 'application/octet-stream' }, call);
  if (res.status === 413) return { full: true, ...(await numbers(res)) };
  if (res.status === 409) return { exists: true };
  return json(res);
}

export async function getBlob(name: string, call: Call = {}): Promise<Uint8Array> {
  if (!BLOB_NAME.test(name)) throw new ServerError('Sync sent a file name that is not one');
  const res = await send('GET', `/blob/${name}`, undefined, {}, call);
  tooMany(res);
  if (!res.ok) throw new ServerError(`Sync answered ${res.status} for a file`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteBlob(name: string, call: Call = {}): Promise<void> {
  const res = await send('DELETE', `/blob/${name}`, undefined, {}, call);
  tooMany(res);
  if (!res.ok && res.status !== 404) throw new ServerError(`Sync answered ${res.status}`, res.status);
}

/** Everything of this account in the mailbox, files included. */
export async function deleteAccount(call: Call = {}): Promise<void> {
  const res = await send('DELETE', '/account', undefined, {}, call);
  tooMany(res);
  if (!res.ok) throw new ServerError(`Sync answered ${res.status}`, res.status);
}

/** `[{ key, seq }]` from a 409; a bare key has no usable seq, so it is always a reason to pull. */
function conflictsOf(list: unknown): Conflict[] {
  if (!Array.isArray(list)) return [];
  const out: Conflict[] = [];
  for (const c of list) {
    if (typeof c === 'string') out.push({ key: c, seq: Infinity });
    else if (c && typeof (c as Conflict).key === 'string') out.push({ key: (c as Conflict).key, seq: Number.isInteger((c as Conflict).seq) ? (c as Conflict).seq : Infinity });
  }
  return out;
}

/** Sends items (all or nothing). Items over 64 KB go up as blobs first. Waits out a 429 once or twice. */
export async function push(items: Item[], call: Call = {}): Promise<PushAnswer> {
  const made: string[] = [];
  const sending: Item[] = [];
  // What was uploaded for a push that does not happen is taken back (best effort; the signal may be spent by then).
  const forget = () => Promise.all(made.splice(0).map((n) => deleteBlob(n, { proof: call.proof }).catch(() => {})));
  try {
    for (const item of items) {
      if (item.data !== undefined && decodedSize(item.data) > BLOB_OVER) {
        const name = randomName();
        const put = await putBlob(name, fromB64(item.data), call);
        // A random 128-bit name that is taken is a mailbox gone wrong, not a name to reuse.
        if ('exists' in put) throw new ServerError('Sync said a new file name was taken', 409);
        if ('full' in put) {
          await forget();
          return put;
        }
        made.push(name);
        const { data, ...rest } = item;
        sending.push({ ...rest, blob: name, size: decodedSize(data) });
      } else sending.push(item);
    }
    const body = JSON.stringify({ items: sending });
    for (let attempt = 0; ; attempt++) {
      const res = await send('POST', '/push', body, { 'Content-Type': 'application/json' }, call);
      if (res.status === 429) {
        const seconds = Math.min(60, Math.max(1, Number(res.headers.get('Retry-After')) || 5));
        if (attempt >= 2) throw new RateLimited(seconds);
        await sleep(seconds * 1000, call.signal);
        continue;
      }
      if (res.status === 409) {
        const answer = (await res.json().catch(() => ({}))) as { conflicts?: unknown };
        await forget();
        return { conflict: conflictsOf(answer.conflicts) };
      }
      if (res.status === 413) {
        const full = { full: true as const, ...(await numbers(res)) };
        await forget();
        return full;
      }
      const answer = await json<{ results: { key: string; seq: number }[]; used: number; limit: number }>(res);
      return { ok: true, ...answer };
    }
  } catch (e) {
    await forget();
    throw e;
  }
}

/** The items after `after`, with big ones fetched and inlined (up to `MAX_PULL_BLOBS`; then `more` is true and the rest is for the next round). */
export async function pull(after: number, limit = 1000, call: Call = {}): Promise<Pulled> {
  const got = await json<{ items: { seq: number; key: string; kind: string; data?: string; blob?: string }[]; seq: number; more: boolean }>(
    await send('GET', `/pull?after=${after}&limit=${limit}`, undefined, {}, call),
  );
  if (!Array.isArray(got.items)) throw new ServerError('Sync answered something unreadable');
  const items: Pulled['items'] = [];
  let held = 0;
  let more = !!got.more;
  for (const item of got.items) {
    let data = item.data ?? '';
    if (item.data === undefined && item.blob !== undefined) {
      if (!BLOB_NAME.test(String(item.blob))) throw new ServerError('Sync sent a file name that is not one');
      if (items.length && held >= MAX_PULL_BLOBS) {
        more = true;
        break;
      }
      const bytes = await getBlob(item.blob, call);
      held += bytes.length;
      data = toB64(bytes);
    }
    items.push({ seq: item.seq, key: item.key, kind: item.kind, data });
  }
  return { items, seq: got.seq, more };
}

/**
 * Tells `onSeq` when the mailbox has something new, over a WebSocket that
 * reconnects (with a longer wait each time it fails). Returns the way to stop.
 * Tests can switch it off with `window.__syncNoLive` (development builds only).
 */
export function live(onSeq: (seq: number) => void): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;
  const retry = () => {
    if (stopped) return;
    failures++;
    timer = setTimeout(() => void connect(), Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
  };
  async function connect() {
    if (stopped || (import.meta.env.DEV && (window as { __syncNoLive?: boolean }).__syncNoLive) || !navigator.onLine) return retry();
    let auth: string;
    try {
      auth = await token();
    } catch {
      return retry();
    }
    if (stopped) return;
    const ws = new WebSocket(base().ws + '/sync/live', [PROTOCOL, auth]);
    socket = ws;
    ws.onopen = () => (failures = 0);
    ws.onmessage = (e) => {
      try {
        const seq = (JSON.parse(String(e.data)) as { seq?: unknown }).seq;
        if (typeof seq === 'number') onSeq(seq);
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        retry();
      }
    };
    ws.onerror = () => ws.close();
  }
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    const ws = socket;
    socket = null;
    ws?.close();
  };
}
