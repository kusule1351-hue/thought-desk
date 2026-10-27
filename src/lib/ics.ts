/**
 * Reads iCalendar (.ics) files: the class schedules and due dates schools
 * publish from Canvas, Google Calendar, Outlook and the like. Turns each
 * entry into an event or an assignment in Thought Desk's own shape, with
 * times converted to the local time zone.
 *
 * Repeats Thought Desk can't express (every other week, the 2nd Tuesday of
 * the month, yearly) come in as a single event and are counted as
 * `simplified`, so the import can say so.
 */

import type { Repeat } from './types';
import { addDays, addMonths, diffDays, toISODate, weekday } from './dates';
import { t } from './i18n';

export interface IcsItem {
  /** Stable id from the file (with a suffix when one entry becomes several). */
  uid: string;
  kind: 'event' | 'assignment';
  title: string;
  /** Course name from a Canvas-style "Title [Course]" summary. */
  course: string | null;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  location: string;
  notes: string;
  repeat: Repeat;
  repeatUntil: string | null;
  exdates: string[];
  /** Its repeat rule was more than Thought Desk can express. */
  simplified: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Stamp {
  date: string;
  time: string | null;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n: number) => String(n).padStart(2, '0');

// ----------------------------------------------------------------- lexing

function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function parseLine(line: string): Prop | null {
  // The value starts at the first colon outside quotes.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescape(text: string): string {
  return text.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c)).trim();
}

// ---------------------------------------------------------------- time zones

const tzFormats = new Map<string, Intl.DateTimeFormat | null>();

function tzFormat(tz: string): Intl.DateTimeFormat | null {
  if (!tzFormats.has(tz)) {
    try {
      tzFormats.set(
        tz,
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        }),
      );
    } catch {
      tzFormats.set(tz, null);
    }
  }
  return tzFormats.get(tz)!;
}

/** How far `tz` is ahead of UTC at instant `ts` (ms). */
function tzOffset(fmt: Intl.DateTimeFormat, ts: number): number {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(ts)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens, or null for unknown zones. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number | null {
  const fmt = tzFormat(tz);
  if (!fmt) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = wall - tzOffset(fmt, wall);
  // Once more, in case the guess crossed a daylight-saving change.
  ts = wall - tzOffset(fmt, ts);
  return ts;
}

/** Outlook writes Windows zone names; these are the ones schools mostly use. */
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Mongolia Standard Time': 'Asia/Ulaanbaatar',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  UTC: 'UTC',
};

/** A DTSTART-style value as a local date and (unless all-day) time. */
function parseStamp(prop: Prop | undefined, raw = prop?.value): Stamp | null {
  if (!prop || !raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  if (!m[4] || prop.params.VALUE === 'DATE') return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  let ts: number | null = null;
  if (m[7]) ts = Date.UTC(y, mo - 1, d, h, mi, s);
  else if (prop.params.TZID) {
    const tz = prop.params.TZID.replace(/^\/+/, '');
    ts = zonedToUtc(y, mo, d, h, mi, s, WINDOWS_ZONES[tz] ?? tz);
  }
  // Floating times (and zones we can't place) are taken as local.
  const local = ts === null ? new Date(y, mo - 1, d, h, mi, s) : new Date(ts);
  return { date: toISODate(local), time: `${pad(local.getHours())}:${pad(local.getMinutes())}` };
}

/** "PT1H30M", "P1D", "P2W" in minutes. */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi] = m;
  const total = (Number(w ?? 0) * 7 + Number(d ?? 0)) * 1440 + Number(h ?? 0) * 60 + Number(mi ?? 0);
  return sign === '-' ? -total : total;
}

function plusMinutes(stamp: Stamp, mins: number): Stamp {
  const [h, mi] = stamp.time!.split(':').map(Number);
  const total = h * 60 + mi + mins;
  const days = Math.floor(total / 1440);
  const rest = total - days * 1440;
  return { date: addDays(stamp.date, days), time: `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` };
}

