<script lang="ts">
  /**
   * A timeline: each row a bar from its start date to its end, on a scale
   * of days, weeks, months or quarters. Drag a bar to move it, its ends to
   * change how long it runs, and click an empty lane to give a row a date.
   */
  import PageIcon from '../components/PageIcon.svelte';
  import { tick, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { databases, type CellSet } from '../databases.svelte';
  import { clock } from '../clock.svelte';
  import { colorVar } from '../colors';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t, type MessageKey } from '../i18n';
  import { fmt } from '../i18n/format';
  import { Progressive } from '../progressive.svelte';
  import { addDaysIso, pinFirst } from './query';
  import { isoDate, option, toDate } from './schema';
  import type { DateValue, DbRow, DbView, ViewConfig } from '../types';

  let { dbId, view, rows, onsettings }: { dbId: string; view: DbView; rows: DbRow[]; onsettings: () => void } = $props();

  type Scale = NonNullable<ViewConfig['scale']>;
  const PPD: Record<Scale, number> = { day: 44, week: 22, month: 6, quarter: 2.4 };
  const SCALES: Scale[] = ['day', 'week', 'month', 'quarter'];
  const SCALE_LABELS = {
    day: 'dbViews.timeline.scales.day',
    week: 'dbViews.timeline.scales.week',
    month: 'dbViews.timeline.scales.month',
    quarter: 'dbViews.timeline.scales.quarter',
  } as const satisfies Record<Scale, MessageKey>;
  const ROW_H = 36;

  const c = $derived(view.config);
  const prop = $derived(databases.prop(dbId, c.dateProp));
  const endProp = $derived(c.endProp ? databases.prop(dbId, c.endProp) : undefined);
  const editable = $derived(prop?.type === 'date' && (!endProp || endProp.type === 'date'));
  const scale = $derived<Scale>(c.scale ?? 'week');
  const ppd = $derived(PPD[scale]);
  const showTable = $derived(c.showTable !== false);

  const lazy = new Progressive(80, 150);
  /** Rows added here come first (on screen at once) until the view is left. */
  let fresh = $state<string[]>([]);
  const shown = $derived(pinFirst(rows, fresh).slice(0, lazy.limit));

  const day = (s: string) => s.slice(0, 10);
  const dayMs = 86_400_000;

  /** A row's span: first and last day, or null without a date. */
  function span(row: DbRow): { start: string; end: string } | null {
    if (!prop) return null;
    const v = databases.get(row, prop) as DateValue | null;
    if (!v) return null;
    const start = day(v.start);
    let end = day(v.end ?? v.start);
    if (endProp) {
      const e = databases.get(row, endProp) as DateValue | null;
      if (e) end = day(e.end ?? e.start);
    }
    return { start, end: end < start ? start : end };
  }

  const spans = $derived(new Map(rows.map((r) => [r.id, span(r)])));
  const undated = $derived(rows.filter((r) => !spans.get(r.id)).length);

  /** The first day shown: before the earliest bar and today, on a week or month boundary. */
  const from = $derived.by(() => {
    let min = addDaysIso(clock.today, -Math.ceil(700 / ppd));
    for (const s of spans.values()) if (s && s.start < min) min = s.start;
    min = addDaysIso(min, -7);
    const d = toDate(min);
    if (scale === 'month' || scale === 'quarter') d.setDate(1);
    else d.setDate(d.getDate() - ((d.getDay() - prefs.weekStart + 7) % 7));
    return isoDate(d);
  });
  const until = $derived.by(() => {
    let max = addDaysIso(clock.today, Math.ceil(2400 / ppd));
    for (const s of spans.values()) if (s && s.end > max) max = s.end;
    return addDaysIso(max, Math.ceil(400 / ppd));
  });
  const index = (iso: string) => Math.round((toDate(day(iso)).getTime() - toDate(from).getTime()) / dayMs);
  const count = $derived(index(until) + 1);
  const width = $derived(count * ppd);
  const todayX = $derived(index(clock.today) * ppd);

  // ----------------------------------------------------------- the header

  type Cell = { left: number; width: number; label: string; key: string };

  function cells(unit: 'day' | 'week' | 'month' | 'year' | 'quarter', labelOf: (d: Date, start: string) => string): Cell[] {
    const out: Cell[] = [];
    let cur = from;
    while (cur <= until) {
      const d = toDate(cur);
      let next: Date;
      if (unit === 'day') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      else if (unit === 'week') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 - ((d.getDay() - prefs.weekStart + 7) % 7));
      else if (unit === 'month') next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      else if (unit === 'quarter') next = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 1);
      else next = new Date(d.getFullYear() + 1, 0, 1);
      const nextIso = isoDate(next);
      const a = index(cur);
      const b = Math.min(index(nextIso), count);
      out.push({ left: a * ppd, width: (b - a) * ppd, label: labelOf(d, cur), key: cur });
      cur = nextIso;
    }
    return out;
  }

  const monthYear = (d: Date) => fmt.date(d, { month: 'long', year: 'numeric' });
  const yearLabel = (d: Date) => fmt.date(d, { year: 'numeric' });

  const header = $derived.by(() => {
    switch (scale) {
      case 'day':
        return {
          top: cells('month', monthYear),
          bottom: cells('day', (d) => t('dbViews.timeline.dayCell', { weekday: fmt.date(d, { weekday: 'narrow' }), day: d.getDate() })),
        };
      case 'week':
        return {
          top: cells('month', monthYear),
          bottom: cells('week', (d, start) => {
            const end = toDate(addDaysIso(start, 6 - ((d.getDay() - prefs.weekStart + 7) % 7)));
            return t('dbViews.timeline.weekCell', { from: d.getDate(), to: end.getDate() });
          }),
        };
      case 'month':
        return { top: cells('year', yearLabel), bottom: cells('month', (d) => fmt.date(d, { month: 'short' })) };
      case 'quarter':
        return { top: cells('year', yearLabel), bottom: cells('quarter', (d) => t('dbViews.timeline.quarter', { quarter: Math.floor(d.getMonth() / 3) + 1 })) };
    }
  });

  /** Weekends shaded on day and week scales (as a repeating background). */
  const weekendBg = $derived.by(() => {
    if (scale !== 'day' && scale !== 'week') return 'none';
    const firstDow = toDate(from).getDay();
    // Day offsets (within a week starting at `from`) of Saturday and Sunday.
    const sat = (6 - firstDow + 7) % 7;
    const sun = (7 - firstDow) % 7;
    const stops = [sat, sun]
      .sort((a, b) => a - b)
      .map((d) => `transparent ${d * ppd}px, var(--weekend) ${d * ppd}px, var(--weekend) ${(d + 1) * ppd}px, transparent ${(d + 1) * ppd}px`)
      .join(', ');
    // The pattern repeats from its first stop to its last: a whole week.
    return `repeating-linear-gradient(90deg, transparent 0px, ${stops}, transparent ${7 * ppd}px)`;
  });

  // ----------------------------------------------------------- scrolling

  let scroller = $state<HTMLDivElement>();

  function scrollToDay(iso: string, smooth = false) {
    if (!scroller) return;
    const tableW = showTable ? 260 : 0;
    scroller.scrollTo({ left: Math.max(0, index(iso) * ppd - (scroller.clientWidth - tableW) / 3), behavior: smooth ? 'smooth' : 'auto' });
  }

  $effect(() => {
    if (!scroller) return;
    untrack(() => void tick().then(() => scrollToDay(clock.today)));
  });

  /** The day in the middle of what's showing (kept when the scale changes). */
  function centerDay(): string {
    if (!scroller) return clock.today;
    const tableW = showTable ? 260 : 0;
    const x = scroller.scrollLeft + (scroller.clientWidth - tableW) / 2;
    return addDaysIso(from, Math.round(x / ppd));
  }

  async function setScale(s: Scale) {
    const mid = centerDay();
    databases.updateView(dbId, view.id, { scale: s });
    await tick();
    if (!scroller) return;
    const tableW = showTable ? 260 : 0;
    scroller.scrollLeft = Math.max(0, index(mid) * ppd - (scroller.clientWidth - tableW) / 2);
  }

  // ------------------------------------------------------------- dragging

  let drag = $state<{ id: string; mode: 'move' | 'start' | 'end'; x: number; delta: number; moved: boolean } | null>(null);

  function shown_(id: string): { start: number; end: number } | null {
    const s = spans.get(id);
    if (!s) return null;
    let a = index(s.start);
    let b = index(s.end);
    if (drag?.id === id) {
      if (drag.mode === 'move') {
        a += drag.delta;
        b += drag.delta;
      } else if (drag.mode === 'start') a = Math.min(b, a + drag.delta);
      else b = Math.max(a, b + drag.delta);
    }
    return { start: a, end: b };
  }

  function onBarDown(e: PointerEvent, row: DbRow, mode: 'move' | 'start' | 'end') {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!editable) {
      if (mode === 'move') store.open(row.id);
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = { id: row.id, mode, x: e.clientX, delta: 0, moved: false };
  }

  function onBarMove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    drag.delta = Math.round(dx / ppd);
  }

  function onBarUp(row: DbRow) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.moved) {
      if (d.mode === 'move') store.open(row.id);
      return;
    }
    if (!d.delta || !prop) return;
    const v = databases.get(row, prop) as DateValue | null;
    if (!v) return;
    const shift = (s: string, n: number) => addDaysIso(day(s), n) + s.slice(10);
    const changes: CellSet[] = [];
    if (endProp) {
      const e = databases.get(row, endProp) as DateValue | null;
      const startDelta = d.mode === 'end' ? 0 : d.mode === 'start' ? Math.min(d.delta, index(e?.start ?? v.start) - index(v.start)) : d.delta;
      const endDelta = d.mode === 'start' ? 0 : d.mode === 'end' ? Math.max(d.delta, index(v.start) - index(e?.start ?? v.start)) : d.delta;
      if (startDelta) changes.push({ row, prop, value: { start: shift(v.start, startDelta) } });
      if (endDelta) changes.push({ row, prop: endProp, value: { start: shift(e?.start ?? v.start, endDelta) } });
    } else {
      const end = v.end ?? v.start;
      const len = index(end) - index(v.start);
      const startDelta = d.mode === 'end' ? 0 : d.mode === 'start' ? Math.min(d.delta, len) : d.delta;
      const endDelta = d.mode === 'start' ? 0 : d.mode === 'end' ? Math.max(d.delta, -len) : d.delta;
      const start = shift(v.start, startDelta);
      const stop = shift(end, endDelta);
      changes.push({ row, prop, value: day(stop) > day(start) ? { start, end: stop } : { start } });
    }
    if (changes.length)
      databases.set(changes, {
        label:
          d.mode === 'move'
            ? { undone: t('dbViews.timeline.undoMove'), redone: t('dbViews.timeline.redoMove') }
            : { undone: t('dbViews.timeline.undoResize'), redone: t('dbViews.timeline.redoResize') },
      });
  }

  // A row without a date: hovering its lane shows where a click would put it.
  let ghost = $state<{ id: string; at: number } | null>(null);

  function laneDay(e: MouseEvent): number {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, Math.floor((e.clientX - r.left) / ppd));
  }

  function schedule(row: DbRow, at: number) {
    if (!prop || !editable) return;
    const start = addDaysIso(from, at);
    // On wide scales a click means a week, not a single day.
    const end = scale === 'month' || scale === 'quarter' ? addDaysIso(start, 6) : start;
    const changes: CellSet[] = endProp
      ? [
          { row, prop, value: { start } },
          { row, prop: endProp, value: { start: end } },
        ]
      : [{ row, prop, value: end > start ? { start, end } : { start } }];
    databases.set(changes, { label: { undone: t('dbViews.timeline.undoSchedule'), redone: t('dbViews.timeline.redoSchedule') } });
    ghost = null;
  }

  // ---------------------------------------------------------------- adding

  let naming = $state<string | null>(null);

  async function add() {
    if (!prop || !editable) {
      const row = await databases.addRow(dbId, { view });
      if (row) store.open(row.id);
      return;
    }
    const cells = endProp ? { [prop.id]: { start: clock.today }, [endProp.id]: { start: addDaysIso(clock.today, 2) } } : { [prop.id]: { start: clock.today, end: addDaysIso(clock.today, 2) } };
    const row = await databases.addRow(dbId, { view, cells });
    if (!row) return;
    fresh = [row.id, ...fresh];
    naming = row.id;
    scrollToDay(clock.today, true);
  }

  function nameInput(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  function commitName(row: DbRow, el: HTMLInputElement) {
    if (naming !== row.id) return;
    naming = null;
    if (el.value !== (store.byId.get(row.id)?.title ?? '')) store.update(row.id, { title: el.value.trim() });
  }

  /** A colour for a row: its first choice's colour, if it has one. */
  const tint = (row: DbRow): string | undefined => {
    for (const p of databases.props(dbId)) {
      if (p.type !== 'select' && p.type !== 'status') continue;
      const o = option(p, databases.get(row, p));
      if (o) return colorVar(o.color);
    }
    return undefined;
  };

  const dayLabel = (iso: string) => fmt.date(toDate(iso), { month: 'short', day: 'numeric' });
  function describe(id: string): string {
    const s = shown_(id);
    if (!s) return '';
    const a = dayLabel(addDaysIso(from, s.start));
    if (s.end === s.start) return a;
    return t('dbViews.timeline.span', { from: a, to: dayLabel(addDaysIso(from, s.end)), count: s.end - s.start + 1 });
  }
</script>

{#if !prop}
  <div class="setup">
    <p>{t('dbViews.timeline.setupHint')}</p>
    <button class="btn small raised" onclick={onsettings}><Icon name="sliders" size={14} /> {t('dbViews.chooseDate')}</button>
  </div>
{:else}
  <div class="tl" style:--ppd="{ppd}px" style:--row-h="{ROW_H}px" style:--label-left="{showTable ? 268 : 8}px">
    <div class="bar">
      <Segmented
        label={t('dbViews.timeline.scale')}
        value={scale}
        options={SCALES.map((value) => ({ value, label: t(SCALE_LABELS[value]) }))}
        onchange={(s) => void setScale(s as Scale)}
      />
      <span class="grow"></span>
      {#if undated}<span class="undated">{t('dbViews.timeline.undated', { count: undated })}</span>{/if}
      <button class="btn small raised" onclick={() => scrollToDay(clock.today, true)}>{t('dbViews.today')}</button>
    </div>

    <div class="scroller" bind:this={scroller}>
      <div class="canvas" style:width="{(showTable ? 260 : 0) + width}px">
        <!-- Header -->
        <div class="head">
          {#if showTable}<div class="corner">{endProp ? t('dbViews.timeline.dateColumns', { start: prop.name, end: endProp.name }) : prop.name}</div>{/if}
          <div class="scale" style:width="{width}px">
            <div class="line top">
              {#each header.top as h (h.key)}<div class="hc" style:left="{h.left}px" style:width="{h.width}px"><span>{h.label}</span></div>{/each}
            </div>
            <div class="line bottom">
              {#each header.bottom as h (h.key)}
                <div class="hc" class:today={scale === 'day' && h.key === clock.today} style:left="{h.left}px" style:width="{h.width}px"><span>{h.label}</span></div>
              {/each}
            </div>
          </div>
        </div>

        <!-- Rows -->
        <div class="rows" style:--weekends={weekendBg}>
          <div class="grid-bg" style:left="{showTable ? 260 : 0}px" style:width="{width}px">
            {#each header.bottom as h (h.key)}<div class="vline" style:left="{h.left}px"></div>{/each}
            <div class="today-line" style:left="{todayX + ppd / 2}px"></div>
          </div>
          {#each shown as row (row.id)}
            {@const page = store.byId.get(row.id)}
            {@const s = shown_(row.id)}
            <div class="tr" class:dragging={drag?.id === row.id}>
              {#if showTable}
                <div class="title-cell">
                  {#if naming === row.id}
                    <input
                      class="name-input"
                      value={page?.title ?? ''}
                      placeholder={t('common.untitled')}
                      {@attach nameInput}
                      onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
                      }}
                      onblur={(e) => commitName(row, e.currentTarget as HTMLInputElement)}
                      aria-label={t('dbViews.titleField')}
                    />
                  {:else}
                    <button class="title" onclick={() => store.open(row.id)} ondblclick={() => (naming = row.id)}>
                      {#if page?.icon}<span class="emoji"><PageIcon icon={page.icon} /></span>{:else}<Icon name="page" size={14} />{/if}
                      <span class="t" class:untitled={!page?.title}>{page?.title || t('common.untitled')}</span>
                    </button>
                    {#if s}
                      <button class="jump" onclick={() => scrollToDay(addDaysIso(from, s.start), true)} aria-label={t('dbViews.timeline.showOnTimeline')} data-tip={t('dbViews.timeline.showOnTimeline')}><Icon name="arrow-right" size={12} /></button>
                    {/if}
                  {/if}
                </div>
              {/if}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div
                class="lane"
                style:width="{width}px"
                onmousemove={(e) => !s && editable && (ghost = { id: row.id, at: laneDay(e) })}
                onmouseleave={() => ghost?.id === row.id && (ghost = null)}
                onclick={(e) => !s && schedule(row, laneDay(e))}
              >
                {#if s}
                  {@const w = Math.max(ppd, (s.end - s.start + 1) * ppd)}
                  <div
                    class="b"
                    class:narrow={w < 72}
                    class:fixed={!editable}
                    style:left="{s.start * ppd}px"
                    style:width="{w}px"
                    style:--tint={tint(row)}
                    role="button"
                    tabindex="0"
                    aria-label={t('dbViews.timeline.bar', { title: page?.title || t('common.untitled'), dates: describe(row.id) })}
                    data-tip={drag?.id === row.id ? undefined : describe(row.id)}
                    onpointerdown={(e) => onBarDown(e, row, 'move')}
                    onpointermove={onBarMove}
                    onpointerup={() => onBarUp(row)}
                    onpointercancel={() => (drag = null)}
                    onkeydown={(e) => e.key === 'Enter' && store.open(row.id)}
                  >
                    {#if editable}
                      <span class="grip left" onpointerdown={(e) => onBarDown(e, row, 'start')} onpointermove={onBarMove} onpointerup={() => onBarUp(row)}></span>
                    {/if}
                    <span class="b-label">{page?.icon ? `${page.icon} ` : ''}{page?.title || t('common.untitled')}</span>
                    {#if editable}
                      <span class="grip right" onpointerdown={(e) => onBarDown(e, row, 'end')} onpointermove={onBarMove} onpointerup={() => onBarUp(row)}></span>
                    {/if}
                  </div>
                  {#if drag?.id === row.id}
                    <span class="drag-note" style:left="{(s.end + 1) * ppd + 8}px">{describe(row.id)}</span>
                  {/if}
                {:else if ghost?.id === row.id}
                  <div class="ghost" style:left="{ghost.at * ppd}px" style:width="{Math.max(ppd, scale === 'month' || scale === 'quarter' ? 7 * ppd : ppd)}px"></div>
                {/if}
              </div>
            </div>
          {/each}
          {#if shown.length < rows.length}<div class="more" {@attach lazy.more}></div>{/if}
        </div>
      </div>
    </div>
    <button class="add-row" onclick={add}><Icon name="plus" size={14} /> {t('common.actions.new')}</button>
    {#if !rows.length}
      <p class="empty">{databases.rowsOf(dbId).length ? t('dbViews.timeline.noMatches') : t('dbViews.timeline.empty')}</p>
    {/if}
  </div>
{/if}

<style>
  .tl {
    --weekend: color-mix(in srgb, var(--text) 3%, transparent);
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .grow {
    flex: 1;
  }
  .undated {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .scroller {
    overflow-x: auto;
    overflow-y: hidden;
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--separator);
    overscroll-behavior-x: contain;
  }
  .canvas {
    position: relative;
  }
  .head {
    position: relative;
    display: flex;
    height: 48px;
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .corner {
    position: sticky;
    left: 0;
    z-index: 3;
    flex: none;
    width: 260px;
    padding: 0 12px;
    display: flex;
    align-items: flex-end;
    padding-bottom: 7px;
    background: var(--bg);
    box-shadow:
      inset -1px 0 0 var(--separator),
      inset 0 -1px 0 var(--separator);
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-3);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .scale {
    position: relative;
    flex: none;
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    height: 24px;
  }
  .line.top {
    top: 0;
  }
  .line.bottom {
    top: 24px;
  }
  .hc {
    position: absolute;
    top: 0;
    height: 24px;
    display: flex;
    align-items: center;
    padding: 0 6px;
    /* Clipped without becoming a scroll box, so labels can stick. */
    overflow: clip;
    white-space: nowrap;
    font-size: var(--fs-caption);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .line.top .hc {
    font-weight: var(--fw-600);
    color: var(--text-2);
  }
  .line.top .hc span {
    position: sticky;
    left: var(--label-left);
  }
  .line.bottom .hc {
    box-shadow: inset 1px 0 0 var(--separator);
    justify-content: center;
    padding: 0 2px;
  }
  .hc.today {
    color: var(--danger);
    font-weight: var(--fw-650);
  }
  .rows {
    position: relative;
  }
  .grid-bg {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--weekends);
    pointer-events: none;
  }
  .vline {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--separator);
    opacity: 0.6;
  }
  .today-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--danger);
    opacity: 0.8;
    z-index: 1;
  }
  .tr {
    position: relative;
    display: flex;
    height: var(--row-h);
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--separator) 60%, transparent);
  }
  .title-cell {
    position: sticky;
    left: 0;
    z-index: 2;
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    width: 260px;
    padding: 0 4px 0 6px;
    background: var(--bg);
    box-shadow:
      inset -1px 0 0 var(--separator),
      inset 0 -1px 0 color-mix(in srgb, var(--separator) 60%, transparent);
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 6px;
    border-radius: var(--r-xs);
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    text-align: left;
  }
  .title :global(.icon) {
    color: var(--text-3);
  }
  .title:hover {
    background: var(--fill);
  }
  .t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t.untitled {
    color: var(--text-3);
  }
  .emoji {
    flex: none;
    width: 16px;
    text-align: center;
    font-size: 14px;
  }
  .jump {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
  }
  .tr:hover .jump {
    opacity: 1;
  }
  .jump:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .name-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    border: none;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow: 0 0 0 2px var(--accent);
    font: inherit;
    font-size: var(--fs-body-ui);
    color: var(--text);
    outline: none;
  }
  .lane {
    position: relative;
    flex: none;
    height: 100%;
  }
  .b {
    position: absolute;
    top: 6px;
    height: calc(var(--row-h) - 12px);
    display: flex;
    align-items: center;
    min-width: 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--tint, var(--accent)) 18%, var(--bg));
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--tint, var(--accent)) 45%, transparent),
      0 1px 2px rgb(0 0 0 / 0.06);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text);
    cursor: grab;
    touch-action: none;
    user-select: none;
    z-index: 1;
  }
  .b.fixed {
    cursor: pointer;
  }
  .b:hover {
    background: color-mix(in srgb, var(--tint, var(--accent)) 26%, var(--bg));
  }
  .tr.dragging .b.narrow .b-label {
    visibility: hidden;
  }
  .tr.dragging .b {
    cursor: grabbing;
    box-shadow:
      inset 0 0 0 1.5px color-mix(in srgb, var(--tint, var(--accent)) 70%, transparent),
      var(--shadow-pop);
  }
  .b-label {
    min-width: 0;
    padding: 0 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }
  /* Too short for its name: the name sits after the bar. */
  .b.narrow .b-label {
    position: absolute;
    left: 100%;
    padding: 0 8px;
    overflow: visible;
    color: var(--text-2);
  }
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    cursor: ew-resize;
    z-index: 1;
  }
  .grip.left {
    left: -2px;
  }
  .grip.right {
    right: -2px;
  }
  .grip::after {
    content: '';
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 3px;
    width: 2px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--tint, var(--accent)) 70%, transparent);
    opacity: 0;
  }
  .b:hover .grip::after {
    opacity: 1;
  }
  .drag-note {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    padding: 2px 6px;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-pop);
    font-size: var(--fs-caption);
    color: var(--text-2);
    white-space: nowrap;
    pointer-events: none;
    z-index: 2;
  }
  .ghost {
    position: absolute;
    top: 6px;
    height: calc(var(--row-h) - 12px);
    border-radius: 6px;
    border: 1.5px dashed color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    pointer-events: none;
  }
  .lane:has(.ghost) {
    cursor: pointer;
  }
  .more {
    height: 1px;
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    margin-top: 4px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .add-row:hover {
    background: var(--fill);
    color: var(--text);
  }
  .empty {
    margin: 4px 10px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .setup {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 24px 0;
    color: var(--text-2);
    font-size: var(--fs-ui);
  }
</style>
