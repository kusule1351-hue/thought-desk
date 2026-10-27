<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import { calendar, itemsByDay, type DayItems } from '../calendar.svelte';
  import { clock } from '../clock.svelte';
  import { formatHour, formatTime, fromMinutes, minutes, parseDate, type Occurrence } from '../dates';
  import { assignmentMenuItems, eventMenuItems } from '../item-actions';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  let { days, onnew }: { days: string[]; onnew: (day: string, time?: string) => void } = $props();

  const HOUR = 48;
  const items = $derived(itemsByDay(days[0], days[6]));
  const empty: DayItems = { allDay: [], timed: [], due: [], rows: [] };
  let scroller: HTMLDivElement;
  let overDay = $state<string | null>(null);

  onMount(() => {
    // Start around the working day, or just before now when this week is showing.
    const now = days.includes(clock.today) ? minutes(clock.time) / 60 - 1.5 : 7.5;
    scroller.scrollTop = Math.max(0, Math.min(now, 16)) * HOUR;
  });

  interface Block {
    occ: Occurrence;
    top: number;
    height: number;
    col: number;
    cols: number;
  }

  /** Positions a day's timed events, side by side where they overlap. */
  function layout(day: string): Block[] {
    const list = (items.get(day) ?? empty).timed.map((occ) => {
      const start = day === occ.start ? minutes(occ.event.startTime ?? '00:00') : 0;
      let end = day === occ.end ? minutes(occ.event.endTime ?? occ.event.startTime ?? '00:00') : 1440;
      if (end - start < 20) end = start + 20;
      return { occ, start, end, col: 0, cols: 1 };
    });
    list.sort((a, b) => a.start - b.start || b.end - a.end);
    let cluster: typeof list = [];
    let clusterEnd = -1;
    const finish = () => {
      const cols = Math.max(1, ...cluster.map((b) => b.col + 1));
      for (const b of cluster) b.cols = cols;
      cluster = [];
    };
    for (const b of list) {
      if (b.start >= clusterEnd) {
        finish();
        clusterEnd = -1;
      }
      const used = new Set(cluster.filter((c) => c.end > b.start).map((c) => c.col));
      let col = 0;
      while (used.has(col)) col++;
      b.col = col;
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.end);
    }
    finish();
    return list.map((b) => ({
      occ: b.occ,
      top: (b.start / 60) * HOUR,
      height: Math.max(((b.end - b.start) / 60) * HOUR - 2, 18),
      col: b.col,
      cols: b.cols,
    }));
  }

  /** The time under the pointer in a day column, snapped to 15 minutes. */
  function timeAt(e: MouseEvent, column: HTMLElement, snap = 15): string {
    const y = e.clientY - column.getBoundingClientRect().top;
    return fromMinutes(Math.floor(((y / HOUR) * 60) / snap) * snap);
  }

  function menu(e: MouseEvent, list: ReturnType<typeof eventMenuItems>) {
    e.preventDefault();
    e.stopPropagation();
    ui.openMenu({ x: e.clientX, y: e.clientY, items: list });
  }

  function start(e: DragEvent, kind: 'event' | 'assignment' | 'row', id: string, from: string, session?: string, prop?: string) {
    if (!e.dataTransfer) {
      e.preventDefault();
      return;
    }
    calendar.drag = { kind, id, from, session, prop };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
</script>

<div class="week">
  <div class="head">
    <div class="gutter"></div>
    {#each days as day (day)}
      {@const d = parseDate(day)}
      <button class="day-head" class:today={day === clock.today} onclick={() => (calendar.selected = day)}>
        <span class="wd">{fmt.date(d, { weekday: 'short' })}</span>
        <span class="dn round">{fmt.number(d.getDate())}</span>
      </button>
    {/each}
  </div>

  <div class="all-day">
    <div class="gutter label">{t('planner.calendar.allDay')}</div>
    {#each days as day (day)}
      {@const d = items.get(day) ?? empty}
      <div
        class="all-cell"
        class:over={overDay === `a:${day}`}
        role="gridcell"
        tabindex="-1"
        ondragover={(e) => {
          if (!calendar.drag) return;
          e.preventDefault();
          overDay = `a:${day}`;
        }}
        ondragleave={() => (overDay = null)}
        ondrop={(e) => {
          e.preventDefault();
          overDay = null;
          calendar.drop(day);
        }}
      >
        {#each d.allDay as occ (occ.key)}
          <button
            class="chip-ev pill"
            style:--c={planner.eventColor(occ.event)}
            draggable="true"
            ondragstart={(e) => start(e, 'event', occ.event.id, day, occ.start)}
            ondragend={() => (calendar.drag = null)}
            onclick={() => planner.openEvent(occ.event.id, occ.start)}
            oncontextmenu={(e) => menu(e, eventMenuItems(occ.event.id, occ.start))}>{occ.event.title || t('planner.untitledEvent')}</button
          >
        {/each}
        {#each d.rows as r (r.key)}
          {@const page = store.byId.get(r.row.id)}
          <button
            class="chip-ev row"
            style:--c={r.color}
            draggable="true"
            ondragstart={(e) => start(e, 'row', r.row.id, day, undefined, r.propId)}
            ondragend={() => (calendar.drag = null)}
            onclick={() => store.open(r.row.id)}
            data-tip={store.byId.get(r.dbId)?.title}
          >
            <span class="square"></span>
            <span class="label">{#if page?.icon}<PageIcon icon={page.icon} />&nbsp;{/if}{page?.title || t('common.untitled')}</span>
            {#if r.time}<span class="t">{formatTime(r.time)}</span>{/if}
          </button>
        {/each}
        {#each d.due as a (a.id)}
          <button
            class="chip-ev due"
            class:done={a.status === 'done'}
            style:--c={planner.courseColor(a.courseId)}
            draggable="true"
            ondragstart={(e) => start(e, 'assignment', a.id, day)}
            ondragend={() => (calendar.drag = null)}
            onclick={() => planner.openAssignment(a.id)}
            oncontextmenu={(e) => menu(e, assignmentMenuItems(a.id))}
          >
            <span class="ring round"></span>
            <span class="label">{a.title || t('common.untitled')}</span>
            {#if a.dueTime}<span class="t">{formatTime(a.dueTime)}</span>{/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <div class="scroll" bind:this={scroller}>
    <div class="grid" style:height="{24 * HOUR}px">
      <div class="gutter hours">
        {#each Array.from({ length: 24 }, (_, h) => h) as h}
          {#if h > 0}<span class="hour" style:top="{h * HOUR}px">{formatHour(h)}</span>{/if}
        {/each}
      </div>
      {#each days as day (day)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="col"
          class:today={day === clock.today}
          class:over={overDay === day}
          role="gridcell"
          tabindex="-1"
          onclick={(e) => e.target === e.currentTarget && onnew(day, timeAt(e, e.currentTarget, 30))}
          ondragover={(e) => {
            if (!calendar.drag) return;
            e.preventDefault();
            overDay = day;
          }}
          ondragleave={(e) => e.target === e.currentTarget && (overDay = null)}
          ondrop={(e) => {
            e.preventDefault();
            overDay = null;
            calendar.drop(day, timeAt(e, e.currentTarget as HTMLElement));
          }}
        >
          {#each layout(day) as b (b.occ.key)}
            {@const ev = b.occ.event}
            <button
              class="block"
              class:short={b.height < 36}
              style:--c={planner.eventColor(ev)}
              style:top="{b.top}px"
              style:height="{b.height}px"
              style:left="calc({(b.col / b.cols) * 100}% + 2px)"
              style:width="calc({100 / b.cols}% - 4px)"
              draggable="true"
              ondragstart={(e) => start(e, 'event', ev.id, day, b.occ.start)}
              ondragend={() => (calendar.drag = null)}
              onclick={() => planner.openEvent(ev.id, b.occ.start)}
              oncontextmenu={(e) => menu(e, eventMenuItems(ev.id, b.occ.start))}
            >
              <span class="b-title">{ev.title || t('planner.untitledEvent')}</span>
              <span class="b-time">{formatTime(ev.startTime ?? '00:00')}{ev.location ? ` · ${ev.location}` : ''}</span>
            </button>
          {/each}
          {#if day === clock.today}
            <div class="now" style:top="{(minutes(clock.time) / 60) * HOUR}px"></div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .week {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .head,
  .all-day,
  .grid {
    display: grid;
    grid-template-columns: 56px repeat(7, minmax(0, 1fr));
  }
  /* Match the grid below, which keeps room for its scrollbar. */
  .head,
  .all-day {
    padding-right: 12px;
  }
  .head {
    flex: none;
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .day-head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 44px;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .wd {
    font-weight: var(--fw-500);
  }
  .dn {
    display: grid;
    place-items: center;
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    border-radius: 13px;
    font-size: var(--fs-callout);
    font-weight: var(--fw-600);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .today .dn {
    background: var(--accent);
    color: var(--on-accent);
  }
  .all-day {
    flex: none;
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .gutter.label {
    padding: 6px 8px 0 0;
    text-align: right;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .all-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 32px;
    padding: 4px 3px;
    border-left: 1px solid var(--separator);
    outline: none;
  }
  .all-cell.over,
  .col.over {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .chip-ev {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    min-width: 0;
    padding: 0 6px;
    border-radius: 5px;
    font-size: var(--fs-footnote);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip-ev:hover {
    background: var(--fill-2);
  }
  .pill {
    display: block;
    background: color-mix(in srgb, var(--c) 18%, transparent);
    color: color-mix(in srgb, var(--c) 62%, var(--text));
    font-weight: var(--fw-550);
    line-height: 20px;
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
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    flex: none;
    margin-left: auto;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .all-cell {
    container-type: inline-size;
  }
  @container (max-width: 150px) {
    .t {
      display: none;
    }
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: scroll;
  }
  .grid {
    position: relative;
    /* Hour lines. */
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(48px - 1px),
      var(--separator) calc(48px - 1px),
      var(--separator) 48px
    );
    background-position: 0 0;
  }
  .hours {
    position: relative;
    background: var(--bg);
  }
  .hour {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
    font-size: var(--fs-caption);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .col {
    position: relative;
    border-left: 1px solid var(--separator);
    outline: none;
  }
  .col.today {
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }
  .block {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 3px 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--c) 20%, var(--bg));
    box-shadow: inset 3px 0 0 var(--c);
    color: color-mix(in srgb, var(--c) 55%, var(--text));
    text-align: left;
    overflow: hidden;
    z-index: 1;
    transition: filter var(--dur-fast) var(--ease);
  }
  .block:hover {
    filter: brightness(0.97) saturate(1.1);
  }
  .b-title {
    max-width: 100%;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-600);
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .b-time {
    max-width: 100%;
    font-size: var(--fs-caption);
    opacity: 0.85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .short {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding-top: 0;
    padding-bottom: 0;
  }
  .now {
    position: absolute;
    left: -1px;
    right: 0;
    height: 2px;
    background: var(--c-red);
    z-index: 2;
    pointer-events: none;
  }
  .now::before {
    content: '';
    position: absolute;
    left: -4px;
    top: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c-red);
  }
</style>