// ------------------------------------------------------------- recognising

const ASSIGNMENT_WORDS =
  /\b(due|homework|hw|assignment|quiz|essay|problem set|pset|lab report|worksheet|submission|deadline|reading response)\b/i;

/** "Lab Report [BIO 101]" → title and course. */
function splitCourse(summary: string): { title: string; course: string | null } {
  const m = /^(.*\S)\s*\[([^\]]+)\]\s*$/.exec(summary);
  return m ? { title: m[1], course: m[2].trim() } : { title: summary, course: null };
}

// ------------------------------------------------------------------ parsing

interface RawEvent {
  props: Map<string, Prop[]>;
}

const first = (e: RawEvent, name: string) => e.props.get(name)?.[0];

function readEvents(lines: string[]): RawEvent[] {
  const out: RawEvent[] = [];
  let current: RawEvent | null = null;
  // Depth inside the event, so alarms' own properties are ignored.
  let nested = 0;
  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && !current) current = { props: new Map() };
      else if (current) nested++;
    } else if (prop.name === 'END') {
      if (current && nested > 0) nested--;
      else if (current && prop.value.toUpperCase() === 'VEVENT') {
        out.push(current);
        current = null;
      }
    } else if (current && nested === 0) {
      const list = current.props.get(prop.name) ?? [];
      list.push(prop);
      current.props.set(prop.name, list);
    }
  }
  return out;
}

function parseRule(value: string): Record<string, string> {
  const rule: Record<string, string> = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) rule[k.toUpperCase()] = v.toUpperCase();
  }
  return rule;
}

/** The last date of a COUNT-limited repeat. */
function lastByCount(start: string, freq: string, days: number[], count: number): string {
  if (freq === 'MONTHLY') return addMonths(start, count - 1);
  if (days.length === 0) return addDays(start, (count - 1) * (freq === 'DAILY' ? 1 : 7));
  let date = start;
  let seen = 0;
  for (let guard = 0; guard < 3700; guard++, date = addDays(date, 1)) {
    if (days.includes(weekday(date)) && ++seen === count) return date;
  }
  return date;
}

/**
 * Parses an .ics file. Cancelled entries are left out; a moved or changed
 * session of a repeating entry comes in as its own event, with the series
 * skipping that date.
 */
