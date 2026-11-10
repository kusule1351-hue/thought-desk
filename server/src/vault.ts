/**
 * One account's mailbox (docs/sync.md, Mailbox API): numbered encrypted items
 * in Durable Object SQLite, big ones as blobs in R2 (a blob's bytes live in
 * R2, its name and size here). It can't read any of it. A push is one SQLite
 * transaction; `used` is a counter kept in step with every change in it.
 *
 * Bytes in R2 are counted before they exist and after they're gone: a blob
 * being uploaded or deleted is a *hold* (name, size, time) that `used`
 * already includes, so what R2 holds never exceeds what the quota counted.
 * A hold the Worker never finished (it was cut off) is dropped, with its
 * object, by the next call after an hour.
 */

import { DurableObject } from 'cloudflare:workers';
import { Hits, refilled, secondsFor, type Bucket } from './limits';
import { decode, encode, type Item, type Kind } from './mailbox';

export interface VaultEnv {
  SYNC_BLOBS: R2Bucket;
  /** The most one account may store, in bytes. */
  SYNC_LIMIT_BYTES: string | number;
}

/** A call that can't go ahead. */
export type Refusal =
  | { status: 429; retryAfter: number }
  /** No wrapped key is set (or the account is being deleted). */
  | { status: 409; noVault: true }
  | { status: 403; proof: false };

export type Pushed =
  | Refusal
  | { status: 200; seq: number; results: { key: string; seq: number }[]; used: number; limit: number }
  | { status: 409; conflicts: { key: string; seq: number }[] }
  | { status: 413; used: number; limit: number }
  | { status: 400 };

export interface Pulled {
  items: { seq: number; key: string; kind: Kind; data?: string; blob?: string }[];
  seq: number;
  more: boolean;
}

export type Reserved = Refusal | { status: 200; id: string } | { status: 409; exists: true } | { status: 413; used: number; limit: number };

export interface Committed {
  ok: boolean;
  used: number;
  limit: number;
}

/** What a call must show beyond the sign-in: the vault proof, and whether it's a push (the item bucket must not be empty). */
export interface Check {
  proof: string | null;
  push?: boolean;
}

interface Hold {
  name: string;
  id: string;
}

/** A pull stops at about this many bytes. */
const PAGE_BYTES = 4 * 1024 * 1024;
/** What every item costs besides its data and key, for the rows and index it takes. */
const ITEM_OVERHEAD = 256;
/** A hold older than this was abandoned. */
const HOLD_LIFE = 60 * 60_000;
/** Sockets are let go after this, and the app reconnects with a fresh sign-in. */
const SOCKET_LIFE = 15 * 60_000;
const MAX_SOCKETS = 10;

/** What an item adds to `used`: its data (a blob is counted when it's uploaded), the overhead and its key. */
const cost = (key: string, data = 0) => data + ITEM_OVERHEAD + key.length;

/** A call that can't go ahead; thrown inside the transaction so nothing is kept. */
class Refused {
  constructor(readonly answer: Pushed) {}
}

export const r2Key = (sub: string, name: string) => `v/${sub}/${name}`;

