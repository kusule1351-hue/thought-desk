/** The assistant's tools for assignments, the calendar, courses, to-dos and flashcard decks. */

import type { Editor } from '@tiptap/core';
import { api } from '../../api';
import { cards } from '../../cards.svelte';
import { addDays, diffDays, formatDate, formatTime, occurrences, parseDate, toISODate } from '../../dates';
import { editorsOf } from '../../editor/open-editors';
import { t } from '../../i18n';
import { planner } from '../../planner.svelte';
import { store } from '../../store.svelte';
import { todos } from '../../todos.svelte';
import type { Assignment, AssignmentPatch, CalEvent, EventPatch, Repeat } from '../../types';
import { keptFromAssistant, pageFor } from '../access';
import { ToolError, type Done, type Preview, type Tool } from '../types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];
const STATUSES = ['todo', 'doing', 'done'] as const;
const CAP = 100;

const untitled = () => t('common.untitled');
const named = (title: string) => title || untitled();
const none = () => t('assistantTools.values.none');

// ---------------------------------------------------------------- checking input

/** A real calendar date written YYYY-MM-DD (not 2026-02-31). */
export function day(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || toISODate(parseDate(value)) !== value) throw new ToolError(`${what} must be a real date written YYYY-MM-DD.`);
  return value;
}

/** A 24-hour time written HH:MM. */
export function hour(value: unknown, what: string): string {
  if (typeof value !== 'string' || !TIME.test(value) || Number(value.slice(0, 2)) > 23 || Number(value.slice(3)) > 59) throw new ToolError(`${what} must be a time written HH:MM on a 24-hour clock (for example 14:30).`);
  return value;
}

function text(value: unknown, what: string, max: number, canBeEmpty = false): string {
  if (typeof value !== 'string' || (!canBeEmpty && !value.trim())) throw new ToolError(`${what} must be text${canBeEmpty ? '' : ', and not empty'}.`);
  if (value.length > max) throw new ToolError(`${what} is too long (at most ${max} characters).`);
  return value.trim();
}

function priorityOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) throw new ToolError('priority must be a whole number from 0 (none) to 3 (high).');
  return value;
}

/** The course asked for. Checked again at run time: a course can be deleted in between. */
function courseFor(id: unknown): string {
  if (typeof id !== 'string' || !planner.courseById.has(id)) throw new ToolError('There is no course with that id. Use list_courses.');
  return id;
}

function assignmentFor(id: unknown): Assignment {
  const a = typeof id === 'string' ? planner.assignmentById.get(id) : undefined;
  if (!a || a.deletedAt) throw new ToolError('There is no assignment with that id. Use list_assignments.');
  return a;
}

function eventFor(id: unknown): CalEvent {
  const e = typeof id === 'string' ? planner.eventById.get(id) : undefined;
  if (!e || e.deletedAt) throw new ToolError('There is no event with that id. Use list_events.');
  return e;
}

// ---------------------------------------------------------------- showing things

const courseName = (id: string | null) => (id ? named(planner.courseById.get(id)?.name ?? '') : none());

/** A date, and a time when there is one, for the person. */
function when(date: string | null, time: string | null): string {
  if (!date) return none();
  const d = formatDate(date, { weekday: 'short', month: 'short', day: 'numeric' });
  return time ? `${d} ${formatTime(time)}` : d;
}

function priorityName(n: number): string {
  switch (n) {
    case 1:
      return t('assistantTools.priority.low');
    case 2:
      return t('assistantTools.priority.medium');
    case 3:
      return t('assistantTools.priority.high');
    default:
      return none();
  }
}

function statusName(s: string): string {
  switch (s) {
    case 'doing':
      return t('assistantTools.status.doing');
    case 'done':
      return t('assistantTools.status.done');
    default:
      return t('assistantTools.status.todo');
  }
}

function repeatName(r: string): string {
  switch (r) {
    case 'daily':
      return t('assistantTools.repeat.daily');
    case 'weekly':
      return t('assistantTools.repeat.weekly');
    case 'monthly':
      return t('assistantTools.repeat.monthly');
    default:
      return t('assistantTools.repeat.none');
  }
}

const PRIORITY_WORDS = ['no priority', 'low priority', 'medium priority', 'high priority'];
/** "2026-11-28 17:00" or "2026-11-28" for the model. */
const stamp = (date: string | null, time: string | null) => (date ? (time ? `${date} ${time}` : date) : 'no date');

