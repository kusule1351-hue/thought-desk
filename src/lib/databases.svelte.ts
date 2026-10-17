/**
 * Databases: their schemas and rows, every value (stored, automatic or
 * calculated), and every action on them, with undo.
 *
 * A database is a page; each row is a page inside it (see databases.rs), so
 * a row's title, icon, tags and times live in the page store and the rest of
 * its values here. Edits apply right away and are saved in batches.
 */

import { untrack } from 'svelte';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from './api';
import { clock } from './clock.svelte';
import { colorVar } from './colors';
import { library } from './library.svelte';
import { planner } from './planner.svelte';
import { prefs } from './prefs.svelte';
import { store } from './store.svelte';
import { tags } from './tags.svelte';
import { ui } from './ui.svelte';
import { lineIcon } from './page-icon';
import { byKey, keyBetween, keysBetween } from './db/order';
import { FDate, FormulaError, isEmpty as emptyF, renameProperty, run, toText, type FValue, type Scope } from './db/formula';
import { calculate, filterRows, groupRows, searchRows, sortRows, type Ctx, type Group, type Plain } from './db/query';
import {
  HAS_OPTIONS,
  defaultConfig,
  formatDateValue,
  formatNumber,
  formatTimestamp,
  inferType,
  isoDate,
  kindOf,
  newOption,
  option,
  optionNamed,
  options,
  parseCheckbox,
  parseDate,
  parseNumber,
  shortId,
  typeInfo,
  type ValueKind,
} from './db/schema';
import { parse as parseCsv, stringify } from './db/csv';
import { TEMPLATES, type Template } from './db/templates';
import type { JNode } from './markdown';
import type {
  ActionValue,
  Automation,
  CalcFn,
  CellValue,
  CreatedRow,
  DatabaseSchema,
  DateValue,
  DbAction,
  DbRow,
  DbView,
  NewRow,
  PageMeta,
  Property,
  PropertyType,
  ViewConfig,
  ViewType,
} from './types';

interface UndoStep {
  label: string;
  undo: () => unknown;
  redo: () => unknown;
}

/** One value to set: a row, a property and what goes in it. */
export interface CellSet {
  row: DbRow;
  prop: Property;
  value: CellValue;
}

const isDateValue = (v: unknown): v is DateValue =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as DateValue).start === 'string';
/** A list cell's ids, each once: stored lists can repeat one (an import, a
 *  sync merge), and every list is drawn keyed by id. */
const asList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []);
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Properties by the names formulas write them as (and by id); a name wins over an id. */
function namesOf(props: Property[]): Map<string, Property> {
  const m = new Map<string, Property>();
  for (const p of props) if (!m.has(p.id.toLowerCase())) m.set(p.id.toLowerCase(), p);
  for (const p of props) m.set(p.name.trim().toLowerCase(), p);
  for (const p of props) if (!m.has(p.name)) m.set(p.name, p);
  return m;
}

class Databases {
  schemas = $state<Record<string, DatabaseSchema>>({});
  /**
   * Every row, as plain objects: with tens of thousands of rows, making each
   * value reactive on its own costs more than everything else put together.
   * Instead each database has a change count (`#version`) that reading a
   * value depends on and writing one bumps; the map itself is replaced when
   * rows come or go.
   */
  rows = $state.raw<Record<string, DbRow>>({});
  #version = $state<Record<string, number>>({});
  /** Bumped when rows change order (moving one). */
  #order = $state(0);
  loaded = $state(false);
  /** Whether there's something to undo or redo (for menus and buttons). */
  canUndo = $state(false);
  canRedo = $state(false);

