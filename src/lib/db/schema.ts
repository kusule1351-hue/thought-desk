/**
 * Property types: what each one is called, how its values look as text, and
 * how text (typed, pasted or imported) becomes a value.
 */

import { nextColor } from '../colors';
import { i18n, t, tAll } from '../i18n';
import { fmt } from '../i18n/format';
import type { CalcFn, DateValue, NumberFormat, Property, PropertyConfig, PropertyType, RollupFn, SelectOption } from '../types';

// The labels here are worked out once, when the app starts: changing the
// interface's language restarts the window. A label that is also a default
// written into a database (a new property's name, a status option) is
// written in the language of the day.

/** The sections of the type picker, in order, and what each is called. */
export const TYPE_GROUPS = ['basic', 'app', 'advanced', 'automatic'] as const;
export type TypeGroup = (typeof TYPE_GROUPS)[number];
export const TYPE_GROUP_LABELS: Record<TypeGroup, string> = {
  basic: t('database.typeGroups.basic'),
  app: t('database.typeGroups.app'),
  advanced: t('database.typeGroups.advanced'),
  automatic: t('database.typeGroups.automatic'),
};

export interface TypeInfo {
  type: PropertyType;
  /** What the type is called; also the name a new property of it gets. */
  label: string;
  icon: string;
  hint: string;
  group: TypeGroup;
}

export const TYPES: TypeInfo[] = [
  { type: 'title', label: t('database.types.title'), icon: 'text', hint: t('database.typeHints.title'), group: 'basic' },
  { type: 'text', label: t('database.types.text'), icon: 'text', hint: t('database.typeHints.text'), group: 'basic' },
  { type: 'number', label: t('database.types.number'), icon: 'hash', hint: t('database.typeHints.number'), group: 'basic' },
  { type: 'select', label: t('database.types.select'), icon: 'select', hint: t('database.typeHints.select'), group: 'basic' },
  { type: 'multiSelect', label: t('database.types.multiSelect'), icon: 'list', hint: t('database.typeHints.multiSelect'), group: 'basic' },
  { type: 'status', label: t('database.types.status'), icon: 'status', hint: t('database.typeHints.status'), group: 'basic' },
  { type: 'date', label: t('database.types.date'), icon: 'calendar', hint: t('database.typeHints.date'), group: 'basic' },
  { type: 'checkbox', label: t('database.types.checkbox'), icon: 'check-square', hint: t('database.typeHints.checkbox'), group: 'basic' },
  { type: 'url', label: t('database.types.url'), icon: 'link', hint: t('database.typeHints.url'), group: 'basic' },
  { type: 'email', label: t('database.types.email'), icon: 'mail', hint: t('database.typeHints.email'), group: 'basic' },
  { type: 'phone', label: t('database.types.phone'), icon: 'phone', hint: t('database.typeHints.phone'), group: 'basic' },
  { type: 'course', label: t('common.course'), icon: 'book', hint: t('database.typeHints.course'), group: 'app' },
  { type: 'tags', label: t('common.tags'), icon: 'tag', hint: t('database.typeHints.tags'), group: 'app' },
  { type: 'files', label: t('database.types.files'), icon: 'paperclip', hint: t('database.typeHints.files'), group: 'app' },
  { type: 'relation', label: t('database.types.relation'), icon: 'relation', hint: t('database.typeHints.relation'), group: 'advanced' },
  { type: 'rollup', label: t('database.types.rollup'), icon: 'sigma', hint: t('database.typeHints.rollup'), group: 'advanced' },
  { type: 'formula', label: t('database.types.formula'), icon: 'function', hint: t('database.typeHints.formula'), group: 'advanced' },
  { type: 'button', label: t('database.types.button'), icon: 'pointer', hint: t('database.typeHints.button'), group: 'advanced' },
  { type: 'id', label: t('database.types.id'), icon: 'hash', hint: t('database.typeHints.id'), group: 'automatic' },
  { type: 'created', label: t('database.types.created'), icon: 'clock', hint: t('database.typeHints.created'), group: 'automatic' },
  { type: 'edited', label: t('database.types.edited'), icon: 'clock', hint: t('database.typeHints.edited'), group: 'automatic' },
];

export const typeInfo = (type: PropertyType): TypeInfo => TYPES.find((x) => x.type === type) ?? TYPES[1];

