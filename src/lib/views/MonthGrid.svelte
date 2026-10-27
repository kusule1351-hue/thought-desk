<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { calendar, itemsByDay, type DayItems, type RowItem } from '../calendar.svelte';
  import { store } from '../store.svelte';
  import { clock } from '../clock.svelte';
  import { formatTime, parseDate, weekdayNames } from '../dates';
  import { assignmentMenuItems, eventMenuItems } from '../item-actions';
  import { planner } from '../planner.svelte';
  import { prefs } from '../prefs.svelte';
  import { ui } from '../ui.svelte';
  import type { Occurrence } from '../dates';
  import type { Assignment } from '../types';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  let { weeks, month, onnew }: { weeks: string[][]; month: string; onnew: (day: string) => void } = $props();

  const MAX = 3;
  const names = $derived(weekdayNames(prefs.weekStart, 'short'));
  const days = $derived(itemsByDay(weeks[0][0], weeks[weeks.length - 1][6]));
  const empty: DayItems = { allDay: [], timed: [], due: [], rows: [] };
  let over = $state<string | null>(null);

  type Entry = { kind: 'allDay' | 'timed'; occ: Occurrence } | { kind: 'due'; a: Assignment } | { kind: 'row'; r: RowItem };
  function entries(day: string): Entry[] {
    const d = days.get(day) ?? empty;
    return [
      ...d.allDay.map((occ) => ({ kind: 'allDay' as const, occ })),
      ...d.due.map((a) => ({ kind: 'due' as const, a })),
      ...d.rows.map((r) => ({ kind: 'row' as const, r })),
      ...d.timed.map((occ) => ({ kind: 'timed' as const, occ })),
    ];
  }

  function dragStart(e: DragEvent, kind: 'event' | 'assignment' | 'row', id: string, from: string, session?: string, prop?: string) {
    if (!e.dataTransfer) {
      e.preventDefault();
      return;
    }
    calendar.drag = { kind, id, from, session, prop };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function menu(e: MouseEvent, items: ReturnType<typeof eventMenuItems>) {
    e.preventDefault();
    e.stopPropagation();
    ui.openMenu({ x: e.clientX, y: e.clientY, items });
  }
</script>

<div class="month" style:--rows={weeks.length}>
  <div class="names">
    {#each names as n}<div class="name">{n}</div>{/each}
  </div>
  <div class="cells" role="grid" aria-label={t('planner.calendar.monthGrid')}>
    {#each weeks as week, w (week[0])}
      {#each week as day, i (day)}
        {@const list = entries(day)}
        {@const inMonth = day.startsWith(month)}
        {@const weekend = parseDate(day).getDay() % 6 === 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="cell"
          class:out={!inMonth}
          class:weekend
          class:selected={calendar.selected === day}
          class:over={over === day}
          class:last-col={i === 6}
          class:last-row={w === weeks.length - 1}
          role="gridcell"
          tabindex="-1"
          aria-selected={calendar.selected === day}
          onclick={() => (calendar.selected = day)}
          ondblclick={(e) => e.target === e.currentTarget && onnew(day)}
          ondragover={(e) => {
            if (!calendar.drag) return;
            e.preventDefault();
            over = day;
          }}
          ondragleave={() => over === day && (over = null)}
          ondrop={(e) => {
            e.preventDefault();
            over = null;
            calendar.drop(day);
          }}
        >
          <span class="num round" class:today={day === clock.today}>{fmt.number(parseDate(day).getDate())}</span>
          {#each list.slice(0, list.length > MAX ? MAX - 1 : MAX) as it (it.kind === 'due' ? `a:${it.a.id}` : it.kind === 'row' ? `r:${it.r.key}` : `${it.kind}:${it.occ.key}`)}
            {#if it.kind === 'row'}
              {@const page = store.byId.get(it.r.row.id)}
              <button
                class="item row"
                style:--c={it.r.color}
                draggable="true"
                ondragstart={(e) => dragStart(e, 'row', it.r.row.id, day, undefined, it.r.propId)}
                ondragend={() => (calendar.drag = null)}
                onclick={(e) => {
                  e.stopPropagation();
                  store.open(it.r.row.id);
                }}
                data-tip={store.byId.get(it.r.dbId)?.title}
              >
                <span class="square"></span>
                <span class="label">{#if page?.icon}<PageIcon icon={page.icon} />&nbsp;{/if}{page?.title || t('common.untitled')}</span>
                {#if it.r.time}<span class="time">{formatTime(it.r.time)}</span>{/if}
              </button>
            {:else if it.kind === 'due'}
              <button
                class="item due"
                class:done={it.a.status === 'done'}
                style:--c={planner.courseColor(it.a.courseId)}
                draggable="true"
                ondragstart={(e) => dragStart(e, 'assignment', it.a.id, day)}
                ondragend={() => (calendar.drag = null)}
                onclick={(e) => {
                  e.stopPropagation();
                  calendar.selected = day;
                  planner.openAssignment(it.a.id);
                }}
                oncontextmenu={(e) => menu(e, assignmentMenuItems(it.a.id))}
              >
                <span class="ring round"></span>
                <span class="label">{it.a.title || t('common.untitled')}</span>
              </button>
            {:else}
              {@const ev = it.occ.event}
              <button
                class="item"
                class:pill={it.kind === 'allDay'}
                class:starts={it.kind === 'allDay' && day === it.occ.start}
                class:ends={it.kind === 'allDay' && day === it.occ.end}
                style:--c={planner.eventColor(ev)}
                draggable="true"
                ondragstart={(e) => dragStart(e, 'event', ev.id, day, it.occ.start)}
                ondragend={() => (calendar.drag = null)}
                onclick={(e) => {
                  e.stopPropagation();
                  calendar.selected = day;
                  planner.openEvent(ev.id, it.occ.start);
                }}
                oncontextmenu={(e) => menu(e, eventMenuItems(ev.id, it.occ.start))}
              >
                {#if it.kind === 'timed'}<span class="dot" style:--dot="var(--c)"></span>{/if}
                <span class="label">{ev.title || t('planner.untitledEvent')}</span>
                {#if it.kind === 'timed'}<span class="time">{formatTime(ev.startTime ?? '00:00')}</span>{/if}
              </button>
            {/if}
          {/each}
          {#if list.length > MAX}
            <button
              class="more"
              onclick={(e) => {
                e.stopPropagation();
                calendar.selected = day;
              }}>{t('planner.calendar.more', { count: list.length - MAX + 1 })}</button
            >
          {/if}
        </div>
      {/each}
    {/each}
  </div>
</div>

<style>
  .month {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }
  .names {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    flex: none;
  }
  .name {
    padding: 0 10px 8px;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-3);
    text-align: right;
  }
  .cells {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: repeat(var(--rows), minmax(96px, 1fr));
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .cell {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 4px 4px 6px;
    border-right: 1px solid var(--separator);
    border-bottom: 1px solid var(--separator);
    outline: none;
    overflow: hidden;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .cell.last-col {
    border-right: none;
  }
  .cell.last-row {
    border-bottom: none;
  }
  .cell.weekend {
    background: color-mix(in srgb, var(--fill) 45%, transparent);
  }
  .cell.selected {
    background: var(--fill);
  }
  .cell.over {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .num {
    align-self: flex-end;
    display: grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    margin-bottom: 1px;
    border-radius: 12px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .out .num {
    color: var(--text-4);
  }
  .num.today {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: var(--fw-650);
  }

  .item {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    height: 20px;
    padding: 0 6px;
    border-radius: 5px;
    font-size: var(--fs-footnote);
    color: var(--text);
    text-align: left;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .item:hover {
    background: var(--fill-2);
  }
  .out .item {
    opacity: 0.6;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time {
    flex: none;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  /* Narrow days keep the title and drop the time. */
  .cell {
    container-type: inline-size;
  }
  @container (max-width: 150px) {
    .time {
      display: none;
    }
  }
  /* All-day and multi-day events: a tinted bar that joins across days. */
  .pill {
    background: color-mix(in srgb, var(--c) 18%, transparent);
    color: color-mix(in srgb, var(--c) 62%, var(--text));
    font-weight: var(--fw-550);
    border-radius: 0;
    margin: 0 -5px;
    width: calc(100% + 10px);
    padding: 0 11px;
  }
  .pill.starts {
    margin-left: 0;
    width: calc(100% + 5px);
    padding-left: 6px;
    border-top-left-radius: 5px;
    border-bottom-left-radius: 5px;
  }
  .pill.ends {
    margin-right: 0;
    width: calc(100% + 5px);
    border-top-right-radius: 5px;
    border-bottom-right-radius: 5px;
  }
  .pill.starts.ends {
    width: 100%;
  }
  .pill:hover {
    background: color-mix(in srgb, var(--c) 28%, transparent);
  }
  .ring {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  .square {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--c);
  }
  .due.done .ring {
    background: var(--c);
  }
  .due.done .label {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .more {
    align-self: flex-start;
    height: 18px;
    padding: 0 6px;
    border-radius: 5px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-3);
  }
  .more:hover {
    background: var(--fill-2);
    color: var(--text);
  }
</style>
