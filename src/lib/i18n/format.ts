/**
 * Dates, times, numbers, lists and sizes, written the way the interface's
 * locale writes them (i18n.locale: the chosen language, with the system's
 * region). Use these, never `toLocale*String(undefined, …)` or
 * `new Intl.*(undefined, …)`, which follow the system's language instead of
 * the one chosen in Settings. Formatters are made once per set of options.
 */
import { i18n, t } from './index';

const made = new Map<string, unknown>();
function cached<T>(kind: string, opts: object | undefined, make: () => T): T {
  const id = kind + JSON.stringify(opts ?? {});
  let found = made.get(id) as T | undefined;
  if (!found) {
    found = make();
    made.set(id, found);
  }
  return found;
}

const dates = (opts?: Intl.DateTimeFormatOptions) => cached('d', opts, () => new Intl.DateTimeFormat(i18n.locale, opts));
const toDate = (d: Date | number | string) => (d instanceof Date ? d : new Date(d));

export const fmt = {
  /** "1,234.5" in English, "1.234,5" in German. */
  number(n: number, opts?: Intl.NumberFormatOptions): string {
    return cached('n', opts, () => new Intl.NumberFormat(i18n.locale, opts)).format(n);
  },

  /** A date; "Oct 14, 2026" by default. Pass the parts you want, as for Intl.DateTimeFormat. */
  date(d: Date | number | string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
    return dates(opts).format(toDate(d));
  },

  /** A time of day; "3:05 PM" by default. */
  time(d: Date | number | string, opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }): string {
    return dates(opts).format(toDate(d));
  },

  /** A date and a time in one ("Oct 14, 3:05 PM"), in the locale's order. */
  dateTime(d: Date | number | string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }): string {
    return dates(opts).format(toDate(d));
  },

  /** From one date to another, shared parts written once ("Oct 14 – 16"). */
  range(from: Date | number | string, to: Date | number | string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
    return dates(opts).formatRange(toDate(from), toDate(to));
  },

  /** "in 3 days", "yesterday", "2 hours ago". */
  relative(value: number, unit: Intl.RelativeTimeFormatUnit, opts: Intl.RelativeTimeFormatOptions = { numeric: 'auto' }): string {
    return cached('r', opts, () => new Intl.RelativeTimeFormat(i18n.locale, opts)).format(value, unit);
  },

  /** "a, b and c" (conjunction) or "a, b or c" (disjunction). */
  list(items: string[], type: 'conjunction' | 'disjunction' = 'conjunction', style: 'long' | 'short' | 'narrow' = 'long'): string {
    return cached('l', { type, style }, () => new Intl.ListFormat(i18n.locale, { type, style })).format(items);
  },

  /** A file size: "512 B", "1.5 KB", "3.2 MB", "1.1 GB" (powers of 1,024). */
  bytes(n: number): string {
    const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    if (n < 1024) return t('common.units.bytes', { size: fmt.number(n) });
    if (n < 1024 ** 2) return t('common.units.kilobytes', { size: fmt.number(n / 1024, one) });
    if (n < 1024 ** 3) return t('common.units.megabytes', { size: fmt.number(n / 1024 ** 2, one) });
    return t('common.units.gigabytes', { size: fmt.number(n / 1024 ** 3, one) });
  },

  /** January…December in the interface's language ("long", "short", or "narrow"). */
  monthNames(style: 'long' | 'short' | 'narrow' = 'long'): string[] {
    const f = dates({ month: style, timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, m) => f.format(Date.UTC(2024, m, 1)));
  },

  /** Sunday…Saturday in the interface's language (index 0 is Sunday, as Date.getDay()). */
  weekdayNames(style: 'long' | 'short' | 'narrow' = 'long'): string[] {
    const f = dates({ weekday: style, timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, d) => f.format(Date.UTC(2024, 0, 7 + d)));
  },

  /** Sorts text the locale's way, numbers in names by value ("Week 2" before "Week 10"). */
  collator(opts: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }): Intl.Collator {
    return cached('c', opts, () => new Intl.Collator(i18n.locale, opts));
  },
};
