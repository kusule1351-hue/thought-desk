/**
 * Spaced repetition: when to show a flashcard next. A simplified SM-2, as
 * in Anki: Again starts the card over, Hard grows the gap a little, Good by
 * the card's ease, Easy by more (and makes the card easier from then on).
 */

import { addDays } from './dates';
import { t } from './i18n';
import type { Card, CardReview } from './types';

export type Grade = 1 | 2 | 3 | 4;

/** The answers, by grade: `label` is in the interface's language, `key` the key that gives it. */
export const GRADES: { grade: Grade; label: string; key: string }[] = [
  { grade: 1, label: t('library.grades.again'), key: '1' },
  { grade: 2, label: t('library.grades.hard'), key: '2' },
  { grade: 3, label: t('library.grades.good'), key: '3' },
  { grade: 4, label: t('library.grades.easy'), key: '4' },
];

const START_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.5;
const MAX_DAYS = 3650;

export function schedule(prev: CardReview | null, grade: Grade, today: string): CardReview {
  const ease0 = prev?.ease ?? START_EASE;
  const reps = prev?.reps ?? 0;
  const last = prev?.interval ?? 0;
  const lapses = prev?.lapses ?? 0;
  if (grade === 1) {
    return { due: today, interval: 0, ease: round(Math.max(MIN_EASE, ease0 - 0.2)), reps: 0, lapses: lapses + (reps > 0 ? 1 : 0) };
  }
  let ease = ease0;
  let days: number;
  if (grade === 2) {
    ease = Math.max(MIN_EASE, ease0 - 0.15);
    days = reps === 0 ? 1 : Math.max(last + 1, Math.round(last * 1.2));
  } else if (grade === 3) {
    days = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(last + 1, Math.round(last * ease0));
  } else {
    ease = Math.min(MAX_EASE, ease0 + 0.15);
    days = reps === 0 ? 4 : reps === 1 ? 6 : Math.max(last + 1, Math.round(last * ease0 * 1.3));
  }
  days = Math.min(days, MAX_DAYS);
  return { due: addDays(today, days), interval: days, ease: round(ease), reps: reps + 1, lapses };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** New cards and cards whose day has come. */
export const isDue = (c: Card, today: string) => !c.review || c.review.due <= today;

/** "Now", "1 day", "3 days", "2 wk", "4 mo", "1.5 yr": shown under each answer. */
export function gapLabel(days: number): string {
  if (days <= 0) return t('library.gaps.now');
  if (days < 14) return t('library.gaps.days', { count: days });
  if (days < 60) return t('library.gaps.weeks', { count: Math.round(days / 7) });
  if (days < 365) return t('library.gaps.months', { count: Math.round(days / 30) });
  return t('library.gaps.years', { count: Math.round((days / 365) * 10) / 10 });
}
