/**
 * Sync's engine (docs/sync.md, "Inside the app"): talks to the mailbox, hands
 * what it brings to Rust to merge, and turns page text into Yjs updates.
 * Loaded only when sync is on (see entry.svelte.ts).
 *
 * One cycle at a time. A request during a cycle only sets a flag for another.
 * Nothing in here ever shows an error toast, least of all while someone is
 * typing: trouble is a status (state.svelte.ts) and a longer wait.
 *
 * Every request carries its epoch's signal, so `stop()` cancels what is in
 * flight, and `stop()` resolves only when the cycle and the file job are over.
 */

import { api } from '../api';
import { cards } from '../cards.svelte';
import { databases } from '../databases.svelte';
import { library } from '../library.svelte';
import { planner } from '../planner.svelte';
import { store } from '../store.svelte';
import { tags } from '../tags.svelte';
import { todos } from '../todos.svelte';
import { fromB64, toB64 } from './bytes';
import * as client from './client';
import * as docs from './docs';
import { syncSchema } from './schema';
import { syncState } from './state.svelte';
import { bodyJson, diffInto, docsEqual, isBlank, LOAD, parse, read, REMOTE, seed, since, Y } from './text';

/** The mailbox format this app speaks. */
const FORMAT = 1;
/** Waits after a failure: 5 s, 15 s, 1 min, then 5 min. */
const BACKOFF = [5_000, 15_000, 60_000, 300_000];
/** How much goes up in one push. */
const MAX_BYTES = 4 * 1024 * 1024;
/** A change starts a cycle after this long... */
const QUICK = 3_000;
/** ...but cycles started by changes are at least this far apart. */
const MIN_GAP = 30_000;
/** Whatever happens, a cycle runs this often. */
const EVERY = 60_000;
/** How often this computer's own changes are looked for. */
const LOOK = 5_000;
/** Focus and coming online start a cycle, but not within this of the last. */
const SETTLE = 5_000;
/** A `/live` message starts a cycle at most this often. */
const LIVE_GAP = 2_000;
/** A refused push is pulled and tried again at once this many times; then it backs off, and says so. */
const MAX_REPEATS = 5;
/** Refusals that name a seq this computer has already seen are fixed without a pull; this many in one cycle. */
const MAX_REBASES = 5;
/** An update that fails to apply this many cycles running is set aside. */
const POISON_AFTER = 3;
/** Stopped for want of a sign-in, an update or the copy: a focus this long after tries again. */
const HOUR = 3_600_000;

/** The newer app wrote something this one can't read. */
export class NeedsUpdate extends Error {}
/** The synced copy this computer belongs to was deleted, and maybe replaced by another with another key. */
export class CopyGone extends Error {}
/** The cycle was stopped (signed out, turned off) while it ran. */
class Stopped extends Error {}

type Outcome = 'done' | 'again';

/** The mailbox says something that can't be true (numbers out of order or past the end). */
function lies(what: string): never {
  throw new client.ServerError(`Sync sent ${what}`);
}

/** Pages stored with something this app can't read are mentioned once. */
const warned = new Set<string>();
function skip(id: string, why: string) {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`Sync: left page ${id} alone (${why})`);
}

/** Reloads what the app shows after changes from other computers. */
async function refreshStores(entities: string[]) {
  const has = (...names: string[]) => names.some((n) => entities.includes(n));
  const jobs: Promise<unknown>[] = [];
  if (has('page')) jobs.push(store.refresh(), databases.load(), cards.load(), todos.loaded ? todos.load() : Promise.resolve());
  else if (has('property', 'view', 'automation')) jobs.push(databases.load());
  if (has('course', 'assignment', 'event', 'occurrence', 'attachment')) jobs.push(planner.load());
  if (has('file', 'attachment')) jobs.push(library.load());
  if (has('tag')) jobs.push(tags.load(), store.refresh());
  if (has('review') && !has('page')) jobs.push(cards.load());
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.warn('Sync: could not reload something', r.reason);
}

/** A picture whose file just arrived: any image waiting for it tries again. */
function fileArrived(e: Event) {
  const stored = (e as CustomEvent<{ stored: string }>).detail?.stored;
  if (!stored) return;
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src?.includes(stored)) img.setAttribute('src', src);
  }
}

