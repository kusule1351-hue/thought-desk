/**
 * What the mailbox accepts, checked strictly: everything in a request is
 * hostile until it passes here. The Vault (vault.ts) only ever sees what
 * these functions let through.
 */

export const MAX_ITEMS = 1000;
/** One item's data: over 64 KB should be a blob, but up to the Durable Object's 2 MB value limit is taken. */
export const MAX_DATA = 2 * 1024 * 1024;
/** A push is at most about 4 MiB of items (anything over 64 KB goes up as a blob), so this leaves room and no more. */
export const MAX_BODY = 6 * 1024 * 1024;
/** A file chunk is 8 MiB, plus its envelope. */
export const MAX_BLOB = 9 * 1024 * 1024;

export type Kind = 'r' | 'y' | 's';

export interface Item {
  key: string;
  kind: Kind;
  data?: Uint8Array;
  blob?: string;
  /** `r`: the seq the key must have now. */
  base?: number;
  /** `y`: refused if the key has any items. */
  first: boolean;
  /** `s`: the newest seq it replaces. */
  upto: number;
}

/** The request was wrong (400). */
export class BadRequest extends Error {}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
export const BLOB_NAME = /^[0-9a-f]{32}$/;
/** 32 bytes as base64url. */
export const PROOF = /^[A-Za-z0-9_-]{43}$/;

export function decode(s: string): Uint8Array {
  if (!BASE64URL.test(s) || s.length % 4 === 1) throw new BadRequest('data is not base64url');
  const binary = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function seqOf(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new BadRequest(`${what} is not a sequence number`);
  return x;
}

function parseItem(raw: unknown): Item {
  if (!isObject(raw)) throw new BadRequest('An item is not an object');
  const { key, kind, data, blob, base, first, upto } = raw;
  if (typeof key !== 'string' || !KEY.test(key)) throw new BadRequest('Bad key');
  if (kind !== 'r' && kind !== 'y' && kind !== 's') throw new BadRequest('Bad kind');
  if ((data === undefined) === (blob === undefined)) throw new BadRequest('An item has data or a blob, not both');
  const item: Item = { key, kind, first: false, upto: 0 };
  if (data !== undefined) {
    // Checked before decoding, so a huge string never costs a decode.
    if (typeof data !== 'string' || data.length === 0 || data.length > Math.ceil((MAX_DATA * 4) / 3)) throw new BadRequest('Bad data');
    item.data = decode(data);
    if (item.data.length > MAX_DATA) throw new BadRequest('Data too big');
  } else {
    if (typeof blob !== 'string' || !BLOB_NAME.test(blob)) throw new BadRequest('Bad blob name');
    item.blob = blob;
  }
  if (base !== undefined) item.base = seqOf(base, 'base');
  if (first !== undefined && typeof first !== 'boolean') throw new BadRequest('first is not true or false');
  if (upto !== undefined) item.upto = seqOf(upto, 'upto');
  if (kind === 'r' && item.base === undefined) throw new BadRequest('A record needs its base');
  item.first = kind === 'y' && first === true;
  if (kind !== 's') item.upto = 0;
  return item;
}

/** The items of a push body, or a BadRequest. */
export function parsePush(body: unknown): Item[] {
  if (!isObject(body) || !Array.isArray(body.items)) throw new BadRequest('Expected { items: [...] }');
  if (body.items.length > MAX_ITEMS) throw new BadRequest('Too many items');
  const items = body.items.map(parseItem);
  // Two writes to one record, or two "first" for one text, in one push can't both be right.
  const seen = new Set<string>();
  for (const item of items) {
    const once = item.kind === 'r' ? `r/${item.key}` : item.first ? `first/${item.key}` : null;
    if (once && seen.has(once)) throw new BadRequest('The same key twice in one push');
    if (once) seen.add(once);
  }
  return items;
}

/** The body of `PUT /sync/key`. */
export function parseKey(body: unknown): { wrappedKey: string; proof: string } {
  const { wrappedKey, proof } = isObject(body) ? body : ({} as Record<string, unknown>);
  if (typeof wrappedKey !== 'string' || wrappedKey.length < 1 || wrappedKey.length > 4096) throw new BadRequest('Bad wrappedKey');
  if (typeof proof !== 'string' || !PROOF.test(proof) || decode(proof).length !== 32 || encode(decode(proof).buffer as ArrayBuffer) !== proof) throw new BadRequest('Bad proof');
  return { wrappedKey, proof };
}

/** The declared Content-Length, or null if it's missing or not a plain number. */
export function contentLength(request: Request): number | null {
  const declared = request.headers.get('content-length');
  return declared !== null && /^\d{1,15}$/.test(declared) ? Number(declared) : null;
}

/** An integer query parameter, or `fallback` when it's absent. */
export function numberParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const n = /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw new BadRequest('Bad number in the query');
  return n;
}

/** The whole text of a request body, refusing more than `max` bytes however it's sent. */
export async function readText(request: Request, max: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) throw new BadRequest('Body too big');
  if (!request.body) throw new BadRequest('Body missing');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new BadRequest('Body too big');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    throw new BadRequest('Body is not text');
  }
}
