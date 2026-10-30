/** UI preferences, persisted in localStorage (they are per-device anyway). */

import { ACCENTS, PALETTES, type Accent, type Palette } from './colors';
import type { ShortcutId } from './shortcuts.svelte';
import { oklchHex, parseHex, textOn } from './color-math';

/** A colour theme made on the wheel: a hue and how strongly it tints. */
export interface CustomTheme {
  /** 0–360 (OKLCH hue). */
  hue: number;
  /** 0 (neutral gray) to 1 (strongly tinted). */
  tint: number;
}

/** An accent made on the wheel (OKLCH: lightness 0–1, chroma 0–0.37). */
export interface CustomAccent {
  hue: number;
  chroma: number;
  lightness: number;
}

export type Theme = 'system' | 'light' | 'dark';
export type Font = 'sans' | 'serif' | 'mono';
/** How big page text is drawn (app.css: --page-fs). */
export type TextSize = 'small' | 'default' | 'large' | 'xlarge';
/** 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;
export type CalendarMode = 'month' | 'week';
export type FilesLayout = 'grid' | 'list';
export type AssignmentScope = 'upcoming' | 'all' | 'done';
/** When to be reminded of a due date: the evening before or that morning. */
export type RemindAssignments = 'off' | 'evening' | 'morning';
/** Minutes before a timed event (0 = off). */
export type RemindEvents = 0 | 5 | 10 | 15 | 30;

/** A tab as remembered between runs: where it is, and the live session it's in. */
export interface SavedTab {
  id: string;
  view: string;
  target: string | null;
  live: string | null;
}

interface Stored {
  theme: Theme;
  palette: Palette;
  accent: Accent;
  font: Font;
  textSize: TextSize;
  spellcheck: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  expanded: Record<string, boolean>;
  sections: Record<string, boolean>;
  /** Sidebar items turned off (see SIDEBAR_ITEMS): true = hidden. */
  sidebarHidden: Record<string, boolean>;
  lastPageId: string | null;
  /** Last place the user was ("page", "assignments", "calendar", "files"). */
  lastView: string;
  weekStart: WeekStart;
  calendarMode: CalendarMode;
  filesLayout: FilesLayout;
  assignmentScope: AssignmentScope;
  /** Study cards in a random order. */
  studyShuffle: boolean;
  /** Study answer first: show the back, recall the front. */
  studyReverse: boolean;
  /** System-wide Quick Capture shortcut (Ctrl+Shift+Space). */
  globalCapture: boolean;
  /** The page captured notes and to-dos go to. */
  inboxId: string | null;
  /** The "Get set up" card on Home was closed. */
  setupHidden: boolean;
  /** The Galaxy was turned on. It asks first: it's new, and it costs memory while open. */
  galaxyOn: boolean;
  /** What Home calls you ("Good morning, Sam"); empty for no name. */
  name: string;
  /** The welcome screen has been gone through (or this install predates it). */
  welcomed: boolean;
  /** Split view: whether the side pane is open, what it shows, and its share of the width. */
  splitOpen: boolean;
  splitPageId: string | null;
  splitRatio: number;
  remindAssignments: RemindAssignments;
  remindEvents: RemindEvents;
  /** The user's own shortcuts; null turns one off. Missing: the default. */
  shortcuts: Partial<Record<ShortcutId, string | null>>;
  customTheme: CustomTheme;
  customAccent: CustomAccent;
  /** The view last shown for each database. */
  dbViews: Record<string, string>;
  /** How big the whole app is drawn (1 = 100%), see zoom.svelte.ts. */
  zoom: number;
  /** Databases opened lately, newest first: their rows are read soon after start-up. */
  recentDbs: string[];
  /** Open tabs: each one's place (and live session), oldest first. */
  tabs: SavedTab[];
  activeTab: string | null;
  /** Your page for each live-session invite (or accepted request) until it goes live. */
  coworkPages: Record<string, string>;
}

/** Monday in most of the world, Sunday where the locale says so. */
function localeWeekStart(): WeekStart {
  type WeekInfo = { firstDay: number };
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
    const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    if (firstDay) return firstDay === 7 ? 0 : 1;
  } catch {
    /* no week info in this engine: fall through */
  }
  return navigator.language === 'en-US' ? 0 : 1;
}

const KEY = 'thoughtdesk.prefs.v1';

