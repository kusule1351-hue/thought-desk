/**
 * Filtering, sorting, grouping, searching and summing up rows. Works on
 * plain values from a Ctx (the databases store provides it), so it knows
 * nothing about pages, courses or formulas.
 */

import { byKey } from './order';
import { CALC_LABELS, formatDay, formatNumber, isoDate, kindOf, toDate, type ValueKind } from './schema';
import { t, type PluralKey, type TextKey } from '../i18n';
import { fmt } from '../i18n/format';
import type { CalcFn, DateValue, DbRow, FilterRule, Property, SortRule } from '../types';

/** A message without plural forms. */
type Key = TextKey;

/** A row's value, normalised by kind (see ValueKind):
 * text → string, number → number | null, option → id | null,
 * options/list → string[], date → DateValue | null, checkbox → boolean. */
export type Plain = string | number | boolean | string[] | DateValue | null;

export interface Ctx {
  get(row: DbRow, p: Property): Plain;
  text(row: DbRow, p: Property): string;
  kind(p: Property): ValueKind;
  /** Where an option (or course) sits in its list, for sorting and grouping. */
  rank(p: Property, key: string): number;
  /** Every group an option-like property can have, in order. */
  groups(p: Property): { key: string; label: string; color?: string }[];
  /** A value's name (an option's name, a course's name…). */
  label(p: Property, key: string): string;
  today: string;
}

// -------------------------------------------------------------------- filters

export interface OpInfo {
  op: string;
  label: string;
  /** What the filter's value is. */
  input: 'text' | 'number' | 'options' | 'date' | 'days' | 'none';
}

const EMPTY_OPS: OpInfo[] = [
  { op: 'isEmpty', label: t('database.ops.isEmpty'), input: 'none' },
  { op: 'isNotEmpty', label: t('database.ops.isNotEmpty'), input: 'none' },
];

/** Each kind's filter conditions (`op` is stored in views; the label is what the filter panel shows). The number ones are symbols, the same in every language. */
export const OPS: Record<ValueKind, OpInfo[]> = {
  text: [
    { op: 'contains', label: t('database.ops.text.contains'), input: 'text' },
    { op: 'notContains', label: t('database.ops.text.notContains'), input: 'text' },
    { op: 'is', label: t('database.ops.text.is'), input: 'text' },
    { op: 'isNot', label: t('database.ops.text.isNot'), input: 'text' },
    { op: 'startsWith', label: t('database.ops.text.startsWith'), input: 'text' },
    { op: 'endsWith', label: t('database.ops.text.endsWith'), input: 'text' },
    ...EMPTY_OPS,
  ],
  number: [
    { op: 'eq', label: '=', input: 'number' },
    { op: 'neq', label: '≠', input: 'number' },
    { op: 'gt', label: '>', input: 'number' },
    { op: 'lt', label: '<', input: 'number' },
    { op: 'gte', label: '≥', input: 'number' },
    { op: 'lte', label: '≤', input: 'number' },
    ...EMPTY_OPS,
  ],
  option: [
    { op: 'is', label: t('database.ops.option.is'), input: 'options' },
    { op: 'isNot', label: t('database.ops.option.isNot'), input: 'options' },
    ...EMPTY_OPS,
  ],
  options: [
    { op: 'hasAny', label: t('database.ops.options.hasAny'), input: 'options' },
    { op: 'hasAll', label: t('database.ops.options.hasAll'), input: 'options' },
    { op: 'hasNone', label: t('database.ops.options.hasNone'), input: 'options' },
    ...EMPTY_OPS,
  ],
  list: [{ op: 'hasAny', label: t('database.ops.list.hasAny'), input: 'options' }, { op: 'hasNone', label: t('database.ops.list.hasNone'), input: 'options' }, ...EMPTY_OPS],
  date: [
    { op: 'is', label: t('database.ops.date.is'), input: 'date' },
    { op: 'before', label: t('database.ops.date.before'), input: 'date' },
    { op: 'after', label: t('database.ops.date.after'), input: 'date' },
    { op: 'onOrBefore', label: t('database.ops.date.onOrBefore'), input: 'date' },
    { op: 'onOrAfter', label: t('database.ops.date.onOrAfter'), input: 'date' },
    { op: 'pastDays', label: t('database.ops.date.pastDays'), input: 'days' },
    { op: 'nextDays', label: t('database.ops.date.nextDays'), input: 'days' },
    { op: 'thisWeek', label: t('database.ops.date.thisWeek'), input: 'none' },
    { op: 'thisMonth', label: t('database.ops.date.thisMonth'), input: 'none' },
    ...EMPTY_OPS,
  ],
  checkbox: [
    { op: 'checked', label: t('database.ops.checkbox.checked'), input: 'none' },
    { op: 'unchecked', label: t('database.ops.checkbox.unchecked'), input: 'none' },
  ],
};

