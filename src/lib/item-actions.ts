/** Context menus for assignments and events, shared by every view that shows them. */

import { calendar } from './calendar.svelte';
import { addDays, startOfWeek, todayISO } from './dates';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import { ui, type MenuItem } from './ui.svelte';
import { t } from './i18n';

/** Opens an item's notes page, creating it first if needed. */
export async function openNotesPage(kind: 'assignment' | 'event', id: string) {
  const item = kind === 'assignment' ? planner.assignmentById.get(id) : planner.eventById.get(id);
  if (!item) return;
  const linked = item.pageId ? store.byId.get(item.pageId) : undefined;
  const pageId = linked && !linked.deletedAt ? linked.id : await planner.createNotesPage(kind, id);
  if (!pageId) return;
  ui.assignmentSheet = null;
  ui.eventSheet = null;
  store.open(pageId);
}

export function assignmentMenuItems(id: string): MenuItem[] {
  const a = planner.assignmentById.get(id);
  if (!a) return [];
  const today = todayISO();
  const nextWeek = addDays(startOfWeek(today, 1), 7);
  const due = (date: string | null) => () => planner.updateAssignment(id, { dueDate: date }, { immediate: true });
  const hasPage = !!(a.pageId && store.byId.get(a.pageId) && !store.byId.get(a.pageId)!.deletedAt);
  return [
    { label: t('common.actions.open'), icon: 'assignment', action: () => planner.openAssignment(id) },
    {
      label: a.status === 'done' ? t('pages.assignment.markNotDone') : t('pages.assignment.markDone'),
      icon: 'check',
      action: () => planner.toggleDone(id),
    },
    {
      label: t('pages.assignment.inProgress'),
      icon: 'clock',
      checked: a.status === 'doing',
      action: () => planner.updateAssignment(id, { status: a.status === 'doing' ? 'todo' : 'doing' }, { immediate: true }),
    },
    { separator: true },
    { header: t('pages.assignment.due') },
    { label: t('common.today'), icon: 'today', checked: a.dueDate === today, action: due(today) },
    { label: t('common.tomorrow'), icon: 'calendar', checked: a.dueDate === addDays(today, 1), action: due(addDays(today, 1)) },
    { label: t('pages.assignment.nextWeek'), icon: 'calendar', checked: a.dueDate === nextWeek, action: due(nextWeek) },
    { label: t('pages.assignment.noDueDate'), icon: 'x', disabled: !a.dueDate, action: due(null) },
    { separator: true },
    { label: hasPage ? t('pages.item.openNotesPage') : t('pages.item.createNotesPage'), icon: 'note', action: () => void openNotesPage('assignment', id) },
    {
      label: t('pages.item.showInCalendar'),
      icon: 'calendar',
      disabled: !a.dueDate || store.view === 'calendar',
      action: () => a.dueDate && calendar.show(a.dueDate),
    },
    { separator: true },
    { label: t('common.actions.moveToTrash'), icon: 'trash', danger: true, action: () => void planner.trash('assignments', id) },
  ];
}

export function eventMenuItems(id: string, date?: string): MenuItem[] {
  const e = planner.eventById.get(id);
  if (!e) return [];
  const repeats = e.repeat !== 'none';
  const items: MenuItem[] = [{ label: t('common.actions.open'), icon: 'calendar', action: () => planner.openEvent(id, date) }];
  if (date || !repeats) {
    // Notes for this session (a one-off event has just the one).
    const session = date ?? e.startDate;
    const has = !!planner.sessionPage(id, session);
    items.push({ label: has ? t('pages.event.openNotes') : t('pages.event.takeNotes'), icon: 'note', action: () => void planner.takeNotes(id, session) });
  } else {
    const hasPage = !!(e.pageId && store.byId.get(e.pageId) && !store.byId.get(e.pageId)!.deletedAt);
    items.push({ label: hasPage ? t('pages.item.openNotesPage') : t('pages.item.createNotesPage'), icon: 'note', action: () => void openNotesPage('event', id) });
  }
  items.push({
    label: t('pages.item.showInCalendar'),
    icon: 'calendar',
    disabled: store.view === 'calendar',
    action: () => calendar.show(date ?? e.startDate),
  });
  items.push({ separator: true });
  if (repeats && date) {
    items.push({ label: t('pages.event.skipDate'), icon: 'x', action: () => planner.skipDate(id, date) });
  }
  items.push({
    label: repeats ? t('pages.event.deleteSeries') : t('common.actions.moveToTrash'),
    icon: 'trash',
    danger: true,
    action: () => void planner.trash('events', id),
  });
  return items;
}
