/** Tags on pages, assignments, events and files. */

import { api } from './api';
import { colorVar } from './colors';
import { library } from './library.svelte';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import { ui } from './ui.svelte';
import { t } from './i18n';
import { fmt } from './i18n/format';
import type { Assignment, CalEvent, FileMeta, PageMeta, Tag, TrashTable } from './types';

/** Mirrors the backend's cleaning: "#Final Exam" → "final-exam". */
export function cleanTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .split(/\s+/)
    .filter(Boolean)
    .join('-')
    .replace(/[",]/g, '')
    .slice(0, 40)
    .toLowerCase();
}

export interface Tagged {
  pages: PageMeta[];
  assignments: Assignment[];
  events: CalEvent[];
  files: FileMeta[];
}

class Tags {
  list = $state<Tag[]>([]);

  /** Every tag in use, with how many live items carry it. */
  counts = $derived.by(() => {
    const counts = new Map<string, number>();
    const add = (tags: string[]) => {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    };
    // Tags and the trash are place fields: typing a title doesn't redo this.
    for (const p of store.placed.values()) if (!p.deletedAt) add(p.tags);
    for (const a of planner.live) add(a.tags);
    for (const e of planner.liveEvents) add(e.tags);
    for (const f of library.live) add(f.tags);
    return counts;
  });

  /** Tags that are in use, alphabetically. */
  used = $derived([...this.counts.keys()].sort(fmt.collator({}).compare));

  async load() {
    this.list = await api.listTags();
  }

  colorKey(name: string): string {
    return this.list.find((tag) => tag.name === name)?.color ?? '';
  }

  /** CSS colour of a tag; untagged-colour tags use the tint. */
  color(name: string): string {
    const key = this.colorKey(name);
    return key ? colorVar(key) : 'var(--tint)';
  }

  /** The tags of an item. */
  of(table: TrashTable, id: string): string[] {
    return this.#item(table, id)?.tags ?? [];
  }

  #item(table: TrashTable, id: string): { tags: string[] } | undefined {
    if (table === 'pages') return store.byId.get(id);
    if (table === 'assignments') return planner.assignmentById.get(id);
    if (table === 'events') return planner.eventById.get(id);
    return library.byId.get(id);
  }

  /** Replaces an item's tags (applied right away, then saved). */
  async set(table: TrashTable, id: string, tags: string[]) {
    const item = this.#item(table, id);
    if (!item) return;
    const clean = [...new Set(tags.map(cleanTag).filter(Boolean))];
    // Pages are never changed in place (see store.pages).
    const put = (list: string[]) => {
      if (table === 'pages') store.editOne(id, { tags: list });
      else item.tags = list;
    };
    put(clean);
    try {
      const saved = await api.setItemTags(table, id, clean);
      put(saved);
      for (const tag of saved) if (!this.list.some((x) => x.name === tag)) this.list.push({ name: tag, color: '' });
    } catch (e) {
      ui.error(e);
    }
  }

  itemsWith(name: string): Tagged {
    return {
      pages: store.all.filter((p) => !p.deletedAt && p.tags.includes(name)),
      assignments: planner.live.filter((a) => a.tags.includes(name)),
      events: planner.liveEvents.filter((e) => e.tags.includes(name)),
      files: library.live.filter((f) => f.tags.includes(name)),
    };
  }

  async recolor(name: string, color: string) {
    const tag = this.list.find((x) => x.name === name);
    if (tag) tag.color = color;
    else this.list.push({ name, color });
    try {
      await api.setTagColor(name, color);
    } catch (e) {
      ui.error(e);
    }
  }

  #replaceEverywhere(from: string, to: string | null) {
    const swap = (item: { tags: string[] }) => {
      if (!item.tags.includes(from)) return;
      item.tags = [...new Set(item.tags.flatMap((tag) => (tag === from ? (to ? [to] : []) : [tag])))];
    };
    const renamed = (tags: string[]) => [...new Set(tags.flatMap((tag) => (tag === from ? (to ? [to] : []) : [tag])))];
    store.edit(new Map(store.pages.filter((p) => p.tags.includes(from)).map((p) => [p.id, { tags: renamed(p.tags) }])));
    planner.assignments.forEach(swap);
    planner.events.forEach(swap);
    library.files.forEach(swap);
  }

  async rename(from: string) {
    const res = await ui.prompt({ title: t('pages.tag.renameTitle'), value: from, confirmLabel: t('common.actions.rename'), icon: 'tag' });
    if (!res) return;
    const to = cleanTag(res.value);
    if (!to || to === from) return;
    try {
      await api.renameTag(from, to);
      this.#replaceEverywhere(from, to);
      await this.load();
      if (store.view === 'tag' && store.tag === from) store.openTag(to, { push: false });
    } catch (e) {
      ui.error(e);
    }
  }

  async remove(name: string) {
    const n = this.counts.get(name) ?? 0;
    const ok = await ui.confirm({
      title: t('pages.tag.deleteTitle'),
      message: t('pages.tag.deleteMessage', { count: n, name }),
      confirmLabel: t('common.actions.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.renameTag(name, null);
      this.#replaceEverywhere(name, null);
      this.list = this.list.filter((tag) => tag.name !== name);
      if (store.view === 'tag' && store.tag === name) store.go('home');
    } catch (e) {
      ui.error(e);
    }
  }
}

export const tags = new Tags();
