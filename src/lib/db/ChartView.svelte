<script lang="ts">
  /**
   * A chart of a view's rows: how many (or how much) per choice, course or
   * month. Bars rank categories, a donut shows shares (six slices at most,
   * the rest folded into "Other"), a line follows months. One colour for one
   * series; a choice's own colour marks its label. Every value is written
   * out, so nothing hides behind hovering.
   */
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { groupRows } from './query';
  import { formatNumber, toDate } from './schema';
  import { i18n, t } from '../i18n';
  import { fmt } from '../i18n/format';
  import type { DbRow, DbView } from '../types';

  let { dbId, view, rows, onsettings }: { dbId: string; view: DbView; rows: DbRow[]; onsettings: () => void } = $props();

  const chart = $derived(view.config.chart);
  const xProp = $derived(chart ? databases.prop(dbId, chart.x) : undefined);
  const yProp = $derived(chart?.y ? databases.prop(dbId, chart.y) : undefined);
  const agg = $derived(chart?.agg ?? 'count');

  interface Datum {
    key: string;
    label: string;
    color?: string;
    value: number;
    count: number;
  }

  const data = $derived.by((): Datum[] => {
    if (!xProp) return [];
    const ctx = databases.ctx(dbId);
    const groups = groupRows(rows, xProp, ctx);
    return groups
      .map((g) => {
        const nums = yProp ? g.rows.map((r) => databases.get(r, yProp)).filter((v): v is number => typeof v === 'number') : [];
        const sum = nums.reduce((a, b) => a + b, 0);
        const value = agg === 'count' ? g.rows.length : agg === 'sum' ? sum : nums.length ? sum / nums.length : 0;
        return { key: g.key, label: g.label, color: g.color, value, count: g.rows.length };
      })
      .filter((d) => d.count > 0 || d.key !== '');
  });

  const num = (n: number) => (agg === 'count' || !yProp ? fmt.number(n) : formatNumber(n, yProp.config));
  /** A share of the donut, as a whole percentage. */
  const pct = (v: number) => fmt.number(Math.round((v / (sliceTotal || 1)) * 100) / 100, { style: 'percent' });
  const groupBy = $derived(xProp?.name ?? '');
  const property = $derived(yProp?.name ?? '');
  /** Under the headline, and the chart's name: what's counted, summed or averaged, and by what. */
  const summary = $derived(
    agg === 'count'
      ? t('dbViews.chart.summaryCount', { groupBy })
      : agg === 'sum'
        ? t('dbViews.chart.summarySum', { property, groupBy })
        : t('dbViews.chart.summaryAverage', { property, groupBy }),
  );
  const chartName = $derived(
    agg === 'count' ? t('dbViews.chart.nameCount', { groupBy }) : agg === 'sum' ? t('dbViews.chart.nameSum', { property, groupBy }) : t('dbViews.chart.nameAverage', { property, groupBy }),
  );
  /** Names inside a sentence are written in lower case ("rows with a status"). */
  const lower = (name: string) => name.toLocaleLowerCase(i18n.language);
  /** The headline: all rows counted, summed or averaged. */
  const overall = $derived.by(() => {
    if (agg === 'count' || !yProp) return rows.length;
    const nums = rows.map((r) => databases.get(r, yProp)).filter((v): v is number => typeof v === 'number');
    const sum = nums.reduce((a, b) => a + b, 0);
    return agg === 'sum' ? sum : nums.length ? sum / nums.length : 0;
  });
  const max = $derived(Math.max(1e-9, ...data.map((d) => d.value)));
  const isTime = $derived(xProp?.type === 'date' || xProp?.type === 'created' || xProp?.type === 'edited');
  const kind = $derived(chart?.kind === 'line' && !isTime ? 'bar' : (chart?.kind ?? 'bar'));

  // ------------------------------------------------------------------ donut

  const slices = $derived.by(() => {
    const list = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
    if (list.length <= 6) return list;
    const rest = list.slice(5);
    return [...list.slice(0, 5), { key: '__other', label: t('dbViews.chart.otherSlice', { count: rest.length }), color: 'var(--c-gray)', value: rest.reduce((n, d) => n + d.value, 0), count: rest.reduce((n, d) => n + d.count, 0) }];
  });
  const sliceTotal = $derived(slices.reduce((n, d) => n + d.value, 0));
  /** Fixed-order fallbacks for groups without a colour of their own. */
  const ORDER = ['blue', 'orange', 'green', 'purple', 'teal', 'pink'];
  const sliceColor = (d: Datum, i: number) => d.color ?? `var(--c-${ORDER[i % ORDER.length]})`;

  function arc(start: number, end: number): string {
    const R = 80;
    const r = 52;
    const pt = (a: number, rad: number) => [100 + rad * Math.sin(a), 100 - rad * Math.cos(a)];
    const large = end - start > Math.PI ? 1 : 0;
    if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4;
    const [x1, y1] = pt(start, R);
    const [x2, y2] = pt(end, R);
    const [x3, y3] = pt(end, r);
    const [x4, y4] = pt(start, r);
    return `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r},${r} 0 ${large} 0 ${x4},${y4} Z`;
  }
  const arcs = $derived.by(() => {
    let a = 0;
    return slices.map((d, i) => {
      const span = (d.value / (sliceTotal || 1)) * Math.PI * 2;
      const path = arc(a, a + span);
      a += span;
      return { d, path, color: sliceColor(d, i) };
    });
  });

  // ------------------------------------------------------------------- line

  /** Drawn at the width it's shown at, so text is never stretched. */
  let W = $state(640);
  const H = 240;
  const PAD = { l: 44, r: 12, t: 12, b: 28 };
  const points = $derived(data.filter((d) => d.key !== ''));
  const yMax = $derived.by(() => {
    const m = Math.max(0, ...points.map((d) => d.value));
    if (m <= 0) return 1;
    const step = 10 ** Math.floor(Math.log10(m));
    return Math.ceil(m / step) * step;
  });
  const px = (i: number) => PAD.l + (points.length < 2 ? (W - PAD.l - PAD.r) / 2 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const py = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
  const path = $derived(points.map((d, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(d.value).toFixed(1)}`).join(' '));
  const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax));
  const caption = $derived(
    agg === 'count'
      ? t('dbViews.chart.captionCount', { count: points.length })
      : agg === 'sum'
        ? t('dbViews.chart.captionSum', { count: points.length, property: lower(property) })
        : t('dbViews.chart.captionAverage', { count: points.length, property: lower(property) }),
  );

  let hover = $state<{ i: number; x: number; y: number } | null>(null);
  let plot = $state<SVGSVGElement>();

  function onMove(e: PointerEvent) {
    if (!plot) return;
    const r = plot.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(px(i) - x) < Math.abs(px(best) - x)) best = i;
    hover = points.length ? { i: best, x: px(best), y: py(points[best].value) } : null;
  }
</script>

{#if !chart || !xProp}
  <div class="setup">
    <p>{t('dbViews.chart.setupHint')}</p>
    <button class="btn small raised" onclick={onsettings}><Icon name="sliders" size={14} /> {t('dbViews.chart.setUp')}</button>
  </div>
{:else}
  <div class="chart">
    <div class="summary">
      <div class="hero">
        <span class="hero-value">{num(overall)}</span>
        <span class="hero-label">{summary}</span>
      </div>
      <button class="icon-btn" onclick={onsettings} data-tip={t('dbViews.chart.settings')}><Icon name="sliders" size={15} /></button>
    </div>

    {#if !data.length || data.every((d) => d.value === 0)}
      <p class="none">{t('dbViews.chart.empty', { property: lower(xProp.name) })}</p>
    {:else if kind === 'donut'}
      <div class="donut-wrap">
        <svg class="donut" viewBox="0 0 200 200" role="img" aria-label={chartName}>
          {#each arcs as a, i (a.d.key)}
            <path d={a.path} fill={a.color} class="slice" role="img" aria-label={t('dbViews.chart.value', { label: a.d.label, value: num(a.d.value) })} class:dim={hover !== null && hover.i !== i} onpointerenter={() => (hover = { i, x: 0, y: 0 })} onpointerleave={() => (hover = null)}>
              <title>{t('dbViews.chart.value', { label: a.d.label, value: num(a.d.value) })}</title>
            </path>
          {/each}
          <text x="100" y="98" class="center-value">{hover !== null && arcs[hover.i] ? pct(arcs[hover.i].d.value) : num(sliceTotal)}</text>
          <text x="100" y="116" class="center-label">{hover !== null && arcs[hover.i] ? arcs[hover.i].d.label : t('dbViews.chart.inAll')}</text>
        </svg>
        <div class="legend" role="list">
          {#each arcs as a, i (a.d.key)}
            <div class="legend-row" role="listitem" class:dim={hover !== null && hover.i !== i} onpointerenter={() => (hover = { i, x: 0, y: 0 })} onpointerleave={() => (hover = null)}>
              <span class="swatch" style:background={a.color}></span>
              <span class="l-label">{a.d.label}</span>
              <span class="l-value">{num(a.d.value)}</span>
              <span class="l-pct">{pct(a.d.value)}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else if kind === 'line'}
      <div class="line-wrap" bind:clientWidth={W}>
        <svg
          bind:this={plot}
          class="line"
          width={W}
          height={H}
          viewBox="0 0 {W} {H}"
          role="img"
          aria-label={chartName}
          onpointermove={onMove}
          onpointerleave={() => (hover = null)}
        >
          {#each ticks as y (y)}
            <line x1={PAD.l} x2={W - PAD.r} y1={py(y)} y2={py(y)} class="grid" />
            <text x={PAD.l - 8} y={py(y) + 4} class="tick" text-anchor="end">{num(Math.round(y * 100) / 100)}</text>
          {/each}
          <path d={path} class="stroke" />
          {#each points as d, i (d.key)}
            {#if points.length <= 24 || i === 0 || i === points.length - 1}
              <text x={px(i)} y={H - 8} class="tick" text-anchor="middle">{fmt.date(toDate(`${d.key}-01`), { month: 'long' })}</text>
            {/if}
          {/each}
          {#if hover && points[hover.i]}
            <line x1={px(hover.i)} x2={px(hover.i)} y1={PAD.t} y2={H - PAD.b} class="cross" />
            <circle cx={px(hover.i)} cy={py(points[hover.i].value)} r="4.5" class="dot" />
          {/if}
        </svg>
        {#if hover && points[hover.i]}
          <div class="tip" style:left="{hover.x}px" style:top="{hover.y}px">
            <strong>{points[hover.i].label}</strong>
            <span>{num(points[hover.i].value)}</span>
          </div>
        {/if}
      </div>
      <p class="caption">{caption}</p>
    {:else}
      <div class="bars" role="list" aria-label={chartName}>
        {#each data as d (d.key)}
          <div class="bar-row" role="listitem" data-tip={t('dbViews.chart.barTip', { label: d.label, value: num(d.value), count: d.count })}>
            <span class="b-label">
              {#if d.color}<span class="dot" style:--dot={d.color}></span>{/if}
              <span class="t">{d.label}</span>
            </span>
            <span class="b-track"><span class="b-fill" style:width="{(d.value / max) * 100}%"></span></span>
            <span class="b-value">{num(d.value)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .chart {
    max-width: 760px;
    padding: 4px 0 24px;
  }
  .summary {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hero-value {
    font-size: 28px;
    font-weight: var(--fw-700);
    letter-spacing: -0.02em;
    line-height: 34px;
  }
  .hero-label {
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .none,
  .caption {
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: minmax(80px, 180px) 1fr 80px;
    align-items: center;
    gap: 12px;
    height: 30px;
    padding: 0 6px;
    border-radius: var(--r-sm);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .bar-row:hover {
    background: var(--fill);
  }
  .b-label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--fs-ui);
    color: var(--text);
  }
  .b-label .t {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .b-track {
    height: 10px;
  }
  .b-fill {
    display: block;
    height: 100%;
    min-width: 2px;
    border-radius: 0 4px 4px 0;
    background: var(--accent);
    transition: width var(--dur-slow) var(--ease-out);
  }
  .b-value {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .donut-wrap {
    display: flex;
    align-items: center;
    gap: 32px;
    flex-wrap: wrap;
  }
  .donut {
    width: 220px;
    height: 220px;
    flex: none;
  }
  .slice {
    stroke: var(--bg);
    stroke-width: 2;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .dim {
    opacity: 0.35;
  }
  .center-value {
    text-anchor: middle;
    font-size: 22px;
    font-weight: 700;
    fill: var(--text);
  }
  .center-label {
    text-anchor: middle;
    font-size: 10px;
    fill: var(--text-3);
  }
  .legend {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 240px;
  }
  .legend-row {
    display: grid;
    grid-template-columns: 12px 1fr auto 44px;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    transition: opacity var(--dur-fast) var(--ease);
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .l-value {
    font-weight: var(--fw-600);
    font-variant-numeric: tabular-nums;
  }
  .l-pct {
    text-align: right;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .line-wrap {
    position: relative;
  }
  .line {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--separator);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .tick {
    font-size: 11px;
    fill: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .stroke {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  .cross {
    stroke: var(--separator-strong);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .line .dot {
    fill: var(--accent);
    stroke: var(--bg);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .tip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 12px));
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    background: var(--ink);
    color: var(--on-ink);
    font-size: var(--fs-footnote);
    white-space: nowrap;
    pointer-events: none;
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
