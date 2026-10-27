/**
 * Works out the reminders for the next few days and hands them to the Rust
 * side, which shows them as system notifications on time (even while the
 * window is minimized). Resent whenever assignments, events or the settings
 * change, and each morning.
 */

import { api } from './api';
import { clock } from './clock.svelte';
import { addDays, formatTime, minutes, occurrences, parseDate } from './dates';
import { planner } from './planner.svelte';
import { prefs, type RemindAssignments, type RemindEvents } from './prefs.svelte';
import type { Assignment, CalEvent, Course, Reminder } from './types';
import { t } from './i18n';

/** How far ahead reminders are scheduled (the list is rebuilt daily). */
const DAYS_AHEAD = 3;

/** Local time of a date and "HH:MM", in ms since the epoch. */
function at(date: string, time: string): number {
  const d = parseDate(date);
  const m = minutes(time);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d.getTime();
}

export function computeReminders(
  assignments: Assignment[],
  events: CalEvent[],
  courses: Map<string, Course>,
  opts: { assignments: RemindAssignments; events: RemindEvents; today: string; now: number },
): Reminder[] {
  const { today, now } = opts;
  const last = addDays(today, DAYS_AHEAD);
  const out: Reminder[] = [];
  const add = (r: Reminder) => {
    if (r.at > now) out.push(r);
  };

  for (const a of assignments) {
    if (a.deletedAt || a.status === 'done' || !a.dueDate) continue;
    if (a.dueDate < today || a.dueDate > last) continue;
    const course = a.courseId ? courses.get(a.courseId)?.name : undefined;
    const title = a.title || t('planner.reminders.untitledAssignment');
    const time = a.dueTime ? formatTime(a.dueTime) : null;
    if (opts.assignments === 'evening') {
      const day = addDays(a.dueDate, -1);
      add({
        key: `a:${a.id}:evening:${a.dueDate}`,
        at: at(day, '18:00'),
        title,
        body: [time ? t('planner.reminders.dueTomorrowAt', { time }) : t('planner.reminders.dueTomorrow'), course].filter(Boolean).join(' · '),
      });
    } else if (opts.assignments === 'morning') {
      add({
        key: `a:${a.id}:morning:${a.dueDate}`,
        at: at(a.dueDate, '09:00'),
        title,
        body: [time ? t('planner.reminders.dueTodayAt', { time }) : t('planner.reminders.dueToday'), course].filter(Boolean).join(' · '),
      });
    }
    // A due time gets a last call an hour before, whatever the setting.
    if (opts.assignments !== 'off' && a.dueTime) {
      add({
        key: `a:${a.id}:hour:${a.dueDate}T${a.dueTime}`,
        at: at(a.dueDate, a.dueTime) - 60 * 60_000,
        title,
        body: [t('planner.reminders.dueInAnHour', { time: formatTime(a.dueTime) }), course].filter(Boolean).join(' · '),
      });
    }
  }

  const lead = opts.events;
  if (lead > 0) {
    for (const e of events) {
      if (e.deletedAt || !e.startTime) continue;
      for (const occ of occurrences(e, today, last)) {
        if (occ.start < today) continue;
        const course = e.courseId ? courses.get(e.courseId)?.name : undefined;
        add({
          key: `e:${occ.key}:${e.startTime}:${lead}`,
          at: at(occ.start, e.startTime) - lead * 60_000,
          title: e.title || t('planner.reminders.untitledEvent'),
          body: [t('planner.reminders.startsIn', { count: lead, time: formatTime(e.startTime) }), e.location, course].filter(Boolean).join(' · '),
        });
      }
    }
  }
  return out.sort((x, y) => x.at - y.at);
}

let timer: ReturnType<typeof setTimeout> | undefined;

$effect.root(() => {
  $effect(() => {
    if (!planner.loaded) return;
    const list = computeReminders(planner.assignments, planner.events, planner.courseById, {
      assignments: prefs.remindAssignments,
      events: prefs.remindEvents,
      today: clock.today,
      now: Date.now(),
    });
    clearTimeout(timer);
    timer = setTimeout(() => void api.setReminders(list).catch(() => {}), 500);
  });
});
