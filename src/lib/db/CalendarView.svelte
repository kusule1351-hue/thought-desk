<script lang="ts">
  /**
   * A month of rows, placed by a date property. Drag a row to another day to
   * move it (its time and length come along); click a day's + to add one.
   */
  import PageIcon from '../components/PageIcon.svelte';
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { clock } from '../clock.svelte';
  import { colorVar } from '../colors';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { addDaysIso } from './query';
  import { isoDate, option, toDate } from './schema';
  import type { DateValue, DbRow, DbView, Property } from '../types';

  let { dbId, view, rows, onsettings }: { dbId: string; view: DbView; rows: DbRow[]; onsettings: () => void } = $props();

  const prop = $derived(databases.prop(dbId, view.config.dateProp));
  const editable = $derived(prop?.type === 'date');
  let month = $state(clock.today.slice(0, 7));

  const days = $derived.by(() => {
    const first = toDate(`${month}-01`);
    const back = (first.getDay() - prefs.weekStart + 7) % 7;
    const start = addDaysIso(`${month}-01`, -back);
    const last = toDate(`${month}-01`);
    last.setMonth(last.getMonth() + 1, 0);
    const span = back + last.getDate();
    const weeks = Math.ceil(span / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDaysIso(start, i));
  });
  const weekdays = $derived.by(() => {
    const names = fmt.weekdayNames('short');
    return Array.from({ length: 7 }, (_, i) => names[(prefs.weekStart + i) % 7]);
  });

  /** A colour for a row: its first choice's colour, if it has one. */
  const tint = (row: DbRow): string | undefined => {
    for (const p of databases.props(dbId)) {
      if (p.type !== 'select' && p.type !== 'status') continue;
      const o = option(p, databases.get(row, p));
      if (o) return colorVar(o.color);
    }
    return undefined;
  };

  const byDay = $derived.by(() => {
    const map = new Map<string, { row: DbRow; time: string | null }[]>();
    if (!prop) return map;
    const from = days[0];
    const to = days[days.length - 1];
    for (const row of rows) {
      const v = databases.get(row, prop) as DateValue | null;
      if (!v) continue;
      const start = v.start.slice(0, 10);
      const end = (v.end ?? v.start).slice(0, 10);
      const time = v.start.length > 10 ? v.start.slice(11, 16) : null;
      for (let d = start < from ? from : start; d <= end && d <= to; d = addDaysIso(d, 1)) {
        const list = map.get(d) ?? [];
        list.push({ row, time: d === start ? time : null });
        map.set(d, list);
      }
    }
    for (const list of map.values()) list.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    return map;
  });
  const undated = $derived(prop ? rows.filter((r) => !databases.get(r, prop)).length : 0);

  function shift(n: number) {
    const d = toDate(`${month}-01`);
    d.setMonth(d.getMonth() + n);
    month = isoDate(d).slice(0, 7);
  }

  const timeFmt = (time: string) => fmt.time(toDate(`2000-01-01T${time}`));

  async function add(day: string) {
    if (!prop || !editable) return;
    await databases.addRow(dbId, { view, cells: { [prop.id]: { start: day } } });
  }

  // Dragging a row to another day moves its dates by the same number of days.
  let drag = $state<{ id: string; from: string } | null>(null);
  let over = $state<string | null>(null);

  function drop(day: string) {
    const d = drag;
    drag = null;
    over = null;
    if (!d || !prop || !editable || d.from === day) return;
    const row = databases.rows[d.id];
    const v = row ? (databases.get(row, prop) as DateValue | null) : null;
    if (!row || !v) return;
    const delta = Math.round((toDate(day).getTime() - toDate(d.from).getTime()) / 86_400_000);
    const moved = (s: string) => addDaysIso(s.slice(0, 10), delta) + s.slice(10);
    databases.setOne(row, prop as Property, v.end ? { start: moved(v.start), end: moved(v.end) } : { start: moved(v.start) });
  }

  const label = $derived(fmt.date(toDate(`${month}-01`), { month: 'long', year: 'numeric' }));
