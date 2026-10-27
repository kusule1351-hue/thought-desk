<script lang="ts">
  /**
   * Picks a date: type it ("Friday", "Oct 20", "tomorrow 3pm") or click a
   * day. An end date makes a range; a time is optional.
   */
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Switch from '../ui/Switch.svelte';
  import { clock } from '../clock.svelte';
  import { prefs } from '../prefs.svelte';
  import { formatDateValue, hasTime, isoDate, parseDate, toDate } from './schema';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import Rich from '../i18n/Rich.svelte';
  import type { DateValue } from '../types';

  let {
    value,
    onchange,
    typed,
  }: {
    value: DateValue | null;
    onchange: (v: DateValue | null) => void;
    /** A key typed to open the picker: typing carries on from it. */
    typed?: string;
  } = $props();

  let text = $state(untrack(() => typed ?? (value ? formatDateValue(value) : '')));
  let input: HTMLInputElement;
  /** Which end a click on the grid sets. */
  let picking = $state<'start' | 'end'>('start');
  const startDay = $derived(value?.start.slice(0, 10) ?? null);
  const endDay = $derived(value?.end?.slice(0, 10) ?? null);
  const timed = $derived(!!value && hasTime(value.start));
  let month = $state(untrack(() => (value?.start ?? clock.today).slice(0, 7)));

  onMount(() => {
    input?.focus();
    if (untrack(() => typed) === undefined) input?.select();
  });

  // Keep the text box in step with clicks and switches (not before the
  // first change, so a typed start isn't wiped).
  let seen = untrack(() => value);
  $effect(() => {
    if (value === seen) return;
    seen = value;
    text = value ? formatDateValue(value) : '';
  });

  function commitText() {
    // Unchanged (focus just moved to the grid): nothing to read.
    if (value && text === formatDateValue(value)) return;
    if (!text.trim()) {
      onchange(null);
      return;
    }
    const v = parseDate(text);
    if (v) {
      onchange(v);
      month = v.start.slice(0, 7);
    }
  }

  const timeOf = (s: string | undefined) => (s && hasTime(s) ? s.slice(11) : '09:00');

  function pickDay(day: string) {
    if (!value || picking === 'start') {
      const start = timed ? `${day}T${timeOf(value?.start)}` : day;
      const end = value?.end && value.end.slice(0, 10) >= day ? value.end : undefined;
      onchange(end ? { start, end } : { start });
      if (value?.end !== undefined) picking = 'end';
    } else {
      const end = timed ? `${day}T${timeOf(value.end ?? value.start)}` : day;
      onchange(day < startDay! ? { start: end, end: value.start } : { start: value.start, end });
      picking = 'start';
    }
  }

  function toggleEnd() {
    if (!value) return;
    if (value.end !== undefined) onchange({ start: value.start });
    else {
      onchange({ start: value.start, end: value.start });
      picking = 'end';
    }
  }

  function toggleTime() {
    if (!value) return;
    if (timed) onchange({ start: value.start.slice(0, 10), ...(value.end ? { end: value.end.slice(0, 10) } : {}) });
    else onchange({ start: `${value.start}T09:00`, ...(value.end ? { end: `${value.end.slice(0, 10)}T10:00` } : {}) });
  }

  function setTime(which: 'start' | 'end', time: string) {
    if (!value || !time) return;
    const base = which === 'start' ? value.start : (value.end ?? value.start);
    const next = `${base.slice(0, 10)}T${time}`;
    onchange(which === 'start' ? { ...value, start: next } : { ...value, end: next });
  }

  function shift(n: number) {
    const d = toDate(`${month}-01`);
    d.setMonth(d.getMonth() + n);
    month = isoDate(d).slice(0, 7);
  }

  const monthLabel = $derived(fmt.date(toDate(`${month}-01`), { month: 'long', year: 'numeric' }));
  const weekdays = $derived.by(() => {
    const names = fmt.weekdayNames('narrow');
    return Array.from({ length: 7 }, (_, i) => names[(prefs.weekStart + i) % 7]);
  });
  const days = $derived.by(() => {
    const first = toDate(`${month}-01`);
    const back = (first.getDay() - prefs.weekStart + 7) % 7;
    const start = new Date(first);
    start.setDate(1 - back);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return isoDate(d);
    });
  });
  const inRange = (day: string) => !!startDay && !!endDay && day > startDay && day < endDay;

  function quick(offset: number) {
    const d = toDate(clock.today);
    d.setDate(d.getDate() + offset);
    pickDay(isoDate(d));
  }
</script>

