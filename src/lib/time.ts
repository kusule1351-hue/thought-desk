import { t } from './i18n';
import { fmt } from './i18n/format';

/** A time said on its own ("just now", "3 minutes ago", or a date). */
export function relativeTime(ms: number, now = Date.now()): string {
  return relativeWhen(ms, now).text;
}

/**
 * The same, saying which kind of phrase it is, for a sentence around it
 * ("Edited just now", "Edited 3 minutes ago", "Edited Mar 3, 2025"): other
 * languages word the sentence differently for each kind.
 */
export function relativeWhen(ms: number, now = Date.now()): { kind: 'now' | 'relative' | 'date'; text: string } {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return { kind: 'now', text: t('planner.justNow') };
  if (abs < 2700) return { kind: 'relative', text: fmt.relative(Math.round(s / 60), 'minute') };
  if (abs < 64800) return { kind: 'relative', text: fmt.relative(Math.round(s / 3600), 'hour') };
  if (abs < 518400) return { kind: 'relative', text: fmt.relative(Math.round(s / 86400), 'day') };
  return { kind: 'date', text: fmt.date(ms) };
}

/** "512 B", "1.5 KB", "3.2 MB": powers of 1,024, up to MB, the numbers ungrouped ("1023.5 MB"). */
export function formatBytes(n: number): string {
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false };
  if (n < 1024) return t('common.units.bytes', { size: fmt.number(n, { useGrouping: false }) });
  if (n < 1024 * 1024) return t('common.units.kilobytes', { size: fmt.number(n / 1024, one) });
  return t('common.units.megabytes', { size: fmt.number(n / 1024 / 1024, one) });
}