export type RelativeDay = 'today' | 'tomorrow' | 'yesterday' | 'oneWeekAgo' | 'oneWeekFromNow';

/** Relative days a date filter can use instead of a fixed date (the key is stored in the filter). */
export const RELATIVE_DAYS: { key: RelativeDay; label: string; days: number }[] = [
  { key: 'today', label: t('common.today'), days: 0 },
  { key: 'tomorrow', label: t('common.tomorrow'), days: 1 },
  { key: 'yesterday', label: t('common.yesterday'), days: -1 },
  { key: 'oneWeekAgo', label: t('database.relativeDays.oneWeekAgo'), days: -7 },
  { key: 'oneWeekFromNow', label: t('database.relativeDays.oneWeekFromNow'), days: 7 },
];

// ------------------------------------------------- filters as sentences

/** A filter's chip, for conditions with a typed value ({value}), picked values ({values}) or none. */
const RULES: Record<ValueKind, Record<string, Key>> = {
  text: {
    contains: 'database.rule.text.contains',
    notContains: 'database.rule.text.notContains',
    is: 'database.rule.text.is',
    isNot: 'database.rule.text.isNot',
    startsWith: 'database.rule.text.startsWith',
    endsWith: 'database.rule.text.endsWith',
  },
  number: {
    eq: 'database.rule.number.eq',
    neq: 'database.rule.number.neq',
    gt: 'database.rule.number.gt',
    lt: 'database.rule.number.lt',
    gte: 'database.rule.number.gte',
    lte: 'database.rule.number.lte',
  },
  option: { is: 'database.rule.option.is', isNot: 'database.rule.option.isNot' },
  options: { hasAny: 'database.rule.options.hasAny', hasAll: 'database.rule.options.hasAll', hasNone: 'database.rule.options.hasNone' },
  list: { hasAny: 'database.rule.list.hasAny', hasNone: 'database.rule.list.hasNone' },
  date: { thisWeek: 'database.rule.date.thisWeek', thisMonth: 'database.rule.date.thisMonth' },
  checkbox: { checked: 'database.rule.checkbox.checked', unchecked: 'database.rule.checkbox.unchecked' },
};

type DateOp = 'is' | 'before' | 'after' | 'onOrBefore' | 'onOrAfter';

/** A date filter's chip, one sentence per day it can name: a fixed date, or each relative day. */
const DATE_RULES: Record<DateOp, Record<RelativeDay | 'date', Key>> = {
  is: {
    date: 'database.rule.date.is.date',
    today: 'database.rule.date.is.today',
    tomorrow: 'database.rule.date.is.tomorrow',
    yesterday: 'database.rule.date.is.yesterday',
    oneWeekAgo: 'database.rule.date.is.oneWeekAgo',
    oneWeekFromNow: 'database.rule.date.is.oneWeekFromNow',
  },
  before: {
    date: 'database.rule.date.before.date',
    today: 'database.rule.date.before.today',
    tomorrow: 'database.rule.date.before.tomorrow',
    yesterday: 'database.rule.date.before.yesterday',
    oneWeekAgo: 'database.rule.date.before.oneWeekAgo',
    oneWeekFromNow: 'database.rule.date.before.oneWeekFromNow',
  },
  after: {
    date: 'database.rule.date.after.date',
    today: 'database.rule.date.after.today',
    tomorrow: 'database.rule.date.after.tomorrow',
    yesterday: 'database.rule.date.after.yesterday',
    oneWeekAgo: 'database.rule.date.after.oneWeekAgo',
    oneWeekFromNow: 'database.rule.date.after.oneWeekFromNow',
  },
  onOrBefore: {
    date: 'database.rule.date.onOrBefore.date',
    today: 'database.rule.date.onOrBefore.today',
    tomorrow: 'database.rule.date.onOrBefore.tomorrow',
    yesterday: 'database.rule.date.onOrBefore.yesterday',
    oneWeekAgo: 'database.rule.date.onOrBefore.oneWeekAgo',
    oneWeekFromNow: 'database.rule.date.onOrBefore.oneWeekFromNow',
  },
  onOrAfter: {
    date: 'database.rule.date.onOrAfter.date',
    today: 'database.rule.date.onOrAfter.today',
    tomorrow: 'database.rule.date.onOrAfter.tomorrow',
    yesterday: 'database.rule.date.onOrAfter.yesterday',
    oneWeekAgo: 'database.rule.date.onOrAfter.oneWeekAgo',
    oneWeekFromNow: 'database.rule.date.onOrAfter.oneWeekFromNow',
  },
};

