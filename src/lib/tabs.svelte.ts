/**
 * Tabs, like a browser's: each one a place in the app with its own back and
 * forward history. The active tab's history lives in the store, so
 * everything that navigates (store.open, store.go, …) simply moves the active
 * tab. The others keep theirs here with nothing mounted, so a tab costs no
 * memory until it's shown.
 */

import { t, type MessageKey, type PluralKey } from './i18n';
import { prefs } from './prefs.svelte';
import { planner } from './planner.svelte';
import { store, VIEWS, type AppView, type Entry, type Nav, type View } from './store.svelte';

export interface Tab {
  id: string;
  /** Where it is. For the active tab, the store's place is the live one (see placeOf). */
  place: Entry;
  /** Its history while another tab is active; null while it's active. */
  nav: Nav | null;
  /** The live session (cowork) it shows, if any. */
  live: string | null;
  /** The tab it was opened from, so tabs opened one after another stay in order. */
  opener?: string;
}

const VIEW_LABELS: Record<AppView, { title: Exclude<MessageKey, PluralKey>; icon: string }> = {
  home: { title: 'common.views.home', icon: 'home' },
  assignments: { title: 'common.views.assignments', icon: 'assignment' },
  calendar: { title: 'common.views.calendar', icon: 'calendar' },
  files: { title: 'common.views.files', icon: 'files' },
  cards: { title: 'common.views.flashcards', icon: 'cards' },
  friends: { title: 'common.views.friends', icon: 'users' },
  galaxy: { title: 'common.views.galaxy', icon: 'galaxy' },
};

const KNOWN_VIEWS = new Set<string>(['page', 'tag', 'course', ...VIEWS]);

const fresh = (place: Entry, live: string | null = null): Tab => ({ id: crypto.randomUUID(), place, nav: { history: [place], index: 0 }, live });

class Tabs {
  list = $state<Tab[]>([]);
  activeId = $state('');
  /** Called when a tab closes (a live session ends with its tab). */
  onClose: ((tab: Tab) => void) | null = null;

  get active(): Tab | undefined {
    return this.list.find((tab) => tab.id === this.activeId);
  }

  /** Where a tab is now. */
  placeOf(tab: Tab): Entry {
    return tab.id === this.activeId ? store.place : tab.place;
  }

  /** A place's name and icon: a page's own, or the view's. */
  label(place: Entry): { title: string; icon: string; pageIcon: string } {
    if (place.view === 'page') {
      const p = place.id ? store.byId.get(place.id) : undefined;
      const db = p?.kind === 'database';
      return { title: p?.title || (db ? t('common.untitledDatabase') : t('common.untitled')), icon: db ? 'database' : 'page', pageIcon: p?.icon ?? '' };
    }
    if (place.view === 'tag') return { title: `#${place.id ?? ''}`, icon: 'tag', pageIcon: '' };
    if (place.view === 'course') return { title: planner.courseById.get(place.id ?? '')?.name || t('common.course'), icon: 'book', pageIcon: '' };
    const view = VIEW_LABELS[place.view];
    return { title: t(view.title), icon: view.icon, pageIcon: '' };
  }

  /** Brings back last run's tabs, once the store has loaded (which already
   *  showed the last place). Then remembers them as they change. */
  init() {
    const saved = prefs.tabs.filter((entry) => KNOWN_VIEWS.has(entry.view));
    if (saved.length) {
      this.list = saved.map((entry) => ({ ...fresh({ view: entry.view as View, id: entry.target }, entry.live), id: entry.id }));
      this.activeId = (this.list.find((tab) => tab.id === prefs.activeTab) ?? this.list[this.list.length - 1]).id;
      const active = this.active!;
      const nav = active.nav!;
      active.nav = null;
      store.loadNav(nav);
    } else {
      const tab = fresh(store.place);
      tab.nav = null;
      this.list = [tab];
      this.activeId = tab.id;
    }
    $effect.root(() => {
      $effect(() => {
        prefs.tabs = this.list.map((tab) => {
          const place = this.placeOf(tab);
          return { id: tab.id, view: place.view, target: place.id, live: tab.live };
        });
        prefs.activeTab = this.activeId;
      });
    });
  }

  /** Opens a place in a new tab after the active one (and after the tabs
   *  already opened from it, so a run of them keeps its order, as in a browser). */
  open(place: Entry, { focus = true, live = null }: { focus?: boolean; live?: string | null } = {}): Tab {
    const tab: Tab = { ...fresh(place, live), opener: this.activeId };
    let at = this.list.findIndex((x) => x.id === this.activeId);
    while (at + 1 < this.list.length && this.list[at + 1].opener === this.activeId) at++;
    const next = this.list.slice();
    next.splice(at + 1, 0, tab);
    this.list = next;
    if (focus) this.activate(tab.id);
    return this.list.find((x) => x.id === tab.id)!;
  }

  openPage(id: string, opts?: { focus?: boolean; live?: string | null }): Tab {
    return this.open({ view: 'page', id }, opts);
  }

  /** A new tab on Home. */
  newTab(): Tab {
    return this.open({ view: 'home', id: null });
  }

  /** Shows a tab: the one being left keeps its history, this one gets its own back. */
  activate(id: string) {
    if (id === this.activeId) return;
    const to = this.list.find((tab) => tab.id === id);
    if (!to) return;
    const from = this.active;
    if (from) {
      from.nav = store.saveNav();
      from.place = store.place;
    }
    this.activeId = id;
    const nav = to.nav ?? { history: [to.place], index: 0 };
    to.nav = null;
    store.loadNav(nav);
  }

  /** Closes a tab (never the last one); closing the active tab shows its neighbour. */
  close(id: string) {
    if (this.list.length < 2) return;
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const tab = this.list[i];
    if (id === this.activeId) this.activate((this.list[i + 1] ?? this.list[i - 1]).id);
    this.list = this.list.filter((x) => x.id !== id);
    this.onClose?.(tab);
  }

  /** The next (1) or previous (-1) tab, wrapping around. */
  step(dir: 1 | -1) {
    if (this.list.length < 2) return;
    const i = this.list.findIndex((x) => x.id === this.activeId);
    this.activate(this.list[(i + dir + this.list.length) % this.list.length].id);
  }
}

export const tabs = new Tabs();