/** Types whose values are typed in (not calculated or automatic). */
export const EDITABLE = new Set<PropertyType>(['title', 'text', 'number', 'select', 'multiSelect', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'files', 'relation', 'tags', 'course']);
/** Types with a list of options. */
export const HAS_OPTIONS = new Set<PropertyType>(['select', 'multiSelect', 'status']);
/** Types whose values live on the row's page rather than in its cells. */
export const ON_PAGE = new Set<PropertyType>(['title', 'tags', 'created', 'edited', 'id']);

/** A short random id for properties, views and options. */
export function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const abc = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from(bytes, (b) => abc[b % 62]).join('');
}

/** A new status property's options (their names are written into the database; ids and groups are what code goes by). */
export const STATUS_OPTIONS: SelectOption[] = [
  { id: 'todo', name: t('database.statusOptions.todo'), color: 'gray', group: 'todo' },
  { id: 'doing', name: t('database.statusOptions.doing'), color: 'blue', group: 'doing' },
  { id: 'done', name: t('database.statusOptions.done'), color: 'green', group: 'done' },
];

export const STATUS_GROUPS: { key: 'todo' | 'doing' | 'done'; label: string }[] = [
  { key: 'todo', label: t('database.statusGroups.todo') },
  { key: 'doing', label: t('database.statusGroups.doing') },
  { key: 'done', label: t('database.statusGroups.done') },
];

/** Settings a new property of a type starts with. */
export function defaultConfig(type: PropertyType): PropertyConfig {
  switch (type) {
    case 'select':
    case 'multiSelect':
      return { options: [] };
    case 'status':
      return { options: STATUS_OPTIONS.map((o) => ({ ...o })) };
    case 'number':
      return { format: 'number' };
    case 'formula':
      return { expression: '' };
    case 'rollup':
      return { fn: 'count' };
    case 'id':
      return { prefix: '' };
    case 'button':
      return { label: '', actions: [] };
    default:
      return {};
  }
}

export function options(p: Property): SelectOption[] {
  return p.config.options ?? [];
}

/** Options by id, per list (a list is replaced, never changed in place, when edited). */
const optionMaps = new WeakMap<SelectOption[], Map<string, SelectOption>>();

export function option(p: Property, id: unknown): SelectOption | undefined {
  if (typeof id !== 'string') return undefined;
  const list = options(p);
  // Short lists are quicker to scan than to index.
  if (list.length < 8) return list.find((o) => o.id === id);
  let map = optionMaps.get(list);
  if (!map) optionMaps.set(list, (map = new Map(list.map((o) => [o.id, o]))));
  return map.get(id);
}

/** A new option for a property's list, in the next unused colour. */
export function newOption(p: Property, name: string): SelectOption {
  const used = options(p).map((o) => o.color);
  return { id: shortId(), name: name.trim(), color: nextColor(used), ...(p.type === 'status' ? { group: 'todo' as const } : {}) };
}

/** The option called `name` (any case), if there is one. */
export function optionNamed(p: Property, name: string): SelectOption | undefined {
  const n = name.trim().toLowerCase();
  return options(p).find((o) => o.name.toLowerCase() === n);
}

// ------------------------------------------------------------------ numbers

const CURRENCY: Partial<Record<NumberFormat, string>> = { dollar: 'USD', euro: 'EUR', pound: 'GBP', yen: 'JPY', rupee: 'INR' };
/** Each format's options for fmt.number, by format and decimals. */
const numberOptions = new Map<string, Intl.NumberFormatOptions>();

/**
 * How the locale writes a percentage around its number ("{n}%", "{n} %",
 * "%{n}"). A percent value is stored as written (45 for 45%): the number is
 * formatted as it is and put in this pattern, rather than divided by 100 for
 * Intl's percent style, which would round some halves the other way.
 */
let percentPattern: string | null = null;
function asPercent(number: string): string {
  if (percentPattern === null) {
    const pattern = fmt.number(0.45, { style: 'percent' }).replace(fmt.number(45), '{n}');
    percentPattern = pattern.includes('{n}') ? pattern : '{n}%';
  }
  return percentPattern.replace('{n}', number);
}

