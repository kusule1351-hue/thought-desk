<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import Swatches from '../ui/Swatches.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Switch from '../ui/Switch.svelte';
  import Backlinks from '../ui/Backlinks.svelte';
  import TagRow from '../ui/TagRow.svelte';
  import { clock } from '../clock.svelte';
  import { colorVar, nextColor } from '../colors';
  import { addDays, diffDays, formatDate, fromMinutes, minutes, REPEAT_LABELS, repeatSentence } from '../dates';
  import { t } from '../i18n';
  import { openNotesPage } from '../item-actions';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { relativeWhen } from '../time';
  import { ui, type SheetState } from '../ui.svelte';
  import type { EventPatch, Repeat } from '../types';

  let { sheet }: { sheet: SheetState<EventPatch> } = $props();

  // The sheet is re-created per item, and closing clears the prop, so keep
  // what's needed after closing.
  // svelte-ignore state_referenced_locally
  const { id, onCreated, date } = sheet;
  /** The event being edited; becomes the standalone copy once one session is split off. */
  let targetId = $state(id);
  const existing = $derived(targetId ? planner.eventById.get(targetId) : undefined);
  const series = $derived(id ? planner.eventById.get(id) : undefined);
  /** Opened on one session of a repeating event. */
  const isSession = $derived(!!date && !!series && series.repeat !== 'none');
  let scope = $state<'this' | 'all'>('all');
  /** This session now lives on as its own event. */
  const split = $derived(targetId !== id);
  const editingSession = $derived(isSession && scope === 'this' && !split);
  const scopes = [
    { value: 'this' as const, label: t('sheets.event.thisEvent') },
    { value: 'all' as const, label: t('sheets.event.allEvents') },
  ];
  // svelte-ignore state_referenced_locally
  let draft = $state({
    title: '',
    startDate: clock.today,
    startTime: '09:00' as string | null,
    endDate: clock.today,
    endTime: '10:00' as string | null,
    color: '',
    courseId: null as string | null,
    location: '',
    notes: '',
    repeat: 'none' as Repeat,
    repeatUntil: null as string | null,
    ...sheet.draft,
  });
  /** In "This Event" mode the form shows the session, not the series. */
  const form = $derived.by(() => {
    if (!existing) return draft;
    if (!editingSession || !date) return existing;
    return { ...existing, startDate: date, endDate: addDays(date, diffDays(existing.startDate, existing.endDate)) };
  });
  const course = $derived(form.courseId ? planner.courseById.get(form.courseId) : undefined);
  const page = $derived(existing?.pageId ? store.byId.get(existing.pageId) : undefined);
  /** The session whose class notes the sheet offers. */
  const sessionEvent = $derived(existing?.id);
  const sessionDate = $derived(existing && isSession ? (split ? existing.startDate : date) : undefined);
  const sessionNotes = $derived.by(() => {
    const pid = sessionEvent && sessionDate ? planner.sessionPage(sessionEvent, sessionDate) : null;
    return pid ? store.byId.get(pid) : undefined;
  });
  const allDay = $derived(form.startTime === null);
  const color = $derived(form.color ? colorVar(form.color) : planner.courseColor(form.courseId));

  let titleEl: HTMLInputElement;
  onMount(() => {
    if (!existing) titleEl.focus();
  });

  let detaching: Promise<void> | null = null;
  let queued: EventPatch = {};

  function set(patch: EventPatch, { typing = false } = {}) {
    if (!existing) {
      Object.assign(draft, patch);
      return;
    }
    if (!editingSession || !date) {
      planner.updateEvent(existing.id, patch, { immediate: !typing });
      return;
    }
    // The first change to one session splits it off the series; changes made
    // while that's under way follow it onto the copy.
    if (detaching) {
      Object.assign(queued, patch);
      return;
    }
    detaching = planner.detach(existing.id, date, patch).then((copy) => {
      if (copy) {
        targetId = copy.id;
        if (Object.keys(queued).length) planner.updateEvent(copy.id, queued, { immediate: true });
      }
      queued = {};
      detaching = null;
    });
  }

  /** Moving the start keeps the length of the event. */
  function setStartDate(date: string) {
    if (!date) return;
    const shift = diffDays(form.startDate, date);
    set({ startDate: date, endDate: addDays(form.endDate, shift) });
  }

  function setStartTime(time: string) {
    if (!time || !form.startTime) return;
    const length = diffDays(form.startDate, form.endDate) * 1440 + minutes(form.endTime ?? form.startTime) - minutes(form.startTime);
    const end = minutes(time) + Math.max(0, length);
    set({ startTime: time, endDate: addDays(form.startDate, Math.floor(end / 1440)), endTime: fromMinutes(end % 1440) });
  }

  function toggleAllDay() {
    if (allDay) set({ startTime: '09:00', endTime: '10:00' });
    else set({ startTime: null, endTime: null });
  }

  async function add() {
    ui.eventSheet = null;
    const ev = await planner.addEvent({ ...draft, title: draft.title.trim() || t('sheets.event.defaultTitle') });
    if (ev) onCreated?.(ev.id);
  }

  /** Closing keeps a new event once it has a title. */
  function close() {
    if (!existing && draft.title.trim()) void add();
    else ui.eventSheet = null;
  }

  function repeatMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      (Object.keys(REPEAT_LABELS) as Repeat[]).map((r) => ({
        label: REPEAT_LABELS[r],
        checked: form.repeat === r,
        action: () => set({ repeat: r, ...(r === 'none' ? { repeatUntil: null } : {}) }),
      })),
      { alignRight: true },
    );
  }

  function courseMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: t('sheets.coursePicker.noCourse'), icon: 'x', checked: !form.courseId, action: () => set({ courseId: null }) },
        ...(planner.courses.length ? [{ separator: true } as const] : []),
        ...planner.courses.map((c) => ({
          label: c.name || t('common.untitled'),
          dot: colorVar(c.color),
          checked: form.courseId === c.id,
          action: () => set({ courseId: c.id }),
        })),
        { separator: true },
        {
          label: t('sheets.coursePicker.newCourse'),
          icon: 'plus',
          action: async () => {
            const res = await ui.prompt({
              title: t('sheets.coursePicker.newCourseTitle'),
              placeholder: t('sheets.coursePicker.namePlaceholder'),
              confirmLabel: t('sheets.coursePicker.addCourse'),
              icon: 'book',
              color: nextColor(planner.courses.map((c) => c.color)),
            });
            if (!res) return;
            const c = await planner.addCourse(res.value, res.color);
            if (c) set({ courseId: c.id });
          },
        },
      ],
      { alignRight: true },
    );
  }

  async function notesPage() {
    if (existing) {
      await openNotesPage('event', existing.id);
      return;
    }
    ui.eventSheet = null;
    const ev = await planner.addEvent({ ...draft, title: draft.title.trim() || t('sheets.event.defaultTitle') });
    if (!ev) return;
    onCreated?.(ev.id);
    await openNotesPage('event', ev.id);
  }

  /** "Created just now", "Created 3 days ago", "Created Oct 20, 2025". */
  function createdText(ms: number): string {
    const when = relativeWhen(ms);
    if (when.kind === 'now') return t('sheets.created.now');
    if (when.kind === 'relative') return t('sheets.created.relative', { when: when.text });
    return t('sheets.created.date', { date: when.text });
  }