export function parseIcs(text: string): IcsItem[] {
  const raw = readEvents(unfold(text));
  const items: IcsItem[] = [];
  const masters = new Map<string, IcsItem[]>();
  const overrides: { uid: string; date: string }[] = [];

  raw.forEach((e, n) => {
    const start = parseStamp(first(e, 'DTSTART'));
    if (!start) return;
    const uid = first(e, 'UID')?.value.trim() || `ics-${n}`;
    const cancelled = first(e, 'STATUS')?.value.toUpperCase() === 'CANCELLED';
    const recurrence = first(e, 'RECURRENCE-ID');
    const replaces = recurrence ? (parseStamp(recurrence)?.date ?? start.date) : null;
    if (replaces) overrides.push({ uid, date: replaces });
    if (cancelled) return;

    // End: DTEND, else DTSTART + DURATION, else the start itself.
    let end = parseStamp(first(e, 'DTEND'));
    if (!end) {
      const mins = first(e, 'DURATION') ? parseDuration(first(e, 'DURATION')!.value) : null;
      if (mins !== null && start.time) end = plusMinutes(start, mins);
      else if (mins !== null) end = { date: addDays(start.date, Math.max(1, Math.round(mins / 1440))), time: null };
    }
    let endDate = start.date;
    let endTime = start.time;
    if (end && start.time && end.time) {
      endDate = end.date;
      endTime = end.time;
      // Ending at midnight belongs to the day before.
      if (endTime === '00:00' && diffDays(start.date, endDate) === 1) {
        endDate = start.date;
        endTime = '23:59';
      }
    } else if (end && !start.time) {
      // All-day ends are exclusive.
      endDate = addDays(end.date, -1);
    }
    if (endDate < start.date) endDate = start.date;
    if (start.time && endDate === start.date && endTime! < start.time) endTime = start.time;

    const summary = unescape(first(e, 'SUMMARY')?.value ?? '');
    const { title, course } = splitCourse(summary);
    const notes = unescape(first(e, 'DESCRIPTION')?.value ?? '').slice(0, 4000);
    const location = unescape(first(e, 'LOCATION')?.value ?? '');
    const pointInTime = !start.time ? endDate === start.date : endDate === start.date && endTime === start.time;
    const kind: IcsItem['kind'] =
      /assignment/i.test(uid) || (pointInTime && ASSIGNMENT_WORDS.test(title)) ? 'assignment' : 'event';

    const exdates: string[] = [];
    for (const p of e.props.get('EXDATE') ?? []) {
      for (const v of p.value.split(',')) {
        const s = parseStamp(p, v);
        if (s) exdates.push(s.date);
      }
    }

    const base: IcsItem = {
      uid: replaces ? `${uid}#${replaces}` : uid,
      kind,
      title: title || t('common.untitled'),
      course,
      startDate: start.date,
      startTime: start.time,
      endDate,
      endTime,
      location,
      notes,
      repeat: 'none',
      repeatUntil: null,
      exdates,
      simplified: false,
    };

    const ruleProp = replaces ? undefined : first(e, 'RRULE');
    if (!ruleProp) {
      items.push(base);
      if (!replaces) masters.set(uid, [base]);
      return;
    }

    const rule = parseRule(ruleProp.value);
    const freq = rule.FREQ ?? '';
    const interval = Number(rule.INTERVAL ?? 1);
    const byDay = (rule.BYDAY ?? '').split(',').filter(Boolean);
    const plainDays = byDay.every((d) => DAYS.includes(d));
    const days = plainDays ? byDay.map((d) => DAYS.indexOf(d)) : [];
    const supported =
      ['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq) &&
      interval === 1 &&
      plainDays &&
      !rule.BYSETPOS &&
      !rule.BYMONTH &&
      (freq !== 'MONTHLY' || (byDay.length === 0 && !rule.BYMONTHDAY)) &&
      (freq !== 'DAILY' || byDay.length === 0 || days.length > 0);

    if (!supported) {
      const one = { ...base, simplified: true, kind: 'event' as const };
      items.push(one);
      masters.set(uid, [one]);
      return;
    }

    let until: string | null = null;
    if (rule.UNTIL) until = parseStamp({ name: 'UNTIL', params: {}, value: rule.UNTIL })?.date ?? null;
    if (rule.COUNT) until = lastByCount(start.date, freq, days, Math.max(1, Number(rule.COUNT)));

    const series: IcsItem[] = [];
    if (days.length > 0 && freq !== 'MONTHLY') {
      // "Mon, Wed, Fri" becomes one weekly event per weekday.
      const span = diffDays(start.date, endDate);
      for (const day of [...new Set(days)].sort()) {
        const offset = (day - weekday(start.date) + 7) % 7;
        const firstDate = addDays(start.date, offset);
        if (until && firstDate > until) continue;
        series.push({
          ...base,
          kind: 'event',
          uid: days.length > 1 ? `${uid}#${DAYS[day]}` : uid,
          startDate: firstDate,
          endDate: addDays(firstDate, span),
          repeat: 'weekly',
          repeatUntil: until,
        });
      }
    } else {
      series.push({ ...base, kind: 'event', repeat: freq.toLowerCase() as Repeat, repeatUntil: until });
    }
    items.push(...series);
    masters.set(uid, series);
  });

  // Moved or cancelled sessions: the series skips their original date.
  for (const o of overrides) {
    for (const m of masters.get(o.uid) ?? []) {
      if (m.repeat !== 'none' && !m.exdates.includes(o.date)) m.exdates.push(o.date);
    }
  }
  for (const item of items) item.exdates.sort();
  return items.sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
}
