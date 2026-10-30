/**
 * What the Galaxy view shows: which pages are stars, which links join them,
 * how much each holds, and where everything sits (layout.ts), in the form
 * this workspace's seed gives its galaxy. The last layout is kept, so coming
 * back to the view with nothing changed is instant.
 */
import { api } from '../api';
import { planner } from '../planner.svelte';
import { store } from '../store.svelte';
import type { PageMeta } from '../types';
import { layoutGalaxy, type GalaxyInput, type GalaxyLayout } from './layout';
import { heatOf } from './render';

export interface Sky {
  /** Page id per star, in the layout's order. */
  ids: string[];
  layout: GalaxyLayout;
  /** Words written in each star's page (a database: in its rows). */
  words: Uint32Array;
  /** Each star's colour step, short notes red to long ones blue (render.ts heatOf). */
  heat: Uint8Array;
  /** The links couldn't be read, so there are none. */
  failed: boolean;
}

/** From this many pages the layout runs in a worker. */
const WORKER_FROM = 150;

let last: { key: string; ids: string[]; layout: GalaxyLayout } | null = null;
/** A layout under way: a re-read with the same input waits for it, a different one stops it. */
let pending: { key: string; promise: Promise<GalaxyLayout>; cancel: () => void } | null = null;
/** The workspace's seed: it never changes, so it's read once. */
let seed: Promise<number> | null = null;

/** A database row stands for its database; anything else for itself. */
export function starOf(id: string): string | undefined {
  let p = store.untracked.get(id);
  const seen = new Set<string>();
  while (p && p.parentId && store.isRow(p) && !seen.has(p.id)) {
    seen.add(p.id);
    p = store.untracked.get(p.parentId);
  }
  return p && !p.deletedAt ? p.id : undefined;
}

/** Live pages and databases, without database rows, siblings in sidebar order. */
export function starPages(): PageMeta[] {
  return store.all.filter((p) => !p.deletedAt && !store.isRow(p)).sort((a, b) => a.position - b.position);
}

/** Changes when stars come, go or move: worth reading the sky again for. */
export function skyKey(pages: PageMeta[]): string {
  let key = '';
  let stamp = 0;
  for (const p of pages) {
    key += p.id.slice(0, 8) + (p.parentId?.slice(0, 8) ?? '-');
    stamp = Math.max(stamp, p.updatedAt);
  }
  return `${pages.length}:${stamp}:${hash(key)}`;
}

function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Thrown into a read whose layout was stopped for a newer one. */
export class Superseded extends Error {}

function layOut(input: GalaxyInput): { promise: Promise<GalaxyLayout>; cancel: () => void } {
  if (input.pages.length < WORKER_FROM || typeof Worker === 'undefined') return { promise: Promise.resolve(layoutGalaxy(input)), cancel: () => {} };
  let cancel = () => {};
  const promise = new Promise<GalaxyLayout>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(layoutGalaxy(input));
      return;
    }
    cancel = () => {
      worker.terminate();
      reject(new Superseded());
    };
    worker.onmessage = (e: MessageEvent<GalaxyLayout>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      resolve(layoutGalaxy(input));
    };
    worker.postMessage(input);
  });
  return { promise, cancel };
}

/** Stops a layout under way (the view is closing). */
export function cancelSky() {
  pending?.cancel();
  pending = null;
}

/** Reads the links (after saving what's being typed) and lays out the sky. */
export async function readSky(pages: PageMeta[]): Promise<Sky> {
  const ids = pages.map((p) => p.id);
  const known = new Set(ids);
  // A course's notes are their own cluster, wherever they sit.
  const courses = new Set(planner.courses.flatMap((c) => (c.pageId ? [c.pageId] : [])));

  let failed = false;
  let pairs: [string, string][] = [];
  let counts: [string, number][] = [];
  seed ??= api.galaxySeed().then(
    (n) => n ?? 0,
    () => 0,
  );
  try {
    await store.flush();
    [pairs, counts] = await Promise.all([api.linkGraph().then((p) => p ?? []), api.pageWords().then((c) => c ?? [], () => [])]);
  } catch {
    failed = true;
  }
  const at = new Map(ids.map((id, i) => [id, i]));
  const words = new Uint32Array(ids.length);
  for (const [id, n] of counts) {
    const star = starOf(id);
    const i = star === undefined ? undefined : at.get(star);
    if (i !== undefined) words[i] += n;
  }
  const heat = Uint8Array.from(words, heatOf);
  const links: [string, string][] = [];
  for (const [from, to] of pairs) {
    const a = starOf(from);
    const b = starOf(to);
    if (a && b && a !== b && known.has(a) && known.has(b)) links.push([a, b]);
  }

  const input: GalaxyInput = {
    pages: pages.map((p) => {
      // Inside a database row is inside its database, as far as the sky goes.
      const up = p.parentId ? starOf(p.parentId) : undefined;
      return { id: p.id, parent: courses.has(p.id) || !up || up === p.id || !known.has(up) ? null : up };
    }),
    links,
    seed: await seed,
  };
  const key = hash(JSON.stringify(input));
  let layout: GalaxyLayout;
  if (last?.key === key) layout = last.layout;
  else {
    if (pending?.key !== key) {
      pending?.cancel();
      pending = { key, ...layOut({ ...input, prev: last ? { ids: last.ids, pos: last.layout.pos } : undefined }) };
    }
    const mine = pending;
    layout = await mine.promise;
    if (pending === mine) pending = null;
    last = { key, ids, layout };
  }
  return { ids, layout, words, heat, failed };
}