/** A change in one field, as the person sees it. */
interface Change {
  label: string;
  from: string;
  to: string;
}
const lines = (changes: Change[]) => changes.map((c) => ({ label: c.label, value: t('assistantTools.values.change', { from: c.from, to: c.to }) }));

/** A short excerpt of text, for showing a long note in one line. */
const brief = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s) || none();

// ---------------------------------------------------------------- assignments

const listAssignments: Tool<{ status?: 'open' | 'done' | 'all'; from?: string; to?: string; course_id?: string }> = {
  name: 'list_assignments',
  kind: 'read',
  description:
    'Lists the person’s assignments, soonest due first (ones with no due date come last): title, id, due date and time, status (todo, doing, done), priority, course and score when graded. `status` is "open" (not done, the default), "done" or "all". `from` and `to` (YYYY-MM-DD, inclusive) keep only assignments due in that range, which leaves out undated ones. Shows at most 100; it says when there are more, so narrow the range.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'done', 'all'] },
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      course_id: { type: 'string', description: 'Only this course’s assignments (an id from list_courses).' },
    },
    additionalProperties: false,
  },
  label: () => t('assistantTools.tools.listingAssignments'),
  async run(i) {
    const status = i.status ?? 'open';
    if (!['open', 'done', 'all'].includes(status)) throw new ToolError('status must be "open", "done" or "all".');
    const from = i.from === undefined ? null : day(i.from, 'from');
    const to = i.to === undefined ? null : day(i.to, 'to');
    const course = i.course_id === undefined ? null : courseFor(i.course_id);
    const found = planner.live.filter(
      (a) =>
        (status === 'all' || (status === 'done') === (a.status === 'done')) &&
        (!course || a.courseId === course) &&
        (!from || (a.dueDate !== null && a.dueDate >= from)) &&
        (!to || (a.dueDate !== null && a.dueDate <= to)),
    );
    if (!found.length) return 'No assignments match.';
    const shown = found.slice(0, CAP).map((a) => {
      const bits = [`due ${stamp(a.dueDate, a.dueTime)}`, `status ${a.status}`, PRIORITY_WORDS[a.priority] ?? PRIORITY_WORDS[0]];
      if (a.courseId) bits.push(`course "${courseName(a.courseId)}"`);
      if (a.score !== null && a.maxScore !== null) bits.push(`score ${a.score}/${a.maxScore}`);
      return `- "${named(a.title)}" (id ${a.id}): ${bits.join(', ')}`;
    });
    if (found.length > CAP) shown.push(`(…and ${found.length - CAP} more. Narrow it with from, to or course_id.)`);
    return shown.join('\n');
  },
};

interface AssignmentInput {
  title: string;
  due_date?: string;
  due_time?: string;
  course_id?: string;
  priority?: number;
  notes?: string;
}

/** What a new assignment is made of, checked. */
function newAssignment(i: AssignmentInput): AssignmentPatch {
  const patch: AssignmentPatch = { title: text(i.title, 'title', 200) };
  if (i.due_date !== undefined) patch.dueDate = day(i.due_date, 'due_date');
  if (i.due_time !== undefined) {
    if (i.due_date === undefined) throw new ToolError('due_time needs a due_date as well.');
    patch.dueTime = hour(i.due_time, 'due_time');
  }
  if (i.course_id !== undefined) patch.courseId = courseFor(i.course_id);
  if (i.priority !== undefined) patch.priority = priorityOf(i.priority);
  if (i.notes !== undefined) patch.notes = text(i.notes, 'notes', 5000, true);
  return patch;
}