  /** Live databases, in the order they were made (the sidebar's list). */
  #listIds = $derived(
    [...store.placed.values()]
      .filter((p) => p.kind === 'database' && !p.deletedAt && this.schemas[p.id])
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => p.id),
  );
  list = $derived.by(() => {
    const byId = store.byId;
    return this.#listIds.flatMap((id) => byId.get(id) ?? []);
  });

  /** Live rows of each database, in their own order (templates apart). */
  #split = $derived.by(() => {
    void this.#order;
    const rows = new Map<string, DbRow[]>();
    const templates = new Map<string, DbRow[]>();
    // Where pages are, not what they say: typing a title doesn't redo this.
    const placed = store.placed;
    for (const row of Object.values(this.rows)) {
      const page = placed.get(row.id);
      if (!page || page.deletedAt) continue;
      const map = row.template ? templates : rows;
      let list = map.get(row.dbId);
      if (!list) map.set(row.dbId, (list = []));
      list.push(row);
    }
    for (const list of [...rows.values(), ...templates.values()]) list.sort(byKey);
    // Keep last time's list where nothing in it changed (a page elsewhere was
    // favorited or tagged), so views showing it don't work their rows out again.
    const prev = untrack(() => this.#lastSplit);
    if (prev) {
      for (const [now, before] of [[rows, prev.rows], [templates, prev.templates]] as const)
        for (const [db, list] of now) {
          const old = before.get(db);
          if (old && old.length === list.length && old.every((r, i) => r === list[i])) now.set(db, old);
        }
    }
    return (this.#lastSplit = { rows, templates });
  });
  #lastSplit: { rows: Map<string, DbRow[]>; templates: Map<string, DbRow[]> } | null = null;
  byDb = $derived(this.#split.rows);

  /** Sub-items shown under their parent (by row id; for this session). */
  expanded = $state<Record<string, boolean>>({});

  /** Properties by id, per database. */
  #props = $derived(new Map(Object.values(this.schemas).map((s) => [s.id, new Map(s.properties.map((p) => [p.id, p]))])));

  #undo: UndoStep[] = [];
  #redo: UndoStep[] = [];

  // ------------------------------------------------------------ loading

  async load() {
    const [schemas, rows] = await Promise.all([api.listDatabases(), api.listRows()]);
    const next: Record<string, DatabaseSchema> = {};
    for (const s of schemas) next[s.id] = sortSchema(s);
    this.schemas = next;
    this.rows = Object.fromEntries(rows.map((r) => [r.id, r]));
    this.loaded = true;
  }

  /** Rows again from storage (after pages were copied or restored). */
  async reloadRows() {
    await this.flush();
    const rows = await api.listRows();
    this.rows = Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  // ------------------------------------------------------------- lookups

  isDatabase(id: string | null | undefined): boolean {
    return !!id && !!this.schemas[id];
  }

  /** The database a page is a row of, if it is one. */
  dbOf(pageId: string | null | undefined): string | null {
    return pageId ? (this.rows[pageId]?.dbId ?? null) : null;
  }

  rowsOf(dbId: string): DbRow[] {
    return this.byDb.get(dbId) ?? [];
  }

  /** A database's templates: pages its new rows can start from. */
  templatesOf(dbId: string): DbRow[] {
    return this.#split.templates.get(dbId) ?? [];
  }

  isTemplate(id: string | null | undefined): boolean {
    return !!id && !!this.rows[id]?.template;
  }

  automations(dbId: string): Automation[] {
    return this.schemas[dbId]?.automations ?? [];
  }

  props(dbId: string): Property[] {
    const plain = this.#copies?.get(dbId);
    if (plain) return plain.list;
    return this.schemas[dbId]?.properties ?? [];
  }

  prop(dbId: string, propId: string | undefined | null): Property | undefined {
    if (!propId) return undefined;
    const plain = this.#copies?.get(dbId);
    return plain ? plain.byId.get(propId) : this.#props.get(dbId)?.get(propId);
  }

  propMap(dbId: string): Map<string, Property> {
    return this.#copies?.get(dbId)?.byId ?? this.#props.get(dbId) ?? new Map();
  }

  /**
   * While `query` works through its rows: plain copies of the properties it
   * can read. The schemas are deeply reactive, and reading a field through
   * them for every row of a big database costs more than the work itself.
   */
  #copies: Map<string, { list: Property[]; byId: Map<string, Property>; byName: Map<string, Property> }> | null = null;

  views(dbId: string): DbView[] {
    return this.schemas[dbId]?.views ?? [];
  }

  view(dbId: string, viewId: string | null | undefined): DbView | undefined {
    const views = this.views(dbId);
    return views.find((v) => v.id === viewId) ?? views[0];
  }

  title(rowOrId: DbRow | string): string {
    const id = typeof rowOrId === 'string' ? rowOrId : rowOrId.id;
    return this.#page(id)?.title || 'Untitled';
  }

  /**
   * True while `query` works through its rows: it has already followed
   * everything they read, so each value needn't follow it again.
   */
  #quiet = false;

  /** Makes the caller depend on a database's values. */
  #track(dbId: string) {
    if (!this.#quiet) void this.#version[dbId];
  }

  /**
   * A page's fields as a database value reads them: a row follows changes to
   * its database's rows, not every page. `stamps` for created/edited times.
   */
  #page(id: string, stamps = false): PageMeta | undefined {
    if (this.#quiet) return store.untracked.get(id);
    const db = this.rows[id]?.dbId;
    return (db ? store.under(db, stamps) : store.byId).get(id);
  }

  /** Tells everything showing a database's values that they changed. */
  touch(dbId: string) {
    this.#version[dbId] = (this.#version[dbId] ?? 0) + 1;
  }

  /** A stored value as it is (for editors; reading it follows changes). */
  cell(row: DbRow, propId: string): CellValue | undefined {
    this.#track(row.dbId);
    return row.cells[propId];
  }

  /** A row's picture (the first image in its page). */
  cover(row: DbRow): string | null | undefined {
    this.#track(row.dbId);
    return row.cover;
  }

  #live(id: string): DbRow | undefined {
    const row = this.rows[id];
    const page = row ? this.#page(id) : undefined;
    return page && !page.deletedAt ? row : undefined;
  }

  /** The rows a relation property links to (live ones). */
  related(row: DbRow, p: Property): DbRow[] {
    this.#track(row.dbId);
    return asList(row.cells[p.id])
      .map((id) => this.#live(id))
      .filter((r): r is DbRow => !!r);
  }

  // -------------------------------------------------------------- values

  /** What a property holds for a row, normalised for sorting and filtering. */
  get(row: DbRow, p: Property): Plain {
    this.#track(row.dbId);
    const page = this.#page(row.id, p.type === 'created' || p.type === 'edited');
    const c = row.cells[p.id];
    switch (p.type) {
      case 'title':
        return page?.title ?? '';
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        return typeof c === 'string' ? c : c === null || c === undefined ? '' : String(c);
      case 'number':
        return typeof c === 'number' && Number.isFinite(c) ? c : null;
      case 'select':
      case 'status':
        return typeof c === 'string' && option(p, c) ? c : null;
      case 'course':
        return typeof c === 'string' && planner.courseById.has(c) ? c : null;
      case 'multiSelect':
        return asList(c).filter((id) => option(p, id));
      case 'files':
        return asList(c).filter((id) => {
          const f = library.byId.get(id);
          return f && !f.deletedAt;
        });
      case 'relation':
        return this.related(row, p).map((r) => r.id);
      case 'tags':
        return page?.tags ?? [];
      case 'date':
        return isDateValue(c) ? c : null;
      case 'checkbox':
        return c === true;
      case 'created':
        return page ? { start: stamp(page.createdAt) } : null;
      case 'edited':
        return page ? { start: stamp(page.updatedAt) } : null;
      case 'id':
        return row.number;
      case 'button':
        return null;
      case 'formula':
      case 'rollup': {
        const v = p.type === 'formula' ? this.formula(row, p) : this.rollup(row, p);
        return v instanceof FormulaError ? null : this.#plain(v, this.kind(row.dbId, p));
      }
    }
  }

  #plain(v: FValue, kind: ValueKind): Plain {
    switch (kind) {
      case 'number':
        return typeof v === 'number' && !Number.isNaN(v) ? v : null;
      case 'checkbox':
        return v === true;
      case 'date':
        return v instanceof FDate ? { start: v.time ? stamp(v.ms) : isoDate(new Date(v.ms)) } : null;
      default:
        return toText(v);
    }
  }

  /** A value as text: for search, copying, CSV and plain display. */
  text(row: DbRow, p: Property): string {
    const v = this.get(row, p);
    switch (p.type) {
      case 'number':
        return formatNumber(v as number | null, p.config);
      case 'select':
      case 'status':
        return option(p, v)?.name ?? '';
      case 'multiSelect':
        return (v as string[]).map((id) => option(p, id)?.name ?? '').join(', ');
      case 'course':
        return v ? (planner.courseById.get(v as string)?.name ?? '') : '';
      case 'tags':
        return (v as string[]).join(', ');
      case 'files':
        return (v as string[]).map((id) => library.byId.get(id)?.name ?? '').join(', ');
      case 'relation':
        return (v as string[]).map((id) => this.title(id)).join(', ');
      case 'date':
        return formatDateValue(v as DateValue | null);
      case 'checkbox':
        return v ? 'Yes' : 'No';
      case 'created':
        return formatTimestamp(this.#page(row.id, true)?.createdAt ?? 0);
      case 'edited':
        return formatTimestamp(this.#page(row.id, true)?.updatedAt ?? 0);
      case 'id':
        return p.config.prefix ? `${p.config.prefix}-${row.number}` : String(row.number);
      case 'button':
        return '';
      case 'formula':
      case 'rollup': {
        const r = p.type === 'formula' ? this.formula(row, p) : this.rollup(row, p);
        if (r instanceof FormulaError) return '';
        if (typeof r === 'number') return formatNumber(r, p.config);
        return toText(r);
      }
      default:
        return (v as string) ?? '';
    }
  }

  /** What a kind of property a formula or rollup turns out to be. */
  #kinds = new Map<string, ValueKind>();

  kind(dbId: string, p: Property): ValueKind {
    if (p.type === 'rollup') {
      const fn = p.config.fn ?? 'count';
      if (fn === 'earliest' || fn === 'latest') return 'date';
      return fn === 'show' ? 'text' : 'number';
    }
    if (p.type !== 'formula') return kindOf(p);
    const key = `${dbId}|${p.id}|${p.config.expression ?? ''}`;
    const known = this.#kinds.get(key);
    if (known) return known;
    let kind: ValueKind = 'text';
    for (const row of this.rowsOf(dbId).slice(0, 40)) {
      const v = this.formula(row, p);
      if (v instanceof FormulaError || emptyF(v)) continue;
      kind = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'checkbox' : v instanceof FDate ? 'date' : 'text';
      break;
    }
    if (this.rowsOf(dbId).length) this.#kinds.set(key, kind);
    return kind;
  }

  #evaluating = new Set<string>();

  #guard<T>(key: string, f: () => T): T | FormulaError {
    if (this.#evaluating.has(key)) return new FormulaError('These formulas refer to each other in a loop');
    this.#evaluating.add(key);
    try {
      return f();
    } finally {
      this.#evaluating.delete(key);
    }
  }

  formula(row: DbRow, p: Property): FValue | FormulaError {
    const src = p.config.expression ?? '';
    if (!src.trim()) return null;
    return this.#guard(`${row.id}:${p.id}`, () => run(src, this.scope(row)));
  }

  /** What a formula sees: every property of the row, by name. */
  scope(row: DbRow, now = Date.now()): Scope {
    const names = this.#names(row.dbId);
    return {
      now,
      prop: (name) => {
        const q = names.get(name) ?? names.get(name.trim().toLowerCase());
        if (!q) return undefined;
        const v = this.fvalue(row, q);
        if (v instanceof FormulaError) throw new FormulaError(`{${q.name}} has a problem: ${v.message}`);
        return v;
      },
    };
  }

  /** A property's value as a formula sees it. */
  fvalue(row: DbRow, q: Property): FValue | FormulaError {
    const v = this.get(row, q);
    switch (q.type) {
      case 'select':
      case 'status':
        return option(q, v)?.name ?? null;
      case 'multiSelect':
        return (v as string[]).map((id) => option(q, id)?.name ?? '');
      case 'course':
        return v ? (planner.courseById.get(v as string)?.name ?? null) : null;
      case 'files':
        return (v as string[]).map((id) => library.byId.get(id)?.name ?? '');
      case 'relation':
        return (v as string[]).map((id) => this.title(id));
      case 'date': {
        const d = v as DateValue | null;
        if (!d) return null;
        const [day, time] = d.start.split('T');
        const [y, m, dd] = day.split('-').map(Number);
        const [h, mi] = (time ?? '0:0').split(':').map(Number);
        return new FDate(new Date(y, m - 1, dd, h, mi).getTime(), !!time);
      }
      case 'created':
        return new FDate(this.#page(row.id, true)?.createdAt ?? 0, true);
      case 'edited':
        return new FDate(this.#page(row.id, true)?.updatedAt ?? 0, true);
      case 'formula':
        return this.formula(row, q);
      case 'rollup':
        return this.rollup(row, q);
      default:
        return v as FValue;
    }
  }

  rollup(row: DbRow, p: Property): FValue | FormulaError {
    const rel = this.prop(row.dbId, p.config.relation);
    if (!rel || rel.type !== 'relation') return null;
    return this.#guard(`${row.id}:${p.id}`, () => {
      const linked = this.related(row, rel);
      const fn = p.config.fn ?? 'count';
      if (fn === 'count') return linked.length;
      const target = rel.config.database ? this.prop(rel.config.database, p.config.target) : undefined;
      if (!target) return fn === 'show' ? linked.map((r) => this.title(r)) : null;
      if (fn === 'percentDone') {
        // Linked rows whose status is in its "Complete" stage.
        if (!linked.length) return null;
        const done = linked.filter((r) => (option(target, this.get(r, target))?.group ?? '') === 'done').length;
        return Math.round((done / linked.length) * 100);
      }
      const values: FValue[] = [];
      for (const r of linked) {
        const v = this.fvalue(r, target);
        if (v instanceof FormulaError) return v;
        values.push(v);
      }
      const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => !emptyF(v));
      const nums = flat.filter((v): v is number => typeof v === 'number');
      const dates = flat.filter((v): v is FDate => v instanceof FDate).sort((a, b) => a.ms - b.ms);
      switch (fn) {
        case 'show':
          return flat;
        case 'countValues':
          return flat.length;
        case 'sum':
          return nums.reduce((a, b) => a + b, 0);
        case 'average':
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        case 'min':
          return nums.length ? nums.reduce((a, b) => Math.min(a, b), Infinity) : null;
        case 'max':
          return nums.length ? nums.reduce((a, b) => Math.max(a, b), -Infinity) : null;
        case 'percentChecked':
          return linked.length ? Math.round((values.filter((v) => v === true).length / linked.length) * 100) : null;
        case 'earliest':
          return dates[0] ?? null;
        case 'latest':
          return dates.at(-1) ?? null;
      }
      return null;
    });
  }

  /** Options (or courses) a property's values can take, as groups. */
  groupsFor(p: Property): { key: string; label: string; color?: string }[] {
    if (HAS_OPTIONS.has(p.type)) return options(p).map((o) => ({ key: o.id, label: o.name, color: colorVar(o.color) }));
    if (p.type === 'course') return planner.courses.map((c) => ({ key: c.id, label: c.name || 'Untitled', color: colorVar(c.color) }));
    return [];
  }

  labelFor(p: Property, key: string): string {
    if (HAS_OPTIONS.has(p.type)) return option(p, key)?.name ?? 'Deleted option';
    if (p.type === 'course') return planner.courseById.get(key)?.name ?? 'Deleted course';
    if (p.type === 'relation') return this.title(key);
    if (p.type === 'tags') return `#${key}`;
    if (p.type === 'files') return library.byId.get(key)?.name ?? '';
    return key;
  }

  ctx(dbId: string): Ctx {
    // Asked once per row while sorting and filtering; a property's kind holds for one query.
    const kinds = new Map<Property, ValueKind>();
    return {
      get: (row, p) => this.get(row, p),
      text: (row, p) => this.text(row, p),
      kind: (p) => {
        let k = kinds.get(p);
        if (k === undefined) kinds.set(p, (k = this.kind(dbId, p)));
        return k;
      },
      rank: (p, key) => {
        const i = p.type === 'course' ? planner.courses.findIndex((c) => c.id === key) : options(p).findIndex((o) => o.id === key);
        return i < 0 ? 1e9 : i;
      },
      groups: (p) => this.groupsFor(p),
      label: (p, key) => this.labelFor(p, key),
      today: clock.today,
    };
  }

  /** A view's rows: searched, filtered, sorted and (when set) grouped. */
  query(dbId: string, view: DbView, search = ''): { rows: DbRow[]; groups: Group[] | null } {
    // Follow everything the rows can read once, up front: this database and
    // the ones its relations reach (for rollups and linked titles). Then work
    // through the rows without following each value again.
    const reach = this.#reach(dbId);
    const props = [...reach].flatMap((db) => this.props(db));
    const key = [
      search,
      prefs.weekStart,
      clock.today,
      JSON.stringify(view.config),
      JSON.stringify(props),
      ...[...reach].map((db) => `${this.#version[db] ?? 0}:${store.stamp(db, this.props(db).some((p) => p.type === 'edited'))}`),
      props.some((p) => p.type === 'course') ? JSON.stringify(planner.courses) : '',
    ].join('\n');
    const files = props.some((p) => p.type === 'files') ? library.byId : null;
    const rows = this.rowsOf(dbId);
    // Nothing it reads changed (a page elsewhere was renamed or favorited):
    // hand back the same result, so the view doesn't redraw either.
    const memo = `${dbId}:${view.id}`;
    const last = this.#results.get(memo);
    if (last && last.key === key && last.rows === rows && last.files === files) return last.result;
    let result: { rows: DbRow[]; groups: Group[] | null };
    if (this.#quiet) result = this.#query(dbId, view, search);
    else {
      this.#copies = new Map(
        [...reach].map((db) => {
          const list = $state.snapshot(this.props(db)) as Property[];
          return [db, { list, byId: new Map(list.map((p) => [p.id, p])), byName: namesOf(list) }];
        }),
      );
      this.#quiet = true;
      try {
        result = this.#query(dbId, $state.snapshot(view) as DbView, search);
      } finally {
        this.#quiet = false;
        this.#copies = null;
      }
    }
    this.#results.set(memo, { key, rows, files, result });
    return result;
  }

  /** Each view's last result and what it was worked out from (one per view, so it stays as small as the views). */
  #results = new Map<string, { key: string; rows: DbRow[]; files: unknown; result: { rows: DbRow[]; groups: Group[] | null } }>();

  /** A database and every database its relations lead to, however far. */
  #reach(dbId: string): Set<string> {
    const seen = new Set([dbId]);
    for (const db of seen)
      for (const p of this.props(db)) if (p.type === 'relation' && p.config.database) seen.add(p.config.database);
    return seen;
  }

  /** Each property by its name as a formula writes it (and by id), per database. */
  #byName = $derived(new Map(Object.values(this.schemas).map((s) => [s.id, namesOf(s.properties)])));

  #names(dbId: string): Map<string, Property> {
    return this.#copies?.get(dbId)?.byName ?? this.#byName.get(dbId) ?? new Map();
  }

  #query(dbId: string, view: DbView, search: string): { rows: DbRow[]; groups: Group[] | null } {
    const ctx = this.ctx(dbId);
    const map = this.propMap(dbId);
    const c = view.config;
    let rows = this.rowsOf(dbId);
    if (search.trim()) {
      const hidden = new Set(c.hidden ?? []);
      const searched = this.props(dbId).filter((p) => p.type === 'title' || !hidden.has(p.id));
      rows = searchRows(rows, search, searched, ctx, this.#haystack(dbId, searched));
    }
    rows = filterRows(rows, c.filters ?? [], c.match ?? 'all', map, ctx, prefs.weekStart === 0);
    rows = sortRows(rows, c.sorts ?? [], map, ctx);
    const gp = c.group ? map.get(c.group) : undefined;
    return { rows, groups: gp ? groupRows(rows, gp, ctx) : null };
  }

  /**
   * Each row's searchable text, kept between keystrokes until a value or a
   * property of the database changes. Titles live on the pages, so they're
   * read fresh each time.
   */
  #hay = new Map<string, { stamp: string; texts: Map<string, string> }>();

  #haystack(dbId: string, props: Property[]): (row: DbRow) => string {
    const others = props.filter((p) => p.type !== 'title');
    const stamp = `${this.#version[dbId] ?? 0}|${JSON.stringify(others.map((p) => [p.id, p.type, p.config]))}`;
    let cache = this.#hay.get(dbId);
    if (!cache || cache.stamp !== stamp) this.#hay.set(dbId, (cache = { stamp, texts: new Map() }));
    const texts = cache.texts;
    return (row) => {
      let t = texts.get(row.id);
      if (t === undefined) texts.set(row.id, (t = others.map((p) => this.text(row, p)).join('\n').toLowerCase()));
      return `${(this.#page(row.id)?.title ?? '').toLowerCase()}\n${t}`;
    };
  }

  /** Rows with a value (not a title: search finds those) containing every word. */
  findRows(query: string, limit = 5): { row: DbRow; prop: Property; text: string }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const SEARCHED = new Set<PropertyType>(['text', 'select', 'multiSelect', 'status', 'url', 'email', 'phone', 'course', 'tags', 'number', 'date', 'relation']);
    const out: { row: DbRow; prop: Property; text: string }[] = [];
    for (const d of this.list) {
      const props = this.props(d.id).filter((p) => SEARCHED.has(p.type));
      const texts = this.#valueTexts(d.id, props);
      for (const row of this.rowsOf(d.id)) {
        const [shown, lower] = texts(row);
        const i = lower.findIndex((t) => t && words.every((w) => t.includes(w)));
        if (i >= 0) out.push({ row, prop: props[i], text: shown[i] });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Rows' values as text (and lower-cased), kept between keystrokes like `#haystack`. */
  #texts = new Map<string, { stamp: string; texts: Map<string, [string[], string[]]> }>();

  #valueTexts(dbId: string, props: Property[]): (row: DbRow) => [string[], string[]] {
    const stamp = `${this.#version[dbId] ?? 0}|${JSON.stringify(props.map((p) => [p.id, p.type, p.config]))}`;
    let cache = this.#texts.get(dbId);
    if (!cache || cache.stamp !== stamp) this.#texts.set(dbId, (cache = { stamp, texts: new Map() }));
    const texts = cache.texts;
    return (row) => {
      let t = texts.get(row.id);
      if (!t) {
        const shown = props.map((p) => this.text(row, p));
        texts.set(row.id, (t = [shown, shown.map((x) => x.toLowerCase())]));
      }
      return t;
    };
  }

  calc(dbId: string, rows: DbRow[], p: Property, fn: CalcFn): string {
    return calculate(rows, p, fn, this.ctx(dbId));
  }

  // ------------------------------------------------------------- saving

  #pending = new Map<string, { cells?: Record<string, CellValue>; sortKey?: string }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();

  #queue(id: string, patch: { cells?: Record<string, CellValue>; sortKey?: string }) {
    const cur = this.#pending.get(id) ?? {};
    this.#pending.set(id, {
      cells: patch.cells || cur.cells ? { ...cur.cells, ...patch.cells } : undefined,
      sortKey: patch.sortKey ?? cur.sortKey,
    });
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), 300);
  }

  /** Writes every change that's waiting. Safe to call any time. */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    if (!this.#pending.size) return this.#chain;
    const batch = [...this.#pending].map(([id, p]) => ({ id, ...p }));
    this.#pending.clear();
    this.#chain = this.#chain.then(async () => {
      try {
        const ts = await api.updateRows(batch);
        store.edit(new Map(batch.filter((ch) => ch.cells && store.byId.has(ch.id)).map((ch) => [ch.id, { updatedAt: ts }])));
      } catch (e) {
        ui.error(e);
      }
    });
    return this.#chain;
  }

  // -------------------------------------------------------------- undo

  #push(step: UndoStep) {
    this.#undo.push(step);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
    this.canUndo = true;
    this.canRedo = false;
  }

  async undo() {
    const step = this.#undo.pop();
    if (!step) return;
    this.#redo.push(step);
    this.canUndo = this.#undo.length > 0;
    this.canRedo = true;
    await step.undo();
    ui.toast(`Undid ${step.label}`);
  }

  async redo() {
    const step = this.#redo.pop();
    if (!step) return;
    this.#undo.push(step);
    this.canUndo = true;
    this.canRedo = this.#redo.length > 0;
    await step.redo();
    ui.toast(`Redid ${step.label}`);
  }

  // -------------------------------------------------------------- cells

  /** The stored value behind a property (for undo). */
  raw(row: DbRow, p: Property): CellValue {
    if (p.type === 'title') return this.#page(row.id)?.title ?? '';
    if (p.type === 'tags') return [...(this.#page(row.id)?.tags ?? [])];
    const v = row.cells[p.id];
    return v === undefined ? null : $state.snapshot(v) as CellValue;
  }

  /**
   * Sets values (one cell, a pasted block, a column fill…) as one undo step.
   * Edits made by hand run the database's automations, whose changes join
   * the same undo step.
   */
  set(changes: CellSet[], { undo = true, label = 'edit', automate = undo }: { undo?: boolean; label?: string; automate?: boolean } = {}) {
    if (!changes.length) return;
    let later: (() => unknown)[] = [];
    if (automate) {
      const fired = this.#triggered(changes);
      changes = [...changes, ...fired.sets];
      later = fired.later;
    }
    const before: CellSet[] = changes.map((c) => ({ row: c.row, prop: c.prop, value: this.raw(c.row, c.prop) }));
    for (const c of changes) this.#write(c.row, c.prop, c.value, true);
    if (undo) {
      const after = changes.map((c) => ({ ...c }));
      this.#push({ label, undo: () => this.set(before, { undo: false }), redo: () => this.set(after, { undo: false }) });
    }
    for (const run of later) void run();
  }

  setOne(row: DbRow, prop: Property, value: CellValue) {
    this.set([{ row, prop, value }], { label: `“${prop.name}”` });
  }

  #write(row: DbRow, p: Property, value: CellValue, syncBack: boolean) {
    switch (p.type) {
      case 'title':
        store.update(row.id, { title: typeof value === 'string' ? value : '' });
        return;
      case 'tags':
        void tags.set('pages', row.id, asList(value));
        return;
      case 'created':
      case 'edited':
      case 'id':
      case 'formula':
      case 'rollup':
      case 'button':
        return;
    }
    if (p.type === 'relation' && syncBack) this.#syncBack(row, p, asList(row.cells[p.id]), asList(value));
    const empty = value === null || value === '' || (Array.isArray(value) && !value.length) || value === false;
    if (empty) delete row.cells[p.id];
    else row.cells[p.id] = value;
    this.touch(row.dbId);
    this.#queue(row.id, { cells: { [p.id]: empty ? null : value } });
  }

  /** Keeps a two-way relation's twin in the other database in step. */
  #syncBack(row: DbRow, p: Property, before: string[], after: string[]) {
    const twinId = p.config.back;
    const otherDb = p.config.database;
    if (!twinId || !otherDb) return;
    const twin = this.prop(otherDb, twinId);
    if (!twin || twin.type !== 'relation') return;
    for (const id of after.filter((x) => !before.includes(x))) {
      const t = this.rows[id];
      const cur = t ? asList(t.cells[twinId]) : [];
      if (t && !cur.includes(row.id)) this.#write(t, twin, [...cur, row.id], false);
    }
    for (const id of before.filter((x) => !after.includes(x))) {
      const t = this.rows[id];
      const cur = t ? asList(t.cells[twinId]) : [];
      if (t && cur.includes(row.id)) this.#write(t, twin, cur.filter((x) => x !== row.id), false);
    }
  }

  /**
   * Text (typed, pasted, imported) as a value for a property. Choices that
   * don't exist yet are added to the property's list.
   */
  parse(text: string, p: Property): CellValue {
    const t = text.trim();
    switch (p.type) {
      case 'title':
      case 'text':
        return text.replace(/\r\n?/g, '\n');
      case 'url':
      case 'email':
      case 'phone':
        return t;
      case 'number':
        return parseNumber(t);
      case 'checkbox':
        return parseCheckbox(t) ?? !!t;
      case 'date':
        return parseDate(t);
      case 'select':
      case 'status':
        return t ? this.#optionFor(p, t) : null;
      case 'multiSelect':
        return [...new Set(t.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => this.#optionFor(p, x)))];
      case 'course': {
        const c = planner.courses.find((x) => x.name.trim().toLowerCase() === t.toLowerCase());
        return c?.id ?? null;
      }
      case 'tags':
        return t.split(/[,;\s]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
      case 'relation': {
        const db = p.config.database;
        if (!db) return [];
        const names = t.split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        return this.rowsOf(db)
          .filter((r) => names.includes(this.title(r).toLowerCase()))
          .map((r) => r.id);
      }
      case 'files': {
        const names = t.split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        return library.live.filter((f) => names.includes(f.name.toLowerCase())).map((f) => f.id);
      }
      default:
        return null;
    }
  }

  /** The option named `name`, added to the property if it's new. */
  #optionFor(p: Property, name: string): string {
    const found = optionNamed(p, name);
    if (found) return found.id;
    const o = newOption(p, name);
    p.config.options = [...options(p), o];
    this.#saveProp(this.#dbOfProp(p), p);
    return o.id;
  }

  /** The database a property belongs to ('' for one not saved yet). */
  #dbOfProp(p: Property): string {
    return Object.values(this.schemas).find((s) => s.properties.includes(p))?.id ?? '';
  }

  // --------------------------------------------------------------- rows

  /**
   * What a new row starts with: a status at its first stage, a template's
   * values (`base`), then what it needs to show up in a view (its filters
   * and group).
   */
  #defaults(dbId: string, view?: DbView, group?: { prop: string; key: string }, base: Record<string, CellValue> = {}): Record<string, CellValue> {
    const out: Record<string, CellValue> = {};
    // A status starts at its first "to do" stage.
    for (const p of this.props(dbId)) {
      if (p.type !== 'status') continue;
      const first = options(p).find((o) => (o.group ?? 'todo') === 'todo') ?? options(p)[0];
      if (first) out[p.id] = first.id;
    }
    Object.assign(out, base);
    for (const f of view?.config.filters ?? []) {
      const p = this.prop(dbId, f.prop);
      if (!p || !EDITABLE_CELL.has(p.type)) continue;
      const v = f.value;
      if ((f.op === 'is' || f.op === 'hasAny' || f.op === 'hasAll') && Array.isArray(v) && v.length) {
        out[p.id] = p.type === 'multiSelect' ? [...(v as string[])] : (v as string[])[0];
      } else if (f.op === 'checked') out[p.id] = true;
      else if (f.op === 'eq' && typeof v === 'number') out[p.id] = v;
      else if ((f.op === 'is' || f.op === 'contains') && typeof v === 'string' && v && (p.type === 'text' || p.type === 'url')) out[p.id] = v;
      else if (f.op === 'is' && p.type === 'date' && typeof v === 'string' && v) out[p.id] = { start: v.slice(0, 10) };
    }
    if (group) {
      const p = this.prop(dbId, group.prop);
      if (p && group.key) {
        if (p.type === 'multiSelect') out[p.id] = [group.key];
        else if (p.type === 'checkbox') out[p.id] = group.key === 'true';
        else if (p.type === 'select' || p.type === 'status' || p.type === 'course') out[p.id] = group.key;
        else if (p.type === 'text') out[p.id] = group.key;
      }
    }
    return out;
  }

  /** The template a new row starts from: the one asked for, or the view's default. */
  #templateFor(dbId: string, id: string | null | undefined): DbRow | undefined {
    const t = id ? this.rows[id] : undefined;
    const page = t ? store.byId.get(t.id) : undefined;
    return t?.template && t.dbId === dbId && page && !page.deletedAt ? t : undefined;
  }

  /**
   * Adds a row (at the end, or after/before another) and returns it. It
   * starts from `template` (or the view's default template; '' for none),
   * and runs the database's "row added" automations unless `automate` is off.
   */
  async addRow(
    dbId: string,
    opts: {
      after?: string;
      before?: string;
      title?: string;
      cells?: Record<string, CellValue>;
      view?: DbView;
      group?: { prop: string; key: string };
      tags?: string[];
      template?: string | null;
      automate?: boolean;
    } = {},
  ): Promise<DbRow | null> {
    const rows = this.rowsOf(dbId);
    let a: string | null = rows.at(-1)?.sortKey ?? null;
    let b: string | null = null;
    const at = rows.findIndex((r) => r.id === (opts.after ?? opts.before));
    if (at >= 0 && opts.after) {
      a = rows[at].sortKey;
      b = rows[at + 1]?.sortKey ?? null;
    } else if (at >= 0 && opts.before) {
      a = rows[at - 1]?.sortKey ?? null;
      b = rows[at].sortKey;
    }
    const tpl = this.#templateFor(dbId, opts.template !== undefined ? opts.template : opts.view?.config.template);
    const tplPage = tpl ? store.byId.get(tpl.id) : undefined;
    const cells = { ...this.#defaults(dbId, opts.view, opts.group, tpl ? (structuredClone($state.snapshot(tpl.cells)) as Record<string, CellValue>) : {}), ...opts.cells };
    const created = await this.#create(dbId, [
      { title: opts.title ?? tplPage?.title ?? '', icon: tplPage?.icon || undefined, sortKey: keyBetween(a, b), cells, fromTemplate: tpl?.id },
    ]);
    const row = created[0] ?? null;
    if (row) {
      const groupTags = opts.group && this.prop(dbId, opts.group.prop)?.type === 'tags' && opts.group.key ? [opts.group.key] : [];
      const t = [...(opts.tags ?? []), ...groupTags];
      if (t.length) void tags.set('pages', row.id, [...new Set([...(store.byId.get(row.id)?.tags ?? []), ...t])]);
      this.#linkNew([row]);
      this.#push({ label: 'new row', undo: () => this.#trash([row.id]), redo: () => this.#restore([row.id]) });
      if (opts.automate !== false) this.#added([row]);
    }
    return row;
  }

  /** New rows' links show up on the other side of two-way relations. */
  #linkNew(rows: DbRow[]) {
    for (const row of rows) {
      for (const p of this.props(row.dbId)) {
        if (p.type === 'relation' && p.config.back && asList(row.cells[p.id]).length) this.#syncBack(row, p, [], asList(row.cells[p.id]));
      }
    }
  }

  /** Adds many rows at once (pasting a sheet), after `afterKey`. */
  async addRows(dbId: string, list: { title: string; cells: Record<string, CellValue> }[], after?: string | null): Promise<DbRow[]> {
    const rows = this.rowsOf(dbId);
    const at = after ? rows.findIndex((r) => r.id === after) : rows.length - 1;
    const keys = keysBetween(rows[at]?.sortKey ?? null, rows[at + 1]?.sortKey ?? null, list.length);
    const created = await this.#create(
      dbId,
      list.map((r, i) => ({ title: r.title, sortKey: keys[i], cells: r.cells })),
    );
    const ids = created.map((r) => r.id);
    this.#linkNew(created);
    if (ids.length) this.#push({ label: ids.length === 1 ? 'a new row' : `${ids.length} new rows`, undo: () => this.#trash(ids), redo: () => this.#restore(ids) });
    this.#added(created);
    return created;
  }

  // ------------------------------------------------------------ templates

  /**
   * Makes a template: empty, or a copy of a row (its values, icon and page).
   * A new empty one opens, to be filled in like any row.
   */
  async newTemplate(dbId: string, from?: DbRow): Promise<DbRow | null> {
    const list = this.templatesOf(dbId);
    const page = from ? store.byId.get(from.id) : undefined;
    if (from) {
      await store.flush();
      await this.flush();
    }
    const made = await this.#create(dbId, [
      {
        title: page ? page.title : '',
        icon: page?.icon || undefined,
        sortKey: keyBetween(list.at(-1)?.sortKey ?? null, null),
        cells: from ? (structuredClone($state.snapshot(from.cells)) as Record<string, CellValue>) : this.#defaults(dbId),
        template: true,
        fromTemplate: from?.id,
      },
    ]);
    const t = made[0] ?? null;
    if (!t) return null;
    if (from) {
      ui.toast(`Saved “${page?.title || 'Untitled'}” as a template`, { label: 'Edit', run: () => store.open(t.id) });
    } else {
      store.open(t.id);
      ui.focusTitle = t.id;
    }
    return t;
  }

  /** The template new rows start from in a view (or every view: `viewId` null). */
  setDefaultTemplate(dbId: string, templateId: string, viewId: string | null) {
    for (const v of this.views(dbId)) if (viewId === null || v.id === viewId) this.updateView(dbId, v.id, { template: templateId });
  }

  // -------------------------------------------------------------- sub-items

  /** The relation that holds each row's parent, and its twin listing sub-items. */
  subItems(dbId: string): { parent: Property; children: Property | undefined } | null {
    const parent = this.props(dbId).find((p) => p.type === 'relation' && p.config.parent && p.config.database === dbId);
    if (!parent) return null;
    return { parent, children: parent.config.back ? this.prop(dbId, parent.config.back) : undefined };
  }

  /** Lets rows hold sub-items: a "Parent item" relation and its "Sub-items" twin. */
  async enableSubItems(dbId: string) {
    if (this.subItems(dbId)) return;
    const parent = await this.addProperty(dbId, 'relation', { name: this.freeName(dbId, 'Parent item'), config: { database: dbId, parent: true } });
    if (parent) await this.linkBack(dbId, parent.id, true, this.freeName(dbId, 'Sub-items'));
  }

  async disableSubItems(dbId: string) {
    const s = this.subItems(dbId);
    if (!s) return;
    const ok = await ui.confirm({
      title: 'Turn off sub-items?',
      message: `“${s.parent.name}” and “${s.children?.name ?? 'Sub-items'}” are deleted, so rows stop being nested. Undo brings them back.`,
      confirmLabel: 'Turn off',
    });
    if (!ok) return;
    if (s.children) await this.deleteProperty(dbId, s.children.id);
    await this.deleteProperty(dbId, s.parent.id);
  }

  /** The parent a row sits under (when it's among `ids`). */
  parentOf(row: DbRow, ids?: Set<string>): string | undefined {
    const s = this.subItems(row.dbId);
    if (!s) return undefined;
    this.#track(row.dbId);
    return asList(row.cells[s.parent.id]).find((x) => x !== row.id && (ids ? ids.has(x) : !!this.#live(x)));
  }

  /**
   * Rows put in tree order: each under its parent (when the parent is shown
   * too), folded unless expanded. Returns null when there are no sub-items.
   */
  nest(dbId: string, list: DbRow[]): { rows: DbRow[]; depth: Map<string, number>; kids: Map<string, number> } | null {
    if (!this.subItems(dbId)) return null;
    const ids = new Set(list.map((r) => r.id));
    const children = new Map<string, DbRow[]>();
    const roots: DbRow[] = [];
    for (const r of list) {
      const pid = this.parentOf(r, ids);
      if (!pid) roots.push(r);
      else {
        let kids = children.get(pid);
        if (!kids) children.set(pid, (kids = []));
        kids.push(r);
      }
    }
    // Rows only reachable through a loop of parents start at the top.
    const reached = new Set<string>();
    const reach = (r: DbRow) => {
      if (reached.has(r.id)) return;
      reached.add(r.id);
      for (const k of children.get(r.id) ?? []) reach(k);
    };
    roots.forEach(reach);
    for (const r of list) if (!reached.has(r.id)) {
      roots.push(r);
      reach(r);
    }
    const isRoot = new Set(roots.map((r) => r.id));
    const rows: DbRow[] = [];
    const depth = new Map<string, number>();
    const kids = new Map<string, number>();
    const seen = new Set<string>();
    const walk = (r: DbRow, d: number) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      rows.push(r);
      depth.set(r.id, d);
      const k = (children.get(r.id) ?? []).filter((x) => !isRoot.has(x.id));
      kids.set(r.id, k.length);
      if (this.expanded[r.id]) for (const c of k) walk(c, d + 1);
    };
    for (const r of roots) walk(r, 0);
    return { rows, depth, kids };
  }

  toggleExpanded(id: string) {
    this.expanded[id] = !this.expanded[id];
  }

  /** Adds a row under another, after its last sub-item. */
  async addSubItem(parent: DbRow, view?: DbView): Promise<DbRow | null> {
    const s = this.subItems(parent.dbId);
    if (!s) return null;
    this.expanded[parent.id] = true;
    const siblings = this.rowsOf(parent.dbId).filter((r) => this.parentOf(r) === parent.id);
    return this.addRow(parent.dbId, { after: siblings.at(-1)?.id ?? parent.id, view, cells: { [s.parent.id]: [parent.id] } });
  }

  // ----------------------------------------------- buttons and automations

  /** What a "set" action puts in a property of a row. */
  #actionValue(row: DbRow, p: Property, v: ActionValue): CellValue {
    switch (v.mode) {
      case 'clear':
        return p.type === 'checkbox' ? false : null;
      case 'today': {
        const d = new Date();
        d.setDate(d.getDate() + (v.days ?? 0));
        return { start: isoDate(d) };
      }
      case 'now':
        return { start: stamp(Date.now()) };
      case 'toggle':
        return this.get(row, p) !== true;
      case 'add': {
        const n = this.get(row, p);
        return (typeof n === 'number' ? n : 0) + (Number(v.by) || 0);
      }
      case 'value':
        return structuredClone($state.snapshot(v.value)) as CellValue;
    }
  }

  /** Text with {Property} replaced by a row's values ("Review of {Name}"). */
  fill(text: string, row: DbRow): string {
    return text.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
      const n = name.trim().toLowerCase();
      const q = this.props(row.dbId).find((x) => x.name.trim().toLowerCase() === n);
      return q ? (q.type === 'title' ? this.title(row) : this.text(row, q)) : whole;
    });
  }

  /** Actions as values to set now and things to do after. */
  #plan(row: DbRow, actions: DbAction[]): { sets: CellSet[]; later: (() => unknown)[] } {
    const sets: CellSet[] = [];
    const later: (() => unknown)[] = [];
    for (const a of actions) {
      if (a.type === 'set') {
        const p = this.prop(row.dbId, a.prop);
        if (p && ACTION_TYPES.has(p.type)) sets.push({ row, prop: p, value: this.#actionValue(row, p, a.value) });
      } else if (a.type === 'add') later.push(() => this.#addFrom(row, a));
      else if (a.type === 'open') later.push(() => store.open(row.id));
      else if (a.type === 'url' && a.url.trim()) {
        const url = this.fill(a.url.trim(), row);
        later.push(() => openUrl(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).catch((e) => ui.error(e)));
      }
    }
    return { sets, later };
  }

  async #addFrom(row: DbRow, a: Extract<DbAction, { type: 'add' }>) {
    const db = a.db || row.dbId;
    if (!this.schemas[db] || !this.list.some((d) => d.id === db)) return;
    const link = this.prop(db, a.link);
    const cells: Record<string, CellValue> = link?.type === 'relation' && link.config.database === row.dbId ? { [link.id]: [row.id] } : {};
    if (link?.config.parent) this.expanded[row.id] = true;
    const made = await this.addRow(db, { title: this.fill(a.title ?? '', row), cells, automate: false });
    if (!made) return;
    if (a.open) {
      store.open(made.id);
      ui.focusTitle = made.id;
    } else if (db !== row.dbId) ui.toast(`Added a row to ${store.byId.get(db)?.title || 'Untitled'}`, { label: 'Open', run: () => store.open(made.id) });
  }

  /** Clicks a button property on a row. */
  press(row: DbRow, p: Property) {
    const actions = p.config.actions ?? [];
    if (!actions.length) {
      ui.toast('This button doesn’t do anything yet: add actions in its settings');
      return;
    }
    const { sets, later } = this.#plan(row, actions);
    if (sets.length) this.set(sets, { label: `“${p.config.label || p.name}”` });
    for (const run of later) void run();
  }

  /** Whether a change of a value starts an automation. */
  #fires(a: Automation, p: Property, before: CellValue, after: CellValue): boolean {
    const norm = (v: CellValue) => (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length) ? null : v);
    if (JSON.stringify(norm(before)) === JSON.stringify(norm(after))) return false;
    const to = a.config.to;
    if (to === undefined || to === null) return true;
    if (p.type === 'checkbox') return (after === true) === to;
    if (p.type === 'multiSelect') return asList(after).includes(to as string) && !asList(before).includes(to as string);
    return after === to;
  }

  /** Changes that automations make in answer to `changes`. */
  #triggered(changes: CellSet[]): { sets: CellSet[]; later: (() => unknown)[] } {
    const sets: CellSet[] = [];
    const later: (() => unknown)[] = [];
    // What's set by hand wins over what a rule would set.
    const touched = new Set(changes.map((c) => `${c.row.id}|${c.prop.id}`));
    for (const c of changes) {
      if (c.row.template) continue;
      for (const a of this.automations(c.row.dbId)) {
        if (a.config.off || a.type !== 'changed' || a.config.prop !== c.prop.id) continue;
        if (!this.#fires(a, c.prop, this.raw(c.row, c.prop), c.value)) continue;
        const plan = this.#plan(c.row, a.config.actions ?? []);
        for (const s of plan.sets) {
          const key = `${s.row.id}|${s.prop.id}`;
          if (touched.has(key)) continue;
          touched.add(key);
          sets.push(s);
        }
        later.push(...plan.later);
      }
    }
    return { sets, later };
  }

  /** Runs "row added" automations on new rows. */
  #added(rows: DbRow[]) {
    const later: (() => unknown)[] = [];
    for (const row of rows) {
      if (row.template) continue;
      for (const a of this.automations(row.dbId)) {
        if (a.config.off || a.type !== 'added') continue;
        const plan = this.#plan(row, a.config.actions ?? []);
        for (const s of plan.sets) this.#write(s.row, s.prop, s.value, true);
        later.push(...plan.later);
      }
    }
    for (const run of later) void run();
  }

  #autoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  #saveAutomation(dbId: string, a: Automation, immediate = false) {
    const key = `${dbId}/${a.id}`;
    clearTimeout(this.#autoTimers.get(key));
    const send = () => {
      this.#autoTimers.delete(key);
      api.saveAutomation(dbId, $state.snapshot(a) as Automation).catch((e) => ui.error(e));
    };
    if (immediate) send();
    else this.#autoTimers.set(key, setTimeout(send, 400));
  }

  addAutomation(dbId: string, type: Automation['type'] = 'changed'): Automation | null {
    const schema = this.schemas[dbId];
    if (!schema) return null;
    const a: Automation = { id: shortId(), name: '', type, config: { actions: [] }, sortKey: keyBetween(schema.automations.at(-1)?.sortKey ?? null, null) };
    schema.automations.push(a);
    const live = schema.automations.at(-1)!;
    this.#saveAutomation(dbId, live, true);
    return live;
  }

  updateAutomation(dbId: string, id: string, patch: Partial<Omit<Automation, 'id'>>) {
    const a = this.automations(dbId).find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.#saveAutomation(dbId, a);
  }

  async deleteAutomation(dbId: string, id: string) {
    const schema = this.schemas[dbId];
    if (!schema) return;
    clearTimeout(this.#autoTimers.get(`${dbId}/${id}`));
    schema.automations = schema.automations.filter((a) => a.id !== id);
    await api.deleteAutomation(dbId, id).catch((e) => ui.error(e));
  }

  async #create(dbId: string, list: NewRow[]): Promise<DbRow[]> {
    try {
      await this.flush();
      const created: CreatedRow[] = [];
      for (let i = 0; i < list.length; i += BATCH) created.push(...(await api.createRows(dbId, list.slice(i, i + BATCH))));
      this.#adopt(created);
      return created.map((c) => this.rows[c.row.id]);
    } catch (e) {
      ui.error(e);
      return [];
    }
  }

  /** New rows from storage into the page list and here, in one go. */
  #adopt(created: CreatedRow[]) {
    store.adopt(created.map((c) => c.page));
    const next = { ...this.rows };
    for (const c of created) next[c.row.id] = c.row;
    this.rows = next;
  }

  async #trash(ids: string[]) {
    await this.flush();
    await store.flush();
    for (const id of ids) await api.trashPage(id);
    // Leave a row page that's going away for its database.
    const cur = store.currentId;
    if (cur && ids.some((id) => store.isInside(cur, id))) {
      const db = this.dbOf(ids.find((id) => store.isInside(cur, id)));
      if (db) store.open(db);
    }
    await store.refresh();
  }

  async #restore(ids: string[]) {
    for (const id of ids) await api.restorePage(id);
    await store.refresh();
  }

  /** Moves rows to the trash, with Undo. */
  async deleteRows(ids: string[]) {
    if (!ids.length) return;
    const label = ids.length === 1 ? `“${this.title(ids[0])}”` : `${ids.length} rows`;
    try {
      await this.#trash(ids);
      this.#push({ label: `deleting ${label}`, undo: () => this.#restore(ids), redo: () => this.#trash(ids) });
      ui.toast(`Deleted ${label}`, { label: 'Undo', run: () => void this.undo() });
    } catch (e) {
      ui.error(e);
    }
  }

  async duplicateRows(ids: string[]) {
    try {
      await this.flush();
      await store.flush();
      for (const id of ids) await api.duplicatePage(id);
      await store.refresh();
      await this.reloadRows();
    } catch (e) {
      ui.error(e);
    }
  }

  /** Puts a row between two others (by id; null for an end). */
  moveRow(id: string, after: string | null, before: string | null) {
    const row = this.rows[id];
    if (!row) return;
    const a = after ? (this.rows[after]?.sortKey ?? null) : null;
    const b = before ? (this.rows[before]?.sortKey ?? null) : null;
    const old = row.sortKey;
    const key = keyBetween(a, b);
    const apply = (k: string) => {
      row.sortKey = k;
      this.#order++;
      this.touch(row.dbId);
      this.#queue(id, { sortKey: k });
    };
    apply(key);
    this.#push({ label: 'moving a row', undo: () => apply(old), redo: () => apply(key) });
  }

  /** Moves a row's date by whole days (dragged on the Calendar). */
  shiftDate(rowId: string, propId: string, days: number) {
    const row = this.rows[rowId];
    const p = row ? this.prop(row.dbId, propId) : undefined;
    const v = row && p ? row.cells[p.id] : null;
    if (!row || !p || !isDateValue(v) || !days) return;
    const move = (s: string) => {
      const d = new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)) + days);
      return isoDate(d) + s.slice(10);
    };
    this.setOne(row, p, v.end ? { start: move(v.start), end: move(v.end) } : { start: move(v.start) });
  }

  // ---------------------------------------------------------- properties

  #propTimers = new Map<string, ReturnType<typeof setTimeout>>();

  #saveProp(dbId: string, p: Property, immediate = false) {
    if (!dbId) return;
    const key = `${dbId}/${p.id}`;
    clearTimeout(this.#propTimers.get(key));
    const send = () => {
      this.#propTimers.delete(key);
      api.saveProperty(dbId, $state.snapshot(p) as Property).catch((e) => ui.error(e));
    };
    if (immediate) send();
    else this.#propTimers.set(key, setTimeout(send, 400));
  }

  /** Changes a property's name or settings (saved shortly after). */
  updateProperty(dbId: string, propId: string, patch: Partial<Omit<Property, 'id'>>, { immediate = false, undo = true } = {}) {
    const p = this.prop(dbId, propId);
    if (!p) return;
    const before = $state.snapshot(p) as Property;
    if (patch.name !== undefined && patch.name !== p.name) this.#renameInFormulas(dbId, p.name, patch.name);
    Object.assign(p, patch);
    if (patch.sortKey) this.schemas[dbId].properties.sort(byKey);
    this.#saveProp(dbId, p, immediate);
    if (undo) {
      const after = $state.snapshot(p) as Property;
      this.#push({
        label: `changes to “${before.name}”`,
        undo: () => this.updateProperty(dbId, propId, before, { immediate: true, undo: false }),
        redo: () => this.updateProperty(dbId, propId, after, { immediate: true, undo: false }),
      });
    }
  }

  /** Formulas that name a property follow it when it's renamed. */
  #renameInFormulas(dbId: string, from: string, to: string) {
    for (const q of this.props(dbId)) {
      if (q.type !== 'formula' || !q.config.expression) continue;
      const next = renameProperty(q.config.expression, from, to);
      if (next !== q.config.expression) {
        q.config.expression = next;
        this.#saveProp(dbId, q, true);
      }
    }
  }

  /** A name not used by another property ("Text", "Text 2"…). */
  freeName(dbId: string, base: string): string {
    const taken = new Set(this.props(dbId).map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  async addProperty(
    dbId: string,
    type: PropertyType,
    opts: { name?: string; after?: string; before?: string; config?: Property['config'] } = {},
  ): Promise<Property | null> {
    const schema = this.schemas[dbId];
    if (!schema) return null;
    const list = schema.properties;
    const at = opts.after ? list.findIndex((p) => p.id === opts.after) : opts.before ? list.findIndex((p) => p.id === opts.before) - 1 : list.length - 1;
    const p: Property = {
      id: shortId(),
      name: opts.name ?? this.freeName(dbId, typeInfo(type).label),
      type,
      config: opts.config ?? defaultConfig(type),
      sortKey: keyBetween(list[at]?.sortKey ?? null, list[at + 1]?.sortKey ?? null),
    };
    list.push(p);
    list.sort(byKey);
    const live = this.prop(dbId, p.id) ?? p;
    try {
      await api.saveProperty(dbId, $state.snapshot(live) as Property);
    } catch (e) {
      ui.error(e);
      return null;
    }
    this.#push({
      label: `adding “${p.name}”`,
      undo: () => this.deleteProperty(dbId, p.id, { undo: false }),
      redo: () => this.#bringBack(dbId, p),
    });
    return live;
  }

  async #bringBack(dbId: string, p: Property) {
    const schema = this.schemas[dbId];
    if (!schema) return;
    if (!schema.properties.some((x) => x.id === p.id)) {
      schema.properties.push(structuredClone(p));
      schema.properties.sort(byKey);
    }
    await api.saveProperty(dbId, p).catch((e) => ui.error(e));
  }

  async deleteProperty(dbId: string, propId: string, { undo = true } = {}) {
    const schema = this.schemas[dbId];
    const p = this.prop(dbId, propId);
    if (!schema || !p || p.type === 'title') return;
    const snapshot = $state.snapshot(p) as Property;
    schema.properties = schema.properties.filter((x) => x.id !== propId);
    try {
      await api.deleteProperty(dbId, propId);
    } catch (e) {
      ui.error(e);
    }
    if (undo) {
      this.#push({ label: `deleting “${snapshot.name}”`, undo: () => this.#bringBack(dbId, snapshot), redo: () => this.deleteProperty(dbId, propId, { undo: false }) });
      ui.toast(`Deleted “${snapshot.name || 'Untitled'}”`, { label: 'Undo', run: () => void this.undo() });
    }
  }

  /** A copy of a property, values included, right after it. */
  async duplicateProperty(dbId: string, propId: string) {
    const p = this.prop(dbId, propId);
    if (!p || p.type === 'title') return;
    const copy = await this.addProperty(dbId, p.type, { name: this.freeName(dbId, `${p.name} copy`), after: p.id, config: structuredClone($state.snapshot(p.config)) });
    if (!copy) return;
    const changes = this.rowsOf(dbId)
      .filter((r) => r.cells[p.id] !== undefined)
      .map((row) => ({ row, prop: copy, value: structuredClone($state.snapshot(row.cells[p.id])) as CellValue }));
    this.set(changes, { undo: false });
  }

  /**
   * Turns a property into another type, converting its values through
   * text: "12" becomes a number, "Done" an option, an option its name…
   */
  async changeType(dbId: string, propId: string, type: PropertyType) {
    const p = this.prop(dbId, propId);
    if (!p || p.type === type || p.type === 'title' || type === 'title') return;
    const rows = this.rowsOf(dbId);
    const texts = new Map(rows.map((r) => [r.id, this.text(r, p)]));
    const before = $state.snapshot(p) as Property;
    const oldCells = new Map(rows.map((r) => [r.id, this.raw(r, p)]));
    let config = { ...defaultConfig(type), description: p.config.description };
    // Choices carry over between select, multi-select and status.
    if (HAS_OPTIONS.has(type) && HAS_OPTIONS.has(p.type)) config = { ...config, options: options(p).map((o) => ({ ...o, group: type === 'status' ? (o.group ?? 'todo') : undefined })) };
    else if (HAS_OPTIONS.has(type)) {
      const guess = inferType([...texts.values()]);
      if (guess.config.options && (type === guess.type || type === 'multiSelect' || type === 'select')) {
        config = { ...config, options: guess.config.options.map((o) => ({ ...o, ...(type === 'status' ? { group: 'todo' as const } : {}) })) };
      }
    }
    if (type === 'number' && p.type === 'number') config = { ...config, ...p.config };
    Object.assign(p, { type, config });
    const changes: CellSet[] = [];
    const computed = ['formula', 'rollup', 'created', 'edited', 'id'].includes(type);
    for (const row of rows) {
      const fromOptions = HAS_OPTIONS.has(type) && HAS_OPTIONS.has(before.type);
      let value: CellValue;
      if (computed) value = null;
      else if (fromOptions) {
        const ids = Array.isArray(oldCells.get(row.id)) ? (oldCells.get(row.id) as string[]) : oldCells.get(row.id) ? [oldCells.get(row.id) as string] : [];
        value = type === 'multiSelect' ? ids : (ids[0] ?? null);
      } else value = this.parse(texts.get(row.id) ?? '', p);
      changes.push({ row, prop: p, value });
    }
    for (const c of changes) this.#write(c.row, c.prop, c.value, false);
    this.#saveProp(dbId, p, true);
    this.#push({
      label: `changing “${p.name}” to ${typeInfo(type).label}`,
      undo: () => {
        const cur = this.prop(dbId, propId);
        if (!cur) return;
        Object.assign(cur, structuredClone(before));
        this.#saveProp(dbId, cur, true);
        for (const row of rows) this.#write(row, cur, oldCells.get(row.id) ?? null, false);
      },
      redo: () => this.changeType(dbId, propId, type),
    });
  }

  /** Makes a relation two-way: a twin property in the other database. */
  async linkBack(dbId: string, propId: string, on: boolean, twinName?: string) {
    const p = this.prop(dbId, propId);
    const other = p?.config.database;
    if (!p || !other || !this.schemas[other]) return;
    if (!on) {
      const twin = p.config.back;
      this.updateProperty(dbId, propId, { config: { ...p.config, back: null } }, { immediate: true, undo: false });
      if (twin) await this.deleteProperty(other, twin, { undo: false });
      return;
    }
    const name = twinName ?? this.freeName(other, store.byId.get(dbId)?.title || 'Related');
    const twin = await this.addProperty(other, 'relation', { name, config: { database: dbId, back: p.id } });
    if (!twin) return;
    this.updateProperty(dbId, propId, { config: { ...p.config, back: twin.id } }, { immediate: true, undo: false });
    // Fill the twin from the links that exist now.
    const changes = new Map<string, string[]>();
    for (const row of this.rowsOf(dbId)) {
      for (const id of asList(row.cells[p.id])) changes.set(id, [...(changes.get(id) ?? []), row.id]);
    }
    for (const [id, linked] of changes) {
      const t = this.rows[id];
      if (t) this.#write(t, twin, linked, false);
    }
  }

  // --------------------------------------------------------------- views

  #viewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  #saveView(dbId: string, v: DbView, immediate = false) {
    const key = `${dbId}/${v.id}`;
    clearTimeout(this.#viewTimers.get(key));
    const send = () => {
      this.#viewTimers.delete(key);
      api.saveView(dbId, $state.snapshot(v) as DbView).catch((e) => ui.error(e));
    };
    if (immediate) send();
    else this.#viewTimers.set(key, setTimeout(send, 400));
  }

  /** Changes a view's settings (filters, sorts, widths…). */
  updateView(dbId: string, viewId: string, patch: Partial<ViewConfig>) {
    const v = this.views(dbId).find((x) => x.id === viewId);
    if (!v) return;
    v.config = { ...v.config, ...patch };
    this.#saveView(dbId, v);
  }

  renameView(dbId: string, viewId: string, name: string) {
    const v = this.views(dbId).find((x) => x.id === viewId);
    if (!v) return;
    v.name = name;
    this.#saveView(dbId, v);
  }

  /** Sensible settings for a new view of a type (a board groups by status…). */
  async defaultsFor(dbId: string, type: ViewType): Promise<ViewConfig> {
    const props = this.props(dbId);
    const first = (...types: PropertyType[]) => {
      for (const t of types) {
        const p = props.find((x) => x.type === t);
        if (p) return p;
      }
      return undefined;
    };
    switch (type) {
      case 'board': {
        const g = first('status', 'select', 'course', 'checkbox', 'multiSelect') ?? (await this.addProperty(dbId, 'status', { name: this.freeName(dbId, 'Status') }));
        return { group: g?.id ?? null };
      }
      case 'calendar': {
        const d = first('date') ?? (await this.addProperty(dbId, 'date', { name: this.freeName(dbId, 'Date') }));
        return { dateProp: d?.id };
      }
      case 'timeline': {
        const d = first('date') ?? (await this.addProperty(dbId, 'date', { name: this.freeName(dbId, 'Dates') }));
        return { dateProp: d?.id, scale: 'week', showTable: true };
      }
      case 'form':
        return { form: { fields: props.filter((p) => FORM_TYPES.has(p.type)).map((p) => ({ prop: p.id, required: p.type === 'title' })) } };
      case 'chart': {
        const x = first('status', 'select', 'course', 'multiSelect', 'checkbox', 'tags', 'date');
        const y = first('number');
        return { chart: { kind: 'bar', x: x?.id ?? 'title', agg: y ? 'sum' : 'count', y: y?.id } };
      }
      case 'gallery':
        return { cover: 'page', cardSize: 'medium' };
      default:
        return {};
    }
  }

  /** Shows a view another way (a table as a board…), keeping its filters. */
  async changeViewType(dbId: string, viewId: string, type: ViewType) {
    const v = this.views(dbId).find((x) => x.id === viewId);
    if (!v || v.type === type) return;
    const needs = await this.defaultsFor(dbId, type);
    const c = v.config;
    const missing =
      (type === 'board' && !this.prop(dbId, c.group)) ||
      ((type === 'calendar' || type === 'timeline') && !this.prop(dbId, c.dateProp)) ||
      (type === 'timeline' && !c.scale) ||
      (type === 'form' && !c.form) ||
      (type === 'chart' && !c.chart) ||
      (type === 'gallery' && !c.cover);
    v.type = type;
    v.config = missing ? { ...c, ...needs } : c;
    // A view still named after its old layout takes the new one's name.
    if (Object.values(VIEW_NAMES).includes(v.name)) v.name = VIEW_NAMES[type];
    this.#saveView(dbId, v, true);
  }

  async addView(dbId: string, type: ViewType): Promise<DbView | null> {
    const schema = this.schemas[dbId];
    if (!schema) return null;
    const label = VIEW_NAMES[type];
    const taken = new Set(schema.views.map((v) => v.name));
    let name = label;
    for (let i = 2; taken.has(name); i++) name = `${label} ${i}`;
    const v: DbView = {
      id: shortId(),
      name,
      type,
      config: await this.defaultsFor(dbId, type),
      sortKey: keyBetween(schema.views.at(-1)?.sortKey ?? null, null),
    };
    schema.views.push(v);
    this.#saveView(dbId, v, true);
    return schema.views.at(-1)!;
  }

  async duplicateView(dbId: string, viewId: string): Promise<DbView | null> {
    const schema = this.schemas[dbId];
    const src = schema?.views.find((v) => v.id === viewId);
    if (!schema || !src) return null;
    const i = schema.views.indexOf(src);
    const v: DbView = {
      ...structuredClone($state.snapshot(src) as DbView),
      id: shortId(),
      name: `${src.name} copy`,
      sortKey: keyBetween(src.sortKey, schema.views[i + 1]?.sortKey ?? null),
    };
    schema.views.push(v);
    schema.views.sort(byKey);
    this.#saveView(dbId, v, true);
    return schema.views.find((x) => x.id === v.id) ?? null;
  }

  async deleteView(dbId: string, viewId: string) {
    const schema = this.schemas[dbId];
    if (!schema || schema.views.length < 2) return;
    schema.views = schema.views.filter((v) => v.id !== viewId);
    await api.deleteView(dbId, viewId).catch((e) => ui.error(e));
  }

  moveView(dbId: string, viewId: string, toIndex: number) {
    const schema = this.schemas[dbId];
    const v = schema?.views.find((x) => x.id === viewId);
    if (!schema || !v) return;
    const rest = schema.views.filter((x) => x !== v);
    v.sortKey = keyBetween(rest[toIndex - 1]?.sortKey ?? null, rest[toIndex]?.sortKey ?? null);
    schema.views.sort(byKey);
    this.#saveView(dbId, v, true);
  }

  // ---------------------------------------------------------- databases

  #descTimer: ReturnType<typeof setTimeout> | undefined;

  setDescription(dbId: string, text: string) {
    const s = this.schemas[dbId];
    if (!s) return;
    s.description = text;
    clearTimeout(this.#descTimer);
    this.#descTimer = setTimeout(() => api.updateDatabase(dbId, text).catch((e) => ui.error(e)), 400);
  }

  /** Makes a database from a template (or a blank one) and opens it. */
  async create(
    opts: { template?: Template; parentId?: string | null; title?: string; icon?: string; open?: boolean; rows?: NewRow[] } = {},
  ): Promise<PageMeta | null> {
    const t = opts.template ?? TEMPLATES[0];
    try {
      await store.flush();
      // One call takes up to BATCH rows; a big import sends the rest after.
      const rows = opts.rows ?? [];
      const res = await api.createDatabase(opts.parentId ?? null, opts.title ?? (t.key === 'blank' ? '' : t.name), opts.icon ?? t.icon, {
        properties: t.properties,
        views: t.views,
        rows: rows.slice(0, BATCH),
      });
      const created = [...res.rows];
      for (let i = BATCH; i < rows.length; i += BATCH) created.push(...(await api.createRows(res.page.id, rows.slice(i, i + BATCH))));
      store.adopt([res.page]);
      this.schemas[res.database.id] = sortSchema(res.database);
      this.#adopt(created);
      if (opts.open !== false) {
        store.open(res.page.id);
        // Name it straight away (typing replaces the template's name).
        ui.focusTitle = res.page.id;
      }
      return res.page;
    } catch (e) {
      ui.error(e);
      return null;
    }
  }

  /**
   * A database from a spreadsheet (CSV or tab-separated): the first row
   * names the columns, the first column becomes the title, and each other
   * column gets the type its values look like.
   */
  async importText(name: string, text: string, opts: { parentId?: string | null; open?: boolean } = {}): Promise<PageMeta | null> {
    const table = parseCsv(text);
    if (table.length < 1) {
      ui.toast('That file has no rows to import');
      return null;
    }
    const [header, ...body] = table;
    const width = table.map((r) => r.length).reduce((a, b) => Math.max(a, b), -Infinity);
    const names = Array.from({ length: width }, (_, i) => (header[i] ?? '').trim() || `Column ${i + 1}`);
    const keys = keysBetween(null, null, width);
    const props: Property[] = names.map((n, i) => {
      if (i === 0) return { id: 'title', name: n, type: 'title', config: {}, sortKey: keys[0] };
      const guess = inferType(body.map((r) => r[i] ?? ''));
      return { id: shortId(), name: n, type: guess.type, config: guess.config, sortKey: keys[i] };
    });
    const rowKeys = keysBetween(null, null, body.length);
    const rows: NewRow[] = body.map((r, ri) => {
      const cells: Record<string, CellValue> = {};
      props.forEach((p, i) => {
        if (i === 0) return;
        const v = this.parse(r[i] ?? '', p);
        if (v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false) cells[p.id] = v;
      });
      return { title: (r[0] ?? '').trim(), sortKey: rowKeys[ri], cells };
    });
    const template: Template = {
      key: 'import',
      name,
      icon: lineIcon('table', 'green'),
      description: '',
      properties: props,
      views: [{ id: 'table', name: 'Table', type: 'table', config: {}, sortKey: 'a0' }],
    };
    const page = await this.create({ template, title: name, parentId: opts.parentId, open: opts.open, rows });
    if (page) ui.toast(`Imported ${rows.length} row${rows.length === 1 ? '' : 's'} into “${name}”`);
    return page;
  }

  /**
   * Rows from a spreadsheet added to an existing database: columns go to
   * the properties with the same names; new columns become new properties.
   */
  async importInto(dbId: string, text: string) {
    const table = parseCsv(text);
    if (table.length < 2) {
      ui.toast('That file has no rows to import');
      return;
    }
    const [header, ...body] = table;
    const titleProp = this.props(dbId).find((p) => p.type === 'title');
    const cols: (Property | null)[] = [];
    for (let i = 0; i < header.length; i++) {
      const name = header[i].trim();
      let p = this.props(dbId).find((x) => x.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
      if (!p && name) {
        const guess = inferType(body.map((r) => r[i] ?? ''));
        p = await this.addProperty(dbId, guess.type, { name, config: guess.config });
      }
      cols.push(p);
    }
    // No column named like the title: the first one is it.
    const titleAt = cols.findIndex((p) => p?.type === 'title');
    if (titleAt < 0 && titleProp) cols[0] = titleProp;
    const list = body.map((r) => {
      const cells: Record<string, CellValue> = {};
      let title = '';
      cols.forEach((p, i) => {
        if (!p) return;
        if (p.type === 'title') title = (r[i] ?? '').trim();
        else if (EDITABLE_CELL.has(p.type) || p.type === 'relation' || p.type === 'files') {
          const v = this.parse(r[i] ?? '', p);
          if (v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false) cells[p.id] = v;
        }
      });
      return { title, cells };
    });
    const made = await this.addRows(dbId, list);
    if (made.length) ui.toast(`Added ${made.length} row${made.length === 1 ? '' : 's'} from the file`);
  }

  /** A database as editor JSON (a bold title and a table), for exports. */
  asTable(dbId: string, viewId: string | null): JNode[] {
    const view = this.view(dbId, viewId ?? prefs.dbViews[dbId]);
    const title = store.byId.get(dbId)?.title || 'Untitled database';
    const heading: JNode = { type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'bold' }] }] };
    if (!view) return [heading];
    const hidden = new Set(view.config.hidden ?? []);
    const cols = this.props(dbId).filter((p) => p.type === 'title' || !hidden.has(p.id));
    const { rows } = this.query(dbId, view);
    const cell = (type: string, text: string): JNode => ({ type, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
    return [
      heading,
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: cols.map((p) => cell('tableHeader', p.name)) },
          ...rows.map((r) => ({ type: 'tableRow', content: cols.map((p) => cell('tableCell', p.type === 'title' ? this.title(r) : this.text(r, p))) })),
        ],
      },
    ];
  }

  /** A view's rows as CSV in Downloads (what's showing, in that order). */
  async exportCsv(dbId: string, viewId: string) {
    const view = this.view(dbId, viewId);
    if (!view) return;
    const hidden = new Set(view.config.hidden ?? []);
    const props = this.props(dbId).filter((p) => p.type === 'title' || !hidden.has(p.id));
    const { rows } = this.query(dbId, view);
    const table = [props.map((p) => p.name), ...rows.map((r) => props.map((p) => this.text(r, p)))];
    const title = store.byId.get(dbId)?.title || 'Untitled';
    try {
      const path = await api.exportDocument(view.name === 'Table' ? title : `${title} - ${view.name}`, 'csv', new TextEncoder().encode('﻿' + stringify(table)));
      ui.toast(`Saved ${path.split(/[\\/]/).pop()} to Downloads`);
    } catch (e) {
      ui.error(e);
    }
  }

  // -------------------------------------------------------- the calendar

  /** Rows with a date shown on the Calendar, by day. */
  calendarItems = $derived.by(() => {
    const out: { row: DbRow; dbId: string; prop: Property; start: string; end: string; time: string | null }[] = [];
    for (const schema of Object.values(this.schemas)) {
      const dateProps = schema.properties.filter((p) => p.type === 'date' && p.config.onCalendar);
      if (!dateProps.length) continue;
      const dbPage = store.placed.get(schema.id);
      if (!dbPage || dbPage.deletedAt) continue;
      this.#track(schema.id);
      for (const row of this.rowsOf(schema.id)) {
        for (const p of dateProps) {
          const v = row.cells[p.id];
          if (!isDateValue(v)) continue;
          const [start, time] = v.start.split('T');
          const end = (v.end ?? v.start).slice(0, 10);
          out.push({ row, dbId: schema.id, prop: p, start, end: end < start ? start : end, time: time ?? null });
        }
      }
    }
    return out;
  });
}