class Engine {
  #account: string | null = null;
  /** Which synced copy this computer belongs to. */
  #wrapped: string | null = null;
  #epoch = 0;
  /** Cancels every request of the current epoch. */
  #abort = new AbortController();
  /** The proof of the vault key, asked once per unlock (docs/sync.md, Vault proof). */
  #proof: string | null = null;
  /** The cycle that is running (nothing else starts until it is over). */
  #cycleP: Promise<void> | null = null;
  /** The file job that is running. */
  #filesP: Promise<void> | null = null;
  /** When sync stopped for want of a sign-in, an update or the copy: nothing retries until something changes. */
  #halt: number | null = null;
  #liveAt = 0;
  /** Updates that failed to apply, by page and seq, with the number of cycles they have failed in a row. */
  #fails = new Map<string, number>();
  /** Updates set aside, and records passed over, since sync started. */
  #aside = 0;
  #skipped = 0;
  /** Items Rust kept because it could not open them. */
  #kept = 0;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = Infinity;
  #failures = 0;
  #repeats = 0;
  #lastStart = 0;
  #cursor = 0;
  #blocked = false;
  #cleanups: (() => void)[] = [];
  #fileWait = new Map<string, { until: number; fails: number }>();

  // ------------------------------------------------------------- lifecycle