const createAssignment: Tool<AssignmentInput> = {
  name: 'create_assignment',
  kind: 'create',
  description:
    'Adds an assignment (homework, a task with a due date) to the planner. `due_date` is YYYY-MM-DD and `due_time` is HH:MM on a 24-hour clock; give a time only with a date. `course_id` comes from list_courses, `priority` is 0 (none) to 3 (high), `notes` is a short plain-text description. The person is shown it and decides before it is added. Returns the new assignment’s id.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      due_date: { type: 'string', description: 'YYYY-MM-DD' },
      due_time: { type: 'string', description: 'HH:MM, 24-hour' },
      course_id: { type: 'string' },
      priority: { type: 'integer', minimum: 0, maximum: 3 },
      notes: { type: 'string' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.createAssignment', { title: named(String(i.title ?? '')) }),
  preview(i) {
    const p = newAssignment(i);
    const out: { label: string; value: string }[] = [];
    if (p.dueDate) out.push({ label: t('assistantTools.labels.due'), value: when(p.dueDate, p.dueTime ?? null) });
    if (p.courseId) out.push({ label: t('assistantTools.labels.course'), value: courseName(p.courseId) });
    if (p.priority) out.push({ label: t('assistantTools.labels.priority'), value: priorityName(p.priority) });
    if (p.notes) out.push({ label: t('assistantTools.labels.notes'), value: brief(p.notes) });
    return { title: t('assistantTools.changes.createAssignment', { title: p.title! }), lines: out };
  },
  async run(i): Promise<Done> {
    const p = newAssignment(i);
    const a = await planner.addAssignment(p);
    if (!a) throw new ToolError('The assignment could not be saved.');
    return {
      summary: t('assistantTools.changes.createdAssignment', { title: p.title! }),
      result: `Created the assignment "${p.title}" (id ${a.id}).`,
      place: { kind: 'assignment', id: a.id },
      // It goes to the Trash, where it can still be had back.
      undo: () => planner.trash('assignments', a.id),
    };
  },
};

interface UpdateAssignmentInput {
  id: string;
  title?: string;
  due_date?: string | null;
  due_time?: string | null;
  status?: 'todo' | 'doing' | 'done';
  priority?: number;
  notes?: string;
  course_id?: string | null;
}

/** What an update changes: the new values, the old ones to put back, and what to show. */
function planAssignment(i: UpdateAssignmentInput) {
  const a = assignmentFor(i.id);
  const patch: Record<string, unknown> = {};
  const back: Record<string, unknown> = {};
  const shown: Change[] = [];
  const set = (key: keyof Assignment, next: unknown) => {
    if (a[key] === next) return false;
    patch[key] = next;
    back[key] = a[key];
    return true;
  };
  if (i.title !== undefined) {
    const title = text(i.title, 'title', 200);
    if (set('title', title)) shown.push({ label: t('assistantTools.labels.title'), from: brief(a.title), to: title });
  }
  let dueDate = a.dueDate;
  let dueTime = a.dueTime;
  if (i.due_date !== undefined) dueDate = i.due_date === null ? null : day(i.due_date, 'due_date');
  // Without a date there is no time (the planner clears it too).
  if (dueDate === null) dueTime = null;
  if (i.due_time !== undefined) {
    if (i.due_time !== null && dueDate === null) throw new ToolError('due_time needs a due date: give due_date as well.');
    dueTime = i.due_time === null ? null : hour(i.due_time, 'due_time');
  }
  const dateChanged = set('dueDate', dueDate);
  const timeChanged = set('dueTime', dueTime);
  if (dateChanged || timeChanged) shown.push({ label: t('assistantTools.labels.due'), from: when(a.dueDate, a.dueTime), to: when(dueDate, dueTime) });
  if (i.status !== undefined) {
    if (!STATUSES.includes(i.status)) throw new ToolError('status must be "todo", "doing" or "done".');
    if (set('status', i.status)) shown.push({ label: t('assistantTools.labels.status'), from: statusName(a.status), to: statusName(i.status) });
  }
  if (i.priority !== undefined) {
    const priority = priorityOf(i.priority);
    if (set('priority', priority)) shown.push({ label: t('assistantTools.labels.priority'), from: priorityName(a.priority), to: priorityName(priority) });
  }
  if (i.notes !== undefined) {
    const notes = text(i.notes, 'notes', 5000, true);
    if (set('notes', notes)) shown.push({ label: t('assistantTools.labels.notes'), from: brief(a.notes), to: brief(notes) });
  }
  if (i.course_id !== undefined) {
    const course = i.course_id === null ? null : courseFor(i.course_id);
    if (set('courseId', course)) shown.push({ label: t('assistantTools.labels.course'), from: courseName(a.courseId), to: courseName(course) });
  }
  if (!shown.length) throw new ToolError('Nothing would change: give at least one field with a new value.');
  return { a, patch: patch as AssignmentPatch, back: back as AssignmentPatch, shown };
}

const updateAssignment: Tool<UpdateAssignmentInput> = {
  name: 'update_assignment',
  kind: 'edit',
  description:
    'Changes an assignment found with list_assignments. Give `id` and only the fields to change: `title`, `due_date` (YYYY-MM-DD, or null to clear it, which also clears the time), `due_time` (HH:MM or null), `status` ("todo", "doing" or "done"; "done" marks it handed in), `priority` (0 to 3), `notes`, `course_id` (or null for none). The person is shown each old and new value and decides before it is changed.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear.' },
      due_time: { type: ['string', 'null'], description: 'HH:MM, 24-hour, or null to clear.' },
      status: { type: 'string', enum: ['todo', 'doing', 'done'] },
      priority: { type: 'integer', minimum: 0, maximum: 3 },
      notes: { type: 'string' },
      course_id: { type: ['string', 'null'] },
    },
    required: ['id'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.updateAssignment', { title: named(planner.assignmentById.get(i.id)?.title ?? '') }),
  preview(i): Preview {
    const { a, shown } = planAssignment(i);
    return { title: t('assistantTools.changes.updateAssignment', { title: named(a.title) }), lines: lines(shown) };
  },
  async run(i): Promise<Done> {
    const { a, patch, back, shown } = planAssignment(i);
    planner.updateAssignment(a.id, patch, { immediate: true });
    await planner.flush();
    return {
      summary: t('assistantTools.changes.updatedAssignment', { title: named(patch.title ?? a.title) }),
      result: `Done. Changed ${shown.map((c) => c.label.toLowerCase()).join(', ')} of the assignment "${named(patch.title ?? a.title)}" (id ${a.id}).`,
      place: { kind: 'assignment', id: a.id },
      undo: async () => {
        planner.updateAssignment(a.id, back, { immediate: true });
        await planner.flush();
      },
    };
  },
};

