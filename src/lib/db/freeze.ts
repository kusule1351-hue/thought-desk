/**
 * Frozen leading columns in a table view.
 *
 * A view stores the id of the property its pin ends at (`freezeThrough`), not
 * a column position, so reordering, renaming and hiding follow the property.
 * The frozen prefix is always every visible column through that property: the
 * table never silently drops columns or narrows them to fit.
 *
 * A new boundary is offered only while the whole prefix fits in the measured
 * table viewport and leaves at least one CSS pixel of the next real column
 * visible. The menu and the rendered prefix both use the helpers below, so
 * what the menu promises and what the table pins cannot disagree.
 */

import { t } from '../i18n';

/** The leading selection/drag gutter, in CSS px. */
export const GUTTER = 40;
/** The least part of the next real column that must stay visible, in CSS px. */
export const MIN_NEXT_COLUMN = 1;
/** Shown when a boundary cannot be offered at the current width. */
export const NO_ROOM = t('dbEdit.property.freezeNoRoom');

export interface FreezeColumn {
  id: string;
  /** Its rendered width at the current zoom, in CSS px. */
  width: number;
}

export interface FreezePlan {
  /** The view asks for a freeze. */
  configured: boolean;
  /** The boundary property is gone: render unfrozen, don't rewrite the view. */
  unresolved: boolean;
  /** Property ids the view asks to freeze, in schema order. */
  wanted: string[];
  /** Property ids pinned now: the complete visible prefix through the boundary. */
  pinned: string[];
  /** The saved prefix no longer leaves room for the next real column. */
  overflow: boolean;
  /** Width of the pinned strip, gutter included, in CSS px. */
  width: number;
  /** The measured table viewport; 0 until the table has been measured. */
  viewport: number;
}

export interface FreezeCheck {
  /** The boundary can be chosen at this width. */
  eligible: boolean;
  /** Why it cannot, ready to show in the menu. Empty when eligible. */
  reason: string;
  /** Complete visible prefix through the boundary (pinned later). */
  prefix: string[];
  /** Width of that prefix, gutter included, in CSS px. */
  width: number;
}

/** Width of the pinned strip for these columns, gutter included. */
export function pinnedWidth(columns: FreezeColumn[]): number {
  return GUTTER + columns.reduce((n, c) => n + c.width, 0);
}

const EMPTY: FreezePlan = {
  configured: false,
  unresolved: false,
  wanted: [],
  pinned: [],
  overflow: false,
  width: 0,
  viewport: 0,
};

/**
 * The visible columns up to and including the boundary's schema position.
 * A hidden boundary still freezes the visible prefix before it; an unknown
 * boundary freezes nothing (and is reported so rendering can leave it alone).
 */
export function freezePrefix(
  propIds: string[],
  columns: FreezeColumn[],
  freezeThrough: string | null | undefined,
): { wanted: FreezeColumn[]; configured: boolean; unresolved: boolean } {
  if (!freezeThrough) return { wanted: [], configured: false, unresolved: false };
  const at = propIds.indexOf(freezeThrough);
  if (at < 0) return { wanted: [], configured: true, unresolved: true };
  const wanted: FreezeColumn[] = [];
  for (const col of columns) {
    const schemaAt = propIds.indexOf(col.id);
    if (schemaAt < 0 || schemaAt > at) break;
    wanted.push(col);
  }
  return { wanted, configured: true, unresolved: false };
}

/**
 * The pins to draw at a viewport `viewport` px wide (the table body's
 * clientWidth, so a vertical scrollbar is already excluded). The complete
 * requested prefix is pinned even after a resize makes it too wide; `overflow`
 * asks the UI for its compact Unfreeze hint rather than rewriting the view.
 */
export function planFreeze(args: {
  propIds: string[];
  columns: FreezeColumn[];
  freezeThrough?: string | null;
  viewport: number;
}): FreezePlan {
  const { wanted, configured, unresolved } = freezePrefix(args.propIds, args.columns, args.freezeThrough);
  if (!configured) return EMPTY;
  if (unresolved) return { ...EMPTY, configured: true, unresolved: true, viewport: args.viewport };
  if (!wanted.length) return { ...EMPTY, configured: true, viewport: args.viewport };

  const width = pinnedWidth(wanted);
  // The boundary can be the last real column only if a later resize hides the
  // one after it. Then a cut-off strip is still worth a hint, but there is no
  // next column whose sliver could be demanded.
  const wantsNext = wanted.length < args.columns.length;
  const overflow = args.viewport > 0 && width + (wantsNext ? MIN_NEXT_COLUMN : 0) > args.viewport;
  return {
    configured: true,
    unresolved: false,
    wanted: wanted.map((c) => c.id),
    pinned: wanted.map((c) => c.id),
    overflow,
    width,
    viewport: args.viewport,
  };
}

/**
 * Whether this property can become the new freeze boundary right now.
 * The measured viewport is the table body's clientWidth (no vertical
 * scrollbar); the prefix starts with the 40px gutter and uses rendered widths.
 * The selected column must be fully inside that strip and at least
 * MIN_NEXT_COLUMN px of the next visible real column must remain to scroll.
 * The add-column button and the blank filler are not real columns.
 */
export function freezeEligibility(args: {
  propIds: string[];
  columns: FreezeColumn[];
  freezeThrough: string;
  viewport: number;
}): FreezeCheck {
  const block = (prefix: string[] = [], width = 0): FreezeCheck => ({
    eligible: false,
    reason: NO_ROOM,
    prefix,
    width,
  });

  const at = args.columns.findIndex((c) => c.id === args.freezeThrough);
  if (at < 0) return block();
  const { wanted, unresolved } = freezePrefix(args.propIds, args.columns, args.freezeThrough);
  if (unresolved || !wanted.length) return block();
  if (at >= args.columns.length - 1) return block(wanted.map((c) => c.id), pinnedWidth(wanted));

  const width = pinnedWidth(wanted);
  if (args.viewport <= 0) return block(wanted.map((c) => c.id), width);
  // Keep one CSS pixel of the next real column; a half-pixel rounding
  // tolerance stops a fractional zoom width from flickering the item.
  if (args.viewport - width < MIN_NEXT_COLUMN - 0.5) return block(wanted.map((c) => c.id), width);

  return { eligible: true, reason: '', prefix: wanted.map((c) => c.id), width };
}
