/**
 * The documents of pages that are open. While a page is open here its Yjs
 * document is the truth for it: the editor is bound to it (Collaboration), a
 * change from another computer is applied to it with the REMOTE origin, and
 * what is typed is kept in Rust shortly after (every 500 ms), together with
 * the whole state.
 *
 * Several editors can show one page (split view), so a document is counted.
 * Loaded only when sync is on.
 */

import { api } from '../api';
import { store } from '../store.svelte';
import { fromB64, toB64 } from './bytes';
import { syncSchema } from './schema';
import { bodyJson, diffInto, isBlank, LOAD, REMOTE, Y } from './text';

export { LOAD, REMOTE };

/** How often typing is written down. */
const EVERY = 500;
/** How long after a failed write the next try is. */
const RETRY = 3000;

interface Entry {
  pageId: string;
  doc: Y.Doc;
  refs: number;
  /** Local changes not written down yet. */
  pending: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Rust has a state for the page (so the next write isn't a seed). */
  known: boolean;
  chain: Promise<void>;
  /** Thrown away (its first push was refused): the editor is rebuilt, and nothing more is written. */
  dead: boolean;
  off: () => void;
}

const entries = new Map<string, Entry>();
const owners = new WeakMap<Y.Doc, Entry>();
let enabled = true;

/** Whether a page's document is open (so it is the truth for the page). */
export function isOpen(pageId: string): boolean {
  return entries.has(pageId);
}

/** The open document of a page. */
export function get(pageId: string): Y.Doc | undefined {
  return entries.get(pageId)?.doc;
}

/** Every page open here. */
export function openPages(): string[] {
  return [...entries.keys()];
}

/**
 * The document of a page, for an editor to bind to. The state kept in Rust is
 * loaded, and the page's body diffed in if it differs (a to-do ticked from
 * Home must not be lost). The body is read again here: the `content` a caller
 * holds can be older than the database, and diffing an old body in would undo
 * what came from other computers since.
 */
export async function open(pageId: string, _content?: string): Promise<Y.Doc> {
  // Under the page's lock, so the engine never merges the page's incoming text while it is being loaded.
  return lock(pageId, async () => {
    const entry = entries.get(pageId) ?? (await load(pageId));
    entry.refs++;
    return entry.doc;
  });
}

const chains = new Map<string, Promise<void>>();

/**
 * Runs `work` when nothing else is working on the page: one at a time per page, in the order asked.
 * `open` takes it, and so do the engine's merge of incoming text and its comparing of the body, so a page
 * is never loaded and merged at the same moment (the load would register a document that lacks what the merge just stored).
 */
export function lock<T>(pageId: string, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(pageId) ?? Promise.resolve()).then(work);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(pageId, tail);
  void tail.then(() => chains.get(pageId) === tail && chains.delete(pageId));
  return run;
}

async function load(pageId: string): Promise<Entry> {
  const read = await api.syncTextRead(pageId);
  const doc = new Y.Doc();
  if (read.state) Y.applyUpdate(doc, fromB64(read.state), LOAD);
  // Text from the mailbox not merged yet, on a page with no state here: it's the baseline, and
  // the body is diffed in on top. Seeding from the body first would put the same text in twice.
  const adopting = !read.state && read.updates.length > 0;
  if (adopting)
    for (const u of read.updates) {
      // One bad update must not keep the page from opening; the engine sets it aside on its own rounds.
      try {
        Y.applyUpdate(doc, fromB64(u.data), REMOTE);
      } catch (e) {
        console.warn('Sync: an update to a page could not be read', pageId, u.seq, e);
      }
    }
  const entry: Entry = { pageId, doc, refs: 0, pending: [], timer: undefined, known: !!read.state || adopting, chain: Promise.resolve(), dead: false, off: () => {} };
  entries.set(pageId, entry);
  owners.set(doc, entry);

  const body = bodyJson(read.content, syncSchema());
  // Adopting with a body that has nothing in it: there is nothing to add, and diffing it in would delete the text.
  if (body && adopting && isBlank(body, syncSchema())) {
    /* the document is what the mailbox has */
  } else if (body) {
    const before = Y.encodeStateVector(doc);
    const changed = diffInto(doc, body, syncSchema(), LOAD);
    // Not typing, but still news for the other computers.
    if (changed) entry.pending.push(Y.encodeStateAsUpdate(doc, before));
  } else console.warn('Sync: a page body this version cannot read was left alone', pageId);

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || origin === LOAD || entry.dead) return;
    entry.pending.push(update);
    arm(entry, EVERY);
  };
  doc.on('update', onUpdate);
  entry.off = () => doc.off('update', onUpdate);
  if (entry.pending.length) void write(entry);
  return entry;
}

function arm(entry: Entry, ms: number) {
  if (entry.timer === undefined) entry.timer = setTimeout(() => void write(entry), ms);
}

/** Writes down what was typed: the merged update and the whole state. */
function write(entry: Entry): Promise<void> {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.chain = entry.chain.then(async () => {
    if (!entry.pending.length || entry.dead || !enabled) return;
    const updates = entry.pending;
    entry.pending = [];
    try {
      const ok = await api.syncTextCommit({
        pageId: entry.pageId,
        base: null,
        state: toB64(Y.encodeStateAsUpdate(entry.doc)),
        update: toB64(Y.mergeUpdates(updates)),
        first: entry.known ? undefined : true,
      });
      if (ok) entry.known = true;
      else retry(entry, updates);
    } catch (e) {
      console.warn('Sync: could not write down a page', e);
      retry(entry, updates);
    }
  });
  return entry.chain;
}

/** Keeps the updates for another go; nothing typed is ever dropped. */
function retry(entry: Entry, updates: Uint8Array[]) {
  entry.pending.unshift(...updates);
  if (!entry.dead && enabled) arm(entry, RETRY);
}

/** The mailbox has text for this page, so what's typed next isn't its first. */
export function markKnown(pageId: string): void {
  const entry = entries.get(pageId);
  if (entry) entry.known = true;
}

/** Writes down every open page's changes now. */
export async function commitAll(): Promise<void> {
  await Promise.all([...entries.values()].map((e) => write(e)));
}

/** Lets go of a page's document; the last one to let go writes it down first (after the body is saved). */
export async function release(pageId: string, doc?: Y.Doc): Promise<void> {
  const entry = (doc && owners.get(doc)) || entries.get(pageId);
  if (!entry) return;
  entry.refs--;
  await store.flush();
  if (entry.refs > 0) return;
  if (!entry.dead) await write(entry);
  if (entry.refs > 0) return;
  entry.off();
  clearTimeout(entry.timer);
  if (entries.get(entry.pageId) === entry) entries.delete(entry.pageId);
  entry.doc.destroy();
}

/** Drops a page's document without writing it (its seed was refused): the next open starts from what Rust has. */
export function discard(pageId: string): void {
  const entry = entries.get(pageId);
  if (!entry) return;
  entry.dead = true;
  entry.pending = [];
  clearTimeout(entry.timer);
  entries.delete(pageId);
}

/** Sync stopped: nothing more is written. */
export function stop(): void {
  enabled = false;
  for (const entry of entries.values()) {
    entry.pending = [];
    clearTimeout(entry.timer);
  }
}

export function start(): void {
  enabled = true;
}

// Saving everything (leaving a page, closing the window) writes the documents down too.
window.addEventListener('td:flush', () => void commitAll());