/** A number property's value as it's shown, the locale's way ("1,234.5", "$12.00", "45%"). */
export function formatNumber(n: number | null | undefined, config: PropertyConfig = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
  const format = config.format ?? 'number';
  const decimals = config.decimals ?? null;
  const key = `${format}|${decimals}`;
  let opts = numberOptions.get(key);
  if (!opts) {
    const digits = decimals === null ? undefined : decimals;
    const currency = CURRENCY[format];
    opts = {
      style: currency ? 'currency' : 'decimal',
      currency,
      useGrouping: format !== 'number',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits ?? (currency ? undefined : 6),
    };
    numberOptions.set(key, opts);
  }
  const text = fmt.number(n, opts);
  return format === 'percent' ? asPercent(text) : text;
}

export const NUMBER_FORMATS: { key: NumberFormat; label: string; example: string }[] = [
  { key: 'number', label: t('database.numberFormats.number'), example: formatNumber(1234.5, { format: 'number' }) },
  { key: 'comma', label: t('database.numberFormats.comma'), example: formatNumber(1234.5, { format: 'comma' }) },
  { key: 'percent', label: t('database.numberFormats.percent'), example: formatNumber(45, { format: 'percent' }) },
  { key: 'dollar', label: t('database.numberFormats.dollar'), example: formatNumber(1234.5, { format: 'dollar' }) },
  { key: 'euro', label: t('database.numberFormats.euro'), example: formatNumber(1234.5, { format: 'euro' }) },
  { key: 'pound', label: t('database.numberFormats.pound'), example: formatNumber(1234.5, { format: 'pound' }) },
  { key: 'yen', label: t('database.numberFormats.yen'), example: formatNumber(1234.5, { format: 'yen' }) },
  { key: 'rupee', label: t('database.numberFormats.rupee'), example: formatNumber(1234.5, { format: 'rupee' }) },
];

/** "1,234.5", "$12", "45%", "(30)", "1.5k" → a number; null if it isn't one. */
export function parseNumber(text: string): number | null {
  let s = text.trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s$€£¥₹%]|,(?=\d{3}\b)/g, '').replace(/^(USD|EUR|GBP|JPY|INR)/i, '');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([kmb])?$/i.exec(s);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k'] ?? 1;
  return sign * Number(m[1]) * mult;
}

// -------------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses a stored date ("2026-10-14" or "2026-10-14T09:30") as local time. */
export function toDate(s: string): Date {
  const [day, time] = s.split('T');
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = (time ?? '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0);
}

export const hasTime = (s: string) => s.includes('T');

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DAY_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const DAY_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const DAY_YEAR_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };

/** "Oct 14", "Oct 14, 2025" (another year), "Oct 14, 9:30 AM", the locale's way. */
export function formatDay(s: string): string {
  const d = toDate(s);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return hasTime(s) ? fmt.dateTime(d, thisYear ? DAY_TIME : DAY_YEAR_TIME) : fmt.date(d, thisYear ? DAY : DAY_YEAR);
}

export function formatDateValue(v: DateValue | null | undefined): string {
  if (!v?.start) return '';
  return v.end ? t('database.dateRange', { start: formatDay(v.start), end: formatDay(v.end) }) : formatDay(v.start);
}

