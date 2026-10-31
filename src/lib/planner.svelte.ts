/** Courses, assignments and calendar events, and every action on them. */

import { api } from './api';
import { Autosave } from './autosave';
import { colorVar, nextColor } from './colors';
import { clock } from './clock.svelte';
import { addDays, diffDays, formatDate, minutes, occurrences } from './dates';
import { store } from './store.svelte';
import { ui } from './ui.svelte';
import type { Assignment, AssignmentPatch, CalEvent, Course, CoursePatch, EventPatch, OccurrencePage } from './types';
import { lineIcon } from './page-icon';
import { parts, t } from './i18n';

const byDue = (a: Assignment, b: Assignment) =>
  (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
  (a.dueTime ?? '24:00').localeCompare(b.dueTime ?? '24:00') ||
  b.priority - a.priority ||
  a.createdAt - b.createdAt;

class Planner {
  courses = $state<Course[]>([]);
  assignments = $state<Assignment[]>([]);
  events = $state<CalEvent[]>([]);
  /** Notes pages for single sessions of events. */
  sessionPages = $state<OccurrencePage[]>([]);
  loaded = $state(false);

  courseById = $derived(new Map(this.courses.map((c) => [c.id, c])));
  assignmentById = $derived(new Map(this.assignments.map((a) => [a.id, a])));
  eventById = $derived(new Map(this.events.map((e) => [e.id, e])));

  /** Live assignments, soonest due first. */
  live = $derived(this.assignments.filter((a) => !a.deletedAt).sort(byDue));
  liveEvents = $derived(this.events.filter((e) => !e.deletedAt));

  /** Open assignments that are overdue or due within a week (sidebar badge). */
  dueSoon = $derived.by(() => {
    const horizon = addDays(clock.today, 7);
    return this.live.filter((a) => a.status !== 'done' && a.dueDate !== null && a.dueDate <= horizon);
  });

  /** Live assignments keyed by due date, for the calendar. */
  dueByDate = $derived.by(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of this.live) {
      if (!a.dueDate) continue;
      let list = map.get(a.dueDate);
      if (!list) map.set(a.dueDate, (list = []));
      list.push(a);
    }
    return map;
  });

  #assignmentSaver = new Autosave<AssignmentPatch, Assignment>(
    (id, patch) => api.updateAssignment(id, patch),
    (id, saved) => {
      const a = this.assignmentById.get(id);
      if (!a) return;
      a.updatedAt = saved.updatedAt;
      a.completedAt = saved.completedAt;
      if (!this.#assignmentSaver.has(id)) a.fileIds = saved.fileIds;
    },
    (id, e) => this.assignmentById.has(id) && ui.error(e),
  );

  #eventSaver = new Autosave<EventPatch, CalEvent>(
    (id, patch) => api.updateEvent(id, patch),
    (id, saved) => {
      const e = this.eventById.get(id);
      if (!e || this.#eventSaver.has(id)) return;
      // The backend normalizes ranges (end never before start), so take its word.
      Object.assign(e, saved);
    },
    (id, e) => this.eventById.has(id) && ui.error(e),
  );

  #courseSaver = new Autosave<CoursePatch, Course>(
    (id, patch) => api.updateCourse(id, patch),
    () => {},
    (id, e) => this.courseById.has(id) && ui.error(e),
  );

  async load() {
    const [courses, assignments, events, sessionPages] = await Promise.all([
      api.listCourses(),
      api.listAssignments(),
      api.listEvents(),
      api.listOccurrencePages(),
    ]);
    this.courses = courses;
    this.assignments = assignments;
    this.events = events;
    this.sessionPages = sessionPages;
    this.loaded = true;
  }

  flush() {
    return Promise.all([this.#assignmentSaver.flush(), this.#eventSaver.flush(), this.#courseSaver.flush()]);
  }

  // ------------------------------------------------------------- colours

  courseColor(courseId: string | null | undefined): string {
    const c = courseId ? this.courseById.get(courseId) : undefined;
    return c ? colorVar(c.color) : 'var(--accent)';
  }

  eventColor(e: CalEvent): string {
    return e.color ? colorVar(e.color) : this.courseColor(e.courseId);
  }

  // ------------------------------------------------------------- courses

  async addCourse(name: string, color?: string): Promise<Course | null> {
    try {
      const course = await api.createCourse(name, color ?? nextColor(this.courses.map((c) => c.color)));
      this.courses.push(course);
      return course;
    } catch (e) {
      ui.error(e);
      return null;
    }
  }

  /** Asks for a name and colour, then adds the course. */
  async promptCourse(): Promise<Course | null> {
    const res = await ui.prompt({
      title: t('planner.course.newTitle'),
      placeholder: t('planner.course.namePlaceholder'),
      confirmLabel: t('planner.course.add'),
      icon: 'book',
      color: nextColor(this.courses.map((c) => c.color)),
    });
    return res ? this.addCourse(res.value, res.color) : null;
  }

  /** Applies right away; typing in course details is saved shortly after. */
  updateCourse(id: string, patch: CoursePatch, { typing = false } = {}) {
    const c = this.courseById.get(id);
    if (c) Object.assign(c, patch);
    this.#courseSaver.queue(id, patch, !typing);
  }

  /** Moves a course to place `to` among the others (as dragged in the sidebar), and saves the new order. */
  moveCourse(id: string, to: number) {
    const course = this.courseById.get(id);
    if (!course) return;
    const next = this.courses.filter((c) => c.id !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, course);
    if (next.every((c, i) => c === this.courses[i])) return;
    next.forEach((c, i) => (c.position = i));
    this.courses = next;
    api.reorderCourses(next.map((c) => c.id)).catch(ui.error);
  }

  /** The page that holds a course's notes, created the first time. */
  async courseFolder(courseId: string): Promise<string | null> {
    const c = this.courseById.get(courseId);
    if (!c) return null;
    const page = c.pageId ? store.byId.get(c.pageId) : undefined;
    if (page && !page.deletedAt) return page.id;
    const meta = await store.create(null, { open: false, title: c.name || t('common.course'), icon: lineIcon('book-open', c.color) });
    if (!meta) return null;
    this.updateCourse(courseId, { pageId: meta.id });
    return meta.id;
  }

  /** A blank page in the course's notes folder, opened for typing. */
  async newCourseNote(courseId: string) {
    const folder = await this.courseFolder(courseId);
    if (folder) await store.create(folder, { index: 0 });
  }

  /**
   * "Take Notes" on a course: notes for today's class (the one under way or
   * the next one), or a blank note when there's no class today.
   */
  async courseNotes(courseId: string) {
    const today = clock.today;
    const sessions = this.liveEvents
      .filter((e) => e.courseId === courseId && e.startTime)
      .flatMap((e) => occurrences(e, today, today))
      .filter((o) => o.start === today)
      .sort((a, b) => a.event.startTime!.localeCompare(b.event.startTime!));
    // A class counts as started 15 minutes early, when people sit down.
    const now = minutes(clock.time) + 15;
    const started = sessions.filter((o) => minutes(o.event.startTime!) <= now);
    const pick = started[started.length - 1] ?? sessions[0];
    if (pick) await this.takeNotes(pick.event.id, today);
    else await this.newCourseNote(courseId);
  }

  async deleteCourse(id: string) {
    const c = this.courseById.get(id);
    if (!c) return;
    const used = this.live.filter((a) => a.courseId === id).length + this.liveEvents.filter((e) => e.courseId === id).length;
    const ok = await ui.confirm({
      title: t('planner.course.deleteTitle'),
      message: used ? t('planner.course.deleteInUse', { count: used, name: c.name }) : t('planner.course.deleteUnused', { name: c.name }),
      confirmLabel: t('common.actions.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteCourse(id);
      this.courses = this.courses.filter((x) => x.id !== id);
      store.forgetCourse(id);
      for (const a of this.assignments) if (a.courseId === id) a.courseId = null;
      for (const e of this.events) if (e.courseId === id) e.courseId = null;
    } catch (e) {
      ui.error(e);
    }
  }

  // ---------------------------------------------------------- assignments

  /** Opens the sheet for a new assignment, prefilled with `draft`. */
  newAssignment(draft: AssignmentPatch = {}) {
    ui.assignmentSheet = { id: null, draft };
  }

  openAssignment(id: string) {
    if (this.assignmentById.get(id)?.deletedAt) return;
    ui.assignmentSheet = { id, draft: {} };
  }

  async addAssignment(input: AssignmentPatch): Promise<Assignment | null> {
    try {
      const a = await api.createAssignment(input);
      this.assignments.push(a);
      return a;
    } catch (e) {
      ui.error(e);
      return null;
    }
  }

  updateAssignment(id: string, patch: AssignmentPatch, { immediate = false } = {}) {
    const a = this.assignmentById.get(id);
    if (!a) return;
    if (patch.status !== undefined && patch.status !== a.status) {
      a.completedAt = patch.status === 'done' ? Date.now() : null;
    }
    if (patch.dueDate === null) patch = { ...patch, dueTime: null };
    Object.assign(a, patch);
    this.#assignmentSaver.queue(id, patch, immediate);
  }

  toggleDone(id: string) {
    const a = this.assignmentById.get(id);
    if (a) this.updateAssignment(id, { status: a.status === 'done' ? 'todo' : 'done' }, { immediate: true });
  }

  // --------------------------------------------------------------- events

  newEvent(draft: EventPatch = {}) {
    ui.eventSheet = { id: null, draft };
  }

  /** Opens an event; `date` picks one session of a repeating event. */
  openEvent(id: string, date?: string) {
    if (this.eventById.get(id)?.deletedAt) return;
    ui.eventSheet = { id, draft: {}, date };
  }

  /**
   * The notes page of one session, if it has one (and it isn't trashed). A
   * one-off event has a single session, whose notes are its notes page.
   */
  sessionPage(eventId: string, date: string): string | null {
    const e = this.eventById.get(eventId);
    const id =
      e && e.repeat === 'none'
        ? e.pageId
        : this.sessionPages.find((s) => s.eventId === eventId && s.date === date)?.pageId;
    const page = id ? store.byId.get(id) : undefined;
    return page && !page.deletedAt ? page.id : null;
  }

  /**
   * Opens the notes for one session ("Biology lecture — Oct 14"), creating
   * the page inside the course's notes folder the first time.
   */
  async takeNotes(eventId: string, date: string) {
    const e = this.eventById.get(eventId);
    if (!e) return;
    let pageId = this.sessionPage(eventId, date);
    if (!pageId) {
      const parent = e.courseId ? await this.courseFolder(e.courseId) : null;
      const day = formatDate(date, { month: 'short', day: 'numeric' });
      const meta = await store.create(parent, {
        open: false,
        title: e.title ? t('planner.sessionNotes.title', { title: e.title, date: day }) : t('planner.sessionNotes.untitled', { date: day }),
        icon: lineIcon('notebook-pen', e.courseId ? this.courseById.get(e.courseId)?.color : null),
        index: 0,
      });
      if (!meta) return;
      const when = formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
      const doc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'mention', attrs: { id: eventId, kind: 'event', date } }, { type: 'text', text: ' ' }] },
          { type: 'paragraph' },
        ],
      };
      store.update(meta.id, { content: JSON.stringify(doc), text: `${e.title} ${when}` }, { immediate: true });
      if (e.repeat === 'none') this.updateEvent(eventId, { pageId: meta.id }, { immediate: true });
      else {
        try {
          await api.setOccurrencePage(eventId, date, meta.id);
          this.sessionPages = [...this.sessionPages.filter((s) => !(s.eventId === eventId && s.date === date)), { eventId, date, pageId: meta.id }];
        } catch (err) {
          ui.error(err);
        }
      }
      pageId = meta.id;
    }
    ui.eventSheet = null;
    store.open(pageId);
  }

  /** Skips one date of a repeating event, with Undo. */
  skipDate(eventId: string, date: string) {
    const e = this.eventById.get(eventId);
    if (!e) return;
    const before = [...e.exdates];
    this.updateEvent(eventId, { exdates: [...before, date] }, { immediate: true });
    if (ui.eventSheet?.id === eventId) ui.eventSheet = null;
    const day = formatDate(date);
    ui.toast(e.title ? t('planner.toast.sessionRemoved', { title: e.title, date: day }) : t('planner.toast.untitledSessionRemoved', { date: day }), {
      label: t('common.actions.undo'),
      run: () => this.updateEvent(eventId, { exdates: before }, { immediate: true }),
    });
  }

  /**
   * Splits one session off a repeating event: the series skips that date and
   * a standalone copy (with `patch` applied) takes its place. Returns the copy.
   */
  async detach(eventId: string, date: string, patch: EventPatch): Promise<CalEvent | null> {
    const e = this.eventById.get(eventId);
    if (!e) return null;
    const span = diffDays(e.startDate, e.endDate);
    // The session's notes follow it (a one-off event keeps them as its page).
    const notes = this.sessionPage(eventId, date);
    const copy = await this.addEvent({
      title: e.title,
      startDate: date,
      endDate: addDays(date, span),
      startTime: e.startTime,
      endTime: e.endTime,
      color: e.color,
      courseId: e.courseId,
      location: e.location,
      notes: e.notes,
      repeat: 'none',
      pageId: notes,
      ...patch,
    });
    if (!copy) return null;
    this.updateEvent(eventId, { exdates: [...e.exdates, date] }, { immediate: true });
    if (e.tags.length) copy.tags = await api.setItemTags('events', copy.id, e.tags).catch(() => []);
    return copy;
  }

  /** Moves one session of a repeating event (drag and drop), with Undo. */
  async moveSession(eventId: string, date: string, patch: EventPatch) {
    const copy = await this.detach(eventId, date, patch);
    if (!copy) return;
    ui.toast(t('planner.toast.sessionMoved', { title: copy.title || t('common.untitled'), date: formatDate(date) }), {
      label: t('common.actions.undo'),
      run: () => void this.reattach(copy.id, eventId, date),
    });
  }

  /** Undoes `detach`: drops the standalone copy and restores the session. */
  async reattach(copyId: string, eventId: string, date: string) {
    const e = this.eventById.get(eventId);
    if (!e) return;
    try {
      await this.#eventSaver.flush();
      await api.deleteItem('events', copyId);
      this.events = this.events.filter((x) => x.id !== copyId);
      if (ui.eventSheet?.id === copyId) ui.eventSheet = null;
      this.updateEvent(eventId, { exdates: e.exdates.filter((d) => d !== date) }, { immediate: true });
    } catch (err) {
      ui.error(err);
    }
  }

  async addEvent(input: EventPatch): Promise<CalEvent | null> {
    try {
      const ev = await api.createEvent(input);
      this.events.push(ev);
      return ev;
    } catch (e) {
      ui.error(e);
      return null;
    }
  }

  updateEvent(id: string, patch: EventPatch, { immediate = false } = {}) {
    const ev = this.eventById.get(id);
    if (!ev) return;
    Object.assign(ev, patch);
    this.#eventSaver.queue(id, patch, immediate);
  }

  // ---------------------------------------------------------------- trash

  async trash(kind: 'assignments' | 'events', id: string) {
    const item = kind === 'assignments' ? this.assignmentById.get(id) : this.eventById.get(id);
    if (!item) return;
    try {
      await this.flush();
      item.deletedAt = await api.trashItem(kind, id);
      if (ui.assignmentSheet?.id === id) ui.assignmentSheet = null;
      if (ui.eventSheet?.id === id) ui.eventSheet = null;
      ui.toast(t('planner.toast.movedToTrash', { title: item.title || t('common.untitled') }), {
        label: t('common.actions.undo'),
        run: () => void this.restore(kind, id),
      });
    } catch (e) {
      ui.error(e);
    }
  }

  async restore(kind: 'assignments' | 'events', id: string) {
    try {
      await api.restoreItem(kind, id);
      const item = kind === 'assignments' ? this.assignmentById.get(id) : this.eventById.get(id);
      if (item) item.deletedAt = null;
    } catch (e) {
      ui.error(e);
    }
  }

  /** Permanently deletes (from the Trash; the caller confirms). */
  async deleteForever(kind: 'assignments' | 'events', id: string) {
    try {
      await api.deleteItem(kind, id);
      if (kind === 'assignments') this.assignments = this.assignments.filter((a) => a.id !== id);
      else this.events = this.events.filter((e) => e.id !== id);
    } catch (e) {
      ui.error(e);
    }
  }

  // ----------------------------------------------------------- notes pages

  /**
   * Creates a page for longer notes, starting with a link back to the
   * assignment or event, and links it. Returns the new page id.
   */
  async createNotesPage(kind: 'assignment' | 'event', id: string): Promise<string | null> {
    const item = kind === 'assignment' ? this.assignmentById.get(id) : this.eventById.get(id);
    if (!item) return null;
    const meta = await store.create(null, {
      open: false,
      title: item.title || t('common.untitled'),
      icon: lineIcon(kind === 'assignment' ? 'file-text' : 'calendar-days', item.courseId ? this.courseById.get(item.courseId)?.color : null),
    });
    if (!meta) return null;
    // "Notes for <mention/>": the link goes where the language puts it.
    const intro = parts(kind === 'assignment' ? 'planner.notesPage.forAssignment' : 'planner.notesPage.fromEvent').flatMap(
      (p): { type: string; attrs?: object; text?: string }[] =>
        p.tag === 'mention' ? [{ type: 'mention', attrs: { id, kind } }] : p.text ? [{ type: 'text', text: p.text }] : [],
    );
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: intro }, { type: 'paragraph' }],
    };
    store.update(meta.id, { content: JSON.stringify(doc), text: t('planner.notesPage.searchText', { title: item.title }) }, { immediate: true });
    if (kind === 'assignment') this.updateAssignment(id, { pageId: meta.id }, { immediate: true });
    else this.updateEvent(id, { pageId: meta.id }, { immediate: true });
    return meta.id;
  }
}

export const planner = new Planner();
