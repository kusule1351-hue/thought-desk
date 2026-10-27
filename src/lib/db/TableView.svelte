<script lang="ts">
  /**
   * The table: a spreadsheet you can type into.
   *
   * Click a cell to select it (choices, dates and links open their picker
   * right away); type to replace it, Enter or a second click to edit. Arrows,
   * Tab and Shift move; Shift or a drag selects a block, which copies to
   * Excel or Sheets as rows and columns, and pasting fills cells (adding
   * rows if needed). Delete clears, Ctrl+D fills down. Columns resize and
   * reorder by dragging; rows drag into place when the view isn't sorted.
   */
  import { tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Popover from './Popover.svelte';
  import Value from './Value.svelte';
  import CellEditor, { type Move } from './CellEditor.svelte';
  import PropertyMenu from './PropertyMenu.svelte';
  import { databases, type CellSet } from '../databases.svelte';
  import { colorVar } from '../colors';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { Progressive } from '../progressive.svelte';
  import { keyBetween } from './order';
  import { parse as parseCsv, stringify } from './csv';
  import { calcLabel, pinFirst, type Group } from './query';
  import { CALC_LABELS, CALC_SHORT, EDITABLE, TYPES, TYPE_GROUPS, TYPE_GROUP_LABELS, calcsFor, checkboxText, typeInfo } from './schema';
  import { GUTTER, freezeEligibility, planFreeze } from './freeze';
  import { comboLabel } from '../shortcuts.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import Rich from '../i18n/Rich.svelte';
  import type { CalcFn, DbRow, DbView, Property, PropertyType } from '../types';

  let {
    dbId,
    view,
    rows,
    groups,
    onfilter,
  }: {
    dbId: string;
    view: DbView;
    rows: DbRow[];
    groups: Group[] | null;
    onfilter?: (p: Property) => void;
  } = $props();

  const WIDTH: Partial<Record<PropertyType, number>> = {
    title: 280, text: 220, number: 120, select: 150, status: 150, multiSelect: 200, date: 160, checkbox: 90, url: 190,
    email: 200, phone: 150, files: 190, relation: 200, rollup: 140, formula: 170, created: 170, edited: 170, tags: 190, course: 160, id: 96,
  };

  const c = $derived(view.config);
  const columns = $derived(databases.props(dbId).filter((p) => p.type === 'title' || !(c.hidden ?? []).includes(p.id)));
  const widthOf = (p: Property) => c.widths?.[p.id] ?? WIDTH[p.type] ?? 180;
  let resizing = $state<{ id: string; w: number } | null>(null);
  const width = (p: Property) => (resizing?.id === p.id ? resizing.w : widthOf(p));

  // ------------------------------------------------------- frozen columns
  // The view stores the property its pins end at. The frozen prefix is every
  // visible column through it, with its full rendered width: a resize never
  // silently drops or narrows part of it. The menu asks freezeEligibility with
  // the same geometry, so it cannot offer a boundary the strip cannot show.
  let viewportW = $state(0);

  const pinned = $derived.by(() =>
    planFreeze({
      propIds: databases.props(dbId).map((p) => p.id),
      columns: columns.map((p) => ({ id: p.id, width: width(p) })),
      freezeThrough: c.freezeThrough,
      viewport: viewportW,
    }),
  );
  const pinnedLeft = $derived.by(() => {
    const left = new Map<string, number>();
    let x = GUTTER;
    for (const id of pinned.pinned) {
      left.set(id, x);
      const p = columns.find((col) => col.id === id);
      if (p) x += width(p);
    }
    return left;
  });
  const pinnedSet = $derived(new Set(pinned.pinned));
  const lastPinned = $derived(pinned.pinned.at(-1) ?? null);

  function measure() {
    if (body) viewportW = body.clientWidth;
  }

  /** The same geometry the strip uses, asked for one candidate boundary. */
  function freezeCheckFor(propId: string) {
    return freezeEligibility({
      propIds: databases.props(dbId).map((p) => p.id),
      columns: columns.map((p) => ({ id: p.id, width: width(p) })),
      freezeThrough: propId,
      viewport: viewportW,
    });
  }
  /** Called on click, after a fresh measure, so a stale menu cannot persist. */
  function recheckFreeze(propId: string) {
    measure();
    return freezeCheckFor(propId).eligible;
  }

  $effect(() => {
    if (!body) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(body);
    measure();
    return () => ro.disconnect();
  });

  $effect(() => {
    // Column edits and a resize change whether the prefix still fits.
    void template;
    void columns.length;
    void view.id;
    void resizing;
    void tick().then(measure);
  });

  const template = $derived(`40px ${columns.map((p) => `${width(p)}px`).join(' ')} 44px`);
  const total = $derived(40 + columns.reduce((n, p) => n + width(p), 0) + 44);
  const manual = $derived(!(c.sorts ?? []).length);

  // ------------------------------------------------------- rows on screen

  const lazy = new Progressive(80, 150);
  const collapsed = $derived(new Set(c.collapsed ?? []));

  // Sub-items sit under their parent row (folded until opened).
  const sub = $derived((c.subItems ?? 'nested') === 'nested' ? databases.subItems(dbId) : null);
  const tree = $derived.by(() => {
    if (!sub) return null;
    const depth = new Map<string, number>();
    const kids = new Map<string, number>();
    const fold = (list: DbRow[]) => {
      const n = databases.nest(dbId, list);
      if (!n) return list;
      n.depth.forEach((v, k) => depth.set(k, v));
      n.kids.forEach((v, k) => kids.set(k, v));
      return n.rows;
    };
    return {
      rows: groups ? rows : fold(rows),
      groups: groups ? groups.map((g) => ({ ...g, total: g.rows.length, rows: fold(g.rows) })) : null,
      depth,
      kids,
    };
  });
  /** Rows added here, shown first until the view is left. */
  let fresh = $state<string[]>([]);
  const listRows = $derived(pinFirst(tree?.rows ?? rows, fresh));
  const listGroups = $derived<(Group & { total?: number })[] | null>(
    (tree?.groups ?? groups)?.map((g) => ({ total: g.rows.length, ...g, rows: pinFirst(g.rows, fresh) })) ?? null,
  );

  const shownGroups = $derived(listGroups ? listGroups.filter((g) => g.rows.length || (!c.hideEmptyGroups && g.key !== '')) : null);
  /** Every row the keyboard can reach, top to bottom. */
  const flat = $derived(shownGroups ? shownGroups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.rows) : listRows);

  async function addSub(parent: DbRow) {
    const made = await databases.addSubItem(parent, view);
    if (!made) return;
    await tick();
    const r = flat.findIndex((x) => x.id === made.id);
    if (r >= 0) {
      await select({ r, c: 0 });
      startEdit({ r, c: 0 });
    }
  }
  const visible = $derived(flat.slice(0, lazy.limit));
  const indexOf = $derived(new Map(visible.map((r, i) => [r.id, i])));

  $effect(() => {
    void view.id;
    void c.filters;
    void c.sorts;
    lazy.reset();
  });

  // ------------------------------------------------------------ selection

  type Pos = { r: number; c: number };
  let sel = $state<Pos | null>(null);
  let anchor = $state<Pos | null>(null);
  // Raw: a row kept here must stay the store's own object (a proxy of it would take edits).
  let editing = $state.raw<{ row: DbRow; prop: Property; el: Element; initial?: string } | null>(null);
  let grid: HTMLDivElement;
  let body: HTMLDivElement;
  let head: HTMLDivElement;
  // The header strip and the rows scroll sideways together (either can lead:
  // focusing a header button scrolls the strip).
  let headWrap: HTMLDivElement;

  const range = $derived.by(() => {
    if (!sel) return null;
    const a = anchor ?? sel;
    return { r0: Math.min(a.r, sel.r), r1: Math.max(a.r, sel.r), c0: Math.min(a.c, sel.c), c1: Math.max(a.c, sel.c) };
  });
  const inRange = (r: number, col: number) => !!range && r >= range.r0 && r <= range.r1 && col >= range.c0 && col <= range.c1;

  function cellEl(p: Pos): HTMLElement | null {
    return grid?.querySelector(`[data-r="${p.r}"][data-c="${p.c}"]`) ?? null;
  }

  /**
   * Brings a cell into view without hiding it under the frozen columns or the
   * header. `scrollIntoView` knows about neither, and it scrolls every
   * ancestor, so the page and the table can both jump.
   */
  function reveal(el: HTMLElement, col: number) {
    if (!body) return;
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const prop = columns[col];
    // A frozen cell is always visible sideways, and scrolling would move the
    // data columns instead.
    if (!prop || !pinnedSet.has(prop.id)) {
      const left = b.left + pinned.width;
      if (r.left < left) body.scrollLeft -= left - r.left;
      else if (r.right > b.right) body.scrollLeft += r.right - b.right;
    }

    // The table scrolls itself in a full-page view; otherwise the page does.
    let root: HTMLElement | null = body;
    while (root && !(/(auto|scroll)/.test(getComputedStyle(root).overflowY) && root.scrollHeight > root.clientHeight + 1)) root = root.parentElement;
    if (root) {
      const rb = root.getBoundingClientRect();
      const top = rb.top + (headWrap?.getBoundingClientRect().height ?? 0);
      if (r.top < top) root.scrollTop -= top - r.top;
      else if (r.bottom > rb.bottom) root.scrollTop += r.bottom - rb.bottom;
    } else {
      const top = headWrap?.getBoundingClientRect().bottom ?? 0;
      if (r.top < top) window.scrollBy(0, r.top - top);
      else if (r.bottom > window.innerHeight) window.scrollBy(0, r.bottom - window.innerHeight);
    }
  }

  async function select(p: Pos, extend = false) {
    // A jump (Ctrl+↓) goes at most 500 rows past what's drawn: drawing a
    // 50,000-row table to its end would freeze the window.
    const r = Math.max(0, Math.min(flat.length - 1, p.r, lazy.limit + 500));
    const col = Math.max(0, Math.min(columns.length - 1, p.c));
    if (r >= lazy.limit) lazy.limit = r + 40;
    // Extending keeps the block's first corner where the selection was.
    if (!extend) anchor = null;
    else if (!anchor) anchor = sel;
    sel = { r, c: col };
    await tick();
    const el = cellEl(sel);
    if (el) reveal(el, col);
  }

  function move(m: Move) {
    if (!sel) return;
    if (m === 'right') {
      if (sel.c < columns.length - 1) void select({ r: sel.r, c: sel.c + 1 });
      else if (sel.r < flat.length - 1) void select({ r: sel.r + 1, c: 0 });
    } else if (m === 'left') {
      if (sel.c > 0) void select({ r: sel.r, c: sel.c - 1 });
      else if (sel.r > 0) void select({ r: sel.r - 1, c: columns.length - 1 });
    } else if (m === 'down') void select({ r: sel.r + 1, c: sel.c });
    else if (m === 'up') void select({ r: sel.r - 1, c: sel.c });
  }

  function startEdit(p: Pos, initial?: string) {
    const row = flat[p.r];
    const prop = columns[p.c];
    const el = cellEl(p);
    if (!row || !prop || !el) return;
    if (!EDITABLE.has(prop.type)) {
      if (prop.type === 'formula') ui.formula = { dbId, propId: prop.id };
      else if (prop.type === 'button' && initial === undefined) databases.press(row, prop);
      return;
    }
    editing = { row, prop, el, initial };
  }

  function endEdit(m?: Move) {
    editing = null;
    grid?.focus({ preventScroll: true });
    if (m) move(m);
  }

  // Dragging across cells selects a block.
  let dragging = false;

  function onCellDown(e: MouseEvent, r: number, col: number) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('button, a, input')) return;
    e.preventDefault();
    grid.focus({ preventScroll: true });
    const was = sel && sel.r === r && sel.c === col && !anchor;
    if (e.shiftKey && sel) {
      if (!anchor) anchor = sel;
      sel = { r, c: col };
      return;
    }
    void select({ r, c: col });
    dragging = true;
    const prop = columns[col];
    // Pickers open on the first click; text edits on the second.
    if (prop && ['select', 'multiSelect', 'status', 'date', 'relation', 'course', 'files', 'tags'].includes(prop.type)) {
      void tick().then(() => startEdit({ r, c: col }));
    } else if (was) startEdit({ r, c: col });
  }

  function onCellEnter(r: number, col: number) {
    if (!dragging || !sel) return;
    if (!anchor) anchor = sel;
    sel = { r, c: col };
  }

  $effect(() => {
    const up = () => (dragging = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  });

  // ------------------------------------------------------------ keyboard

  function cellsIn(rg: NonNullable<typeof range>): { row: DbRow; prop: Property }[] {
    const out: { row: DbRow; prop: Property }[] = [];
    for (let r = rg.r0; r <= rg.r1; r++) for (let col = rg.c0; col <= rg.c1; col++) if (flat[r] && columns[col]) out.push({ row: flat[r], prop: columns[col] });
    return out;
  }

  function clear() {
    if (!range) return;
    const changes: CellSet[] = cellsIn(range)
      .filter((x) => EDITABLE.has(x.prop.type))
      .map((x) => ({ ...x, value: x.prop.type === 'title' ? '' : null }));
    databases.set(changes, {
      label: { undone: t('dbTable.history.clearUndone', { count: changes.length }), redone: t('dbTable.history.clearRedone', { count: changes.length }) },
    });
  }

  function copyText(): string {
    if (!range) return '';
    const table: string[][] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const line: string[] = [];
      for (let col = range.c0; col <= range.c1; col++) {
        const row = flat[r];
        const p = columns[col];
        line.push(row && p ? (p.type === 'checkbox' ? checkboxText(!!databases.get(row, p)) : databases.text(row, p)) : '');
      }
      table.push(line);
    }
    return table.length === 1 && table[0].length === 1 ? table[0][0] : stringify(table, '\t');
  }

  function fillDown() {
    if (!range || range.r0 === range.r1) return;
    const changes: CellSet[] = [];
    for (let col = range.c0; col <= range.c1; col++) {
      const p = columns[col];
      if (!EDITABLE.has(p.type)) continue;
      const value = databases.raw(flat[range.r0], p);
      for (let r = range.r0 + 1; r <= range.r1; r++) changes.push({ row: flat[r], prop: p, value: structuredClone($state.snapshot(value)) });
    }
    databases.set(changes, { label: { undone: t('dbTable.history.fillDownUndone'), redone: t('dbTable.history.fillDownRedone') } });
  }

  async function paste(text: string) {
    if (!sel) return;
    const table = text.includes('\t') || text.includes('\n') ? parseCsv(text.replace(/\r?\n$/, ''), '\t') : [[text]];
    if (!table.length) return;
    const start = range ? { r: range.r0, c: range.c0 } : sel;
    // One value into a block: fill the whole block.
    if (table.length === 1 && table[0].length === 1 && range && (range.r1 > range.r0 || range.c1 > range.c0)) {
      const changes = cellsIn(range)
        .filter((x) => EDITABLE.has(x.prop.type))
        .map((x) => ({ ...x, value: databases.parse(table[0][0], x.prop) }));
      databases.set(changes, { label: { undone: t('dbTable.history.pasteUndone'), redone: t('dbTable.history.pasteRedone') } });
      return;
    }
    const changes: CellSet[] = [];
    const extra: string[][] = [];
    table.forEach((line, i) => {
      const row = flat[start.r + i];
      if (!row) {
        extra.push(line);
        return;
      }
      line.forEach((cell, j) => {
        const p = columns[start.c + j];
        if (p && EDITABLE.has(p.type)) changes.push({ row, prop: p, value: databases.parse(cell, p) });
      });
    });
    databases.set(changes, { label: { undone: t('dbTable.history.pasteUndone'), redone: t('dbTable.history.pasteRedone') } });
    if (extra.length) {
      // Lines past the last row become new rows.
      const made = await databases.addRows(
        dbId,
        extra.map((line) => {
          const cells: Record<string, never> = {};
          let title = '';
          line.forEach((cell, j) => {
            const p = columns[start.c + j];
            if (!p || !EDITABLE.has(p.type)) return;
            if (p.type === 'title') title = cell.trim();
            else (cells as Record<string, unknown>)[p.id] = databases.parse(cell, p);
          });
          return { title, cells };
        }),
        flat.at(-1)?.id ?? null,
      );
      if (made.length) ui.toast(t('dbTable.addedRows', { count: made.length }));
    }
    anchor = { r: start.r, c: start.c };
    sel = { r: Math.min(flat.length - 1, start.r + table.length - 1), c: Math.min(columns.length - 1, start.c + table.map((l) => l.length).reduce((a, b) => Math.max(a, b), -Infinity) - 1) };
  }

  function onKey(e: KeyboardEvent) {
    if (editing || !sel) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k as 'ArrowUp']!;
      const far = mod ? (d[0] ? (d[0] > 0 ? flat.length : -flat.length) : d[1] > 0 ? columns.length : -columns.length) : 1;
      void select({ r: sel.r + d[0] * far, c: sel.c + d[1] * far }, e.shiftKey);
    } else if (k === 'Tab') {
      e.preventDefault();
      move(e.shiftKey ? 'left' : 'right');
    } else if (k === 'Enter' && mod) {
      e.preventDefault();
      if (flat[sel.r]) store.open(flat[sel.r].id);
    } else if (k === 'Enter' || k === 'F2') {
      e.preventDefault();
      startEdit(sel);
    } else if (k === 'Escape') {
      if (anchor) anchor = null;
      else sel = null;
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      clear();
    } else if (k === ' ' && columns[sel.c]?.type === 'checkbox') {
      e.preventDefault();
      const row = flat[sel.r];
      if (row) databases.setOne(row, columns[sel.c], !databases.get(row, columns[sel.c]));
    } else if (mod && k.toLowerCase() === 'a') {
      e.preventDefault();
      anchor = { r: 0, c: 0 };
      sel = { r: flat.length - 1, c: columns.length - 1 };
    } else if (mod && k.toLowerCase() === 'd') {
      e.preventDefault();
      fillDown();
    } else if (!mod && !e.altKey && k.length === 1) {
      const p = columns[sel.c];
      if (p && ['title', 'text', 'number', 'url', 'email', 'phone'].includes(p.type)) {
        e.preventDefault();
        startEdit(sel, k);
      } else if (p && EDITABLE.has(p.type)) {
        // Pickers open with what was typed as their search ("hi" → High).
        e.preventDefault();
        startEdit(sel, k);
      }
    }
  }

  function onCopy(e: ClipboardEvent, cut = false) {
    if (editing || !range) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', copyText());
    if (cut) clear();
  }

  function onPaste(e: ClipboardEvent) {
    if (editing || !sel) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    void paste(text);
  }

  // Leave the selection when the rows under it change shape.
  $effect(() => {
    if (sel && sel.r >= flat.length) sel = flat.length ? { r: flat.length - 1, c: sel.c } : null;
  });

  // ---------------------------------------------------------- picked rows

  let picked = $state<Set<string>>(new Set());
  const pickedRows = $derived(flat.filter((r) => picked.has(r.id)));

  function togglePick(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    picked = next;
  }

  function pickAll() {
    picked = picked.size === flat.length ? new Set() : new Set(flat.map((r) => r.id));
  }

  async function deletePicked() {
    const ids = pickedRows.map((r) => r.id);
    picked = new Set();
    await databases.deleteRows(ids);
  }

  function bulkEdit(e: MouseEvent) {
    const target = e.currentTarget as Element;
    ui.openMenuAt(
      target,
      databases
        .props(dbId)
        .filter((p) => EDITABLE.has(p.type) && p.type !== 'title')
        .map((p) => ({
          label: p.name,
          icon: typeInfo(p.type).icon,
          action: () => {
            const first = pickedRows[0];
            const el = target;
            if (!first) return;
            // Edit the first; the same value then goes to every picked row.
            const before = JSON.stringify(first.cells[p.id] ?? null);
            bulk = { prop: p, el, rows: [...pickedRows], before };
          },
        })),
    );
  }

  let bulk = $state.raw<{ prop: Property; el: Element; rows: DbRow[]; before: string } | null>(null);

  function endBulk() {
    if (!bulk) return;
    const { prop, rows: list } = bulk;
    const value = databases.raw(list[0], prop);
    bulk = null;
    databases.set(
      list.slice(1).map((row) => ({ row, prop, value: structuredClone($state.snapshot(value)) })),
      {
        label: {
          undone: t('dbTable.history.setManyUndone', { name: prop.name, count: list.length }),
          redone: t('dbTable.history.setManyRedone', { name: prop.name, count: list.length }),
        },
      },
    );
  }

  // ------------------------------------------------------------- columns

  let menuFor = $state<{ prop: Property; anchor: Element; fresh?: boolean } | null>(null);
  const menuFreeze = $derived(menuFor ? freezeCheckFor(menuFor.prop.id) : null);
  let addAnchor = $state<Element | null>(null);

  async function addColumn(type: PropertyType) {
    addAnchor = null;
    const p = await databases.addProperty(dbId, type);
    if (!p) return;
    await tick();
    const th = head?.querySelector(`[data-prop="${p.id}"]`);
    // A formula is named and written in its editor; others in their menu.
    if (type === 'formula') ui.formula = { dbId, propId: p.id };
    else if (th) menuFor = { prop: p, anchor: th, fresh: true };
  }

  function startResize(e: PointerEvent, p: Property) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = widthOf(p);
    resizing = { id: p.id, w: w0 };
    const moveFn = (ev: PointerEvent) => (resizing = { id: p.id, w: Math.max(70, Math.min(900, Math.round(w0 + ev.clientX - x0))) });
    const up = () => {
      el.removeEventListener('pointermove', moveFn);
      el.removeEventListener('pointerup', up);
      if (resizing) databases.updateView(dbId, view.id, { widths: { ...(c.widths ?? {}), [p.id]: resizing.w } });
      resizing = null;
    };
    el.addEventListener('pointermove', moveFn);
    el.addEventListener('pointerup', up);
  }

  function resetWidth(p: Property) {
    const widths = { ...(c.widths ?? {}) };
    delete widths[p.id];
    databases.updateView(dbId, view.id, { widths });
  }

  // Dragging a header moves the property (in every view).
  let dragCol = $state<string | null>(null);
  let dropCol = $state<{ id: string; side: 'before' | 'after' } | null>(null);

  function onColOver(e: DragEvent, p: Property) {
    if (!dragCol || dragCol === p.id) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropCol = { id: p.id, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' };
  }

  function onColDrop(e: DragEvent) {
    e.preventDefault();
    const id = dragCol;
    const target = dropCol;
    dragCol = null;
    dropCol = null;
    if (!id || !target) return;
    const all = databases.props(dbId).filter((p) => p.id !== id);
    const i = all.findIndex((p) => p.id === target.id);
    const at = target.side === 'before' ? i : i + 1;
    databases.updateProperty(dbId, id, { sortKey: keyBetween(all[at - 1]?.sortKey ?? null, all[at]?.sortKey ?? null) }, { immediate: true });
  }

  // ------------------------------------------------------- dragging rows

  let dragRow = $state<string | null>(null);
  let dropRow = $state<{ id: string; side: 'before' | 'after' } | null>(null);

  function onRowOver(e: DragEvent, row: DbRow) {
    if (!dragRow || dragRow === row.id) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropRow = { id: row.id, side: e.clientY < r.top + r.height / 2 ? 'before' : 'after' };
  }

  function onRowDrop(e: DragEvent) {
    e.preventDefault();
    const id = dragRow;
    const target = dropRow;
    dragRow = null;
    dropRow = null;
    if (!id || !target) return;
    const order = flat.filter((r) => r.id !== id);
    const i = order.findIndex((r) => r.id === target.id);
    const at = target.side === 'before' ? i : i + 1;
    databases.moveRow(id, order[at - 1]?.id ?? null, order[at]?.id ?? null);
  }

  // ------------------------------------------------------------ adding

  /** Adds a row at the end and starts typing its title (the toolbar's New). */
  export function addRow(template?: string): Promise<void> {
    return newRow(undefined, template);
  }

  /**
   * Adds a row where it can be seen straight away: at the top (stored there
   * too when the view has its own order), or, from the button under the
   * rows, after the last one showing. Never by drawing every row down to
   * the end of a long table.
   */
  async function newRow(group?: Group, template?: string, below = false) {
    const last = visible.at(-1);
    const placed = manual && !groups && !sub;
    const where = below && placed && last ? { after: last.id } : placed && listRows[0] ? { before: listRows[0].id } : {};
    const made = await databases.addRow(dbId, { view, template, ...where, group: group && c.group ? { prop: c.group, key: group.key } : undefined });
    if (!made) return;
    if (!(below && placed)) fresh = [made.id, ...fresh];
    await tick();
    const r = flat.findIndex((x) => x.id === made.id);
    if (r >= 0) {
      await select({ r, c: 0 });
      startEdit({ r, c: 0 });
    }
  }

  function toggleGroup(key: string) {
    const list = c.collapsed ?? [];
    databases.updateView(dbId, view.id, { collapsed: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] });
  }

  function calcMenu(e: MouseEvent, p: Property) {
    const kind = databases.kind(dbId, p);
    const current = c.calc?.[p.id] ?? 'none';
    ui.openMenuAt(
      e.currentTarget as Element,
      calcsFor(kind).map((fn) => ({
        label: CALC_LABELS[fn],
        checked: fn === current,
        action: () => databases.updateView(dbId, view.id, { calc: { ...(c.calc ?? {}), [p.id]: fn as CalcFn } }),
      })),
    );
  }

  const groupedTypes = TYPE_GROUPS.map((g) => ({ g, items: TYPES.filter((info) => info.group === g && info.type !== 'title') }));