const defaults: Stored = {
  theme: 'system',
  palette: 'default',
  accent: 'graphite',
  font: 'sans',
  textSize: 'default',
  spellcheck: true,
  sidebarOpen: true,
  sidebarWidth: 260,
  expanded: {},
  sidebarHidden: {},
  sections: {},
  lastPageId: null,
  lastView: 'home',
  weekStart: localeWeekStart(),
  calendarMode: 'month',
  filesLayout: 'grid',
  assignmentScope: 'upcoming',
  studyShuffle: false,
  studyReverse: false,
  globalCapture: true,
  inboxId: null,
  setupHidden: false,
  galaxyOn: false,
  name: '',
  welcomed: false,
  splitOpen: false,
  splitPageId: null,
  splitRatio: 0.5,
  remindAssignments: 'evening',
  remindEvents: 10,
  shortcuts: {},
  customTheme: { hue: 250, tint: 0.5 },
  customAccent: { hue: 265, chroma: 0.2, lightness: 0.58 },
  dbViews: {},
  recentDbs: [],
  tabs: [],
  activeTab: null,
  coworkPages: {},
  zoom: 1,
};

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const stored = { ...defaults, ...parsed } as Stored;
      // Someone who used the app before the welcome screen existed doesn't get it now.
      if (!('welcomed' in parsed)) stored.welcomed = true;
      if (!ACCENTS.some((a) => a.key === stored.accent) && stored.accent !== 'custom') stored.accent = 'graphite';
      if (!PALETTES.some((p) => p.key === stored.palette) && stored.palette !== 'custom') stored.palette = 'default';
      if (!Array.isArray(stored.recentDbs)) stored.recentDbs = [];
      if (!Array.isArray(stored.tabs)) stored.tabs = [];
      if (!stored.coworkPages || typeof stored.coworkPages !== 'object') stored.coworkPages = {};
      if (!stored.sidebarHidden || typeof stored.sidebarHidden !== 'object') stored.sidebarHidden = {};
      // "Small text" was a switch before there were sizes.
      if (!('textSize' in parsed)) stored.textSize = parsed.smallText ? 'small' : 'default';
      if (!['small', 'default', 'large', 'xlarge'].includes(stored.textSize)) stored.textSize = 'default';
      delete (stored as { smallText?: boolean }).smallText;
      if (typeof stored.zoom !== 'number' || !(stored.zoom >= 0.5 && stored.zoom <= 3)) stored.zoom = 1;
      return stored;
    }
  } catch {
    /* corrupt or unavailable storage: fall back to defaults */
  }
  return { ...defaults };
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