// ---------------------------------------------------------------- events

const listEvents: Tool<{ from: string; to: string }> = {
  name: 'list_events',
  kind: 'read',
  description:
    'Lists the calendar events that happen between two dates (inclusive, YYYY-MM-DD), one line for each occurrence: date, time, title, location, course and the event’s id. Repeating events appear once for every date they fall on in the range. The range may be at most 92 days; ask for more in several calls. All-day events say so.',
  input_schema: {
    type: 'object',
    properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  label: () => t('assistantTools.tools.listingEvents'),
  async run(i) {
    const from = day(i.from, 'from');
    const to = day(i.to, 'to');
    if (to < from) throw new ToolError('`to` is before `from`. Give the earlier date as `from`.');
    if (diffDays(from, to) > 92) throw new ToolError('That range is longer than 92 days. Ask for a shorter range, or several.');
    const found = planner.liveEvents
      .flatMap((e) => occurrences(e, from, to))
      .sort((a, b) => a.start.localeCompare(b.start) || (a.event.startTime ?? '').localeCompare(b.event.startTime ?? '') || a.event.title.localeCompare(b.event.title));
    if (!found.length) return `Nothing is on the calendar from ${from} to ${to}.`;
    const shown = found.slice(0, 200).map((o) => {
      const e = o.event;
      const span = o.end !== o.start ? ` to ${o.end}${e.endTime ? ` ${e.endTime}` : ''}` : '';
      const time = e.startTime ? `${e.startTime}${o.end === o.start && e.endTime ? `-${e.endTime}` : ''}` : 'all day';
      const bits = [e.location && `at ${e.location}`, e.courseId && `course "${courseName(e.courseId)}"`, e.repeat !== 'none' && `repeats ${e.repeat}`].filter(Boolean);
      return `- ${o.start} ${time}${span}: "${named(e.title)}" (event id ${e.id})${bits.length ? `, ${bits.join(', ')}` : ''}`;
    });
    if (found.length > 200) shown.push(`(…and ${found.length - 200} more. Ask for a shorter range.)`);
    return shown.join('\n');
  },
};

interface EventInput {
  title: string;
  start_date: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  location?: string;
  notes?: string;
  course_id?: string;
  repeat?: Repeat;
  repeat_until?: string;
}

/** The parts of an event that have to agree with each other. */
interface Span {
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  repeat: Repeat;
  repeatUntil: string | null;
}

function checkSpan(s: Span) {
  if (s.startTime === null && s.endTime !== null) throw new ToolError('An all-day event has no times. Give start_time as well, or leave end_time out.');
  if (s.endDate < s.startDate) throw new ToolError('The event ends before it starts: end_date is earlier than start_date.');
  if (s.endDate === s.startDate && s.startTime && s.endTime && s.endTime < s.startTime) throw new ToolError('The event ends before it starts: end_time is earlier than start_time.');
  if (s.repeatUntil !== null && s.repeat === 'none') throw new ToolError('repeat_until only works for a repeating event: set repeat to "daily", "weekly" or "monthly".');
  if (s.repeatUntil !== null && s.repeatUntil < s.startDate) throw new ToolError('repeat_until is before the first date of the event.');
}

const repeatOf = (value: unknown): Repeat => {
  if (!REPEATS.includes(value as Repeat)) throw new ToolError('repeat must be "none", "daily", "weekly" or "monthly".');
  return value as Repeat;
};

/** What a new event is made of, checked. */
function newEvent(i: EventInput): { patch: EventPatch; span: Span } {
  const startDate = day(i.start_date, 'start_date');
  const span: Span = {
    startDate,
    startTime: i.start_time === undefined ? null : hour(i.start_time, 'start_time'),
    endDate: i.end_date === undefined ? startDate : day(i.end_date, 'end_date'),
    endTime: i.end_time === undefined ? null : hour(i.end_time, 'end_time'),
    repeat: i.repeat === undefined ? 'none' : repeatOf(i.repeat),
    repeatUntil: i.repeat_until === undefined ? null : day(i.repeat_until, 'repeat_until'),
  };
  checkSpan(span);
  const patch: EventPatch = { title: text(i.title, 'title', 200), ...span };
  if (i.location !== undefined) patch.location = text(i.location, 'location', 200, true);
  if (i.notes !== undefined) patch.notes = text(i.notes, 'notes', 5000, true);
  if (i.course_id !== undefined) patch.courseId = courseFor(i.course_id);
  return { patch, span };
}

const createEvent: Tool<EventInput> = {
  name: 'create_event',
  kind: 'create',
  description:
    'Adds an event to the calendar. `start_date` is YYYY-MM-DD; `start_time` and `end_time` are HH:MM on a 24-hour clock, and an event with no times is an all-day event. `end_date` defaults to the start date and may not be before it. `repeat` is "none" (the default), "daily", "weekly" or "monthly", with `repeat_until` (YYYY-MM-DD) as the last date it may fall on. The person is shown it and decides before it is added. Returns the new event’s id.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      start_time: { type: 'string', description: 'HH:MM, 24-hour' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_time: { type: 'string', description: 'HH:MM, 24-hour' },
      location: { type: 'string' },
      notes: { type: 'string' },
      course_id: { type: 'string' },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] },
      repeat_until: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['title', 'start_date'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.createEvent', { title: named(String(i.title ?? '')) }),
  preview(i) {
    const { patch, span } = newEvent(i);
    const out = [
      { label: t('assistantTools.labels.starts'), value: when(span.startDate, span.startTime) },
      ...(span.endDate !== span.startDate || span.endTime ? [{ label: t('assistantTools.labels.ends'), value: when(span.endDate, span.endTime) }] : []),
      ...(patch.location ? [{ label: t('assistantTools.labels.location'), value: patch.location }] : []),
      ...(patch.courseId ? [{ label: t('assistantTools.labels.course'), value: courseName(patch.courseId) }] : []),
      ...(span.repeat !== 'none' ? [{ label: t('assistantTools.labels.repeats'), value: repeatName(span.repeat) }] : []),
      ...(span.repeatUntil ? [{ label: t('assistantTools.labels.until'), value: when(span.repeatUntil, null) }] : []),
      ...(patch.notes ? [{ label: t('assistantTools.labels.notes'), value: brief(patch.notes) }] : []),
    ];
    return { title: t('assistantTools.changes.createEvent', { title: patch.title! }), lines: out };
  },
  async run(i): Promise<Done> {
    const { patch } = newEvent(i);
    const e = await planner.addEvent(patch);
    if (!e) throw new ToolError('The event could not be saved.');
    return {
      summary: t('assistantTools.changes.createdEvent', { title: patch.title! }),
      result: `Created the event "${patch.title}" (id ${e.id}).`,
      place: { kind: 'event', id: e.id },
      undo: () => planner.trash('events', e.id),
    };
  },
};

