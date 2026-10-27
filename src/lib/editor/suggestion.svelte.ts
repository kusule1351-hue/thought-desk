/** Shared popup renderer for "/" commands and "@" page links. */

import type { Editor, Range } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { mount, unmount } from 'svelte';
import SuggestionList from './SuggestionList.svelte';

export interface MenuEntry {
  id: string;
  title: string;
  description?: string;
  /** Icon name, short text label, or emoji for the glyph box. */
  icon?: string;
  label?: string;
  emoji?: string;
  hint?: string;
  /** The section it's listed under (an id), and the section's heading. */
  group?: string;
  groupLabel?: string;
  keywords?: string;
  run: (editor: Editor, range: Range) => void;
}

export interface SuggestionState {
  items: MenuEntry[];
  selected: number;
  rect: DOMRect | null;
  empty: string;
  pick: (index: number) => void;
}

export function suggestionRenderer(empty: string) {
  return () => {
    let target: HTMLDivElement | null = null;
    let component: ReturnType<typeof mount> | null = null;
    let command: ((item: MenuEntry) => void) | null = null;

    const ctl: SuggestionState = $state({
      items: [],
      selected: 0,
      rect: null,
      empty,
      pick: (i: number) => {
        const item = ctl.items[i];
        if (item && command) command(item);
      },
    });

    /** What was typed after the "/" or "@" for the list shown now. */
    let query = '';
    const sync = (props: SuggestionProps<MenuEntry, MenuEntry>) => {
      command = props.command;
      ctl.rect = props.clientRect?.() ?? null;
      // Tiptap empties the list while it fetches it again, which it also does
      // when only the text moved (the other person in a shared page typed
      // above it): keep showing the list until the new one comes.
      if (props.loading && !props.items.length) return;
      const changed = props.items.length !== ctl.items.length || props.items.some((it, i) => it.id !== ctl.items[i]?.id);
      const picked = ctl.items[ctl.selected]?.id;
      ctl.items = props.items;
      // A new list starts at the top, unless the search is the same, when
      // the highlighted entry stays highlighted.
      if (changed) ctl.selected = props.query === query ? Math.max(0, props.items.findIndex((it) => it.id === picked)) : 0;
      query = props.query;
    };

    return {
      onStart(props: SuggestionProps<MenuEntry, MenuEntry>) {
        target = document.createElement('div');
        document.body.appendChild(target);
        component = mount(SuggestionList, { target, props: { ctl } });
        sync(props);
      },
      onUpdate(props: SuggestionProps<MenuEntry, MenuEntry>) {
        sync(props);
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        const n = ctl.items.length;
        if (event.key === 'ArrowDown') {
          if (n) ctl.selected = (ctl.selected + 1) % n;
          return true;
        }
        if (event.key === 'ArrowUp') {
          if (n) ctl.selected = (ctl.selected - 1 + n) % n;
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!n) return false;
          ctl.pick(ctl.selected);
          return true;
        }
        return false;
      },
      onExit() {
        if (component) void unmount(component);
        target?.remove();
        component = null;
        target = null;
      },
    };
  };
}

/**
 * Lowercases and drops accents, punctuation and spaces, so "todo" matches
 * "To-do" and "pagina" matches "Página". Only the accents of the Latin,
 * Greek and Cyrillic alphabets (U+0300–U+036F) go: other scripts' marks
 * are letters' vowels (Hindi, Thai) or change the sound (Japanese ゛),
 * and dropping them would make unrelated words match. NFC afterwards puts
 * Korean syllables back together.
 */
const squash = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/** How well an entry's title/keywords match a (lowercased) query; 0 = not at all. */
export function matchScore(item: { title: string; keywords?: string }, q: string): number {
  const sq = squash(q);
  const title = item.title.toLowerCase();
  const words = `${title} ${item.keywords ?? ''}`.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q) || (sq && squash(title).startsWith(sq))) return 80;
  if (words.split(/\s+/).some((w) => w.startsWith(q) || (sq && squash(w).startsWith(sq)))) return 60;
  if (words.includes(q)) return 40;
  if (sq.length > 1 && isSubsequence(sq, squash(title))) return 10;
  return 0;
}

/** Ranks entries by how well their title/keywords match the query. */
export function rank<T extends { title: string; keywords?: string }>(items: T[], query: string, limit = 50): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = matchScore(item, q);
    if (score) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/**
 * Ranks several kinds of entries (pages, assignments…), each kept together
 * under its heading, with the kind holding the best match listed first.
 */
export function rankGroups<T extends { title: string; keywords?: string }>(groups: [T[], number][], query: string): T[] {
  const q = query.trim().toLowerCase();
  return groups
    .map(([items, limit], order) => {
      const ranked = rank(items, q, limit);
      return { ranked, order, best: ranked.length ? matchScore(ranked[0], q) : 0 };
    })
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .flatMap((g) => g.ranked);
}