/** A date filter's chip with a number of days. */
const DAYS_RULES: Record<string, PluralKey> = { pastDays: 'database.rule.date.pastDays', nextDays: 'database.rule.date.nextDays' };

/** A filter as its chip says it ("Status is Done, Doing", "Due is before today"); `names` are those of the values picked. */
export function ruleText(name: string, kind: ValueKind, rule: FilterRule, names: string[]): string {
  const op = OPS[kind].find((o) => o.op === rule.op);
  if (!op) return name;
  if (rule.op === 'isEmpty') return t('database.rule.isEmpty', { name });
  if (rule.op === 'isNotEmpty') return t('database.rule.isNotEmpty', { name });
  const days = DAYS_RULES[rule.op];
  if (op.input === 'days' && days) {
    // A value left from another condition (a day picked before) counts as none, as the filter itself takes it.
    const n = Number(rule.value ?? 7);
    return t(days, { name, count: Number.isFinite(n) ? n : 0 });
  }
  const dated = DATE_RULES[rule.op as DateOp];
  if (op.input === 'date' && dated && !Array.isArray(rule.value)) {
    const rel = RELATIVE_DAYS.find((d) => d.key === rule.value);
    return rel ? t(dated[rel.key], { name }) : t(dated.date, { name, date: String(rule.value ?? '') });
  }
  const key = RULES[kind][rule.op];
  if (!key) return name;
  // Values picked from a list read as one ("Done, Doing"); a typed one as typed.
  const value = Array.isArray(rule.value) ? fmt.list(names, 'conjunction', 'narrow') : rule.value === undefined || rule.value === null ? '' : String(rule.value);
  return t(key, { name, value, values: value });
}