/** Most rows storage takes in one call (see MAX_BATCH in databases.rs). */
const BATCH = 20_000;

/** Types a button or automation can set. */
export const ACTION_TYPES = new Set<PropertyType>(['title', 'text', 'number', 'select', 'multiSelect', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'course']);

/** Types a form can ask for. */
export const FORM_TYPES = new Set<PropertyType>(['title', 'text', 'number', 'select', 'multiSelect', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'course', 'relation', 'files', 'tags']);

/** Types whose cells a new row can be given from a view's filters. */
const EDITABLE_CELL = new Set<PropertyType>(['text', 'number', 'select', 'multiSelect', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'course']);

export const VIEW_NAMES: Record<ViewType, string> = {
  table: 'Table',
  board: 'Board',
  gallery: 'Gallery',
  list: 'List',
  calendar: 'Calendar',
  chart: 'Chart',
  timeline: 'Timeline',
  form: 'Form',
};

function sortSchema(s: DatabaseSchema): DatabaseSchema {
  return { ...s, properties: [...s.properties].sort(byKey), views: [...s.views].sort(byKey), automations: [...(s.automations ?? [])].sort(byKey) };
}

export const databases = new Databases();
// For poking at in the browser console while developing.
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { databases: Databases }).databases = databases;

/** The first image in a page body (editor JSON), for gallery cards. */
export function firstImage(content: string): string | null {
  if (!content.includes('"image"')) return null;
  const walk = (node: { type?: string; attrs?: { src?: string }; content?: unknown[] }): string | null => {
    if (node.type === 'image') return node.attrs?.src ?? null;
    for (const child of (node.content ?? []) as (typeof node)[]) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  try {
    return walk(JSON.parse(content));
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  // Pages copied elsewhere (a row, or a whole database, duplicated from its
  // menu) bring their values and schema.
  window.addEventListener('td:pages-copied', () => void databases.flush().then(() => databases.load()));
  // A row's page saved: its first image may have changed.
  window.addEventListener('td:page-saved', (e) => {
    const { id, content } = (e as CustomEvent<{ id: string; content: string }>).detail;
    const row = databases.rows[id];
    if (row) {
      row.cover = firstImage(content);
      databases.touch(row.dbId);
    }
  });
}