export function formatTimestamp(ms: number): string {
  return formatDay(`${isoDate(new Date(ms))}T${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The words parseDate reads besides the English ones: the interface's
 * language's month names (long and short, on their own and as written
 * beside a day: "март", "14 марта"), "today", "tomorrow" and "yesterday" in
 * every language, and whether the locale writes 10/14 day first. Worked
 * out on first use.
 */
let dateWords: { months: Map<string, number>; relative: Map<string, number>; dayFirst: boolean } | null = null;
function words() {
  if (dateWords) return dateWords;
  const months = new Map<string, number>();
  for (const style of ['long', 'short'] as const) {
    fmt.monthNames(style).forEach((name, i) => {
      const w = name.toLowerCase().replace(/\.$/, '');
      if (w && !months.has(w)) months.set(w, i);
    });
    // The month's word in a date with a day ("15 de marzo" → "marzo"); kept only where each month has its own.
    const beside = Array.from({ length: 12 }, (_, i) => {
      const found = fmt.date(new Date(2024, i, 15), { day: 'numeric', month: style }).toLowerCase().match(/\p{L}+/gu) ?? [];
      return found.sort((a, b) => b.length - a.length)[0] ?? '';
    });
    if (beside.every(Boolean) && new Set(beside).size === 12) {
      beside.forEach((w, i) => {
        if (!months.has(w)) months.set(w, i);
      });
    }
  }
  const relative = new Map<string, number>([
    ['today', 0],
    ['tomorrow', 1],
    ['yesterday', -1],
  ]);
  for (const w of tAll('common.today')) relative.set(w.trim().toLowerCase(), 0);
  for (const w of tAll('common.tomorrow')) relative.set(w.trim().toLowerCase(), 1);
  for (const w of tAll('common.yesterday')) relative.set(w.trim().toLowerCase(), -1);
  // How the locale writes 22 November 2024 in numbers: "11/22/2024" is month first, "22/11/2024" and "22.11.2024" day first.
  // A locale that writes the year first ("2024-11-22", "2024/11/22") says nothing about how a day and a month alone are
  // typed: those keep the rule from before, day first everywhere but the US.
  const sample = fmt.date(new Date(2024, 10, 22), { day: 'numeric', month: 'numeric', year: 'numeric', numberingSystem: 'latn' });
  const dayAt = sample.indexOf('22');
  const monthAt = sample.indexOf('11');
  const yearAt = sample.indexOf('2024');
  const told = dayAt >= 0 && monthAt >= 0 && !(yearAt >= 0 && yearAt < dayAt && yearAt < monthAt);
  return (dateWords = { months, relative, dayFirst: told ? dayAt < monthAt : !/^en-us/i.test(i18n.locale) });
}

/** The month a word names (0–11): the locale's name for it, or English ("oct", "October"); -1 if none. */
function monthOf(word: string): number {
  const own = words().months.get(word);
  if (own !== undefined) return own;
  return /^[a-z]{3,}$/.test(word) ? MONTHS.indexOf(word.slice(0, 3)) : -1;
}

/** Text people type or paste as a date ("2026-10-14", "10/14/2026",
 * "14 Oct 2026", "Oct 14", "today", "tomorrow 3pm"…), in English or the
 * interface's language ("14. Okt.", "mañana"). */
export function parseDate(text: string, today = new Date()): DateValue | null {
  let s = text.trim().toLowerCase();
  if (!s) return null;
  // A range written "start → end", "start - end" or "start to end".
  const range = s.split(/\s*(?:→|←|–|—| to | - )\s*/);
  if (range.length === 2 && range[0] && range[1]) {
    const a = parseDate(range[0], today);
    const b = parseDate(range[1], today);
    if (a && b) return { start: a.start, end: b.start };
  }
  let time = '';
  const tm = /(?:^|\s|t|,)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (tm && (tm[2] || tm[3])) {
    let h = +tm[1];
    const mi = tm[2] ? +tm[2] : 0;
    const ap = tm[3]?.[0];
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h < 24 && mi < 60) {
      time = `T${pad(h)}:${pad(mi)}`;
      // The "T" of "2026-10-14T09:30", not the end of a month ("14 Oct, 9:30").
      s = s.slice(0, tm.index).replace(/[,\s]+$/, '').replace(/(\d)t$/, '$1');
    }
  }
  const y0 = today.getFullYear();
  let day: Date | null = null;
  const rel = words().relative.get(s);
  let m: RegExpExecArray | null;
  let mo = -1;
  if (!s && time) day = today;
  else if (rel !== undefined) day = new Date(y0, today.getMonth(), today.getDate() + rel);
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) day = new Date(+m[1], +m[2] - 1, +m[3]);
  else if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s))) {
    // Month first where the locale writes it so (the US), day first elsewhere; a value over 12 settles it.
    const dayFirst = words().dayFirst || +m[1] > 12;
    const [d, month] = dayFirst && +m[2] <= 12 ? [+m[1], +m[2]] : [+m[2], +m[1]];
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : y0;
    day = new Date(y, month - 1, d);
  } else if ((m = /^(?:\p{L}+\.?,?\s+)?(\p{L}{2,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/u.exec(s)) && (mo = monthOf(m[1])) >= 0) {
    // "Oct 14", "Tue, Oct 14, 2026" (a weekday first, in any language, is skipped).
    day = new Date(m[3] ? +m[3] : y0, mo, +m[2]);
  } else if (
    (m = /^(?:\p{L}+\.?,?\s+)?(\d{1,2})(?:st|nd|rd|th|\.)?\s+(?:\p{L}{1,3}\.?\s+)?(\p{L}{2,})\.?,?(?:\s+(?:\p{L}{1,3}\.?\s+)?(\d{4})(?:\s+\p{L}{1,3}\.?)?)?$/u.exec(s)) &&
    (mo = monthOf(m[2])) >= 0
  ) {
    // "14 Oct 2026", "14. Okt.", "mardi 14 octobre", "14 de octubre de 2026", "14 окт. 2026 г.".
    day = new Date(m[3] ? +m[3] : y0, mo, +m[1]);
  } else {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms) && /\d/.test(text)) {
      const d = new Date(ms);
      day = d;
      if (!time && /\d:\d/.test(text)) time = `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  if (!day || Number.isNaN(day.getTime())) return null;
  return { start: isoDate(day) + time };
}

// ---------------------------------------------------------------- checkboxes

/** A checkbox as text (a copied cell, a text column it's turned into); parseCheckbox reads it back. */
export const checkboxText = (on: boolean) => t(on ? 'common.yes' : 'common.no');

/** Words read as a ticked or an empty box: English ones, and "Yes" and "No" in every language (worked out on first use). */
let checkboxWords: { on: Set<string>; off: Set<string> } | null = null;

export function parseCheckbox(text: string): boolean | null {
  const s = text.trim().toLowerCase();
  checkboxWords ??= {
    on: new Set(['true', 'yes', 'y', '1', 'x', '✓', '✔', '☑', 'checked', 'done', 'on', ...tAll('common.yes').map((w) => w.trim().toLowerCase())]),
    off: new Set(['false', 'no', 'n', '0', '', '☐', 'unchecked', 'off', ...tAll('common.no').map((w) => w.trim().toLowerCase())]),
  };
  if (checkboxWords.on.has(s)) return true;
  if (checkboxWords.off.has(s)) return false;
  return null;
}

// ------------------------------------------------------------- guessing types

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

/** A good type for a column of imported text. */
export function inferType(values: string[]): { type: PropertyType; config: PropertyConfig } {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return { type: 'text', config: {} };
  const share = (test: (v: string) => boolean) => vals.filter(test).length / vals.length;
  if (share((v) => parseCheckbox(v) !== null && !/^\d$/.test(v)) >= 0.95 && vals.some((v) => !/^[01]$/.test(v))) return { type: 'checkbox', config: {} };
  if (share((v) => parseNumber(v) !== null) >= 0.9) {
    const format: NumberFormat = vals.some((v) => v.includes('$'))
      ? 'dollar'
      : vals.some((v) => v.includes('€'))
        ? 'euro'
        : vals.some((v) => v.includes('£'))
          ? 'pound'
          : vals.some((v) => v.includes('%'))
            ? 'percent'
            : vals.some((v) => /\d,\d{3}/.test(v))
              ? 'comma'
              : 'number';
    return { type: 'number', config: { format } };
  }
  if (share((v) => /\d/.test(v) && parseDate(v) !== null) >= 0.9) return { type: 'date', config: {} };
  if (share((v) => URL_RE.test(v)) >= 0.9) return { type: 'url', config: {} };
  if (share((v) => EMAIL_RE.test(v)) >= 0.9) return { type: 'email', config: {} };
  if (share((v) => PHONE_RE.test(v) && /\d{3}/.test(v)) >= 0.9) return { type: 'phone', config: {} };
  // Short values that repeat: a list of choices.
  const listy = vals.filter((v) => v.includes(',') && v.length < 120);
  if (listy.length >= vals.length * 0.3) {
    const parts = vals.flatMap((v) => v.split(',').map((x) => x.trim()).filter(Boolean));
    const distinct = new Set(parts.map((p) => p.toLowerCase()));
    if (distinct.size <= Math.max(12, parts.length / 3) && parts.every((p) => p.length <= 40)) {
      return { type: 'multiSelect', config: { options: optionsFrom([...new Set(parts)]) } };
    }
  }
  const distinct = new Set(vals.map((v) => v.toLowerCase()));
  if (distinct.size <= 12 && distinct.size < vals.length && vals.every((v) => v.length <= 40)) {
    return { type: 'select', config: { options: optionsFrom([...new Map(vals.map((v) => [v.toLowerCase(), v])).values()]) } };
  }
  return { type: 'text', config: {} };
}

function optionsFrom(names: string[]): SelectOption[] {
  const out: SelectOption[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: shortId(), name, color: nextColor(out.map((o) => o.color)) });
  }
  return out;
}

