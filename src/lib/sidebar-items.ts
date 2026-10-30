/** The sidebar items that can be turned off (Pages always shows), and hiding them. */

import { t, type MessageKey } from './i18n';
import { prefs } from './prefs.svelte';
import { ui } from './ui.svelte';

/** An item's id, as prefs.sidebarHidden keeps it. */
export type SidebarItem = 'home' | 'assignments' | 'calendar' | 'files' | 'cards' | 'friends' | 'galaxy' | 'favorites' | 'courses' | 'databases' | 'tags';

export const SIDEBAR_ITEMS: { key: SidebarItem; label: string }[] = [
  { key: 'home', label: t('common.views.home') },
  { key: 'assignments', label: t('common.views.assignments') },
  { key: 'calendar', label: t('common.views.calendar') },
  { key: 'files', label: t('common.views.files') },
  { key: 'cards', label: t('common.views.flashcards') },
  { key: 'friends', label: t('common.views.friends') },
  { key: 'galaxy', label: t('common.views.galaxy') },
  { key: 'favorites', label: t('shell.sidebar.sections.favorites') },
  { key: 'courses', label: t('shell.sidebar.sections.courses') },
  { key: 'databases', label: t('shell.sidebar.sections.databases') },
  { key: 'tags', label: t('common.tags') },
];

/** What the toast says once an item is hidden: a sentence for each, since another language may word it around the name. */
const HIDDEN = {
  home: 'shell.sidebar.hidden.home',
  assignments: 'shell.sidebar.hidden.assignments',
  calendar: 'shell.sidebar.hidden.calendar',
  files: 'shell.sidebar.hidden.files',
  cards: 'shell.sidebar.hidden.flashcards',
  friends: 'shell.sidebar.hidden.friends',
  galaxy: 'shell.sidebar.hidden.galaxy',
  favorites: 'shell.sidebar.hidden.favorites',
  courses: 'shell.sidebar.hidden.courses',
  databases: 'shell.sidebar.hidden.databases',
  tags: 'shell.sidebar.hidden.tags',
} as const satisfies Record<SidebarItem, MessageKey>;

export function shownInSidebar(key: string): boolean {
  return !prefs.sidebarHidden[key];
}

export function setShownInSidebar(key: string, shown: boolean) {
  prefs.sidebarHidden[key] = !shown;
}

/** Hides an item, saying so with a way to undo it. */
export function hideFromSidebar(key: SidebarItem) {
  setShownInSidebar(key, false);
  ui.toast(t(HIDDEN[key]), { label: t('common.actions.undo'), run: () => setShownInSidebar(key, true) });
}

/** Right-click on a sidebar item: hide it, or open the list of them all. */
export function sidebarItemMenu(e: MouseEvent, key: SidebarItem) {
  e.preventDefault();
  e.stopPropagation();
  ui.openMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        label: t('shell.sidebar.hideItem'),
        icon: 'eye-off',
        action: () => hideFromSidebar(key),
      },
      { label: t('shell.sidebar.customize'), icon: 'sliders', action: () => (ui.settingsOpen = true) },
    ],
  });
}