<div class="dp">
  <input
    class="pop-input"
    bind:this={input}
    bind:value={text}
    placeholder={t('dbEdit.date.placeholder')}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitText();
      }
    }}
    onblur={commitText}
    aria-label={t('dbEdit.date.field')}
  />
  <div class="quick">
    <button class="chip" onclick={() => quick(0)}>{t('common.today')}</button>
    <button class="chip" onclick={() => quick(1)}>{t('common.tomorrow')}</button>
    <button class="chip" onclick={() => quick(7)}>{t('dbEdit.date.inAWeek')}</button>
  </div>
  <div class="cal-head">
    <span class="month">{monthLabel}</span>
    <button class="icon-btn small" onclick={() => shift(-1)} aria-label={t('dbEdit.date.previousMonth')}><Icon name="chevron-left" size={14} /></button>
    <button class="icon-btn small" onclick={() => (month = clock.today.slice(0, 7))} aria-label={t('dbEdit.date.thisMonth')}><Icon name="today" size={14} /></button>
    <button class="icon-btn small" onclick={() => shift(1)} aria-label={t('dbEdit.date.nextMonth')}><Icon name="chevron-right" size={14} /></button>
  </div>
  <div class="grid" role="grid">
    {#each weekdays as w, i (i)}<span class="wd">{w}</span>{/each}
    {#each days as day (day)}
      <button
        class="day round"
        class:other={day.slice(0, 7) !== month}
        class:today={day === clock.today}
        class:sel={day === startDay || day === endDay}
        class:range={inRange(day)}
        onclick={() => pickDay(day)}
        aria-label={day}
      >
        {fmt.number(Number(day.slice(8)))}
      </button>
    {/each}
  </div>
  <div class="pop-sep"></div>
  <div class="pop-row">
    <span class="label">{t('dbEdit.date.endDate')}</span>
    <Switch on={value?.end !== undefined} label={t('dbEdit.date.endDate')} onchange={toggleEnd} />
  </div>
  <div class="pop-row">
    <span class="label">{t('dbEdit.date.time')}</span>
    <Switch on={timed} label={t('dbEdit.date.includeTime')} onchange={toggleTime} />
  </div>
  {#if timed && value}
    {@const startTime = value.start.slice(11, 16)}
    {@const endTime = (value.end ?? '').slice(11, 16)}
    <div class="pop-row times">
      {#if value.end !== undefined}
        <Rich key="dbEdit.date.timeRange">
          {#snippet start()}{@render startInput(startTime)}{/snippet}
          {#snippet to(text: string)}<span class="to">{text}</span>{/snippet}
          {#snippet end()}<input type="time" class="pop-input" value={endTime} onchange={(e) => setTime('end', (e.currentTarget as HTMLInputElement).value)} aria-label={t('dbEdit.date.endTime')} />{/snippet}
        </Rich>
      {:else}
        {@render startInput(startTime)}
      {/if}
    </div>
  {/if}
  {#if value?.end !== undefined}
    <p class="hint">{picking === 'start' ? t('dbEdit.date.clickToSetStart') : t('dbEdit.date.clickToSetEnd')}</p>
  {/if}
  <div class="pop-sep"></div>
  <button class="pop-item" onclick={() => onchange(null)} disabled={!value}><Icon name="x" size={14} /><span class="grow">{t('common.actions.clear')}</span></button>
</div>

{#snippet startInput(time: string)}
  <input type="time" class="pop-input" value={time} onchange={(e) => setTime('start', (e.currentTarget as HTMLInputElement).value)} aria-label={t('dbEdit.date.startTime')} />
{/snippet}

<style>
  .dp {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .quick {
    display: flex;
    gap: 4px;
    padding: 6px 2px 2px;
  }
  .quick .chip {
    height: 24px;
    padding: 0 10px;
    font-size: var(--fs-footnote);
  }
  .cal-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 2px 2px 8px;
  }
  .month {
    flex: 1;
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    padding: 0 2px;
  }
  .wd {
    display: grid;
    place-items: center;
    height: 22px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-3);
  }
  .day {
    display: grid;
    place-items: center;
    height: 28px;
    border-radius: 50%;
    font-size: var(--fs-ui);
    font-variant-numeric: tabular-nums;
    color: var(--text);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .day:hover {
    background: var(--fill-2);
  }
  .day.other {
    color: var(--text-4);
  }
  .day.today {
    color: var(--danger);
    font-weight: var(--fw-650);
  }
  .day.range {
    border-radius: 4px;
    background: var(--fill-2);
  }
  .day.sel {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: var(--fw-600);
  }
  .times {
    gap: 6px;
  }
  .times .pop-input {
    flex: 1;
  }
  .to {
    color: var(--text-3);
    font-size: var(--fs-ui);
  }
  .hint {
    margin: 2px 8px 4px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
</style>