</script>

<Modal onclose={close} label={existing ? t('sheets.event.label') : t('sheets.event.newLabel')}>
  <header class="modal-head">
    <span class="swatch round" style:--c={color}></span>
    <input
      class="title"
      bind:this={titleEl}
      value={form.title}
      placeholder={existing ? t('common.untitled') : t('sheets.event.titlePlaceholder')}
      spellcheck="false"
      oninput={(e) => set({ title: e.currentTarget.value }, { typing: true })}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (existing) close();
          else void add();
        }
      }}
    />
    <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </header>

  <div class="modal-body">
    <div class="group">
      {#if isSession && !split}
        <div class="group-row">
          <div class="row-label">
            {t('sheets.event.editScope')}
            <small>{scope === 'this' ? t('sheets.event.onlyDate', { date: formatDate(date!, { weekday: 'long', month: 'short', day: 'numeric' }) }) : t('sheets.event.everyRepeat')}</small>
          </div>
          <Segmented options={scopes} value={scope} onchange={(v) => (scope = v)} label={t('sheets.event.editScopeLabel')} />
        </div>
      {/if}
      <div class="group-row">
        <div class="row-label">{t('sheets.event.allDay')}</div>
        <Switch on={allDay} label={t('sheets.event.allDay')} onchange={toggleAllDay} />
      </div>
      <div class="group-row">
        <div class="row-label">{t('sheets.event.starts')}</div>
        <div class="when">
          <label class="field date"><input type="date" value={form.startDate} aria-label={t('sheets.event.startDate')} onchange={(e) => setStartDate(e.currentTarget.value)} /></label>
          {#if !allDay}
            <label class="field time"><input type="time" value={form.startTime} aria-label={t('sheets.event.startTime')} onchange={(e) => setStartTime(e.currentTarget.value)} /></label>
          {/if}
        </div>
      </div>
      <div class="group-row">
        <div class="row-label">{t('sheets.event.ends')}</div>
        <div class="when">
          <label class="field date">
            <input
              type="date"
              value={form.endDate}
              min={form.startDate}
              aria-label={t('sheets.event.endDate')}
              onchange={(e) => e.currentTarget.value && set({ endDate: e.currentTarget.value })}
            />
          </label>
          {#if !allDay}
            <label class="field time">
              <input type="time" value={form.endTime} aria-label={t('sheets.event.endTime')} onchange={(e) => e.currentTarget.value && set({ endTime: e.currentTarget.value })} />
            </label>
          {/if}
        </div>
      </div>
      {#if !editingSession}
        <div class="group-row">
          <div class="row-label">
            {t('sheets.event.repeat')}
            {#if form.repeat !== 'none' && !isSession}<small>{t('sheets.event.everyRepeat')}</small>{/if}
          </div>
          <div class="when">
            {#if form.repeat !== 'none'}
              <label class="field date" data-tip={t('sheets.event.repeatUntilTip')}>
                <input
                  type="date"
                  value={form.repeatUntil ?? ''}
                  min={form.startDate}
                  aria-label={t('sheets.event.repeatUntil')}
                  onchange={(e) => set({ repeatUntil: e.currentTarget.value || null })}
                />
              </label>
            {/if}
            <button class="btn small raised picker" onclick={repeatMenu}>
              <Icon name="repeat" size={13} stroke={2} />{REPEAT_LABELS[form.repeat]}<Icon name="chevron-down" size={12} stroke={2.2} />
            </button>
          </div>
        </div>
      {/if}
    </div>

    <h3 class="group-title">{t('sheets.details')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">{t('common.course')}</div>
        <button class="btn small raised picker" onclick={courseMenu}>
          {#if course}<span class="dot" style:--dot={colorVar(course.color)}></span>{course.name || t('common.untitled')}{:else}<span class="muted">{t('sheets.coursePicker.none')}</span>{/if}
          <Icon name="chevron-down" size={12} stroke={2.2} />
        </button>
      </div>
      <div class="group-row">
        <div class="row-label">{t('sheets.color')}</div>
        <Swatches value={form.color} onchange={(c) => set({ color: c })} auto={course ? t('sheets.event.courseColor') : t('sheets.event.accentColor')} />
      </div>
      <div class="group-row">
        <div class="row-label">{t('sheets.event.location')}</div>
        <label class="field place">
          <Icon name="map-pin" size={14} stroke={2} />
          <input value={form.location} placeholder={t('sheets.event.locationPlaceholder')} spellcheck="false" oninput={(e) => set({ location: e.currentTarget.value }, { typing: true })} />
        </label>
      </div>
    </div>

    {#if existing}
      <div class="group tags-group">
        <div class="group-row">
          <div class="row-label">{t('common.tags')}</div>
          <TagRow table="events" id={existing.id} compact />
        </div>
      </div>
    {/if}

    <h3 class="group-title">{t('common.notes')}</h3>
    <div class="group">
      <div class="group-row stack">
        <textarea class="field" value={form.notes} placeholder={t('sheets.event.notesPlaceholder')} oninput={(e) => set({ notes: e.currentTarget.value }, { typing: true })}></textarea>
      </div>
      {#if sessionDate}
        <div class="group-row">
          <div class="row-label">
            {t('sheets.event.notesFor', { date: formatDate(sessionDate, { weekday: 'short', month: 'short', day: 'numeric' }) })}
            <small>{sessionNotes ? t('sheets.event.sessionNotesSaved') : t('sheets.event.sessionNotesNone')}</small>
          </div>
          {#if sessionNotes}
            <button class="btn small raised" onclick={() => void planner.takeNotes(sessionEvent!, sessionDate)}>
              {#if sessionNotes.icon}<span>{sessionNotes.icon}</span>{:else}<Icon name="page" size={14} />{/if}
              <span class="page-name">{sessionNotes.title || t('common.untitled')}</span>
              <Icon name="arrow-right" size={13} stroke={2} />
            </button>
          {:else}
            <button class="btn small raised" onclick={() => void planner.takeNotes(sessionEvent!, sessionDate)}><Icon name="note" size={14} /> {t('sheets.takeNotes')}</button>
          {/if}
        </div>
      {/if}
      {#if !sessionDate || (scope === 'all' && !split)}
        <div class="group-row">
          <div class="row-label">
            {isSession ? t('sheets.event.seriesNotesPage') : t('sheets.notesPage')}
            <small>{page && !page.deletedAt ? t('sheets.event.notesPageLinked') : t('sheets.event.notesPageNone')}</small>
          </div>
          {#if page && !page.deletedAt}
            <button class="btn small raised" onclick={notesPage}>
              {#if page.icon}<span><PageIcon icon={page.icon} /></span>{:else}<Icon name="page" size={14} />{/if}
              <span class="page-name">{page.title || t('common.untitled')}</span>
              <Icon name="arrow-right" size={13} stroke={2} />
            </button>
          {:else}
            <button class="btn small raised" onclick={notesPage}><Icon name="page-plus" size={14} /> {t('sheets.createPage')}</button>
          {/if}
        </div>
      {/if}
    </div>

    {#if existing}<Backlinks id={existing.id} inSheet />{/if}
  </div>

  <footer class="modal-foot">
    {#if existing && isSession && !split}
      <span>{repeatSentence(existing.repeat, existing.repeatUntil)}</span>
      <div class="actions">
        <button class="btn small destructive" onclick={() => planner.skipDate(existing.id, date!)}>{t('sheets.event.deleteThis')}</button>
        <button class="btn small destructive" onclick={() => planner.trash('events', existing.id)}>{t('sheets.event.deleteSeries')}</button>
        <button class="btn small primary" onclick={close}>{t('common.actions.done')}</button>
      </div>
    {:else if existing}
      <span>
        {#if split}{t('sheets.event.changedSeparately')}{:else if form.repeat !== 'none'}{repeatSentence(form.repeat, form.repeatUntil)}{:else}{createdText(existing.createdAt)}{/if}
      </span>
      <div class="actions">
        <button class="btn small destructive" onclick={() => planner.trash('events', existing.id)}>{t('common.actions.moveToTrash')}</button>
        <button class="btn small primary" onclick={close}>{t('common.actions.done')}</button>
      </div>
    {:else}
      <span>{t('sheets.event.showsInCalendar')}</span>
      <div class="actions">
        <button class="btn small" onclick={() => (ui.eventSheet = null)}>{t('common.actions.cancel')}</button>
        <button class="btn small primary" onclick={add}>{t('sheets.event.add')}</button>
      </div>
    {/if}
  </footer>
</Modal>

<style>
  .swatch {
    flex: none;
    /* 4 + 12 + 4 = the 20px check in the assignment sheet, so titles line up. */
    width: 12px;
    height: 12px;
    margin: 0 4px;
    border-radius: 50%;
    background: var(--c);
  }
  .title {
    flex: 1;
    min-width: 0;
    height: 36px;
    border: none;
    background: transparent;
    font-size: 17px;
    font-weight: var(--fw-650);
    letter-spacing: -0.016em;
    color: var(--text);
  }
  .tags-group {
    margin-top: 8px;
  }
  .when {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .field.date {
    width: 148px;
  }
  .field.time {
    width: 128px;
  }
  .field.place {
    width: 260px;
    color: var(--text-3);
  }
  .field.place input {
    color: var(--text);
  }
  .picker {
    gap: 8px;
  }
  .picker :global(svg) {
    color: var(--text-3);
  }
  .muted {
    color: var(--text-3);
  }
  .page-name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
