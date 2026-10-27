<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { shortcuts } from '../shortcuts.svelte';
  import { importCalendar } from '../ics-import.svelte';
  import Icon from '../components/Icon.svelte';
  import AssignmentRow from '../ui/AssignmentRow.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import EventRow from '../ui/EventRow.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import MonthGrid from './MonthGrid.svelte';
  import WeekGrid from './WeekGrid.svelte';
  import { calendar, itemsByDay } from '../calendar.svelte';
  import { clock } from '../clock.svelte';
  import {
    formatTime,
    addDays,
    addMonths,
    formatMonth,
    fromMinutes,
    minutes,
    parseDate,
    startOfMonth,
    startOfWeek,
    toISODate,
  } from '../dates';
  import { planner } from '../planner.svelte';
  import { prefs, type CalendarMode } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import { fmt } from '../i18n/format';

  const modes: { value: CalendarMode; label: string }[] = [
    { value: 'month', label: t('planner.calendar.mode.month') },
    { value: 'week', label: t('planner.calendar.mode.week') },
  ];

  const weeks = $derived.by(() => {
    const first = startOfMonth(calendar.cursor);
    const start = startOfWeek(first, prefs.weekStart);
    // As many rows as the month needs (4–6), like a wall calendar.
    const nextMonth = addMonths(first, 1);
    const rows: string[][] = [];
    for (let day = start; day < nextMonth; day = addDays(day, 7)) {
      rows.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
    }
    return rows;
  });
  const weekDays = $derived.by(() => {
    const start = startOfWeek(calendar.cursor, prefs.weekStart);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  });

  const title = $derived.by(() => {
    if (prefs.calendarMode === 'month') return formatMonth(calendar.cursor);
    // Same month: compared by date ("2026-10"), not by its written name.
    if (weekDays[0].slice(0, 7) === weekDays[6].slice(0, 7)) return formatMonth(weekDays[0]);
    const short = (iso: string) => fmt.date(parseDate(iso), { month: 'short' });
    return { month: t('planner.dates.range', { from: short(weekDays[0]), to: short(weekDays[6]) }), year: formatMonth(weekDays[6]).year };
  });

  const range = $derived(
    prefs.calendarMode === 'month'
      ? [startOfMonth(calendar.cursor), addDays(addMonths(startOfMonth(calendar.cursor), 1), -1)]
      : [weekDays[0], weekDays[6]],
  );
  const summary = $derived.by(() => {
    const days = itemsByDay(range[0], range[1]);
    const events = new Set<string>();
    let due = 0;
    for (const d of days.values()) {
      for (const o of [...d.allDay, ...d.timed]) events.add(o.key);
      due += d.due.filter((a) => a.status !== 'done').length;
    }
    if (!events.size && !due) return prefs.calendarMode === 'month' ? t('planner.calendar.nothingThisMonth') : t('planner.calendar.nothingThisWeek');
    const parts = [];
    if (events.size) parts.push(t('planner.calendar.events', { count: events.size }));
    if (due) parts.push(t('planner.calendar.assignmentsDue', { count: due }));
    return parts.join(' · ');
  });

  // The selected day's agenda.
  const day = $derived(itemsByDay(calendar.selected, calendar.selected).get(calendar.selected));
  const dayPages = $derived(
    store.all
      .filter((p) => !p.deletedAt && p.kind !== 'database' && !store.isRow(p))
      .filter((p) => toISODate(new Date(p.createdAt)) === calendar.selected || toISODate(new Date(p.updatedAt)) === calendar.selected)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8),
  );
  const occurrencesForDay = $derived(day ? [...day.allDay, ...day.timed] : []);
  const isEmptyDay = $derived(!occurrencesForDay.length && !day?.due.length && !day?.rows.length && !dayPages.length);

  function step(dir: 1 | -1) {
    if (prefs.calendarMode === 'month') {
      calendar.cursor = addMonths(startOfMonth(calendar.cursor), dir);
    } else {
      calendar.cursor = addDays(calendar.cursor, dir * 7);
      calendar.selected = addDays(calendar.selected, dir * 7);
    }
  }

  function today() {
    calendar.cursor = clock.today;
    calendar.selected = clock.today;
  }

  function newEvent(date = calendar.selected, time = '09:00') {
    const end = Math.min(minutes(time) + 60, 23 * 60 + 59);
    planner.newEvent({ startDate: date, endDate: date, startTime: time, endTime: fromMinutes(end) });
  }

  function newMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: t('planner.newEvent'), icon: 'calendar', action: () => newEvent() },
        { label: t('planner.newAssignment'), icon: 'assignment', action: () => planner.newAssignment({ dueDate: calendar.selected }) },
      ],
      { alignRight: true },
    );
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || ui.anyModalOpen || ui.menu) return;
    const id = shortcuts.match(e, ['calendarPrev', 'calendarNext', 'calendarToday']);
    if (!id) return;
    // A plain key belongs to whatever is being typed in.
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain && (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    if (id === 'calendarPrev') step(-1);
    else if (id === 'calendarNext') step(1);
    else today();
  }

  const selectedDate = $derived(parseDate(calendar.selected));