export function addDaysIso(day: string, n: number): string {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** A filter's date: a fixed day, or a relative one worked out from today. */
export function resolveDay(value: unknown, today: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  const rel = RELATIVE_DAYS.find((r) => r.key === value);
  return rel ? addDaysIso(today, rel.days) : value.slice(0, 10);
}

/** First day of the week holding `day` (Monday, or Sunday when weeks start then). */
function weekStart(day: string, sunday: boolean): string {
  const d = toDate(day);
  const back = sunday ? d.getDay() : (d.getDay() + 6) % 7;
  return addDaysIso(day, -back);
}

function isEmptyPlain(v: Plain): boolean {
  return v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
}

export function matches(row: DbRow, rule: FilterRule, p: Property, ctx: Ctx, weekStartsSunday = false): boolean {
  const kind = ctx.kind(p);
  const v = ctx.get(row, p);
  if (rule.op === 'isEmpty') return kind === 'checkbox' ? v !== true : isEmptyPlain(v);
  if (rule.op === 'isNotEmpty') return kind === 'checkbox' ? v === true : !isEmptyPlain(v);
  const want = rule.value;
  switch (kind) {
    case 'checkbox':
      return rule.op === 'checked' ? v === true : v !== true;
    case 'number': {
      const target = typeof want === 'number' ? want : want === '' || want === undefined || want === null ? null : Number(want);
      if (target === null || Number.isNaN(target)) return true;
      if (typeof v !== 'number') return rule.op === 'neq';
      switch (rule.op) {
        case 'eq':
          return v === target;
        case 'neq':
          return v !== target;
        case 'gt':
          return v > target;
        case 'lt':
          return v < target;
        case 'gte':
          return v >= target;
        case 'lte':
          return v <= target;
      }
      return true;
    }
    case 'option':
    case 'options':
    case 'list': {
      const ids = Array.isArray(want) ? (want as string[]) : typeof want === 'string' && want ? [want] : [];
      if (!ids.length) return true;
      const have = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
      switch (rule.op) {
        case 'is':
        case 'hasAny':
          return have.some((x) => ids.includes(x));
        case 'isNot':
        case 'hasNone':
          return !have.some((x) => ids.includes(x));
        case 'hasAll':
          return ids.every((x) => have.includes(x));
      }
      return true;
    }
    case 'date': {
      const day = v && typeof v === 'object' && !Array.isArray(v) ? (v as DateValue).start.slice(0, 10) : null;
      const end = v && typeof v === 'object' && !Array.isArray(v) ? ((v as DateValue).end ?? (v as DateValue).start).slice(0, 10) : null;
      if (rule.op === 'thisWeek' || rule.op === 'thisMonth') {
        if (!day) return false;
        if (rule.op === 'thisMonth') return day.slice(0, 7) === ctx.today.slice(0, 7);
        const from = weekStart(ctx.today, weekStartsSunday);
        return day >= from && day <= addDaysIso(from, 6);
      }
      if (rule.op === 'pastDays' || rule.op === 'nextDays') {
        const n = Math.max(0, Number(want) || 0);
        if (!day) return false;
        return rule.op === 'pastDays' ? day <= ctx.today && day >= addDaysIso(ctx.today, -n) : day >= ctx.today && day <= addDaysIso(ctx.today, n);
      }
      const target = resolveDay(want, ctx.today);
      if (!target) return true;
      if (!day || !end) return false;
      switch (rule.op) {
        case 'is':
          return day <= target && end >= target;
        case 'before':
          return day < target;
        case 'after':
          return day > target;
        case 'onOrBefore':
          return day <= target;
        case 'onOrAfter':
          return day >= target;
      }
      return true;
    }
    default: {
      const needle = String(want ?? '').trim().toLowerCase();
      if (!needle) return true;
      const hay = ctx.text(row, p).toLowerCase();
      switch (rule.op) {
        case 'contains':
          return hay.includes(needle);
        case 'notContains':
          return !hay.includes(needle);
        case 'is':
          return hay.trim() === needle;
        case 'isNot':
          return hay.trim() !== needle;
        case 'startsWith':
          return hay.startsWith(needle);
        case 'endsWith':
          return hay.trimEnd().endsWith(needle);
      }
      return true;
    }
  }
}

/** Whether a rule is complete enough to apply (an empty "contains" isn't). */
export function ruleActive(rule: FilterRule, p: Property | undefined, ctx: Ctx): boolean {
  if (!p) return false;
  const info = OPS[ctx.kind(p)].find((o) => o.op === rule.op);
  if (!info) return false;
  if (info.input === 'none') return true;
  const v = rule.value;
  return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
}

export function filterRows(
  rows: DbRow[],
  rules: FilterRule[],
  match: 'all' | 'any',
  props: Map<string, Property>,
  ctx: Ctx,
  weekStartsSunday = false,
): DbRow[] {
  const active = rules.filter((r) => ruleActive(r, props.get(r.prop), ctx));
  if (!active.length) return rows;
  return rows.filter((row) => {
    const test = (r: FilterRule) => matches(row, r, props.get(r.prop)!, ctx, weekStartsSunday);
    return match === 'any' ? active.some(test) : active.every(test);
  });
}

// ------------------------------------------------------------------- sorting

const collator = fmt.collator({ numeric: true, sensitivity: 'base' });

/** A comparable stand-in for a value; null sorts last either way. */
function sortKey(v: Plain, p: Property, ctx: Ctx): number | string | null {
  const kind = ctx.kind(p);
  if (v === null || v === '' || (Array.isArray(v) && !v.length)) return kind === 'checkbox' ? 0 : null;
  switch (kind) {
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'checkbox':
      return v === true ? 1 : 0;
    case 'option':
      return ctx.rank(p, String(v));
    case 'date':
      return typeof v === 'object' && !Array.isArray(v) ? (v as DateValue).start : null;
    default:
      return null;
  }
}

/** A row's value for sorting by a property: a number, text, or null (always last). */
function sortValue(row: DbRow, p: Property, ctx: Ctx, textual: boolean): string | number | null {
  return textual ? ctx.text(row, p) || null : sortKey(ctx.get(row, p), p, ctx);
}

function compareValues(x: string | number | null, y: string | number | null, desc: boolean): number {
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
  return desc ? -c : c;
}

const isTextual = (kind: string) => kind === 'text' || kind === 'options' || kind === 'list';

export function compareRows(a: DbRow, b: DbRow, rule: SortRule, p: Property, ctx: Ctx): number {
  const textual = isTextual(ctx.kind(p));
  return compareValues(sortValue(a, p, ctx, textual), sortValue(b, p, ctx, textual), rule.dir === 'desc');
}

/**
 * Rows in order. Each row's sort values are worked out once, not at every
 * comparison: tens of thousands of rows make hundreds of thousands of those.
 */
export function sortRows(rows: DbRow[], sorts: SortRule[], props: Map<string, Property>, ctx: Ctx): DbRow[] {
  const rules = sorts.filter((s) => props.has(s.prop));
  if (!rules.length) return [...rows].sort(byKey);
  const specs = rules.map((r) => {
    const p = props.get(r.prop)!;
    return { p, desc: r.dir === 'desc', textual: isTextual(ctx.kind(p)) };
  });
  const keyed = rows.map((row) => ({ row, keys: specs.map((s) => sortValue(row, s.p, ctx, s.textual)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const c = compareValues(a.keys[i], b.keys[i], specs[i].desc);
      if (c) return c;
    }
    return byKey(a.row, b.row);
  });
  return keyed.map((k) => k.row);
}

/**
 * Rows just added in a view go first (newest on top) until the view is left:
 * they're on screen at once and stay put while being filled in, however long
 * the list or wherever the sort would put them.
 */
export function pinFirst(rows: DbRow[], ids: string[]): DbRow[] {
  if (!ids.length) return rows;
  const at = new Map(ids.map((id, i) => [id, i]));
  const top = rows.filter((r) => at.has(r.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return top.length ? [...top, ...rows.filter((r) => !at.has(r.id))] : rows;
}

// ------------------------------------------------------------------ searching

export function searchRows(rows: DbRow[], query: string, props: Property[], ctx: Ctx, hay?: (row: DbRow) => string): DbRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  const text = hay ?? ((row: DbRow) => props.map((p) => ctx.text(row, p)).join('\n').toLowerCase());
  return rows.filter((row) => {
    const h = text(row);
    return words.every((w) => h.includes(w));
  });
}

// ------------------------------------------------------------------- grouping

export interface Group {
  key: string;
  label: string;
  color?: string;
  rows: DbRow[];
}

const MONTH_YEAR: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };

/** Properties a view can be grouped by. */
export function canGroup(p: Property): boolean {
  return !['title', 'id', 'rollup', 'created', 'edited', 'files', 'button'].includes(p.type);
}

export function groupRows(rows: DbRow[], p: Property, ctx: Ctx): Group[] {
  const kind = ctx.kind(p);
  const empty: Group = { key: '', label: p.name ? t('database.group.empty', { name: p.name }) : t('database.group.emptyUnnamed'), rows: [] };
  if (kind === 'option' || kind === 'options') {
    const groups = ctx.groups(p).map((g) => ({ ...g, rows: [] as DbRow[] }));
    const byKey = new Map(groups.map((g) => [g.key, g]));
    for (const row of rows) {
      const v = ctx.get(row, p);
      const keys = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
      let placed = false;
      for (const k of keys) {
        let g = byKey.get(k);
        if (!g) {
          // A value whose option was deleted (or a tag with no list): its own group.
          g = { key: k, label: ctx.label(p, k), rows: [] };
          byKey.set(k, g);
          groups.push(g);
        }
        g.rows.push(row);
        placed = true;
      }
      if (!placed) empty.rows.push(row);
    }
    return [empty, ...groups];
  }
  if (kind === 'checkbox') {
    const off: Group = { key: 'false', label: t('database.group.unchecked'), rows: [] };
    const on: Group = { key: 'true', label: t('database.group.checked'), rows: [] };
    for (const row of rows) (ctx.get(row, p) === true ? on : off).rows.push(row);
    return [off, on];
  }
  const map = new Map<string, Group>();
  for (const row of rows) {
    const v = ctx.get(row, p);
    let key = '';
    let label = '';
    if (kind === 'date') {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        key = (v as DateValue).start.slice(0, 7);
        label = fmt.date(toDate(`${key}-01`), MONTH_YEAR);
      }
    } else if (Array.isArray(v)) {
      // Lists (relations): one group per item.
      for (const item of v) {
        const g = map.get(item) ?? { key: item, label: ctx.label(p, item), rows: [] };
        g.rows.push(row);
        map.set(item, g);
      }
      if (v.length) continue;
    } else {
      key = ctx.text(row, p).trim();
      label = key;
    }
    if (!key) {
      empty.rows.push(row);
      continue;
    }
    const g = map.get(key) ?? { key, label, rows: [] };
    g.rows.push(row);
    map.set(key, g);
  }
  const groups = [...map.values()].sort((a, b) =>
    kind === 'number' ? Number(a.key) - Number(b.key) : kind === 'date' ? (a.key < b.key ? -1 : 1) : collator.compare(a.label, b.label),
  );
  return kind === 'date' ? [...groups, empty] : [empty, ...groups];
}

// ---------------------------------------------------------------- summaries

const PERCENT: Intl.NumberFormatOptions = { style: 'percent', maximumFractionDigits: 1 };
/** Counts under a column are written without thousands separators ("1234"), as they always were, in the locale's digits. */
const COUNT: Intl.NumberFormatOptions = { useGrouping: false };

/** A column's summary, ready to show ("12", "$1,204.50", "45%"). */
export function calculate(rows: DbRow[], p: Property, fn: CalcFn, ctx: Ctx): string {
  if (fn === 'none') return '';
  const kind = ctx.kind(p);
  const values = rows.map((r) => ctx.get(r, p));
  const filled = values.filter((v) => !isEmptyPlain(v));
  // A share to one decimal place (rounded here, as it always was), written the locale's way: "45.5%".
  const pct = (n: number) => fmt.number(rows.length ? Math.round((n / rows.length) * 1000) / 1000 : 0, PERCENT);
  const numFmt = (n: number) => (p.type === 'number' || p.type === 'formula' || p.type === 'rollup' ? formatNumber(n, p.config) : formatNumber(n));
  switch (fn) {
    case 'count':
      return fmt.number(rows.length, COUNT);
    case 'countValues':
      return fmt.number(filled.length, COUNT);
    case 'countEmpty':
      return fmt.number(rows.length - filled.length, COUNT);
    case 'countUnique':
      return fmt.number(new Set(rows.filter((r) => !isEmptyPlain(ctx.get(r, p))).flatMap((r) => (kind === 'options' || kind === 'list' ? (ctx.get(r, p) as string[]) : [ctx.text(r, p)]))).size, COUNT);
    case 'percentFilled':
      return pct(filled.length);
    case 'percentEmpty':
      return pct(rows.length - filled.length);
    case 'checked':
      return fmt.number(values.filter((v) => v === true).length, COUNT);
    case 'unchecked':
      return fmt.number(values.filter((v) => v !== true).length, COUNT);
    case 'percentChecked':
      return pct(values.filter((v) => v === true).length);
  }
  if (kind === 'date') {
    const days = filled.map((v) => (v as DateValue).start).sort();
    if (!days.length) return '';
    if (fn === 'earliest') return formatDay(days[0]);
    if (fn === 'latest') return formatDay(days[days.length - 1]);
    if (fn === 'range') {
      const span = Math.round((toDate(days[days.length - 1].slice(0, 10)).getTime() - toDate(days[0].slice(0, 10)).getTime()) / 86_400_000);
      return t('database.calcDays', { count: span });
    }
    return '';
  }
  const nums = filled.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return '';
  switch (fn) {
    case 'sum':
      return numFmt(nums.reduce((a, b) => a + b, 0));
    case 'average':
      return numFmt(nums.reduce((a, b) => a + b, 0) / nums.length);
    case 'median': {
      const s = [...nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return numFmt(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
    case 'min':
      return numFmt(nums.reduce((a, b) => Math.min(a, b), Infinity));
    case 'max':
      return numFmt(nums.reduce((a, b) => Math.max(a, b), -Infinity));
    case 'range':
      return numFmt(nums.reduce((a, b) => Math.max(a, b), -Infinity) - nums.reduce((a, b) => Math.min(a, b), Infinity));
  }
  return '';
}

/** "Sum", "Count all"… shown before a summary. */
export const calcLabel = (fn: CalcFn) => CALC_LABELS[fn];

export { kindOf, isoDate };
