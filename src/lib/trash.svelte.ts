/** One Trash for everything: pages, assignments, events and files. */

import { api } from './api';
import { t, type MessageKey } from './i18n';
import { library } from './library.svelte';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import { ui } from './ui.svelte';
import type { FileMeta, TrashTable } from './types';

export interface TrashItem {
  table: TrashTable;
  id: string;
  title: string;
  /** Where it came from, e.g. the parent page or the course. */
  origin: string | null;
  emoji?: string;
  icon: string;
  color?: string;
  file?: FileMeta;
  deletedAt: number;
}

/** What each kind is called: `item` beside one deleted item ("Page"), `filter` on the button that shows only that kind ("Pages"). */
export const TABLE_LABELS = {
  pages: { item: 'onboarding.trash.kinds.page', filter: 'onboarding.trash.chips.pages' },
  assignments: { item: 'onboarding.trash.kinds.assignment', filter: 'onboarding.trash.chips.assignments' },
  events: { item: 'onboarding.trash.kinds.event', filter: 'onboarding.trash.chips.events' },
  files: { item: 'onboarding.trash.kinds.file', filter: 'onboarding.trash.chips.files' },
} as const satisfies Record<TrashTable, { item: MessageKey; filter: MessageKey }>;

/** Everything in the trash, most recently deleted first. */
export function trashItems(): TrashItem[] {
  const items: TrashItem[] = [];
  for (const p of store.trash) {
    const path = store.ancestors(p.id);
    items.push({
      table: 'pages',
      id: p.id,
      title: p.title || t('common.untitled'),
      origin: path.length ? path.map((a) => a.title || t('common.untitled')).join(' › ') : null,
      emoji: p.icon || undefined,
      icon: 'page',
      deletedAt: p.deletedAt ?? 0,
    });
  }
  for (const a of planner.assignments) {
    if (!a.deletedAt) continue;
    items.push({
      table: 'assignments',
      id: a.id,
      title: a.title || t('common.untitled'),
      origin: a.courseId ? (planner.courseById.get(a.courseId)?.name ?? null) : null,
      icon: 'assignment',
      color: planner.courseColor(a.courseId),
      deletedAt: a.deletedAt,
    });
  }
  for (const e of planner.events) {
    if (!e.deletedAt) continue;
    items.push({
      table: 'events',
      id: e.id,
      title: e.title || t('common.untitled'),
      origin: null,
      icon: 'calendar',
      color: planner.eventColor(e),
      deletedAt: e.deletedAt,
    });
  }
  for (const f of library.files) {
    if (!f.deletedAt) continue;
    items.push({ table: 'files', id: f.id, title: f.name, origin: null, icon: 'file', file: f, deletedAt: f.deletedAt });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function restoreItem(item: TrashItem) {
  if (item.table === 'pages') await store.restore(item.id);
  else if (item.table === 'files') await library.restore(item.id);
  else await planner.restore(item.table, item.id);
}

export async function deleteItem(item: TrashItem) {
  const ok = await ui.confirm({
    title: t('onboarding.trash.deleteTitle'),
    message:
      item.table === 'pages'
        ? t('onboarding.trash.deletePage', { title: item.title })
        : t('onboarding.trash.deleteItem', { title: item.title }),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  if (item.table === 'pages') await store.deleteForever(item.id);
  else if (item.table === 'files') await library.deleteForever(item.id);
  else await planner.deleteForever(item.table, item.id);
}

export async function emptyTrash(count: number) {
  if (count === 0) return;
  const ok = await ui.confirm({
    title: t('onboarding.trash.emptyTitle'),
    message: t('onboarding.trash.emptyMessage', { count }),
    confirmLabel: t('onboarding.trash.emptyTrash'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.emptyTrash();
    await Promise.all([store.refresh(), planner.load(), library.load()]);
  } catch (e) {
    ui.error(e);
  }
}