interface UpdateEventInput {
  id: string;
  title?: string;
  start_date?: string;
  start_time?: string | null;
  end_date?: string;
  end_time?: string | null;
  location?: string;
  notes?: string;
  course_id?: string | null;
  repeat?: Repeat;
  repeat_until?: string | null;
}

function planEvent(i: UpdateEventInput) {
  const e = eventFor(i.id);
  const patch: Record<string, unknown> = {};
  const back: Record<string, unknown> = {};
  const shown: Change[] = [];
  const set = (key: keyof CalEvent, next: unknown) => {
    if (e[key] === next) return false;
    patch[key] = next;
    back[key] = e[key];
    return true;
  };
  if (i.title !== undefined) {
    const title = text(i.title, 'title', 200);
    if (set('title', title)) shown.push({ label: t('assistantTools.labels.title'), from: brief(e.title), to: title });
  }
  const s: Span = { startDate: e.startDate, startTime: e.startTime, endDate: e.endDate, endTime: e.endTime, repeat: e.repeat, repeatUntil: e.repeatUntil };
  if (i.start_date !== undefined) {
    s.startDate = day(i.start_date, 'start_date');
    // Moving the start moves the end with it, so the event keeps its length (as dragging it does).
    if (i.end_date === undefined) s.endDate = addDays(s.startDate, diffDays(e.startDate, e.endDate));
  }
  if (i.end_date !== undefined) s.endDate = day(i.end_date, 'end_date');
  if (i.start_time !== undefined) {
    s.startTime = i.start_time === null ? null : hour(i.start_time, 'start_time');
    // An all-day event has no end time either.
    if (s.startTime === null && i.end_time === undefined) s.endTime = null;
  }
  if (i.end_time !== undefined) s.endTime = i.end_time === null ? null : hour(i.end_time, 'end_time');
  if (i.repeat !== undefined) {
    s.repeat = repeatOf(i.repeat);
    if (s.repeat === 'none' && i.repeat_until === undefined) s.repeatUntil = null;
  }
  if (i.repeat_until !== undefined) s.repeatUntil = i.repeat_until === null ? null : day(i.repeat_until, 'repeat_until');
  checkSpan(s);
  const starts = [set('startDate', s.startDate), set('startTime', s.startTime)];
  const ends = [set('endDate', s.endDate), set('endTime', s.endTime)];
  if (starts.some(Boolean)) shown.push({ label: t('assistantTools.labels.starts'), from: when(e.startDate, e.startTime), to: when(s.startDate, s.startTime) });
  if (ends.some(Boolean)) shown.push({ label: t('assistantTools.labels.ends'), from: when(e.endDate, e.endTime), to: when(s.endDate, s.endTime) });
  if (i.location !== undefined) {
    const location = text(i.location, 'location', 200, true);
    if (set('location', location)) shown.push({ label: t('assistantTools.labels.location'), from: e.location || none(), to: location || none() });
  }
  if (i.notes !== undefined) {
    const notes = text(i.notes, 'notes', 5000, true);
    if (set('notes', notes)) shown.push({ label: t('assistantTools.labels.notes'), from: brief(e.notes), to: brief(notes) });
  }
  if (i.course_id !== undefined) {
    const course = i.course_id === null ? null : courseFor(i.course_id);
    if (set('courseId', course)) shown.push({ label: t('assistantTools.labels.course'), from: courseName(e.courseId), to: courseName(course) });
  }
  if (set('repeat', s.repeat)) shown.push({ label: t('assistantTools.labels.repeats'), from: repeatName(e.repeat), to: repeatName(s.repeat) });
  if (set('repeatUntil', s.repeatUntil)) shown.push({ label: t('assistantTools.labels.until'), from: when(e.repeatUntil, null), to: when(s.repeatUntil, null) });
  if (!shown.length) throw new ToolError('Nothing would change: give at least one field with a new value.');
  return { e, patch: patch as EventPatch, back: back as EventPatch, shown };
}