/** SHA-256 of a proof, or null if it isn't 32 bytes of base64url. */
async function proofHash(proof: string | null): Promise<Uint8Array | null> {
  if (!proof || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return null;
  const raw = decode(proof);
  // Only the canonical spelling: other spellings of the same bytes would be other proofs to a client that compares text.
  return raw.length === 32 && encode(raw.buffer as ArrayBuffer) === proof ? new Uint8Array(await crypto.subtle.digest('SHA-256', raw)) : null;
}

/** Whether two hashes are equal, in the same time whatever they hold. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class Vault extends DurableObject<VaultEnv> {
  #ready = false;
  #hits = new Hits();

  constructor(ctx: DurableObjectState, env: VaultEnv) {
    super(ctx, env);
    // An idle socket is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  get #limit() {
    return Number(this.env.SYNC_LIMIT_BYTES);
  }

  /** The storage, with the tables made (again, after the account was deleted). */
  get #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(`CREATE TABLE IF NOT EXISTS items (seq INTEGER PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, data BLOB, blob TEXT, size INTEGER NOT NULL)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS items_key ON items (key, kind)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS items_blob ON items (blob) WHERE blob IS NOT NULL`);
      sql.exec(`CREATE TABLE IF NOT EXISTS blobs (name TEXT PRIMARY KEY, size INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS holds (name TEXT PRIMARY KEY, id TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v)`);
      sql.exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0), ('used', 0)`);
      this.#ready = true;
    }
    return sql;
  }

  #get(k: string): SqlStorageValue | undefined {
    return this.#sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v;
  }

  #meta(k: string): number {
    return Number(this.#sql.exec(`SELECT v FROM meta WHERE k = ?`, k).one().v);
  }

  #setMeta(k: string, v: SqlStorageValue) {
    this.#sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, v);
  }

  info() {
    return {
      seq: this.#meta('seq'),
      used: this.#meta('used'),
      limit: this.#limit,
      wrappedKey: (this.#get('wrappedKey') as string | undefined) ?? null,
      keySetAt: (this.#get('keySetAt') as number | undefined) ?? null,
      empty: this.#empty(),
      format: 1,
    };
  }

  /** Nothing in it but (maybe) its key: no items, no blobs, nothing on its way. */
  #empty(): boolean {
    const any = (table: string) => this.#sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length > 0;
    return !any('items') && !any('blobs') && !any('holds');
  }

  // Who may do what

  /**
   * The first thing every call asks: is there room for it in this minute's
   * budget? For a call that changes something, `check` also asks for the vault
   * proof (and, for a push, a bucket that isn't empty), so a refused call is
   * turned away before its body is read.
   */
  async admit(weight: number, check?: Check): Promise<Refusal | null> {
    const wait = this.#hits.take(weight, Date.now());
    if (wait) return { status: 429, retryAfter: wait };
    if (!check) return null;
    const refused = this.#gate(await proofHash(check.proof));
    if (refused) return refused;
    if (check.push) {
      const wait = secondsFor(this.#bucket(Date.now()), 1);
      if (wait) return { status: 429, retryAfter: wait };
    }
    return null;
  }

  /**
   * Whether a call that changes something may go ahead: a vault exists (and isn't
   * being deleted), and `presented`, the hash of the caller's proof, is the one stored.
   * Synchronous, so a state read here is still true in the transaction that follows.
   * Deleting the account is allowed to resume a deletion that was cut off.
   */
  #gate(presented: Uint8Array | null, resuming = false): Refusal | null {
    if (this.#get('wrappedKey') === undefined || (this.#get('deleting') !== undefined && !resuming)) return { status: 409, noVault: true };
    const stored = this.#get('proof') as string | undefined;
    if (!presented || stored === undefined || !same(decode(stored), presented)) return { status: 403, proof: false };
    return null;
  }

  /** Sets the key that wraps the vault key, and the hash of its proof, once. False if a key was already set. */
  async setWrappedKey(wrappedKey: string, proof: string): Promise<boolean> {
    const hash = await proofHash(proof);
    if (!hash) return false;
    void this.#sql;
    return this.ctx.storage.transactionSync(() => {
      if (this.#get('deleting') !== undefined) return false;
      const first = this.#sql.exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('wrappedKey', ?)`, wrappedKey).rowsWritten > 0;
      if (first) {
        this.#setMeta('proof', encode(hash.buffer as ArrayBuffer));
        // When, for anyone wondering whose key this is.
        this.#setMeta('keySetAt', Date.now());
      }
      return first;
    });
  }

  // The item bucket

  #bucket(now: number): Bucket {
    const stored = this.#get('bucket');
    return refilled(typeof stored === 'string' ? (JSON.parse(stored) as Bucket) : undefined, now);
  }

  /** Takes `n` items from the bucket, in the push's own transaction so a refused push spends nothing. */
  #spend(n: number) {
    if (n === 0) return;
    const now = Date.now();
    const bucket = this.#bucket(now);
    const wait = secondsFor(bucket, n);
    if (wait) throw new Refused({ status: 429, retryAfter: wait });
    this.#setMeta('bucket', JSON.stringify({ tokens: bucket.tokens - n, at: now }));
  }

  // Items

  async push(sub: string, items: Item[], proof: string | null): Promise<Pushed> {
    const presented = await proofHash(proof);
    await this.#sweep(sub);
    // The tables are made out here: made inside the transaction, a refusal would roll them back.
    void this.#sql;
    let holds: Hold[] = [];
    let answer: Pushed;
    try {
      answer = this.ctx.storage.transactionSync(() => {
        const refused = this.#gate(presented);
        if (refused) throw new Refused(refused);
        const out = this.#apply(items);
        holds = out.holds;
        return out.answer;
      });
    } catch (e) {
      if (e instanceof Refused) return e.answer;
      throw e;
    }
    const used = await this.#reap(sub, holds);
    if (answer.status === 200) {
      if (holds.length) answer = { ...answer, used };
      this.#announce(answer.seq);
    }
    return answer;
  }

  /** Runs inside the transaction. Blobs no item uses any more become holds, to be deleted from R2. */
  #apply(items: Item[]): { answer: Pushed; holds: Hold[] } {
    const sql = this.#sql;
    const conflicts = items.flatMap((i) => this.#conflict(i) ?? []);
    if (conflicts.length) return { answer: { status: 409, conflicts }, holds: [] };

    let seq = this.#meta('seq');
    const used = this.#meta('used');
    let delta = 0;
    const freedBlobs = new Set<string>();
    const results: { key: string; seq: number }[] = [];

    const drop = (where: string, ...args: SqlStorageValue[]) => {
      for (const row of sql.exec(`SELECT seq, key, blob, size FROM items WHERE ${where}`, ...args).toArray()) {
        delta -= cost(row.key as string, row.blob === null ? Number(row.size) : 0);
        if (row.blob !== null) freedBlobs.add(row.blob as string);
        sql.exec(`DELETE FROM items WHERE seq = ?`, row.seq);
      }
    };

    for (const item of items) {
      if (item.kind === 'r') drop(`key = ? AND kind = 'r'`, item.key);
      if (item.kind === 's') {
        if (item.upto > seq) throw new Refused({ status: 400 });
        drop(`key = ? AND kind IN ('y', 's') AND seq <= ?`, item.key, item.upto);
      }
      seq++;
      let size: number;
      if (item.blob !== undefined) {
        // Uploaded first, so already counted in `used`.
        const blob = sql.exec(`SELECT size FROM blobs WHERE name = ?`, item.blob).toArray()[0];
        if (!blob) throw new Refused({ status: 400 });
        size = Number(blob.size);
        delta += cost(item.key);
      } else {
        size = item.data!.length;
        delta += cost(item.key, size);
      }
      sql.exec(`INSERT INTO items (seq, key, kind, data, blob, size) VALUES (?, ?, ?, ?, ?, ?)`, seq, item.key, item.kind, item.data?.buffer ?? null, item.blob ?? null, size);
      results.push({ key: item.key, seq });
    }

    // A blob goes with the last item that used it. Its bytes stay counted until the object is really gone.
    const holds: Hold[] = [];
    let freed = 0;
    for (const name of freedBlobs) {
      if (sql.exec(`SELECT 1 FROM items WHERE blob = ? LIMIT 1`, name).toArray().length) continue;
      const row = sql.exec(`SELECT size FROM blobs WHERE name = ?`, name).toArray()[0];
      if (!row) continue;
      sql.exec(`DELETE FROM blobs WHERE name = ?`, name);
      holds.push(this.#hold(name, Number(row.size)));
      freed += Number(row.size);
    }

    // A push that doesn't add bytes always goes through, so a full account can still delete.
    const net = delta - freed;
    if (net > 0 && used + net > this.#limit) throw new Refused({ status: 413, used, limit: this.#limit });
    this.#spend(items.length);
    this.#setMeta('seq', seq);
    this.#setMeta('used', used + delta);
    return { answer: { status: 200, seq, results, used: used + delta, limit: this.#limit }, holds };
  }

  /** The key and the seq it has now, if `item` can't be stored on top of that. */
  #conflict(item: Item): { key: string; seq: number } | null {
    const rows = this.#sql.exec(`SELECT seq, kind FROM items WHERE key = ?`, item.key).toArray();
    if (item.kind === 'r') {
      const now = Number(rows.find((r) => r.kind === 'r')?.seq ?? 0);
      return now !== item.base ? { key: item.key, seq: now } : null;
    }
    return item.first && rows.length > 0 ? { key: item.key, seq: Math.max(...rows.map((r) => Number(r.seq))) } : null;
  }

  pull(after: number, limit: number): Pulled {
    const out: Pulled['items'] = [];
    let bytes = 0;
    let more = false;
    const rows = this.#sql.exec(`SELECT seq, key, kind, data, blob, size FROM items WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit + 1);
    for (const row of rows) {
      const own = row.blob === null ? Number(row.size) : 0;
      // At least one item always goes, whatever its size.
      if (out.length >= limit || (out.length && bytes + own > PAGE_BYTES)) {
        more = true;
        break;
      }
      bytes += own;
      const item = { seq: Number(row.seq), key: row.key as string, kind: row.kind as Kind };
      out.push(row.blob === null ? { ...item, data: encode(row.data as ArrayBuffer) } : { ...item, blob: row.blob as string });
    }
    return { items: out, seq: more ? out[out.length - 1].seq : this.#meta('seq'), more };
  }

  // Blobs: written once, reserved before the upload

  /** Makes room for a blob of `size` called `name` and counts it. The caller uploads, then commits or abandons. */
  async reserveBlob(sub: string, name: string, size: number, proof: string | null): Promise<Reserved> {
    const presented = await proofHash(proof);
    await this.#sweep(sub);
    void this.#sql;
    return this.ctx.storage.transactionSync((): Reserved => {
      const refused = this.#gate(presented);
      if (refused) return refused;
      const taken = this.#sql.exec(`SELECT 1 FROM blobs WHERE name = ? UNION ALL SELECT 1 FROM holds WHERE name = ?`, name, name).toArray();
      if (taken.length) return { status: 409, exists: true };
      const used = this.#meta('used');
      if (used + size > this.#limit) return { status: 413, used, limit: this.#limit };
      const { id } = this.#hold(name, size);
      this.#setMeta('used', used + size);
      return { status: 200, id };
    });
  }

  /** The upload is done: the hold becomes the blob, counted by the size R2 reports. */
  commitBlob(name: string, id: string, size: number): Committed {
    void this.#sql;
    return this.ctx.storage.transactionSync(() => {
      const used = this.#meta('used');
      const held = this.#sql.exec(`SELECT size FROM holds WHERE name = ? AND id = ?`, name, id).toArray()[0];
      // Gone: the account was deleted meanwhile, or the hold ran out.
      if (!held || this.#get('deleting') !== undefined) return { ok: false, used, limit: this.#limit };
      const next = used - Number(held.size) + size;
      if (next > used && next > this.#limit) return { ok: false, used, limit: this.#limit };
      this.#sql.exec(`DELETE FROM holds WHERE name = ?`, name);
      this.#sql.exec(`INSERT INTO blobs (name, size) VALUES (?, ?)`, name, size);
      this.#setMeta('used', next);
      return { ok: true, used: next, limit: this.#limit };
    });
  }

  /** The upload failed: its object (if any) goes, then its hold, and the bytes are uncounted. */
  async abandonBlob(sub: string, name: string, id: string): Promise<void> {
    await this.#reap(sub, [{ name, id }]);
  }

  /** Deletes a blob: its name stays taken until the object is really gone. */
  async deleteBlob(sub: string, name: string, proof: string | null): Promise<Refusal | null> {
    const presented = await proofHash(proof);
    await this.#sweep(sub);
    void this.#sql;
    const out = this.ctx.storage.transactionSync((): Refusal | Hold | null => {
      const refused = this.#gate(presented);
      if (refused) return refused;
      const row = this.#sql.exec(`SELECT size FROM blobs WHERE name = ?`, name).toArray()[0];
      if (!row) return null;
      this.#sql.exec(`DELETE FROM blobs WHERE name = ?`, name);
      return this.#hold(name, Number(row.size));
    });
    if (out && 'status' in out) return out;
    if (out) await this.#reap(sub, [out]);
    return null;
  }

  #hold(name: string, size: number): Hold {
    const id = crypto.randomUUID();
    this.#sql.exec(`INSERT INTO holds (name, id, size, at) VALUES (?, ?, ?, ?)`, name, id, size, Date.now());
    return { name, id };
  }

  /** Deletes the objects of these holds, then lets the holds go. A delete that fails leaves them for the next sweep. Returns `used`. */
  async #reap(sub: string, holds: Hold[]): Promise<number> {
    if (holds.length) {
      try {
        await this.env.SYNC_BLOBS.delete(holds.map((h) => r2Key(sub, h.name)));
        this.ctx.storage.transactionSync(() => {
          for (const { name, id } of holds) {
            const held = this.#sql.exec(`SELECT size FROM holds WHERE name = ? AND id = ?`, name, id).toArray()[0];
            if (!held) continue;
            this.#sql.exec(`DELETE FROM holds WHERE name = ?`, name);
            this.#setMeta('used', this.#meta('used') - Number(held.size));
          }
        });
      } catch (e) {
        console.error('Could not delete blobs; they stay counted until the next sweep', e);
      }
    }
    return this.#meta('used');
  }

  /** Lets go of holds nobody finished (the Worker was cut off), objects included. */
  async #sweep(sub: string) {
    const stale = this.#sql.exec(`SELECT name, id FROM holds WHERE at < ?`, Date.now() - HOLD_LIFE).toArray();
    if (stale.length) await this.#reap(sub, stale as unknown as Hold[]);
  }

  // The account

  /**
   * Every R2 object of the account, then everything here. The vault is marked
   * deleting first, so nothing new is accepted while the objects are listed and
   * deleted, and a blob still in flight is refused when it finishes.
   */
  async deleteAccount(sub: string, proof: string | null, pageSize = 1000): Promise<Refusal | null> {
    const presented = await proofHash(proof);
    void this.#sql;
    const refused = this.#gate(presented, true);
    // Nothing to delete (or already gone): same answer as when it's done.
    if (refused?.status === 409) return null;
    // A copy with nothing in it goes without the proof. Setting a key needs only a
    // sign-in, so a token that leaked could otherwise plant a key on an account
    // nobody could ever open or remove; this way it costs the owner nothing.
    if (refused && !(refused.status === 403 && this.#empty())) return refused;
    this.#setMeta('deleting', 1);

    // Until a pass finds nothing: an upload that finished while the last pass ran is deleted by the next.
    for (let found = 1; found; ) {
      found = 0;
      for (let cursor: string | undefined; ; ) {
        const page = await this.env.SYNC_BLOBS.list({ prefix: r2Key(sub, ''), cursor, limit: pageSize });
        found += page.objects.length;
        if (page.objects.length) await this.env.SYNC_BLOBS.delete(page.objects.map((o) => o.key));
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'Account deleted');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#ready = false;
    this.#hits = new Hits();
    return null;
  }

  // Live notices. Hibernation API: an idle socket keeps no object in memory and costs nothing.

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response(null, { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ at: Date.now() });
    void this.#armAlarm();
    // The browser only takes the socket if the server picks a subprotocol it offered.
    const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',')[0].trim();
    return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} });
  }

  async #armAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SOCKET_LIFE);
  }

  #announce(seq: number) {
    const text = JSON.stringify({ seq });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Already closing.
      }
    }
  }

  /** The only message that's ever sent is the exact `ping`, which is answered without waking this object. Anything else is a client to be rid of. */
  webSocketMessage(ws: WebSocket) {
    try {
      ws.close(1008, 'Only ping is allowed');
    } catch {
      // Already closed.
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    // 1005 and 1006 can't be sent back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  /** Lets go of sockets that are too old, and asks for itself again only while some remain. */
  async alarm() {
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const at = (ws.deserializeAttachment() as { at: number } | null)?.at ?? 0;
      if (now - at >= SOCKET_LIFE) ws.close(4001, 'Reconnect with a fresh sign-in');
      else next = Math.min(next, at + SOCKET_LIFE);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }
}
