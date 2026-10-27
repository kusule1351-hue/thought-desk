/**
 * Page icons: an emoji, or one of the app's line icons with an optional
 * colour ("icon:book-open" or "icon:book-open:blue").
 */

import { PALETTE, type ColorKey } from './colors';
import { PAGE_ICONS, PAGE_ICON_GROUPS, PAGE_ICON_GROUP_LABELS, type PageIconDef } from './page-icons-data';

export { PAGE_ICONS, PAGE_ICON_GROUPS, PAGE_ICON_GROUP_LABELS };

const BY_NAME = new Map<string, PageIconDef>(PAGE_ICONS.map((i) => [i.name, i]));

export type ParsedIcon = { kind: 'emoji'; text: string } | { kind: 'icon'; def: PageIconDef; color: string | null };

/** What a stored icon is, or null for none (or a line icon this version doesn't know). */
export function parseIcon(value: string | null | undefined): ParsedIcon | null {
  if (!value) return null;
  if (!value.startsWith('icon:')) return { kind: 'emoji', text: value };
  const [, name, color] = value.split(':');
  const def = BY_NAME.get(name);
  return def ? { kind: 'icon', def, color: color || null } : null;
}

export const lineIcon = (name: string, color?: string | null) => (color ? `icon:${name}:${color}` : `icon:${name}`);

/** The icon as text, where only text fits (calendar chips, window titles): an emoji, or nothing. */
export const iconText = (value: string | null | undefined) => (value && !value.startsWith('icon:') ? value : '');

/** Colours a line icon can take (none means it follows the text). */
export type IconColor = Exclude<ColorKey, 'gray'>;
export const ICON_COLORS = PALETTE.map((c) => c.key).filter((k): k is IconColor => k !== 'gray');

/** A random line icon in a random colour, for "Add icon". */
export function randomIcon(): string {
  const pool = PAGE_ICONS.filter((i) => i.group !== 'life');
  const def = pool[Math.floor(Math.random() * pool.length)];
  return lineIcon(def.name, ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)]);
}

/** Draws an icon into a plain element (for editor node views, outside Svelte). */
export function renderIcon(el: HTMLElement, value: string | null | undefined) {
  const parsed = parseIcon(value);
  if (parsed?.kind !== 'icon') {
    el.textContent = parsed?.text ?? '';
    return;
  }
  const color = parsed.color ? `style="color:var(--c-${parsed.color})"` : '';
  el.innerHTML = `<svg class="page-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${color} aria-hidden="true">${parsed.def.svg}</svg>`;
}