const updateEvent: Tool<UpdateEventInput> = {
  name: 'update_event',
  kind: 'edit',
  description:
    'Changes a calendar event found with list_events. Give `id` and only the fields to change: `title`, `start_date`, `start_time` (HH:MM or null to make it all-day), `end_date`, `end_time`, `location`, `notes`, `course_id` (or null), `repeat`, `repeat_until` (or null). This changes the whole event: for a repeating event, every occurrence changes, not just the one listed. Moving `start_date` moves the end date too unless `end_date` is given. The person is shown each old and new value and decides first.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      start_time: { type: ['string', 'null'], description: 'HH:MM, 24-hour, or null for all day.' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_time: { type: ['string', 'null'], description: 'HH:MM, 24-hour, or null.' },
      location: { type: 'string' },
      notes: { type: 'string' },
      course_id: { type: ['string', 'null'] },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] },
      repeat_until: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null for no end.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  label: (i) => t('assistantTools.changes.updateEvent', { title: named(planner.eventById.get(i.id)?.title ?? '') }),
  preview(i): Preview {
    const { e, shown } = planEvent(i);
    return { title: t('assistantTools.changes.updateEvent', { title: named(e.title) }), lines: lines(shown) };
  },
  async run(i): Promise<Done> {
    const { e, patch, back, shown } = planEvent(i);
    planner.updateEvent(e.id, patch, { immediate: true });
    await planner.flush();
    const title = named(patch.title ?? e.title);
    return {
      summary: t('assistantTools.changes.updatedEvent', { title }),
      result: `Done. Changed ${shown.map((c) => c.label.toLowerCase()).join(', ')} of the event "${title}" (id ${e.id}).`,
      place: { kind: 'event', id: e.id },
      undo: async () => {
        planner.updateEvent(e.id, back, { immediate: true });
        await planner.flush();
      },
    };
  },
};