  /** Follows whoever is signed in: starts if sync is on for them here, stops otherwise. */
  async follow(id: string | null) {
    if (id === this.#account) return;
    this.#account = id;
    await this.stop();
    if (this.#account !== id || !id) return;
    await this.#start(id);
  }

  async #start(id: string) {
    const st = await api.syncStatus().catch(() => null);
    if (this.#account !== id) return;
    if (!st?.enabled || st.account !== id) {
      syncState.status = 'off';
      return;
    }
    let open = false;
    try {
      open = await api.syncVaultOpen(id);
      // The proof is asked once per unlock; without the key there is none.
      if (open) this.#proof = await api.syncVaultProof();
    } catch (e) {
      open = false;
      console.warn('Sync: could not open the key', e);
    }
    if (this.#account !== id) return;
    if (!open) {
      syncState.status = 'locked';
      return;
    }
    this.#wrapped = st.wrappedKey ?? null;
    this.#kept = st.unreadable ?? 0;
    this.#publish(!!st.backup);
    await this.#run(st.ready);
  }

  /** Begins working: a look at what changed behind the app's back, then listening for reasons to sync, and a first cycle. */
  async #run(ready: boolean) {
    const epoch = this.#epoch;
    docs.start();
    if (ready) {
      syncState.status = 'idle';
      syncState.ready = true;
      syncState.generation++;
    } else {
      syncState.status = 'setup';
      syncState.progress = 'starting';
    }
    // Writes made without the triggers (an older app, another tool) are noticed before anything is sent.
    let found = 0;
    try {
      found = await api.syncAudit();
    } catch (e) {
      console.warn('Sync: the audit failed', e);
    }
    if (epoch !== this.#epoch) return;
    this.#listen();
    this.request(0);
    if (found > 0) this.changed();
  }

  /** The numbers Settings shows quietly: what could not be read here. */
  #publish(backup?: boolean) {
    syncState.unreadable = this.#kept + this.#aside + this.#skipped;
    if (backup !== undefined) syncState.backup = backup;
  }

  #listen() {
    this.#unlisten();
    const on = (type: string, fn: (e: Event) => void, target: EventTarget = window) => {
      target.addEventListener(type, fn);
      this.#cleanups.push(() => target.removeEventListener(type, fn));
    };
    const soon = () => {
      // Stopped for want of a sign-in, an update or the copy: only a focus an hour later tries again.
      if (this.#halt !== null) {
        if (Date.now() - this.#halt < HOUR) return;
        this.#halt = null;
      }
      this.request(Math.max(0, this.#lastStart + SETTLE - Date.now()));
    };
    on('td:page-saved', () => this.changed());
    on('td:pages-copied', () => this.changed());
    on('focus', soon);
    on('online', soon);
    on('td:file-arrived', fileArrived);
    on('visibilitychange', () => document.visibilityState === 'visible' && soon(), document);
    const every = setInterval(() => this.request(0), EVERY);
    this.#cleanups.push(() => clearInterval(every));
    // Whatever was changed, however: a title, an assignment, a course.
    const look = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.#cycleP)
        void api.syncHasChanges().then((yes) => yes && this.changed(), () => {});
    }, LOOK);
    this.#cleanups.push(() => clearInterval(look));
    // A burst of messages is one cycle: at most one every LIVE_GAP.
    this.#cleanups.push(
      client.live((seq) => {
        if (!Number.isInteger(seq) || seq <= this.#cursor) return;
        const wait = Math.max(0, this.#liveAt + LIVE_GAP - Date.now());
        this.#liveAt = Date.now() + wait;
        this.request(wait);
      }),
    );
  }

  #unlisten() {
    for (const stop of this.#cleanups.splice(0)) stop();
  }

  /**
   * Stops syncing on this computer (signed out, or turned off). Nothing is forgotten. What was in flight is
   * cancelled, and the promise resolves when the cycle and the file job are over: callers that go on to
   * delete or turn off await it, so two cycles never overlap and nothing lands after.
   */
  async stop(): Promise<void> {
    this.#epoch++;
    this.#abort.abort();
    this.#abort = new AbortController();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Infinity;
    this.#unlisten();
    docs.stop();
    this.#failures = this.#repeats = 0;
    this.#again = false;
    this.#halt = null;
    this.#liveAt = 0;
    this.#fails.clear();
    this.#aside = this.#skipped = this.#kept = 0;
    const wasReady = syncState.ready;
    syncState.status = 'off';
    syncState.ready = false;
    syncState.progress = '';
    syncState.reason = '';
    syncState.unreadable = 0;
    // Editors bound to documents go back to the plain way.
    if (wasReady) syncState.generation++;
    await Promise.allSettled([this.#cycleP, this.#filesP]);
  }

  // ----------------------------------------------------------- scheduling

  /** Something was saved: a cycle in a few seconds, but not too often. */
  changed() {
    this.request(Math.max(QUICK, this.#lastStart + MIN_GAP - Date.now()));
  }

  /** A cycle after `delay` ms (or right after the one running). */
  request(delay = 0) {
    if (!this.#account || syncState.status === 'off' || syncState.status === 'locked' || this.#halt !== null) return;
    if (this.#cycleP) {
      this.#again = true;
      return;
    }
    const at = Date.now() + delay;
    if (this.#timer !== undefined && this.#timerAt <= at) return;
    clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = setTimeout(() => this.#go(), delay);
  }

  /** "Sync Now": it also ends a stop for want of a sign-in, an update or the copy. */
  syncNow() {
    this.#halt = null;
    this.request(0);
  }

  #go() {
    this.#timer = undefined;
    this.#timerAt = Infinity;
    if (this.#cycleP || !this.#account) return;
    this.#cycleP = this.#goOnce(this.#epoch, { signal: this.#abort.signal, proof: this.#proof ?? undefined });
  }

  async #goOnce(epoch: number, call: client.Call) {
    this.#again = false;
    this.#lastStart = Date.now();
    if (syncState.status !== 'setup') syncState.status = 'syncing';
    let next: number | null = null;
    try {
      next = await this.#once(epoch, call);
    } finally {
      this.#cycleP = null;
    }
    if (epoch !== this.#epoch) return;
    if (this.#again && next === null && this.#halt === null) next = 0;
    if (next !== null) this.request(next);
  }

  /** One cycle and what follows from how it went: how long to wait before the next (null: nothing to schedule). */
  async #once(epoch: number, call: client.Call): Promise<number | null> {
    try {
      const outcome = await this.#cycle(epoch, call);
      if (epoch !== this.#epoch) return null;
      this.#failures = 0;
      if (outcome === 'again') {
        // A refusal: pull, merge and go again, but don't spin; after a few, wait longer and say so.
        this.#repeats++;
        if (this.#repeats <= MAX_REPEATS) {
          if (syncState.ready) syncState.status = this.#blocked ? 'full' : 'idle';
          return 0;
        }
        syncState.reason = 'conflicts';
        if (syncState.ready) syncState.status = 'error';
        return BACKOFF[Math.min(this.#repeats - MAX_REPEATS - 1, BACKOFF.length - 1)];
      }
      this.#repeats = 0;
      syncState.reason = '';
      if (!syncState.ready) {
        await this.#becomeReady();
        // Text held back from pages open in plain editors can go in now.
        this.#again = true;
      }
      syncState.lastSynced = Date.now();
      if (syncState.ready) syncState.status = this.#blocked ? 'full' : 'idle';
      return null;
    } catch (e) {
      if (e instanceof Stopped || e instanceof client.Aborted || epoch !== this.#epoch) return null;
      return this.#failed(e);
    }
  }

  /** What a failed cycle means for the status, and how long to wait (null: nothing retries until something changes). */
  #failed(e: unknown): number | null {
    const wait = BACKOFF[Math.min(this.#failures++, BACKOFF.length - 1)];
    const setup = !syncState.ready;
    if (e instanceof client.Offline) {
      syncState.status = setup ? 'setup' : 'offline';
      syncState.progress = 'offline';
      return wait;
    }
    if (e instanceof client.ClockOff) {
      syncState.status = 'paused-clock';
      return 60_000;
    }
    if (e instanceof NeedsUpdate) {
      syncState.status = 'needs-update';
      this.#halt = Date.now();
      return null;
    }
    // The copy was deleted or replaced (the key or the proof isn't the one that is there now).
    if (e instanceof CopyGone || e instanceof client.ProofRefused || e instanceof client.NoVault) {
      syncState.status = 'copy-gone';
      this.#halt = Date.now();
      return null;
    }
    if (e instanceof client.SignedOut) {
      syncState.status = 'signed-out';
      this.#halt = Date.now();
      return null;
    }
    if (e instanceof client.RateLimited) {
      syncState.status = setup ? 'setup' : 'idle';
      return e.seconds * 1000;
    }
    console.warn('Sync: a cycle failed', e);
    syncState.status = setup ? 'setup' : 'error';
    return wait;
  }

  async #becomeReady() {
    await api.syncMarkReady();
    syncState.ready = true;
    syncState.progress = '';
    syncState.generation++;
    window.dispatchEvent(new Event('td:sync-ready'));
  }

  // ----------------------------------------------------------------- cycle

  #alive(epoch: number) {
    if (epoch !== this.#epoch) throw new Stopped();
  }

  async #cycle(epoch: number, call: client.Call): Promise<Outcome> {
    // 1. What is saved is the latest, and what is typed is written down.
    window.dispatchEvent(new Event('td:flush'));
    await store.flush();
    await docs.commitAll();
    this.#alive(epoch);

    const info = await client.info(call);
    this.#alive(epoch);
    if (info.format > FORMAT) throw new NeedsUpdate();
    // Pushing with the old key into a copy someone deleted, or replaced with a new key,
    // would leave things there no other computer can read.
    if (this.#wrapped && info.wrappedKey !== this.#wrapped) throw new CopyGone();
    syncState.note({ used: info.used, limit: info.limit });
    if (this.#blocked && info.used < info.limit) this.#blocked = false;
    syncState.progress = 'pulling';

    // 2. Pull.
    await this.#pull(epoch, call, info.seq);

    // 3. Text.
    syncState.progress = 'text';
    await this.#text(epoch);
    this.#alive(epoch);

    // 4 and 5. Push, unless the account is full.
    if (!this.#blocked) {
      syncState.progress = 'pushing';
      const records = await this.#pushRecords(epoch, call);
      if (records === 'again') return 'again';
      const text = await this.#pushText(epoch, call);
      if (text === 'again') return 'again';
    }

    // 6. Files, on their own: a big one never holds up the text.
    if (!this.#filesP) {
      const job: Promise<void> = this.#files(epoch, call).finally(() => {
        if (this.#filesP === job) this.#filesP = null;
      });
      this.#filesP = job;
    }
    return 'done';
  }

  async #pull(epoch: number, call: client.Call, head: number) {
    const status = await api.syncStatus();
    this.#alive(epoch);
    let after = status.cursor;
    this.#cursor = after;
    let asked = false;
    for (let pages = 0; after < head && pages < 10_000; pages++) {
      const got = await client.pull(after, 1000, call);
      this.#alive(epoch);
      // What the mailbox sends is checked: numbers whole and in order, none above its own count, none behind the cursor.
      let last = after;
      for (const item of got.items) {
        if (!Number.isInteger(item.seq) || item.seq <= last) lies('an item number out of order');
        last = item.seq;
      }
      if (!Number.isInteger(got.seq) || got.seq < after) lies('a count behind the cursor');
      if (Math.max(last, got.seq) > head && !asked) {
        // New things may have arrived since the cycle began; ask once before believing it is a lie.
        asked = true;
        head = (await client.info(call)).seq;
        this.#alive(epoch);
      }
      if (Math.max(last, got.seq) > head) lies('a number past its own count');
      const cursor = got.more ? last : Math.max(got.seq, last);
      if (got.items.length || cursor > after) {
        try {
          await api.syncIngest(got.items, cursor);
        } catch (e) {
          if (/update thought desk/i.test(String(e))) throw new NeedsUpdate();
          throw e;
        }
        after = this.#cursor = cursor;
      }
      if (!got.more || !got.items.length) break;
    }
    const applied = await api.syncApply();
    this.#skipped += applied.skipped ?? 0;
    if (applied.entities.length) await refreshStores(applied.entities);
    // What couldn't be opened is counted by Rust; the rest is a quiet line in Settings.
    const now = await api.syncStatus();
    this.#kept = now.unreadable ?? 0;
    this.#publish(!!now.backup);
  }

  // ------------------------------------------------------------------ text

  async #text(epoch: number) {
    const todo = await api.syncTextTodo();
    // Local edits first: they become updates before anything from outside is merged in.
    for (const id of todo.bodies) {
      this.#alive(epoch);
      await docs.lock(id, () => this.#body(id)).catch((e) => console.warn('Sync: a page body could not be compared', id, e));
    }
    for (const id of todo.incoming) {
      this.#alive(epoch);
      // A plain editor's next save would overwrite what's merged; wait until it rebinds.
      if (syncState.plain.has(id)) continue;
      await docs.lock(id, () => this.#incoming(id)).catch((e) => console.warn('Sync: a page could not be merged', id, e));
    }
    this.#publish();
  }

  /** A page whose body was written: make its document say the same. (Under the page's lock.) */
  async #body(id: string) {
    const schema = syncSchema();
    const r = await api.syncTextRead(id);
    const body = bodyJson(r.content, schema);
    if (!body) return skip(id, 'its body is not readable');

    const open = docs.get(id);
    if (open) {
      // The document is the truth. A stored body that differs is behind it (a save captured
      // just before a remote change landed): bring the body up, never the other way.
      const mine = read(open);
      const same = docsEqual(mine.json, body, schema);
      if (same === null) return skip(id, 'a block this version does not know');
      const state = toB64(Y.encodeStateAsUpdate(open));
      await api.syncTextCommit(same ? { pageId: id, base: r.content, state } : { pageId: id, base: r.content, state, content: JSON.stringify(mine.json), text: mine.text });
      return;
    }

    // Text from the mailbox is waiting, and this page has no state: that text is the
    // baseline. Seeding here would put the same words in twice; adoption does it right.
    if (!r.state && r.updates.length) return;

    const doc = new Y.Doc();
    try {
      if (!r.state) {
        // Nothing here yet: an empty body has nothing to seed.
        const seeded = seed(doc, body, schema);
        if (seeded === null) return skip(id, 'a block this version does not know');
        const all = toB64(Y.encodeStateAsUpdate(doc));
        // A blank body: an empty state says it's been looked at, and there's nothing to send.
        await api.syncTextCommit(seeded ? { pageId: id, base: r.content, state: all, update: all, first: true } : { pageId: id, base: r.content, state: all });
        return;
      }
      Y.applyUpdate(doc, fromB64(r.state), LOAD);
      const before = Y.encodeStateVector(doc);
      const changed = diffInto(doc, body, schema);
      if (changed === null) return skip(id, 'a block this version does not know');
      const state = toB64(Y.encodeStateAsUpdate(doc));
      await api.syncTextCommit(changed ? { pageId: id, base: r.content, state, update: toB64(since(doc, before)) } : { pageId: id, base: r.content, state });
    } finally {
      doc.destroy();
    }
  }

  /**
   * A page other computers wrote to: merge their updates into its document and its body. (Under the page's
   * lock.) Updates go in one by one: one that can't be applied is tried again for a few cycles and then set
   * aside, so it never keeps the page from moving on. What is consumed is the run of updates from the start
   * that went in or were set aside.
   */
  async #incoming(id: string) {
    const schema = syncSchema();
    const r = await api.syncTextRead(id);
    if (!r.updates.length) return;
    const body = bodyJson(r.content, schema);
    if (!body) return skip(id, 'its body is not readable');

    const open = docs.get(id);
    const doc = open ?? new Y.Doc();
    try {
      if (!open && r.state) Y.applyUpdate(doc, fromB64(r.state), LOAD);
      const updates = [...r.updates].sort((x, y) => x.seq - y.seq);
      let consumed: number | undefined;
      let stuck = false;
      let applied = 0;
      const merge = () => {
        for (const u of updates) {
          const mark = `${id}:${u.seq}`;
          try {
            Y.applyUpdate(doc, fromB64(u.data), REMOTE);
            this.#fails.delete(mark);
            applied++;
            if (!stuck) consumed = u.seq;
          } catch (e) {
            const n = (this.#fails.get(mark) ?? 0) + 1;
            if (n >= POISON_AFTER) {
              // Set aside for good: consumed, so the page moves on; said once, and counted in Settings.
              this.#fails.delete(mark);
              this.#aside++;
              console.warn(`Sync: set aside an update to page ${id} that could not be applied (seq ${u.seq})`, e);
              if (!stuck) consumed = u.seq;
            } else {
              this.#fails.set(mark, n);
              stuck = true;
            }
          }
        }
      };
      /** The local body, made an ordinary update on top of what the document says. */
      let mine: Uint8Array | null = null;
      const diffLocal = (): boolean => {
        const before = Y.encodeStateVector(doc);
        const changed = diffInto(doc, body, schema);
        if (changed) mine = since(doc, before);
        return changed !== null;
      };
      if (open) {
        merge();
        docs.markKnown(id);
      } else if (r.state) {
        // An edit nobody has diffed yet goes in first.
        if (!diffLocal()) return skip(id, 'a block this version does not know');
        merge();
      } else {
        // Adoption: what the mailbox has comes first, then the local body on top, so nothing is doubled.
        // A body with nothing in it (a page that arrived with no text yet) has nothing to add, and
        // diffing it in would delete the text that just came.
        merge();
        // The baseline is not all here: adding the local body on top now would put the same words in twice later.
        if (stuck) return;
        if (!isBlank(body, schema) && !diffLocal()) return skip(id, 'a block this version does not know');
      }
      if (applied === 0 && consumed === undefined && !mine) return;
      const merged = read(doc);
      if (!parse(merged.json, schema)) return skip(id, 'a block this version does not know');
      // False: the body changed since it was read. The page is noted again, so it comes round next time.
      await api.syncTextCommit({
        pageId: id,
        base: r.content,
        state: toB64(Y.encodeStateAsUpdate(doc)),
        update: mine ? toB64(mine) : undefined,
        content: JSON.stringify(merged.json),
        text: merged.text,
        consumed,
      });
    } finally {
      if (!open) doc.destroy();
    }
  }

  // ------------------------------------------------------------------ push

  /** True when the answer says the account is full (uploads stop). */
  #full(answer: { used: number; limit: number }) {
    this.#blocked = true;
    syncState.note(answer);
    syncState.status = 'full';
  }

  async #pushRecords(epoch: number, call: client.Call): Promise<'again' | 'ok'> {
    let rebases = 0;
    for (let i = 0; i < 1000; i++) {
      this.#alive(epoch);
      const out = await api.syncSealRecords(MAX_BYTES);
      this.#alive(epoch);
      if (!out.length) return 'ok';
      const answer = await client.push(
        out.map((o) => ({ key: o.key, kind: 'r' as const, data: o.data, base: o.base })),
        call,
      );
      if ('conflict' in answer) {
        this.#alive(epoch);
        // A key whose seq this computer's cursor is already past has been seen (or couldn't be read): that seq is
        // the new base, and the push goes again. Anything else needs a pull.
        const byKey = new Map(out.map((o) => [o.key, o]));
        const rebase: { entity: string; id: string; seq: number }[] = [];
        let pulls = answer.conflict.length === 0;
        for (const c of answer.conflict) {
          const o = byKey.get(c.key);
          if (o && c.seq <= this.#cursor) rebase.push({ entity: o.entity, id: o.id, seq: c.seq });
          else pulls = true;
        }
        if (rebase.length) await api.syncRecordsRebase(rebase);
        if (pulls || ++rebases > MAX_REBASES) return 'again';
        continue;
      }
      if ('full' in answer) {
        this.#full(answer);
        return 'ok';
      }
      if (!Array.isArray(answer.results) || answer.results.length !== out.length || answer.results.some((x) => !Number.isInteger(x.seq))) lies('an answer that does not match the push');
      syncState.note(answer);
      // The push went through: it is written down before anything else is asked of a cycle that may have been stopped.
      await api.syncRecordsSent(out.map((o, n) => ({ entity: o.entity, id: o.id, seq: answer.results[n].seq })));
    }
    return 'ok';
  }

  async #pushText(epoch: number, call: client.Call): Promise<'again' | 'ok'> {
    for (let i = 0; i < 1000; i++) {
      this.#alive(epoch);
      const out = await api.syncSealText(MAX_BYTES);
      this.#alive(epoch);
      if (!out.length) return 'ok';
      const answer = await client.push(
        out.map((o) => ({ key: o.key, kind: o.kind, data: o.data, ...(o.first ? { first: true } : {}), ...(o.upto ? { upto: o.upto } : {}) })),
        call,
      );
      if ('conflict' in answer) {
        this.#alive(epoch);
        // Someone else got there first with this page's text: drop the seed and adopt theirs.
        const refused = new Set(answer.conflict.map((c) => c.key));
        for (const o of out)
          if (o.first && refused.has(o.key)) {
            await api.syncTextRefused(o.pageId);
            if (docs.isOpen(o.pageId)) {
              docs.discard(o.pageId);
              syncState.generation++;
            }
          }
        return 'again';
      }
      if ('full' in answer) {
        this.#full(answer);
        return 'ok';
      }
      if (!Array.isArray(answer.results) || answer.results.length !== out.length || answer.results.some((x) => !Number.isInteger(x.seq))) lies('an answer that does not match the push');
      syncState.note(answer);
      await api.syncTextSent(out.map((o, n) => ({ ref: o.ref, seq: answer.results[n].seq })));
    }
    return 'ok';
  }

  // ----------------------------------------------------------------- files

  /** At most one upload or download at a time; what's left resumes on the next cycle. */
  async #files(epoch: number, call: client.Call) {
    try {
      const todo = await api.syncFilesTodo();
      this.#alive(epoch);
      const more = todo.upload.length + todo.download.length + todo.remove.length > 0;
      const ready = (id: string) => (this.#fileWait.get(id)?.until ?? 0) <= Date.now();
      const attempt = async (id: string, work: () => Promise<void>) => {
        if (!ready(id) || epoch !== this.#epoch) return;
        try {
          await work();
          this.#fileWait.delete(id);
        } catch (e) {
          if (epoch !== this.#epoch || e instanceof Stopped || e instanceof client.Aborted) return;
          const fails = (this.#fileWait.get(id)?.fails ?? 0) + 1;
          this.#fileWait.set(id, { fails, until: Date.now() + BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)] });
          if (!(e instanceof client.Offline || e instanceof client.ProofRefused || e instanceof client.NoVault)) console.warn('Sync: a file could not be moved', id, e);
        }
      };
      for (const job of todo.download)
        await attempt(job.id, async () => {
          const names = await api.syncFileNames(job.stored, job.chunks);
          this.#alive(epoch);
          for (let i = 0; i < job.chunks; i++) {
            const bytes = await client.getBlob(names[i], call);
            this.#alive(epoch);
            const done = await api.syncFileOpen(bytes, job.stored, i, job.chunks);
            this.#alive(epoch);
            if (done) window.dispatchEvent(new CustomEvent('td:file-arrived', { detail: { stored: job.stored } }));
          }
        });
      if (!this.#blocked)
        for (const job of todo.upload)
          await attempt(job.id, async () => {
            const names = await api.syncFileNames(job.stored, job.chunks);
            this.#alive(epoch);
            for (let i = 0; i < job.chunks; i++) {
              const sealed = new Uint8Array(await api.syncFileSeal(job.stored, i));
              this.#alive(epoch);
              const put = await client.putBlob(names[i], sealed, call);
              this.#alive(epoch);
              if ('exists' in put) {
                // Names are written once, and a name is the chunk's own: an earlier try (cut off before the file was marked
                // done) already put it there. The chunk is looked at before it is believed; a name only held by an
                // upload still being counted isn't there yet, and fails into the usual wait.
                await client.getBlob(names[i], call);
                this.#alive(epoch);
                continue;
              }
              if ('full' in put) {
                this.#full(put);
                return;
              }
            }
            if (!this.#blocked) await api.syncFileDone(job.id, 'uploaded');
          });
      for (const job of todo.remove)
        await attempt(job.id, async () => {
          const names = await api.syncFileNames(job.stored, job.chunks);
          this.#alive(epoch);
          for (const name of names) {
            await client.deleteBlob(name, call);
            this.#alive(epoch);
          }
          await api.syncFileDone(job.id, 'removed');
        });
      // The lists are short on purpose; a first sync of many files keeps going.
      if (more && epoch === this.#epoch && !this.#fileWait.size && !this.#blocked) this.request(1000);
    } catch (e) {
      if (!(e instanceof client.Offline || e instanceof Stopped || e instanceof client.Aborted)) console.warn('Sync: files could not be looked at', e);
    }
  }

  // --------------------------------------------------------------- turning on

  /**
   * First step of turning on: looks at the mailbox. A new vault gives a
   * recovery key to show (nothing is on the server, or turned on, until
   * `create` after it is saved); an existing one needs its recovery key (`join`).
   */
  async prepare(account: string): Promise<{ mode: 'create'; recoveryKey: string; wrappedKey: string } | { mode: 'join'; wrappedKey: string; seq: number; empty: boolean }> {
    const info = await client.info();
    if (info.format > FORMAT) throw new NeedsUpdate();
    syncState.note({ used: info.used, limit: info.limit });
    if (info.wrappedKey) return { mode: 'join', wrappedKey: info.wrappedKey, seq: info.seq, empty: info.empty === true };
    const made = await api.syncVaultCreate(account);
    return { mode: 'create', ...made };
  }

  /**
   * The copy in the mailbox has nothing in it, and this person hasn't got its
   * recovery key (one they set and lost, or one a sign-in that leaked set): it
   * goes, and a new one is made in its place. Nothing is lost.
   */
  async startOver(account: string) {
    const info = await client.info();
    if (!info.empty) throw new Error('The synced copy has notes in it');
    await client.deleteAccount({});
    return this.prepare(account);
  }

  /** The recovery key is saved: the wrapped key goes to the mailbox, and this computer turns sync on. */
  async create(account: string, wrappedKey: string) {
    const proof = await api.syncVaultProof();
    if (!(await client.setKey(wrappedKey, proof))) {
      // Our own earlier try got in and turning on failed after it: the same copy, so this is a retry. Anything else is another computer's.
      const now = await client.info();
      if (now.wrappedKey !== wrappedKey) {
        await api.syncVaultForget(account);
        throw new AlreadySetUp();
      }
    }
    await this.stop();
    this.#proof = proof;
    await this.#turnOn(account, false, wrappedKey);
  }

  /** Joins an existing vault with its recovery key. A wrong key throws. */
  async join(account: string, wrappedKey: string, recoveryKey: string, seq: number) {
    await openVault(account, recoveryKey, wrappedKey);
    const proof = await api.syncVaultProof();
    await this.stop();
    this.#proof = proof;
    await this.#turnOn(account, seq > 0, wrappedKey);
  }

  /** The key was lost from this computer: the recovery key brings it back. */
  async unlock(account: string, recoveryKey: string) {
    const info = await client.info();
    if (!info.wrappedKey) throw new Error('No vault');
    await openVault(account, recoveryKey, info.wrappedKey);
    await this.stop();
    this.#account = account;
    await this.#start(account);
  }

  async #turnOn(account: string, joining: boolean, wrappedKey: string) {
    await api.syncTurnOn(account, joining, wrappedKey);
    this.#account = account;
    this.#wrapped = wrappedKey;
    const st = await api.syncStatus().catch(() => null);
    this.#kept = st?.unreadable ?? 0;
    this.#publish(!!st?.backup);
    await this.#run(false);
  }

  /** Stops syncing here and forgets the vault key on this computer. Notes stay on this computer, and so does the synced copy. */
  async turnOff() {
    const account = this.#account;
    await this.stop();
    await api.syncTurnOff();
    if (account) await api.syncVaultForget(account);
    this.#account = account;
    this.#proof = null;
    this.#wrapped = null;
    syncState.backup = false;
  }

  /**
   * Removes the synced copy from the mailbox, and stops syncing here. Notes on computers stay. A computer whose
   * copy was deleted and replaced is refused: the delete would remove the replacement.
   */
  async deleteSyncedCopy() {
    const account = this.#account;
    const now = await client.info();
    if (this.#wrapped && now.wrappedKey !== this.#wrapped) throw new CopyGone();
    // Stopped first, and waited for: a cycle in flight must not push anything once the copy is gone.
    await this.stop();
    try {
      await client.deleteAccount({ proof: this.#proof ?? undefined });
    } catch (e) {
      // Not deleted (offline, say): sync goes on as it was.
      if (account) await this.#start(account);
      if (e instanceof client.ProofRefused || e instanceof client.NoVault) throw new CopyGone();
      throw e;
    }
    if (account) await api.syncVaultForget(account);
    await this.turnOff();
    syncState.usage = null;
  }

  /** Deletes the copy of the notes from before sync was turned on. */
  async deleteBackup() {
    await api.syncBackupDelete();
    syncState.backup = !!(await api.syncStatus().catch(() => null))?.backup;
  }
}

/** Another computer set sync up first. */
export class AlreadySetUp extends Error {}
/** The recovery key doesn't open the synced copy. */
export class WrongKey extends Error {}

async function openVault(account: string, recoveryKey: string, wrappedKey: string) {
  try {
    await api.syncVaultJoin(account, recoveryKey, wrappedKey);
  } catch (e) {
    console.warn('Sync: the recovery key was refused', e);
    throw new WrongKey(String(e));
  }
}

/** What went wrong, in a word the settings pane turns into a sentence. */
export function describe(e: unknown): 'offline' | 'clock' | 'update' | 'taken' | 'wrong' | 'gone' | 'signedout' | 'generic' {
  if (e instanceof client.Offline) return 'offline';
  if (e instanceof client.ClockOff) return 'clock';
  if (e instanceof NeedsUpdate) return 'update';
  if (e instanceof AlreadySetUp) return 'taken';
  if (e instanceof WrongKey) return 'wrong';
  if (e instanceof CopyGone || e instanceof client.ProofRefused || e instanceof client.NoVault) return 'gone';
  if (e instanceof client.SignedOut) return 'signedout';
  return 'generic';
}

export const engine = new Engine();
