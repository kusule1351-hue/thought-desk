/**
 * Calendar dates as local "YYYY-MM-DD" strings and times as "HH:MM", the
 * same shape they're stored in. Arithmetic goes through local Dates at noon,
 * so daylight-saving changes never move a day.
 */

import { t, type MessageKey } from './i18n';
import { fmt } from './i18n/format';
import type { CalEvent, Repeat } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local noon of a "YYYY-MM-DD" date. */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, n: number): string {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Same day of the month `n` months later, clamped to the month's length. */
export function addMonths(iso: string, n: number): string {
  const d = parseDate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

export function weekday(iso: string): number {
  return parseDate(iso).getDay();
}

/** The first day of the week containing `iso`. */
export function startOfWeek(iso: string, weekStart: 0 | 1): string {
  return addDays(iso, -((weekday(iso) - weekStart + 7) % 7));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** "HH:MM" → minutes after midnight. */
export function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function nowTime(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --------------------------------------------------------------- formatting

export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return fmt.time(new Date(2000, 0, 1, h, m));
}

/** "9 AM" style labels for the week view's hour gutter. */
export function formatHour(h: number): string {
  return fmt.time(new Date(2000, 0, 1, h), { hour: 'numeric' });
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const d = parseDate(iso);
  if (opts.year === undefined && d.getFullYear() !== new Date().getFullYear() && !opts.weekday) {
    opts = { ...opts, year: 'numeric' };
  }
  return fmt.date(d, opts);
}

export function formatMonth(iso: string): { month: string; year: string } {
  const d = parseDate(iso);
  return {
    month: fmt.date(d, { month: 'long' }),
    year: String(d.getFullYear()),
  };
}

/** Weekday labels starting at `weekStart`. */
export function weekdayNames(weekStart: 0 | 1, style: 'short' | 'narrow' | 'long' = 'short'): string[] {
  const names = fmt.weekdayNames(style);
  return Array.from({ length: 7 }, (_, i) => names[(i + weekStart) % 7]);
}

/** "Today", "Tomorrow", "Friday", "Oct 20": how people say due dates. */
export function relativeDay(iso: string, today = todayISO()): string {
  const n = diffDays(today, iso);
  if (n === 0) return t('common.today');
  if (n === 1) return t('common.tomorrow');
  if (n === -1) return t('common.yesterday');
  if (n > 1 && n < 7) return formatDate(iso, { weekday: 'long' });
  return formatDate(iso);
}

/** A due date, with its time if it has one ("Tomorrow, 3:05 PM", "Friday", "Oct 20, 9:00 AM"). */
export function formatDue(date: string | null, time: string | null, today = todayISO()): string {
  if (!date) return t('planner.dates.noDueDate');
  if (!time) return relativeDay(date, today);
  const at = formatTime(time);
  const n = diffDays(today, date);
  if (n === 0) return t('planner.dates.todayAt', { time: at });
  if (n === 1) return t('planner.dates.tomorrowAt', { time: at });
  if (n === -1) return t('planner.dates.yesterdayAt', { time: at });
  return t('planner.dates.dateAt', { date: relativeDay(date, today), time: at });
}

export type DueState = 'done' | 'overdue' | 'today' | 'soon' | 'later' | 'none';

/** Urgency of an assignment, for colouring its due label. */
export function dueState(
  a: { dueDate: string | null; dueTime: string | null; status: string },
  today = todayISO(),
  now = nowTime(),
): DueState {
  if (a.status === 'done') return 'done';
  if (!a.dueDate) return 'none';
  const n = diffDays(today, a.dueDate);
  if (n < 0 || (n === 0 && a.dueTime !== null && a.dueTime < now)) return 'overdue';
  if (n === 0) return 'today';
  if (n <= 2) return 'soon';
  return 'later';
}

// ---------------------------------------------------------------- recurrence

export interface Occurrence {
  event: CalEvent;
  /** Unique per occurrence (repeating events share an id). */
  key: string;
  start: string;
  end: string;
}

/** Occurrences of an event that overlap [from, to] (inclusive dates). */
export function occurrences(event: CalEvent, from: string, to: string): Occurrence[] {
  const span = diffDays(event.startDate, event.endDate);
  const out: Occurrence[] = [];
  const skip = new Set(event.exdates ?? []);
  const push = (start: string) => {
    const end = addDays(start, span);
    if (skip.has(start)) return;
    if (end >= from && start <= to) out.push({ event, key: `${event.id}:${start}`, start, end });
  };
  if (event.repeat === 'none') {
    push(event.startDate);
    return out;
  }
  const until = event.repeatUntil && event.repeatUntil < to ? event.repeatUntil : to;
  // Jump close to the range instead of stepping from a start years ago.
  let i = 0;
  if (event.repeat === 'daily') i = Math.max(0, diffDays(event.startDate, from) - span);
  if (event.repeat === 'weekly') i = Math.max(0, Math.floor((diffDays(event.startDate, from) - span) / 7));
  if (event.repeat === 'monthly') {
    const [fy, fm] = from.split('-').map(Number);
    const [sy, sm] = event.startDate.split('-').map(Number);
    i = Math.max(0, (fy - sy) * 12 + (fm - sm) - 1);
  }
  for (let guard = 0; guard < 500; guard++, i++) {
    const start =
      event.repeat === 'daily'
        ? addDays(event.startDate, i)
        : event.repeat === 'weekly'
          ? addDays(event.startDate, i * 7)
          : addMonths(event.startDate, i);
    if (start > until) break;
    // Monthly repeats skip months that don't have the day (no Feb 31st).
    if (event.repeat === 'monthly' && start.slice(8) !== event.startDate.slice(8)) continue;
    push(start);
  }
  return out;
}

export const REPEAT_LABELS: Record<string, string> = {
  none: t('planner.repeat.never'),
  daily: t('planner.repeat.daily'),
  weekly: t('planner.repeat.weekly'),
  monthly: t('planner.repeat.monthly'),
};

const REPEATS = {
  none: 'planner.repeats.never',
  daily: 'planner.repeats.daily',
  weekly: 'planner.repeats.weekly',
  monthly: 'planner.repeats.monthly',
} as const satisfies Record<Repeat, MessageKey>;
const REPEATS_UNTIL = {
  daily: 'planner.repeatsUntil.daily',
  weekly: 'planner.repeatsUntil.weekly',
  monthly: 'planner.repeatsUntil.monthly',
} as const satisfies Record<Exclude<Repeat, 'none'>, MessageKey>;

/** How an event repeats, as a sentence ("Repeats every week until Mar 3"). */
export function repeatSentence(repeat: string, until?: string | null): string {
  const r = repeat as Repeat;
  // An event that doesn't repeat has no last date to give.
  if (r === 'none' || !until) return t(REPEATS[r]);
  return t(REPEATS_UNTIL[r], { date: formatDate(until) });
}