</script>

{#if !prop}
  <div class="setup">
    <p>{t('dbViews.calendar.setupHint')}</p>
    <button class="btn small raised" onclick={onsettings}><Icon name="sliders" size={14} /> {t('dbViews.chooseDate')}</button>
  </div>
{:else}
  <div class="cal">
    <div class="bar">
      <h3 class="month">{label}</h3>
      {#if undated}<span class="undated">{t('dbViews.calendar.undated', { count: undated })}</span>{/if}
      <button class="btn small raised" onclick={() => (month = clock.today.slice(0, 7))}>{t('dbViews.today')}</button>
      <button class="icon-btn" onclick={() => shift(-1)} aria-label={t('dbViews.calendar.previousMonth')}><Icon name="chevron-left" /></button>
      <button class="icon-btn" onclick={() => shift(1)} aria-label={t('dbViews.calendar.nextMonth')}><Icon name="chevron-right" /></button>
    </div>
    <div class="grid">
      {#each weekdays as w, i (i)}<div class="wd">{w}</div>{/each}
      {#each days as day (day)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="day"
          class:other={day.slice(0, 7) !== month}
          class:over={over === day}
          ondragover={(e) => {
            if (!drag) return;
            e.preventDefault();
            over = day;
          }}
          ondragleave={() => over === day && (over = null)}
          ondrop={(e) => {
            e.preventDefault();
            drop(day);
          }}
        >
          <div class="day-head">
            <span class="num" class:today={day === clock.today}>{fmt.number(Number(day.slice(8)))}</span>
            {#if editable}<button class="plus" onclick={() => add(day)} aria-label={t('dbViews.calendar.newRowOn', { date: day })}><Icon name="plus" size={13} /></button>{/if}
          </div>
          <div class="items">
            {#each byDay.get(day) ?? [] as item (item.row.id)}
              {@const page = store.byId.get(item.row.id)}
              <button
                class="item"
                style:--tint={tint(item.row)}
                draggable={editable}
                ondragstart={(e) => {
                  drag = { id: item.row.id, from: day };
                  e.dataTransfer?.setData('text/plain', page?.title ?? '');
                }}
                ondragend={() => {
                  drag = null;
                  over = null;
                }}
                onclick={() => store.open(item.row.id)}
              >
                {#if item.time}<span class="time">{timeFmt(item.time)}</span>{/if}
                {#if page?.icon}<span><PageIcon icon={page.icon} /></span>{/if}
                <span class="t">{page?.title || t('common.untitled')}</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .month {
    flex: 1;
    margin: 0;
    font-size: 17px;
    font-weight: var(--fw-650);
    letter-spacing: -0.012em;
  }
  .undated {
    margin-right: 6px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .wd {
    padding: 6px 8px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-3);
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .day {
    display: flex;
    flex-direction: column;
    min-height: 112px;
    padding: 4px;
    box-shadow:
      inset -1px 0 0 var(--separator),
      inset 0 -1px 0 var(--separator);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .day.other {
    background: var(--bg-grouped);
  }
  .day.other .num {
    color: var(--text-4);
  }
  .day.over {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .day-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px 2px 4px;
  }
  .num {
    display: grid;
    place-items: center;
    min-width: 22px;
    height: 22px;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .num.today {
    border-radius: 11px;
    background: var(--danger);
    color: #fff;
    font-weight: var(--fw-650);
  }
  .plus {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
  }
  .day:hover .plus {
    opacity: 1;
  }
  .plus:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: 22px;
    padding: 0 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--tint, var(--c-gray)) 14%, var(--bg));
    box-shadow: inset 2px 0 0 var(--tint, var(--text-4));
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    background: color-mix(in srgb, var(--tint, var(--c-gray)) 22%, var(--bg));
  }
  .item .t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    flex: none;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
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
