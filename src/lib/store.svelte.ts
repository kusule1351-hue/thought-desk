/** Page tree state and every action that changes it. */

import { untrack } from 'svelte';
import { api } from './api';
import { t } from './i18n';
import { prefs } from './prefs.svelte';
import { ui } from './ui.svelte';
import type { PageMeta, PagePatch } from './types';

const SAVE_DELAY = 400;

/** What fills the main area: a page, a tag's items, a course, or an app view. */
export type View = 'page' | 'tag' | 'course' | 'home' | 'assignments' | 'calendar' | 'files' | 'cards' | 'friends' | 'galaxy';
export type AppView = Exclude<View, 'page' | 'tag' | 'course'>;
export const VIEWS: AppView[] = ['home', 'assignments', 'calendar', 'files', 'cards', 'friends', 'galaxy'];

/** A place in the app (one step of back/forward history). */
export interface Entry {
  view: View;
  /** The page id, tag name or course id. */
  id: string | null;
}

/** A tab's place and history (see tabs.svelte.ts). */
export interface Nav {
  history: Entry[];
  index: number;
}

/** The page fields a patch changes (null when it only touches the body). */
function localFields(page: PageMeta, patch: PagePatch): Partial<PageMeta> | null {
  const out: Partial<PageMeta> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.icon !== undefined) out.icon = patch.icon;
  if (patch.fullWidth !== undefined) out.fullWidth = patch.fullWidth;
  if (patch.favorite !== undefined && !!page.favorite !== patch.favorite) out.favorite = patch.favorite ? Date.now() : 0;
  return Object.keys(out).length ? out : null;
}

/**
 * Fields that decide which lists a page is in and where (the tree, the
 * trash, favorites, databases, tags), as opposed to what it shows.
 */
const PLACE_FIELDS = new Set<keyof PageMeta>(['parentId', 'position', 'deletedAt', 'kind', 'favorite', 'tags']);

class Store {
  /**
   * Every page (database rows included), as plain objects that are never
   * changed in place: an edit makes a new object for that page, and a new
   * list (see `edit`). With tens of thousands of pages, tracking each field
   * of each one would cost more memory than everything else in the window.
   */
  pages = $state.raw<PageMeta[]>([]);
  /** Bumped on every change to pages. */
  #ver = $state(0);
  /** Bumped when pages come, go or change place (see PLACE_FIELDS), not when a title changes. */
  #place = $state(0);
  /**
   * Bumped per parent when one of its pages changes (a database's rows), so
   * a database's values follow its own rows instead of every page. Edits
   * that only move `updatedAt` (a save's timestamp) count apart.
   */
  #under = $state<Record<string, number>>({});
  #stamped = $state<Record<string, number>>({});
  /** Bumped when the whole list is replaced (loads, reloads, new pages). */
  #reloads = $state(0);
  /** Pages by id and their index in `pages`, kept up to date as they change. */
  #map = new Map<string, PageMeta>();
  #index = new Map<string, number>();
  loaded = $state(false);
  view = $state<View>('page');
  /** The open page; null while an app view is showing. */
  currentId = $state<string | null>(null);
  /** The tag whose items are showing (view "tag"). */
  tag = $state<string | null>(null);
  /** The course whose hub is showing (view "course"). */
  courseId = $state<string | null>(null);
  saving = $state(false);
  #history = $state<Entry[]>([]);
  #historyIndex = $state(-1);
  /** How the current view was reached, so it can animate in from that side. */
  navDirection = $state<'push' | 'back' | 'forward' | 'tab'>('push');

  /** Pages by id. Reading it follows every change. */
  get byId(): Map<string, PageMeta> {
    void this.#ver;
    return this.#map;
  }

  /**
   * The same map, following only changes to the pages under `parentId` (a
   * database's rows) and whole-list reloads. `stamps` also follows edits that
   * only move `updatedAt`. Read only those pages through it.
   */
  under(parentId: string, stamps = false): Map<string, PageMeta> {
    void this.#reloads;
    void this.#under[parentId];
    if (stamps) void this.#stamped[parentId];
    return this.#map;
  }

  /** Changes so far to the pages under `parentId`, as a key (follows them like `under`). */
  stamp(parentId: string, stamps = false): string {
    return `${this.#reloads}:${this.#under[parentId] ?? 0}:${stamps ? (this.#stamped[parentId] ?? 0) : ''}`;
  }