// ---------------------------------------------------------------- courses

const listCourses: Tool<Record<string, never>> = {
  name: 'list_courses',
  kind: 'read',
  description:
    'Lists the person’s courses: name, id, teacher and room, and the id of the note that holds the course’s notes when it has one the assistant may read. Use it to find the `course_id` for assignments and events.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  label: () => t('assistantTools.tools.listingCourses'),
  async run() {
    if (!planner.courses.length) return 'There are no courses yet.';
    return planner.courses
      .map((c) => {
        const bits = [c.teacher && `teacher ${c.teacher}`, c.room && `room ${c.room}`, c.pageId && !keptFromAssistant(c.pageId) && `notes in note id ${c.pageId}`].filter(Boolean);
        return `- "${named(c.name)}" (id ${c.id})${bits.length ? `: ${bits.join(', ')}` : ''}`;
      })
      .join('\n');
  },
};

// ---------------------------------------------------------------- to-dos

const listTodos: Tool<Record<string, never>> = {
  name: 'list_todos',
  kind: 'read',
  description:
    'Lists the open to-do items written inside the person’s notes (the `- [ ]` lines): the text, the note’s title and id, and an `index` and `key` that identify the item. Ticked items are not listed. Shows at most 100. To tick one, pass its note id, index and key to check_todo.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  label: () => t('assistantTools.tools.listingTodos'),
  async run() {
    // Reads the notes again first, so what is listed is what the notes say now.
    await todos.load();
    const open = todos.items.filter((x) => !keptFromAssistant(x.pageId));
    if (!open.length) return 'There are no open to-dos in the notes.';
    const shown = open.slice(0, CAP).map((x) => `- "${x.text}" in the note "${named(store.untracked.get(x.pageId)?.title ?? '')}" (note id ${x.pageId}), index ${x.index}, key ${JSON.stringify(x.key)}`);
    if (open.length > CAP) shown.push(`(…and ${open.length - CAP} more.)`);
    return shown.join('\n');
  },
};

interface TodoInput {
  note_id: string;
  index: number;
  key: string;
  done: boolean;
}

function checkTodo(i: TodoInput) {
  const page = pageFor(i.note_id);
  if (typeof i.index !== 'number' || !Number.isInteger(i.index) || i.index < 0) throw new ToolError('index must be the whole number list_todos gave.');
  if (typeof i.key !== 'string') throw new ToolError('key must be the text list_todos gave.');
  if (typeof i.done !== 'boolean') throw new ToolError('done must be true (tick it) or false (untick it).');
  return page;
}

/** The nth to-do of a note's open editor, if it still reads as `key`. */
function todoIn(editor: Editor, index: number, key: string) {
  const items: { pos: number; attrs: Record<string, unknown>; first: string }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem') items.push({ pos, attrs: node.attrs, first: node.firstChild?.textContent ?? '' });
  });
  const item = items[index];
  if (!item || item.first.trim() !== key.trim()) throw new ToolError('That to-do has changed since list_todos. Call list_todos again.');
  return item;
}