</script>

<svelte:window onkeydown={onKey} />

<div class="view wide cal">
  <header class="view-head">
    <div>
      <h1 class="view-title"
        ><Rich key="planner.calendar.title" params={{ month: title.month, year: title.year }}
          >{#snippet year(text: string)}<span class="year">{text}</span>{/snippet}</Rich
        ></h1
      >
      <p class="view-sub">{summary}</p>
    </div>
    <div class="view-actions">
      <Segmented options={modes} value={prefs.calendarMode} onchange={(v) => (prefs.calendarMode = v)} label={t('planner.calendar.modeLabel')} />
      <div class="nav">
        <button
          class="icon-btn"
          onclick={() => step(-1)}
          data-tip={prefs.calendarMode === 'month' ? t('planner.calendar.previousMonth') : t('planner.calendar.previousWeek')}
          data-tip-key={shortcuts.label('calendarPrev')}
        >
          <Icon name="chevron-left" />
        </button>
        <button class="btn small today-btn" onclick={today} data-tip-key={shortcuts.label('calendarToday')} data-tip={t('planner.calendar.goToToday')}
          >{t('planner.calendar.today')}</button
        >
        <button
          class="icon-btn"
          onclick={() => step(1)}
          data-tip={prefs.calendarMode === 'month' ? t('planner.calendar.nextMonth') : t('planner.calendar.nextWeek')}
          data-tip-key={shortcuts.label('calendarNext')}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
      <button class="btn raised import-btn" onclick={importCalendar} data-tip={t('planner.calendar.importTip')}
        ><Icon name="download" size={15} /> {t('planner.calendar.import')}</button
      >
      <button class="btn primary" onclick={() => newEvent()}><Icon name="plus" size={15} stroke={2.2} /> {t('planner.newEvent')}</button>
    </div>
  </header>

  {#if !planner.events.some((e) => !e.deletedAt)}
    <div class="first-run">
      <Icon name="calendar" size={18} />
      <div class="grow">
        <strong>{t('planner.calendar.firstRunTitle')}</strong>
        <span>{t('planner.calendar.firstRunText')}</span>
      </div>
      <button class="btn primary" onclick={importCalendar}><Icon name="download" size={15} /> {t('planner.calendar.importIcs')}</button>
      <button class="btn raised" onclick={() => newEvent()}>{t('planner.calendar.addClass')}</button>
    </div>
  {/if}

  <div class="body" class:week={prefs.calendarMode === 'week'}>
    <div class="grid-wrap">
      {#if prefs.calendarMode === 'month'}
        <MonthGrid {weeks} month={calendar.cursor.slice(0, 7)} onnew={(d) => newEvent(d)} />
      {:else}
        {#key weekDays[0]}
          <WeekGrid days={weekDays} onnew={(d, time) => newEvent(d, time)} />
        {/key}
      {/if}
    </div>

    {#if prefs.calendarMode === 'month'}
      <aside class="panel" aria-label={t('planner.calendar.selectedDay')}>
        <div class="panel-head">
          <div>
            <div class="eyebrow">{calendar.selected === clock.today ? t('common.today') : fmt.date(selectedDate, { weekday: 'long' })}</div>
            <h2>{fmt.date(selectedDate, { month: 'long', day: 'numeric' })}</h2>
          </div>
          <button class="icon-btn" onclick={newMenu} data-tip={t('planner.calendar.addToDay')}><Icon name="plus" /></button>
        </div>

        {#if day?.due.length}
          <h3 class="group-title">{t('planner.calendar.due')}</h3>
          <div class="group">
            {#each day.due as a (a.id)}
              <AssignmentRow {a} compact />
            {/each}
          </div>
        {/if}

        {#if occurrencesForDay.length}
          <h3 class="group-title">{t('planner.calendar.eventsHeading')}</h3>
          <div class="group">
            {#each occurrencesForDay as occ (occ.key)}
              <EventRow {occ} day={calendar.selected} />
            {/each}
          </div>
        {/if}

        {#if day?.rows.length}
          <h3 class="group-title">{t('planner.calendar.fromDatabases')}</h3>
          <div class="group">
            {#each day.rows as r (r.key)}
              {@const p = store.byId.get(r.row.id)}
              <button class="group-row page-row" onclick={() => store.open(r.row.id)}>
                <span class="page-icon">{#if p?.icon}<PageIcon icon={p.icon} />{:else}<span class="square" style:--c={r.color}></span>{/if}</span>
                <span class="page-title">{p?.title || t('common.untitled')}</span>
                <span class="page-meta">{r.time ? `${formatTime(r.time)} · ` : ''}{store.byId.get(r.dbId)?.title || t('planner.calendar.untitledDatabase')}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if dayPages.length}
          <h3 class="group-title">{t('planner.calendar.pages')}</h3>
          <div class="group">
            {#each dayPages as p (p.id)}
              <button class="group-row page-row" onclick={() => store.open(p.id)}>
                <span class="page-icon">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name="page" size={16} />{/if}</span>
                <span class="page-title">{p.title || t('common.untitled')}</span>
                <span class="page-meta">{toISODate(new Date(p.createdAt)) === calendar.selected ? t('planner.calendar.created') : t('planner.calendar.edited')}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if isEmptyDay}
          <EmptyState compact icon="calendar" title={t('planner.calendar.nothingScheduled')} text={t('planner.calendar.emptyDayText')}>
            <button class="btn small" onclick={() => newEvent()}>{t('planner.calendar.newEventShort')}</button>
            <button class="btn small" onclick={() => planner.newAssignment({ dueDate: calendar.selected })}>{t('planner.calendar.newAssignmentShort')}</button>
          </EmptyState>
        {/if}
      </aside>
    {/if}
  </div>
</div>

<style>
  .cal {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 600px;
    padding-top: 36px;
    padding-bottom: 28px;
    padding-left: clamp(20px, calc(var(--pane-w, 100vw) * 0.04), 48px);
    padding-right: clamp(20px, calc(var(--pane-w, 100vw) * 0.04), 48px);
  }
  .year {
    font-weight: var(--fw-400);
    color: var(--text-3);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .today-btn {
    background: var(--fill);
  }
  .first-run {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 14px;
    padding: 12px 16px;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 1px var(--hairline);
    font-size: var(--fs-ui);
  }
  .first-run :global(.icon) {
    flex: none;
    color: var(--text-2);
  }
  .first-run .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .first-run span {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .first-run .btn {
    flex: none;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 24px;
  }
  .grid-wrap {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .panel {
    flex: none;
    width: 292px;
    overflow-y: auto;
    margin-right: -6px;
    padding-right: 6px;
  }
  .panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0 0 4px 4px;
  }
  .panel-head h2 {
    margin: 2px 0 0;
    font-size: 20px;
    font-weight: var(--fw-650);
    letter-spacing: -0.018em;
  }
  .page-row {
    width: 100%;
    gap: 12px;
    min-height: 44px;
    padding: 6px 12px;
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .page-row:hover {
    background: var(--fill);
  }
  .page-row:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .page-row:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .page-icon {
    display: grid;
    place-items: center;
    width: 20px;
    font-size: 15px;
    color: var(--text-3);
  }
  .square {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--c);
  }
  .page-title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .page-meta {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }

  /* The day panel goes under the month when the pane is narrow (pane-size.ts). */
  :global([data-below-820]) .cal:has(.body:not(.week)) {
    height: auto;
  }
  :global([data-below-820]) .body:not(.week) {
    flex-direction: column;
  }
  :global([data-below-820]) .body:not(.week) .grid-wrap {
    flex: none;
    height: 620px;
  }
  :global([data-below-820]) .panel {
    width: auto;
    overflow: visible;
    margin: 0;
    padding: 0 0 24px;
  }

</style>