</script>

{#snippet rowEl(row: DbRow)}
  {@const r = indexOf.get(row.id) ?? -1}
  <div
    class="tr"
    class:picked={picked.has(row.id)}
    class:drop-before={dropRow?.id === row.id && dropRow.side === 'before'}
    class:drop-after={dropRow?.id === row.id && dropRow.side === 'after'}
    class:dragging={dragRow === row.id}
    style:grid-template-columns={template}
    role="row"
    tabindex="-1"
    ondragover={(e) => onRowOver(e, row)}
    ondrop={onRowDrop}
  >
    <div class="gutter" class:pinned={pinned.pinned.length > 0} style:left="0px">
      {#if manual}
        <span
          class="handle"
          draggable="true"
          role="button"
          tabindex="-1"
          aria-label={t('dbTable.row.dragToMove')}
          ondragstart={(e) => {
            dragRow = row.id;
            e.dataTransfer?.setData('text/plain', databases.title(row));
          }}
          ondragend={() => {
            dragRow = null;
            dropRow = null;
          }}
        ><Icon name="grip" size={14} /></span>
      {/if}
      <button class="pick round" class:on={picked.has(row.id)} onmousedown={(e) => e.preventDefault()} onclick={() => togglePick(row.id)} aria-label={t('dbTable.row.select')} tabindex="-1"></button>
    </div>
    {#each columns as p, col (p.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="td"
        class:pinned={pinnedSet.has(p.id)}
        class:frozen-end={lastPinned === p.id}
        class:sel={sel?.r === r && sel?.c === col}
        class:in-range={inRange(r, col) && !!anchor}
        class:right={p.type === 'number' || (p.type === 'formula' && databases.kind(dbId, p) === 'number') || (p.type === 'rollup' && databases.kind(dbId, p) === 'number')}
        class:center={p.type === 'checkbox'}
        class:computed={!EDITABLE.has(p.type)}
        style:left={pinnedSet.has(p.id) ? `${pinnedLeft.get(p.id) ?? 0}px` : null}
        data-r={r}
        data-c={col}
        role="gridcell"
        tabindex="-1"
        onmousedown={(e) => onCellDown(e, r, col)}
        onmouseenter={() => onCellEnter(r, col)}
        ondblclick={() => startEdit({ r, c: col })}
      >
        {#if tree && p.type === 'title'}
          {@const kids = tree.kids.get(row.id) ?? 0}
          <span class="indent" style:width="{(tree.depth.get(row.id) ?? 0) * 20}px"></span>
          {#if kids}
            <button
              class="twisty"
              class:open={databases.expanded[row.id]}
              tabindex="-1"
              onmousedown={(e) => e.stopPropagation()}
              onclick={(e) => {
                e.stopPropagation();
                databases.toggleExpanded(row.id);
              }}
              aria-label={databases.expanded[row.id] ? t('dbTable.row.hideSubItems') : t('dbTable.row.showSubItems')}
              aria-expanded={!!databases.expanded[row.id]}
              data-tip={t('dbTable.row.subItemCount', { count: kids })}
            ><Icon name="chevron-right" size={12} stroke={2.4} /></button>
          {:else}
            <span class="twisty-space"></span>
          {/if}
        {/if}
        <Value {dbId} {row} prop={p} wrap={c.wrap} oncheck={p.type === 'checkbox' ? () => databases.setOne(row, p, !databases.get(row, p)) : undefined} />
        {#if p.type === 'title'}
          <span class="row-tools">
            {#if sub}
              <button class="open" tabindex="-1" onmousedown={(e) => e.stopPropagation()} onclick={() => void addSub(row)} data-tip={t('dbTable.row.addSubItem')} aria-label={t('dbTable.row.addSubItem')}>
                <Icon name="corner-down-right" size={12} />
              </button>
            {/if}
            <button class="open" tabindex="-1" onclick={() => store.open(row.id)} data-tip={t('dbTable.row.openAsPage')} data-tip-key={comboLabel('Mod+Enter')}>
              <Icon name="expand" size={12} /> {t('common.actions.open')}
            </button>
          </span>
        {/if}
      </div>
    {/each}
    <div class="td filler"></div>
  </div>
{/snippet}

<div class="table" class:wrap={c.wrap} class:frozen={pinned.pinned.length > 0} style:--table-w="{total}px">
  {#if picked.size}
    <div class="bulk">
      <span class="count">{t('dbTable.selection.count', { count: picked.size })}</span>
      <button class="btn small raised" onclick={bulkEdit}><Icon name="pencil" size={13} /> {t('dbTable.selection.setProperty')}</button>
      <button class="btn small raised" onclick={() => void databases.duplicateRows(pickedRows.map((r) => r.id)).then(() => (picked = new Set()))}><Icon name="copy" size={13} /> {t('common.actions.duplicate')}</button>
      <button class="btn small raised destructive" onclick={deletePicked}><Icon name="trash" size={13} /> {t('common.actions.delete')}</button>
      <button class="icon-btn" onclick={() => (picked = new Set())} aria-label={t('dbTable.selection.clear')}><Icon name="x" size={14} /></button>
    </div>
  {/if}

  <div class="head-wrap" bind:this={headWrap} onscroll={() => body && body.scrollLeft !== headWrap.scrollLeft && (body.scrollLeft = headWrap.scrollLeft)}>
    <div class="head-inner">
    <div class="head" bind:this={head} role="row" style:grid-template-columns={template}>
      <div class="gutter" class:pinned={pinned.pinned.length > 0} style:left="0px">
        <button class="pick round" class:on={picked.size > 0 && picked.size === flat.length} class:some={picked.size > 0 && picked.size < flat.length} onclick={pickAll} aria-label={t('dbTable.selection.selectAll')} tabindex="-1"></button>
      </div>
      {#each columns as p (p.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="th"
          class:pinned={pinnedSet.has(p.id)}
          class:frozen-end={lastPinned === p.id}
          class:drop-before={dropCol?.id === p.id && dropCol.side === 'before'}
          class:drop-after={dropCol?.id === p.id && dropCol.side === 'after'}
          class:right={p.type === 'number'}
          style:left={pinnedSet.has(p.id) ? `${pinnedLeft.get(p.id) ?? 0}px` : null}
          data-prop={p.id}
          role="columnheader"
          tabindex="-1"
          draggable="true"
          ondragstart={(e) => {
            dragCol = p.id;
            e.dataTransfer?.setData('text/plain', p.name);
          }}
          ondragend={() => {
            dragCol = null;
            dropCol = null;
          }}
          ondragover={(e) => onColOver(e, p)}
          ondrop={onColDrop}
          onclick={(e) => (menuFor = { prop: p, anchor: e.currentTarget as Element })}
          data-tip={p.config.description || undefined}
        >
          <Icon name={typeInfo(p.type).icon} size={14} />
          <span class="name">{p.name}</span>
          {#if (c.sorts ?? []).some((s) => s.prop === p.id)}
            <Icon name={(c.sorts ?? []).find((s) => s.prop === p.id)?.dir === 'desc' ? 'arrow-down' : 'arrow-up'} size={12} />
          {/if}
          {#if lastPinned === p.id}
            <span class="pin-mark" data-tip={pinned.overflow ? t('dbTable.freeze.frozenOverflow') : t('dbTable.freeze.frozen')} aria-label={t('dbTable.freeze.frozen')}><Icon name="pin" size={11} /></span>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="resize" onpointerdown={(e) => startResize(e, p)} ondblclick={(e) => (e.stopPropagation(), resetWidth(p))} onclick={(e) => e.stopPropagation()}></span>
        </div>
      {/each}
      <button class="th add" onclick={(e) => (addAnchor = e.currentTarget as Element)} data-tip={t('dbTable.addProperty')} aria-label={t('dbTable.addProperty')}><Icon name="plus" size={15} /></button>
    </div>
    </div>
  </div>

  {#if pinned.overflow}
    <!-- A saved freeze survives a resize intact; this is the reachable way out
         when its strip is too wide to show the boundary column. -->
    <div class="freeze-overflow" role="status">
      <Icon name="pin" size={13} />
      <span class="grow">{t('dbTable.freeze.noLongerFits')}</span>
      <button class="btn small" onclick={() => databases.updateView(dbId, view.id, { freezeThrough: null })}>{t('dbTable.freeze.unfreeze')}</button>
    </div>
  {/if}

  <div class="body" bind:this={body} onscroll={() => headWrap.scrollLeft !== body.scrollLeft && (headWrap.scrollLeft = body.scrollLeft)}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="grid"
      bind:this={grid}
      role="grid"
      tabindex="0"
      aria-label={t('dbTable.rows')}
      onkeydown={onKey}
      oncopy={(e) => onCopy(e)}
      oncut={(e) => onCopy(e, true)}
      onpaste={onPaste}
    >
      {#if shownGroups}
        {@const shownIds = new Set(visible.map((r) => r.id))}
        {#each shownGroups as g (g.key)}
          {#if !g.rows.length || g.rows.some((r) => shownIds.has(r.id)) || collapsed.has(g.key)}
            <div class="group-row" style:left={pinned.pinned.length ? `${pinned.width}px` : null}>
              <button class="chev" class:closed={collapsed.has(g.key)} onclick={() => toggleGroup(g.key)} aria-label={collapsed.has(g.key) ? t('dbTable.group.show') : t('dbTable.group.hide')}><Icon name="chevron-down" size={13} stroke={2.2} /></button>
              {#if g.key && g.color}<span class="pill" class:status={databases.prop(dbId, c.group)?.type === 'status'} style:--pill={g.color}><span>{g.label}</span></span>{:else}<span class="g-label">{g.label}</span>{/if}
              <span class="g-count">{fmt.number(g.total ?? g.rows.length)}</span>
              <button class="icon-btn g-add" onclick={() => newRow(g)} aria-label={t('dbTable.group.newRowIn', { group: g.label })} data-tip={t('dbTable.group.newRowHere')}><Icon name="plus" size={14} /></button>
            </div>
            {#if !collapsed.has(g.key)}
              {#each g.rows.filter((r) => shownIds.has(r.id)) as row (row.id)}{@render rowEl(row)}{/each}
            {/if}
          {/if}
        {/each}
      {:else}
        {#each visible as row (row.id)}{@render rowEl(row)}{/each}
      {/if}
      {#if visible.length < flat.length}<div class="more" {@attach lazy.more}></div>{/if}

      {#if !flat.length}
        <div class="empty-row">
          {#if databases.rowsOf(dbId).length}
            {t('dbTable.empty.noMatches')}
          {:else}
            <Rich key="dbTable.empty.noRows" />
          {/if}
        </div>
      {/if}

      <button class="add-row" onclick={() => newRow(undefined, undefined, true)}><Icon name="plus" size={14} /> {t('common.actions.new')}</button>

      <div class="calc" style:grid-template-columns={template}>
        <div class="calc-gutter" class:pinned={pinned.pinned.length > 0} style:left="0px"></div>
        {#each columns as p (p.id)}
          {@const fn = c.calc?.[p.id] ?? 'none'}
          <button
            class="calc-cell"
            class:pinned={pinnedSet.has(p.id)}
            class:frozen-end={lastPinned === p.id}
            class:set={fn !== 'none'}
            class:right={p.type === 'number'}
            style:left={pinnedSet.has(p.id) ? `${pinnedLeft.get(p.id) ?? 0}px` : null}
            disabled={p.type === 'button'}
            onclick={(e) => calcMenu(e, p)}
          >
            {#if p.type === 'button'}
              <span></span>
            {:else if fn !== 'none'}
              <span class="calc-label" data-tip={calcLabel(fn)}>{CALC_SHORT[fn]}</span>
              <span class="calc-value">{databases.calc(dbId, rows, p, fn)}</span>
            {:else}
              <span class="calc-label hover">{t('dbTable.calculate')}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

{#if editing}
  {#key editing}
    <CellEditor {dbId} row={editing.row} prop={editing.prop} anchor={editing.el} initial={editing.initial} onclose={endEdit} />
  {/key}
{/if}

{#if bulk}
  <CellEditor {dbId} row={bulk.rows[0]} prop={bulk.prop} anchor={bulk.el} onclose={endBulk} />
{/if}

{#if menuFor}
  {#key menuFor.prop.id}
    <PropertyMenu {dbId} prop={menuFor.prop} {view} anchor={menuFor.anchor} fresh={menuFor.fresh} {onfilter} freezeStatus={menuFreeze} {recheckFreeze} onclose={() => (menuFor = null)} />
  {/key}
{/if}

{#if addAnchor}
  <Popover anchor={addAnchor} align="end" width={260} onclose={() => (addAnchor = null)} label={t('dbTable.addProperty')}>
    {#each groupedTypes as group (group.g)}
      <div class="pop-head">{TYPE_GROUP_LABELS[group.g]}</div>
      {#each group.items as info (info.type)}
        <button class="pop-item" onclick={() => addColumn(info.type)}>
          <Icon name={info.icon} size={15} />
          <span class="grow">{info.label}</span>
        </button>
      {/each}
    {/each}
  </Popover>
{/if}

<style>
  /* --edge (set by a full-page database) is the page margin: the 40px row
     handles sit in it, so the first column lines up with the title. */
  .table {
    --edge-l: max(0px, calc(var(--edge, 48px) - 48px));
    --edge-r: var(--edge, 0px);
    position: relative;
    font-size: var(--fs-body-ui);
  }
  :global(.embedded) .table {
    margin-left: -48px;
  }
  .freeze-overflow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: 32px;
    padding: 3px 8px 3px 12px;
    font-size: var(--fs-ui);
    color: var(--text-2);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .freeze-overflow > :global(.icon) {
    flex: none;
    color: var(--text-3);
  }
  .freeze-overflow .grow {
    flex: 1;
    min-width: 0;
  }
  .head-inner,
  .grid {
    width: max-content;
    min-width: 100%;
    padding: 0 var(--edge-r) 0 var(--edge-l);
  }
  /* The header sticks to the top while the page scrolls, and follows the
     body sideways (it's a separate strip, scrolled in step). */
  .head-wrap {
    position: sticky;
    top: 0;
    z-index: 3;
    overflow: hidden;
    background: var(--bg);
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .head,
  .tr,
  .calc {
    display: grid;
    width: var(--table-w);
  }
  .th {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 8px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-2);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .th:hover {
    background: var(--fill);
  }
  .th :global(.icon) {
    flex: none;
    color: var(--text-3);
  }
  .th .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .th.add {
    justify-content: center;
    color: var(--text-3);
  }
  .th.drop-before {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .th.drop-after {
    box-shadow: inset -2px 0 0 var(--accent);
  }
  .resize {
    position: absolute;
    top: 6px;
    bottom: 6px;
    right: -3px;
    width: 7px;
    z-index: 2;
    cursor: col-resize;
  }
  .resize::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--separator-strong);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .th:hover .resize::after,
  .resize:active::after {
    opacity: 1;
  }
  .body {
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 8px;
  }
  .grid {
    outline: none;
  }
  .tr {
    position: relative;
    box-shadow: inset 0 -1px 0 var(--separator);
    /* Rows out of sight skip layout and painting: a table thousands of rows
       long scrolls as lightly as a short one. */
    content-visibility: auto;
    contain-intrinsic-block-size: auto 35px;
  }
  /* While columns are frozen the rows keep their sticky children in the
     ordinary paint tree: containment can rasterize a row band against a stale
     horizontal offset during a drag. Progressive row loading stays on, and
     the optimization returns as soon as the view is unfrozen. */
  .table.frozen .tr {
    content-visibility: visible;
    contain-intrinsic-block-size: none;
  }
  .tr:hover .gutter .handle,
  .tr:hover .pick,
  .tr.picked .pick {
    opacity: 1;
  }
  .tr.picked {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .tr.dragging {
    opacity: 0.4;
  }
  .tr.drop-before {
    box-shadow:
      inset 0 2px 0 var(--accent),
      inset 0 -1px 0 var(--separator);
  }
  .tr.drop-after {
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .gutter {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding-right: 4px;
  }
  .handle {
    display: grid;
    place-items: center;
    width: 14px;
    height: 22px;
    color: var(--text-3);
    cursor: grab;
    opacity: 0;
  }
  .pick {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1.5px var(--text-4);
    background: center / 11px no-repeat;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .head .pick {
    opacity: 0;
  }
  .head:hover .pick,
  .pick.on,
  .pick.some {
    opacity: 1;
  }
  .pick.on {
    background-color: var(--accent);
    background-image: var(--check);
    box-shadow: none;
  }
  .pick.some {
    background: var(--accent) linear-gradient(var(--on-accent), var(--on-accent)) center / 7px 1.5px no-repeat;
    box-shadow: none;
  }
  .td {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 34px;
    padding: 6px 8px;
    box-shadow: inset -1px 0 0 var(--separator);
    overflow: hidden;
    cursor: default;
  }
  .wrap .td {
    align-items: flex-start;
  }
  .td.right {
    justify-content: flex-end;
  }
  .td.center {
    justify-content: center;
  }
  .td.computed {
    color: var(--text-2);
  }
  .td.filler {
    box-shadow: none;
  }
  .td > :global(*:first-child) {
    min-width: 0;
  }
  .td.in-range {
    background: color-mix(in srgb, var(--accent) 9%, transparent);
  }
  .td.sel {
    box-shadow:
      inset 0 0 0 2px var(--accent),
      inset -1px 0 0 var(--separator);
    border-radius: 2px;
  }
  .grid:not(:focus-within) .td.sel {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent),
      inset -1px 0 0 var(--separator);
  }
  /* Frozen columns: an opaque leading strip, above the cells scrolling under
     it. A firmer edge marks where the freeze ends. */
  .th.pinned,
  .td.pinned,
  .calc-cell.pinned,
  .gutter.pinned {
    position: sticky;
    background: var(--bg);
  }
  .th.pinned {
    z-index: 2;
  }
  .th.pinned:hover {
    background: color-mix(in srgb, var(--text) 6%, var(--bg));
  }
  .td.pinned,
  .calc-cell.pinned {
    z-index: 2;
  }
  .gutter.pinned {
    z-index: 3;
  }
  .td.pinned {
    box-shadow:
      inset -1px 0 0 var(--separator),
      inset 0 -1px 0 var(--separator);
  }
  .td.pinned.frozen-end,
  .th.pinned.frozen-end,
  .calc-cell.pinned.frozen-end {
    box-shadow: inset -2px 0 0 var(--separator-strong);
  }
  .td.pinned.frozen-end {
    box-shadow:
      inset -2px 0 0 var(--separator-strong),
      inset 0 -1px 0 var(--separator);
  }
  .tr.picked .td.pinned {
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  }
  .tr.picked .gutter.pinned {
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  }
  .td.pinned.in-range {
    background: color-mix(in srgb, var(--accent) 9%, var(--bg));
  }
  .td.pinned.sel {
    background: var(--bg);
    box-shadow:
      inset 0 0 0 2px var(--accent),
      inset 0 -1px 0 var(--separator);
  }
  .grid:not(:focus-within) .td.pinned.sel {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent),
      inset 0 -1px 0 var(--separator);
  }
  .pin-mark {
    display: grid;
    place-items: center;
    flex: none;
    margin-left: auto;
    color: var(--text-3);
  }
  .calc-gutter {
    display: block;
  }
  .row-tools {
    position: absolute;
    right: 6px;
    top: 50%;
    translate: 0 -50%;
    display: flex;
    gap: 4px;
  }
  .indent {
    flex: none;
    margin-right: -6px;
  }
  .twisty,
  .twisty-space {
    flex: none;
    width: 18px;
    height: 18px;
    margin: 0 -2px 0 -4px;
  }
  .twisty {
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    color: var(--text-3);
  }
  .twisty:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .twisty :global(.icon) {
    transition: transform var(--dur-fast) var(--ease);
  }
  .twisty.open :global(.icon) {
    transform: rotate(90deg);
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-sm);
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-2);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .tr:hover .open {
    opacity: 1;
  }
  .open:hover {
    color: var(--text);
  }
  .group-row {
    position: sticky;
    left: var(--edge-l);
    display: flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    height: 40px;
    margin-top: 8px;
    padding: 0 8px 0 14px;
  }
  .chev {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--r-xs);
    color: var(--text-3);
    transition: transform var(--dur) var(--ease-out);
  }
  .chev:hover {
    background: var(--fill-2);
  }
  .chev.closed {
    transform: rotate(-90deg);
  }
  .g-label {
    font-weight: var(--fw-600);
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .g-count {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .g-add {
    width: 24px;
    height: 24px;
    opacity: 0;
  }
  .group-row:hover .g-add {
    opacity: 1;
  }
  .more {
    height: 1px;
  }
  .empty-row {
    position: sticky;
    left: var(--edge-l);
    width: var(--table-w);
    padding: 14px 16px 14px 48px;
    font-size: var(--fs-ui);
    color: var(--text-3);
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: var(--table-w);
    height: 34px;
    padding-left: 44px;
    font-size: var(--fs-ui);
    color: var(--text-3);
    box-shadow: inset 0 -1px 0 var(--separator);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .add-row:hover {
    background: var(--fill);
    color: var(--text);
  }
  .calc-cell {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .calc-cell:hover {
    background: var(--fill);
  }
  .calc-label {
    white-space: nowrap;
  }
  .calc-label.hover {
    opacity: 0;
  }
  .calc-cell:hover .calc-label.hover {
    opacity: 1;
  }
  .calc-value {
    font-weight: var(--fw-600);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bulk {
    position: sticky;
    top: 0;
    z-index: 4;
    margin-left: var(--edge-l);
    margin-right: var(--edge-r);
    display: flex;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 8px 0 14px;
    border-radius: var(--r-md);
    background: var(--material-strong);
    -webkit-backdrop-filter: blur(20px);
    backdrop-filter: blur(20px);
    box-shadow: var(--shadow-pop);
    margin-bottom: 8px;
  }
  .bulk .count {
    flex: 1;
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
  }
</style>