/**
 * Ticks or unticks a to-do. In a note that is open in an editor it goes through
 * the editor (the way typing would), because a write behind its back would be
 * lost when the editor next saves. Otherwise it is saved the way the Home list
 * does it (todos.svelte.ts), but the error is kept: the Home list's own toggle
 * shows it to the person, and here the model has to be told.
 */
async function setTodo(pageId: string, index: number, key: string, checked: boolean) {
  const editor = editorsOf(pageId)[0];
  if (editor) {
    const item = todoIn(editor, index, key);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(item.pos, undefined, { ...item.attrs, checked }));
    return;
  }
  try {
    const updatedAt = await api.setTodo(pageId, index, key, checked);
    if (store.byId.has(pageId)) store.editOne(pageId, { updatedAt });
  } catch {
    throw new ToolError('That to-do has changed since list_todos. Call list_todos again.');
  }
}

const checkTodoTool: Tool<TodoInput> = {
  name: 'check_todo',
  kind: 'edit',
  description:
    'Ticks (done: true) or unticks (done: false) one to-do item inside a note. Pass the `note_id`, `index` and `key` exactly as list_todos gave them; if the note has changed since, it fails and you should list again. The person is shown it and decides first.',
  input_schema: {
    type: 'object',
    properties: { note_id: { type: 'string' }, index: { type: 'integer', minimum: 0 }, key: { type: 'string' }, done: { type: 'boolean' } },
    required: ['note_id', 'index', 'key', 'done'],
    additionalProperties: false,
  },
  label: (i) => t(i.done ? 'assistantTools.changes.tickTodo' : 'assistantTools.changes.untickTodo', { text: String(i.key ?? '') }),
  async preview(i) {
    const page = checkTodo(i);
    // Only open (unticked) to-dos are listed, so those can be checked against the notes.
    await todos.load();
    const item = todos.items.find((x) => x.pageId === page.id && x.index === i.index && x.key === i.key);
    if (i.done && !item) throw new ToolError('There is no open to-do like that: it may be ticked already, or the note changed. Call list_todos again.');
    if (!i.done && item) throw new ToolError('That to-do is not ticked, so there is nothing to untick.');
    const shown = item?.text ?? i.key;
    return {
      title: t(i.done ? 'assistantTools.changes.tickTodo' : 'assistantTools.changes.untickTodo', { text: shown }),
      lines: [{ label: t('assistantTools.labels.note'), value: named(page.title) }],
    };
  },
  async run(i): Promise<Done> {
    const page = checkTodo(i);
    await setTodo(page.id, i.index, i.key, i.done);
    await todos.load();
    return {
      summary: t(i.done ? 'assistantTools.changes.tickedTodo' : 'assistantTools.changes.untickedTodo', { text: i.key }),
      result: `Done. The to-do "${i.key}" in "${named(page.title)}" is ${i.done ? 'ticked' : 'not ticked'} now. Its index may have changed for other items: call list_todos again before another.`,
      place: { kind: 'page', id: page.id },
      undo: async () => {
        await setTodo(page.id, i.index, i.key, !i.done);
        await todos.load();
      },
    };
  },
};

// ---------------------------------------------------------------- flashcard decks

const listDecks: Tool<Record<string, never>> = {
  name: 'list_flashcard_decks',
  kind: 'read',
  description:
    'Lists the notes that hold flashcards: the note’s title and id, how many cards it has, how many are due for review today, how many are new (never studied) and how many are mastered. Use it to answer what the person should study. To add cards, use add_flashcards; to read the cards, read the note.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  label: () => t('assistantTools.tools.listingDecks'),
  async run() {
    await cards.load();
    const decks = cards.decks.filter((d) => !keptFromAssistant(d.pageId));
    if (!decks.length) return 'There are no flashcards yet.';
    return decks
      .map((d) => `- "${named(store.untracked.get(d.pageId)?.title ?? '')}" (note id ${d.pageId}): ${d.count} cards, ${d.due} due today, ${d.fresh} new, ${d.mastered} mastered`)
      .join('\n');
  },
};

export const plannerTools: Tool[] = [listAssignments, createAssignment, updateAssignment, listEvents, createEvent, updateEvent, listCourses, listTodos, checkTodoTool, listDecks];