// --------------------------------------------------------------- summaries

export const ROLLUP_FNS: { key: RollupFn; label: string }[] = [
  { key: 'show', label: t('database.rollup.show') },
  { key: 'count', label: t('database.rollup.count') },
  { key: 'countValues', label: t('database.rollup.countValues') },
  { key: 'sum', label: t('database.rollup.sum') },
  { key: 'average', label: t('database.rollup.average') },
  { key: 'min', label: t('database.rollup.min') },
  { key: 'max', label: t('database.rollup.max') },
  { key: 'percentChecked', label: t('database.rollup.percentChecked') },
  { key: 'percentDone', label: t('database.rollup.percentDone') },
  { key: 'earliest', label: t('database.rollup.earliest') },
  { key: 'latest', label: t('database.rollup.latest') },
];

export const CALC_LABELS: Record<CalcFn, string> = {
  none: t('database.calc.none'),
  count: t('database.calc.count'),
  countValues: t('database.calc.countValues'),
  countEmpty: t('database.calc.countEmpty'),
  countUnique: t('database.calc.countUnique'),
  percentFilled: t('database.calc.percentFilled'),
  percentEmpty: t('database.calc.percentEmpty'),
  sum: t('database.calc.sum'),
  average: t('database.calc.average'),
  median: t('database.calc.median'),
  min: t('database.calc.min'),
  max: t('database.calc.max'),
  range: t('database.calc.range'),
  checked: t('database.calc.checked'),
  unchecked: t('database.calc.unchecked'),
  percentChecked: t('database.calc.percentChecked'),
  earliest: t('database.calc.earliest'),
  latest: t('database.calc.latest'),
};