class Prefs {
  #initial = read();
  theme = $state<Theme>(this.#initial.theme);
  palette = $state<Palette>(this.#initial.palette);
  accent = $state<Accent>(this.#initial.accent);
  font = $state<Font>(this.#initial.font);
  textSize = $state<TextSize>(this.#initial.textSize);
  spellcheck = $state(this.#initial.spellcheck);
  sidebarOpen = $state(this.#initial.sidebarOpen);
  sidebarWidth = $state(this.#initial.sidebarWidth);
  expanded = $state<Record<string, boolean>>(this.#initial.expanded);
  dbViews = $state<Record<string, string>>(this.#initial.dbViews);
  recentDbs = $state<string[]>(this.#initial.recentDbs);
  tabs = $state.raw<SavedTab[]>(this.#initial.tabs);
  activeTab = $state<string | null>(this.#initial.activeTab);
  coworkPages = $state.raw<Record<string, string>>(this.#initial.coworkPages);
  zoom = $state(this.#initial.zoom);
  sections = $state<Record<string, boolean>>(this.#initial.sections);
  sidebarHidden = $state<Record<string, boolean>>(this.#initial.sidebarHidden);
  lastPageId = $state<string | null>(this.#initial.lastPageId);
  lastView = $state(this.#initial.lastView);
  weekStart = $state<WeekStart>(this.#initial.weekStart);
  calendarMode = $state<CalendarMode>(this.#initial.calendarMode);
  filesLayout = $state<FilesLayout>(this.#initial.filesLayout);
  assignmentScope = $state<AssignmentScope>(this.#initial.assignmentScope);
  studyShuffle = $state(this.#initial.studyShuffle);
  studyReverse = $state(this.#initial.studyReverse);
  globalCapture = $state(this.#initial.globalCapture);
  inboxId = $state<string | null>(this.#initial.inboxId);
  setupHidden = $state(this.#initial.setupHidden);
  galaxyOn = $state(this.#initial.galaxyOn);
  name = $state(this.#initial.name);
  welcomed = $state(this.#initial.welcomed);
  splitOpen = $state(this.#initial.splitOpen);
  splitPageId = $state<string | null>(this.#initial.splitPageId);
  splitRatio = $state(this.#initial.splitRatio);
  remindAssignments = $state<RemindAssignments>(this.#initial.remindAssignments);
  remindEvents = $state<RemindEvents>(this.#initial.remindEvents);
  shortcuts = $state<Partial<Record<ShortcutId, string | null>>>(this.#initial.shortcuts);
  customTheme = $state<CustomTheme>(this.#initial.customTheme);
  customAccent = $state<CustomAccent>(this.#initial.customAccent);

  systemDark = $state(darkQuery.matches);
  resolvedTheme = $derived<'light' | 'dark'>(
    this.theme === 'system' ? (this.systemDark ? 'dark' : 'light') : this.theme,
  );

  toggleTheme() {
    this.theme = this.resolvedTheme === 'dark' ? 'light' : 'dark';
  }

  snapshot(): Stored {
    return {
      theme: this.theme,
      palette: this.palette,
      accent: this.accent,
      font: this.font,
      textSize: this.textSize,
      spellcheck: this.spellcheck,
      sidebarOpen: this.sidebarOpen,
      sidebarWidth: this.sidebarWidth,
      expanded: $state.snapshot(this.expanded),
      sections: $state.snapshot(this.sections),
      sidebarHidden: $state.snapshot(this.sidebarHidden),
      lastPageId: this.lastPageId,
      lastView: this.lastView,
      weekStart: this.weekStart,
      calendarMode: this.calendarMode,
      filesLayout: this.filesLayout,
      assignmentScope: this.assignmentScope,
      studyShuffle: this.studyShuffle,
      studyReverse: this.studyReverse,
      globalCapture: this.globalCapture,
      inboxId: this.inboxId,
      setupHidden: this.setupHidden,
      galaxyOn: this.galaxyOn,
      name: this.name,
      welcomed: this.welcomed,
      splitOpen: this.splitOpen,
      splitPageId: this.splitPageId,
      splitRatio: this.splitRatio,
      remindAssignments: this.remindAssignments,
      remindEvents: this.remindEvents,
      shortcuts: $state.snapshot(this.shortcuts),
      customTheme: $state.snapshot(this.customTheme),
      customAccent: $state.snapshot(this.customAccent),
      dbViews: $state.snapshot(this.dbViews),
      recentDbs: $state.snapshot(this.recentDbs),
      tabs: this.tabs,
      activeTab: this.activeTab,
      coworkPages: this.coworkPages,
      zoom: this.zoom,
    };
  }
}

export const prefs = new Prefs();

darkQuery.addEventListener('change', (e) => (prefs.systemDark = e.matches));

let saveTimer: ReturnType<typeof setTimeout> | undefined;

$effect.root(() => {
  // Apply theme and typography to the document.
  $effect(() => {
    const root = document.documentElement;
    root.dataset.theme = prefs.resolvedTheme;
    root.dataset.accent = prefs.accent;
    root.dataset.palette = prefs.palette;
    root.dataset.font = prefs.font;
    root.dataset.textSize = prefs.textSize;
    root.style.colorScheme = prefs.resolvedTheme;
  });
  // A theme made on the colour wheel: its hue and tint feed app.css.
  $effect(() => {
    const style = document.documentElement.style;
    if (prefs.palette === 'custom') {
      style.setProperty('--th', prefs.customTheme.hue.toFixed(1));
      style.setProperty('--tc', prefs.customTheme.tint.toFixed(3));
    } else {
      style.removeProperty('--th');
      style.removeProperty('--tc');
    }
  });
  // An accent made on the colour wheel, with marks that stay legible on it.
  $effect(() => {
    const style = document.documentElement.style;
    if (prefs.accent === 'custom') {
      const { hue, chroma, lightness } = prefs.customAccent;
      const hex = oklchHex(lightness, chroma, hue);
      const light = textOn(parseHex(hex)!) === 'light';
      style.setProperty('--accent', hex);
      style.setProperty('--on-accent', light ? '#ffffff' : '#1d1d1f');
      style.setProperty('--check', light ? 'var(--check-white)' : 'var(--check-black)');
    } else {
      for (const p of ['--accent', '--on-accent', '--check']) style.removeProperty(p);
    }
  });
  // Persist (debounced) whenever anything changes.
  $effect(() => {
    const data = prefs.snapshot();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(data), 250);
  });
});

function save(data: ReturnType<Prefs['snapshot']>) {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable: preferences just won't persist */
  }
}

/** Writes a change still waiting out the debounce, so closing, minimizing or
 *  reloading right after changing a setting doesn't lose it. */
function saveNow() {
  if (saveTimer !== undefined) save(prefs.snapshot());
}
window.addEventListener('td:flush', saveNow);
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});