  /** The map without following anything (for loops whose caller already does). */
  get untracked(): Map<string, PageMeta> {
    return this.#map;
  }

  /**
   * The same map, following only pages coming, going or changing place: for
   * long lists (a database's rows, the tree) that typing a title shouldn't
   * redo. Read only place fields through it.
   */
  get placed(): Map<string, PageMeta> {
    void this.#place;
    return this.#map;
  }

  /** Every page (follows every change). */
  get all(): PageMeta[] {
    void this.#ver;
    return this.pages;
  }

  #setPages(next: PageMeta[], moved: boolean) {
    this.pages = next;
    this.#map = new Map(next.map((p) => [p.id, p]));
    this.#index = new Map(next.map((p, i) => [p.id, i]));
    this.#ver++;
    this.#reloads++;
    if (moved) this.#place++;
  }

  /** Changes fields of pages (by id): each changed page becomes a new object. */
  edit(changes: Map<string, Partial<PageMeta>>) {
    let next: PageMeta[] | null = null;
    let moved = false;
    const under = new Set<string>();
    const stamped = new Set<string>();
    for (const [id, fields] of changes) {
      const i = this.#index.get(id);
      if (i === undefined) continue;
      next ??= this.pages.slice();
      const was = next[i];
      const page = { ...was, ...fields };
      next[i] = page;
      this.#map.set(id, page);
      const keys = Object.keys(fields);
      if (keys.some((k) => PLACE_FIELDS.has(k as keyof PageMeta))) moved = true;
      (keys.every((k) => k === 'updatedAt') ? stamped : under).add(page.parentId ?? '');
      if (was.parentId !== page.parentId) under.add(was.parentId ?? '');
    }
    if (!next) return;
    this.pages = next;
    this.#ver++;
    if (moved) this.#place++;
    for (const p of under) this.#under[p] = (this.#under[p] ?? 0) + 1;
    for (const p of stamped) this.#stamped[p] = (this.#stamped[p] ?? 0) + 1;
  }

  editOne(id: string, fields: Partial<PageMeta>) {
    this.edit(new Map([[id, fields]]));
  }

  // The lists below are worked out as ids when pages come, go or move, and
  // turned into the pages' current versions when read: typing a title in a
  // workspace of 50,000 pages doesn't redo them.

  /** Live page ids grouped by parent id ('' = top level), in sibling order.
   * Databases and their rows aren't part of the tree (the sidebar lists
   * databases on their own). */
  #childIds = $derived.by(() => {
    void this.#place;
    const pages = untrack(() => this.pages);
    const map = new Map<string, PageMeta[]>();
    const databases = new Set(pages.filter((p) => p.kind === 'database').map((p) => p.id));
    for (const p of pages) {
      if (p.deletedAt || p.kind === 'database' || (p.parentId && databases.has(p.parentId))) continue;
      const key = p.parentId ?? '';
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(p);
    }
    const ids = new Map<string, string[]>();
    for (const [key, list] of map) ids.set(key, list.sort((a, b) => a.position - b.position).map((p) => p.id));
    return ids;
  });

  #favoriteIds = $derived.by(() => {
    void this.#place;
    return untrack(() => this.pages)
      .filter((p) => p.favorite && !p.deletedAt)
      .sort((a, b) => a.favorite - b.favorite)
      .map((p) => p.id);
  });

  #trashIds = $derived.by(() => {
    void this.#place;
    const map = this.#map;
    return untrack(() => this.pages)
      .filter((p) => {
        if (!p.deletedAt) return false;
        const parent = p.parentId ? map.get(p.parentId) : undefined;
        return !parent || parent.deletedAt !== p.deletedAt;
      })
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((p) => p.id);
  });

  #pagesOf(ids: string[]): PageMeta[] {
    const byId = this.byId;
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  get roots(): PageMeta[] {
    return this.children(null);
  }

  get favorites(): PageMeta[] {
    return this.#pagesOf(this.#favoriteIds);
  }

  /** Trashed pages that were deleted on their own (not along with a parent). */
  get trash(): PageMeta[] {
    return this.#pagesOf(this.#trashIds);
  }

  current = $derived(this.currentId ? (this.byId.get(this.currentId) ?? null) : null);
  /** The open page and its ancestors (rows the sidebar always renders). */
  openPath = $derived.by(() => {
    const id = this.currentId;
    return new Set(id ? [id, ...this.ancestors(id).map((a) => a.id)] : []);
  });
  canGoBack = $derived(this.#historyIndex > 0);
  canGoForward = $derived(this.#historyIndex < this.#history.length - 1);
  /** The page open now, or else the last one this tab showed before here. */
  lastPage = $derived.by(() => {
    for (let i = this.#historyIndex; i >= 0; i--) {
      const e = this.#history[i];
      if (e?.view === 'page' && e.id) return this.byId.get(e.id) ?? null;
    }
    return null;
  });

  /** Whether a page is a database row (its parent is a database). */
  isRow(p: PageMeta): boolean {
    return !!p.parentId && this.byId.get(p.parentId)?.kind === 'database';
  }

  children(id: string | null): PageMeta[] {
    return this.#pagesOf(this.#childIds.get(id ?? '') ?? []);
  }

  /** Ancestors from the top level down to (not including) the page. */
  ancestors(id: string): PageMeta[] {
    const out: PageMeta[] = [];
    let p = this.byId.get(id);
    const seen = new Set<string>();
    while (p?.parentId && !seen.has(p.parentId)) {
      seen.add(p.parentId);
      p = this.byId.get(p.parentId);
      if (p) out.unshift(p);
    }
    return out;
  }

  isInside(id: string, ancestorId: string): boolean {
    return id === ancestorId || this.ancestors(id).some((a) => a.id === ancestorId);
  }

  // ---------------------------------------------------------------- loading

  async load() {
    this.#setPages(await api.listPages(), true);
    this.loaded = true;
    // Forget expanded state of pages that no longer exist.
    for (const id of Object.keys(prefs.expanded)) {
      if (!this.byId.has(id)) delete prefs.expanded[id];
    }
    const lastView = VIEWS.find((v) => v === prefs.lastView);
    if (lastView) {
      this.go(lastView);
      return;
    }
    const last = prefs.lastPageId ? this.byId.get(prefs.lastPageId) : undefined;
    const start = last && !last.deletedAt ? last : this.roots[0];
    if (start) this.open(start.id);
    else this.go('home');
  }

  /** Reloads the page list, keeping local edits that aren't saved yet. */
  async refresh() {
    await this.#chain;
    const pages = (await api.listPages()).map((p) => {
      const patch = this.#pending.get(p.id);
      const fields = patch ? localFields(p, patch) : null;
      return fields ? { ...p, ...fields } : p;
    });
    this.#merge(pages);
  }

  /**
   * Takes a fresh page list but keeps the existing object of every page that
   * didn't change. Adding one page among thousands then re-renders that page
   * and its reordered siblings, not the whole sidebar.
   */
  #merge(next: PageMeta[]) {
    const byId = this.byId;
    let same = next.length === this.pages.length;
    let moved = !same;
    const merged = next.map((p, i) => {
      const cur = byId.get(p.id);
      if (!cur) {
        same = false;
        moved = true;
        return p;
      }
      let changed = false;
      for (const key of Object.keys(p) as (keyof PageMeta)[]) {
        const a = cur[key];
        const b = p[key];
        const equal = Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, j) => x === b[j]) : a === b;
        if (!equal) {
          changed = true;
          if (PLACE_FIELDS.has(key)) moved = true;
        }
      }
      if (changed || this.pages[i] !== cur) same = false;
      return changed ? p : cur;
    });
    if (!same) this.#setPages(merged, moved);
  }

  /** Takes pages made elsewhere (database rows) without reloading the list. */
  adopt(metas: PageMeta[]) {
    const fresh = metas.filter((m) => !this.byId.has(m.id));
    if (fresh.length) this.#setPages(this.pages.concat(fresh), true);
  }

  // ------------------------------------------------------------- navigation

  open(id: string, { push = true }: { push?: boolean } = {}) {
    const page = this.byId.get(id);
    if (!page || page.deletedAt) return;
    if (this.view === 'page' && this.currentId === id) return;
    this.view = 'page';
    this.tag = null;
    this.courseId = null;
    this.currentId = id;
    prefs.lastPageId = id;
    prefs.lastView = 'page';
    // Reveal the page in the sidebar.
    for (const a of this.ancestors(id)) prefs.expanded[a.id] = true;
    if (push) this.#push({ view: 'page', id });
  }

  /** Shows Home, Assignments, Calendar, Files or Flashcards. */
  go(view: AppView, { push = true }: { push?: boolean } = {}) {
    if (this.view === view) return;
    this.view = view;
    this.currentId = null;
    this.tag = null;
    this.courseId = null;
    prefs.lastView = view;
    if (push) this.#push({ view, id: null });
  }

  /** Shows everything tagged `name`. */
  openTag(name: string, { push = true }: { push?: boolean } = {}) {
    if (this.view === 'tag' && this.tag === name) return;
    this.view = 'tag';
    this.tag = name;
    this.courseId = null;
    this.currentId = null;
    if (push) this.#push({ view: 'tag', id: name });
  }

  /** Shows a course's hub: schedule, assignments, notes and details. */
  openCourse(id: string, { push = true }: { push?: boolean } = {}) {
    if (this.view === 'course' && this.courseId === id) return;
    this.view = 'course';
    this.courseId = id;
    this.tag = null;
    this.currentId = null;
    if (push) this.#push({ view: 'course', id });
  }

  /** Drops a deleted course from history (and leaves its hub). */
  forgetCourse(id: string) {
    const keep = this.#history.map((e, i) => ({ e, i })).filter(({ e }) => !(e.view === 'course' && e.id === id));
    const before = keep.filter(({ i }) => i <= this.#historyIndex).length;
    this.#history = keep.map(({ e }) => e);
    this.#historyIndex = Math.max(0, before - 1);
    if (this.view === 'course' && this.courseId === id) this.go('home');
  }

  #push(entry: Entry) {
    this.navDirection = 'push';
    const next = this.#history.slice(0, this.#historyIndex + 1);
    next.push(entry);
    if (next.length > 100) next.shift();
    this.#history = next;
    this.#historyIndex = next.length - 1;
  }

  back() {
    this.#step(-1);
  }

  forward() {
    this.#step(1);
  }

  #step(dir: 1 | -1) {
    this.navDirection = dir < 0 ? 'back' : 'forward';
    for (let i = this.#historyIndex + dir; i >= 0 && i < this.#history.length; i += dir) {
      if (this.#usable(this.#history[i])) {
        this.#historyIndex = i;
        this.#show(this.#history[i]);
        return;
      }
    }
  }

  /** Whether a history entry can still be shown (its page wasn't deleted). */
  #usable(entry: Entry | undefined): entry is Entry {
    if (!entry) return false;
    if (entry.view !== 'page') return true;
    const p = entry.id ? this.byId.get(entry.id) : undefined;
    return !!p && !p.deletedAt;
  }

  /** Shows a history entry without adding to history. */
  #show(entry: Entry) {
    if (entry.view === 'tag') this.openTag(entry.id ?? '', { push: false });
    else if (entry.view === 'course') this.openCourse(entry.id ?? '', { push: false });
    else if (entry.view === 'page') this.open(entry.id ?? '', { push: false });
    else this.go(entry.view, { push: false });
  }

  /** The place showing now. */
  get place(): Entry {
    return { view: this.view, id: this.view === 'page' ? this.currentId : this.view === 'tag' ? this.tag : this.view === 'course' ? this.courseId : null };
  }

  /** The active tab's history, to keep while another tab is showing. */
  saveNav(): Nav {
    return { history: this.#history.slice(), index: this.#historyIndex };
  }

  /** Shows another tab: its history, at its place (or the nearest earlier
   *  one that still exists, or Home). */
  loadNav(nav: Nav) {
    this.navDirection = 'tab';
    this.#history = nav.history.slice();
    let i = Math.min(nav.index, this.#history.length - 1);
    while (i >= 0 && !this.#usable(this.#history[i])) i--;
    if (i < 0) {
      this.#history = [{ view: 'home', id: null }];
      this.#historyIndex = 0;
      this.go('home', { push: false });
      return;
    }
    this.#historyIndex = i;
    this.#show(this.#history[i]);
  }

  /** After the current page disappears, land somewhere sensible. */
  #leave(removedId: string) {
    if (!this.currentId || !this.isInside(this.currentId, removedId)) return;
    const removed = this.byId.get(removedId);
    const parent = removed?.parentId ? this.byId.get(removed.parentId) : undefined;
    const fallback =
      parent && !parent.deletedAt
        ? parent
        : this.roots.find((p) => p.id !== removedId && !p.deletedAt);
    this.currentId = null;
    if (fallback) this.open(fallback.id);
  }

  // ---------------------------------------------------------------- editing

  async create(
    parentId: string | null = null,
    opts: { index?: number; open?: boolean; title?: string; icon?: string; content?: unknown[] } = {},
  ) {
    try {
      const meta = await api.createPage(parentId, opts.index ?? null, opts.title ?? '', opts.icon ?? '');
      // Starter blocks (a flashcard deck, lecture notes…).
      if (opts.content?.length) await api.updatePage(meta.id, { content: JSON.stringify({ type: 'doc', content: opts.content }) });
      await this.refresh();
      if (parentId) prefs.expanded[parentId] = true;
      if (opts.open !== false) {
        this.open(meta.id);
        ui.focusTitle = meta.id;
      }
      return meta;
    } catch (e) {
      ui.error(e);
      return null;
    }
  }

  // Pending writes are merged per page and flushed together.
  #pending = new Map<string, PagePatch>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();

  /** Updates a page locally right away and persists it shortly after. */
  update(id: string, patch: PagePatch, { immediate = false } = {}) {
    const page = this.byId.get(id);
    const fields = page ? localFields(page, patch) : null;
    if (fields) this.editOne(id, fields);
    this.#pending.set(id, { ...this.#pending.get(id), ...patch });
    clearTimeout(this.#timer);
    if (immediate) void this.flush();
    else this.#timer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /** Writes all pending changes. Safe to call at any time. */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    if (this.#pending.size === 0) return this.#chain;
    const batch = [...this.#pending];
    this.#pending.clear();
    this.saving = true;
    this.#chain = this.#chain.then(async () => {
      for (const [id, patch] of batch) {
        try {
          const updatedAt = await api.updatePage(id, patch);
          const page = this.byId.get(id);
          if (page && page.updatedAt !== updatedAt) this.editOne(id, { updatedAt });
          if (patch.content !== undefined) {
            window.dispatchEvent(new CustomEvent('td:page-saved', { detail: { id, content: patch.content } }));
          }
        } catch (e) {
          // The page may have been deleted meanwhile; nothing to save then.
          if (this.byId.has(id)) ui.error(e);
        }
      }
      if (this.#pending.size === 0) this.saving = false;
    });
    return this.#chain;
  }

  async move(id: string, parentId: string | null, index: number) {
    if (parentId && this.isInside(parentId, id)) return;
    try {
      await this.flush();
      await api.movePage(id, parentId, index);
      await this.refresh();
      if (parentId) prefs.expanded[parentId] = true;
    } catch (e) {
      ui.error(e);
    }
  }

  async duplicate(id: string) {
    try {
      await this.flush();
      const meta = await api.duplicatePage(id);
      await this.refresh();
      // A copied database or row brings its values along (databases.svelte.ts).
      window.dispatchEvent(new CustomEvent('td:pages-copied', { detail: meta.id }));
      this.open(meta.id);
    } catch (e) {
      ui.error(e);
    }
  }

  async trashPage(id: string) {
    const page = this.byId.get(id);
    if (!page) return;
    try {
      await this.flush();
      await api.trashPage(id);
      this.#leave(id);
      await this.refresh();
      ui.toast(t('app.movedToTrash', { title: page.title || t('common.untitled') }), {
        label: t('common.actions.undo'),
        run: () => void this.restore(id),
      });
    } catch (e) {
      ui.error(e);
    }
  }

  async restore(id: string) {
    try {
      await api.restorePage(id);
      await this.refresh();
      this.open(id);
    } catch (e) {
      ui.error(e);
    }
  }

  /** Permanently deletes a trashed page (the Trash confirms first). */
  async deleteForever(id: string) {
    try {
      await api.deletePage(id);
      await this.refresh();
    } catch (e) {
      ui.error(e);
    }
  }

  toggleFavorite(id: string) {
    const page = this.byId.get(id);
    if (page) this.update(id, { favorite: !page.favorite }, { immediate: true });
  }
}

export const store = new Store();