/** The same, short enough for the line under a narrow column (none: nothing). */
export const CALC_SHORT: Record<CalcFn, string> = {
  none: '',
  count: t('database.calcShort.count'),
  countValues: t('database.calcShort.countValues'),
  countEmpty: t('database.calcShort.countEmpty'),
  countUnique: t('database.calcShort.countUnique'),
  percentFilled: t('database.calcShort.percentFilled'),
  percentEmpty: t('database.calcShort.percentEmpty'),
  sum: t('database.calcShort.sum'),
  average: t('database.calcShort.average'),
  median: t('database.calcShort.median'),
  min: t('database.calcShort.min'),
  max: t('database.calcShort.max'),
  range: t('database.calcShort.range'),
  checked: t('database.calcShort.checked'),
  unchecked: t('database.calcShort.unchecked'),
  percentChecked: t('database.calcShort.percentChecked'),
  earliest: t('database.calcShort.earliest'),
  latest: t('database.calcShort.latest'),
};

/** Summaries that make sense for a kind of value. */
export function calcsFor(kind: ValueKind): CalcFn[] {
  const base: CalcFn[] = ['none', 'count', 'countValues', 'countEmpty', 'countUnique', 'percentFilled', 'percentEmpty'];
  if (kind === 'number') return [...base, 'sum', 'average', 'median', 'min', 'max', 'range'];
  if (kind === 'checkbox') return ['none', 'count', 'checked', 'unchecked', 'percentChecked'];
  if (kind === 'date') return [...base, 'earliest', 'latest', 'range'];
  return base;
}

/** What a property's values are like, for sorting, filtering and sums. */
export type ValueKind = 'text' | 'number' | 'option' | 'options' | 'date' | 'checkbox' | 'list';

export function kindOf(p: Property, formulaKind?: ValueKind): ValueKind {
  switch (p.type) {
    case 'number':
    case 'id':
      return 'number';
    case 'select':
    case 'status':
    case 'course':
      return 'option';
    case 'multiSelect':
    case 'tags':
      return 'options';
    case 'date':
    case 'created':
    case 'edited':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'files':
    case 'relation':
      return 'list';
    case 'formula':
    case 'rollup':
      return formulaKind ?? 'text';
    default:
      return 'text';
  }
}
