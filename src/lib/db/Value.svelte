<script lang="ts">
  /**
   * A property's value, drawn for its type: pills for choices, a box for a
   * checkbox, chips for links and files, a bar for a progress number…
   * Used by table cells, cards and a row's property list.
   */
  import PageIcon from '../components/PageIcon.svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { colorVar } from '../colors';
  import { library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { FDate, FormulaError, formatDateValue as fDate } from './formula';
  import { formatDateValue, formatNumber, option } from './schema';
  import type { DateValue, DbRow, Property } from '../types';

  let {
    dbId,
    row,
    prop,
    wrap = false,
    compact = false,
    oncheck,
  }: {
    dbId: string;
    row: DbRow;
    prop: Property;
    /** Let long text and many pills wrap onto more lines. */
    wrap?: boolean;
    /** On cards: smaller, and nothing for empty values. */
    compact?: boolean;
    /** A checkbox was clicked (the caller decides whether it's editable here). */
    oncheck?: () => void;
  } = $props();

  const v = $derived(databases.get(row, prop));
  const page = $derived(store.byId.get(row.id));
  /** Formula and rollup results, as they came out. */
  const computed = $derived(prop.type === 'formula' ? databases.formula(row, prop) : prop.type === 'rollup' ? databases.rollup(row, prop) : undefined);

  function open(url: string, e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    openUrl(url).catch(ui.error);
  }

  const href = (s: string) => (/^[a-z]+:/i.test(s) ? s : `https://${s}`);
  const shortUrl = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

  /** A number's share of its bar (0–1). */
  function share(n: number): number {
    const max = prop.config.max || 100;
    return Math.max(0, Math.min(1, n / max));
  }
</script>

{#snippet bar(n: number)}
  {#if prop.config.display === 'ring'}
    <span class="ring-wrap">
      <svg class="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" class="track" />
        <circle cx="8" cy="8" r="6" class="fill" stroke-dasharray="{share(n) * 37.7} 37.7" transform="rotate(-90 8 8)" />
      </svg>
      <span class="num">{formatNumber(n, prop.config)}</span>
    </span>
  {:else}
    <span class="bar-wrap">
      <span class="bar"><span style:width="{share(n) * 100}%"></span></span>
      <span class="num">{formatNumber(n, prop.config)}</span>
    </span>
  {/if}
{/snippet}

{#snippet number(n: number | null)}
  {#if n === null}
    {''}
  {:else if prop.config.display === 'bar' || prop.config.display === 'ring'}
    {@render bar(n)}
  {:else}
    <span class="v-num">{formatNumber(n, prop.config)}</span>
  {/if}
{/snippet}

{#if prop.type === 'title'}
  <span class="v-title" class:wrap>
    {#if page?.icon}<span class="emoji"><PageIcon icon={page.icon} /></span>{/if}
    <span class="t">{page?.title || ''}</span>
  </span>
{:else if prop.type === 'text'}
  <span class="v-text" class:wrap>{v}</span>
{:else if prop.type === 'number'}
  {@render number(v as number | null)}
{:else if prop.type === 'select' || prop.type === 'status'}
  {@const o = option(prop, v)}
  {#if o}<span class="pill" class:status={prop.type === 'status'} style:--pill={colorVar(o.color)}><span>{o.name}</span></span>{/if}
{:else if prop.type === 'multiSelect'}
  <span class="pills" class:wrap>
    {#each v as string[] as id (id)}
      {@const o = option(prop, id)}
      {#if o}<span class="pill" style:--pill={colorVar(o.color)}><span>{o.name}</span></span>{/if}
    {/each}
  </span>
{:else if prop.type === 'course'}
  {@const c = planner.courseById.get(v as string)}
  {#if c}<span class="pill" style:--pill={colorVar(c.color)}><span>{c.name || t('common.untitled')}</span></span>{/if}
{:else if prop.type === 'tags'}
  <span class="pills" class:wrap>
    {#each v as string[] as tag (tag)}<span class="pill" style:--pill={tags.color(tag)}><span>#{tag}</span></span>{/each}
  </span>
{:else if prop.type === 'date'}
  {#if v}<span class="v-text">{formatDateValue(v as DateValue)}</span>{/if}
{:else if prop.type === 'button'}
  <button
    class="v-button"
    class:empty={!(prop.config.actions ?? []).length}
    tabindex="-1"
    onmousedown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      databases.press(row, prop);
    }}
  >
    <Icon name="pointer" size={12} />
    <span>{prop.config.label || prop.name}</span>
  </button>
{:else if prop.type === 'checkbox'}
  <button
    class="v-check round"
    class:on={v === true}
    class:readonly={!oncheck}
    role="checkbox"
    aria-checked={v === true}
    aria-label={prop.name}
    tabindex="-1"
    onclick={(e) => {
      if (!oncheck) return;
      e.stopPropagation();
      oncheck();
    }}
  ></button>
{:else if prop.type === 'url' && v}
  <a class="v-link" href={href(v as string)} onclick={(e) => open(href(v as string), e)} data-tip={t('dbEdit.value.openInBrowser')}>{shortUrl(v as string)}</a>
{:else if prop.type === 'email' && v}
  <a class="v-link" href="mailto:{v}" onclick={(e) => open(`mailto:${v}`, e)} data-tip={t('dbEdit.value.writeEmail')}>{v}</a>
{:else if prop.type === 'phone' && v}
  <a class="v-link" href="tel:{v}" onclick={(e) => open(`tel:${String(v).replace(/[^\d+]/g, '')}`, e)} data-tip={t('dbEdit.value.call')}>{v}</a>
{:else if prop.type === 'files'}
  <span class="pills" class:wrap>
    {#each v as string[] as id (id)}
      {@const f = library.byId.get(id)}
      {#if f}
        <button
          class="chip-link"
          tabindex="-1"
          onclick={(e) => {
            e.stopPropagation();
            library.preview(id);
          }}
        >
          <Icon name="paperclip" size={12} /><span>{f.name}</span>
        </button>
      {/if}
    {/each}
  </span>
{:else if prop.type === 'relation'}
  <span class="pills" class:wrap>
    {#each v as string[] as id (id)}
      {@const p = store.byId.get(id)}
      <button
        class="chip-link"
        tabindex="-1"
        onclick={(e) => {
          e.stopPropagation();
          store.open(id);
        }}
      >
        {#if p?.icon}<span class="emoji small"><PageIcon icon={p.icon} /></span>{:else}<Icon name="page" size={12} />{/if}<span>{p?.title || t('common.untitled')}</span>
      </button>
    {/each}
  </span>
{:else if prop.type === 'created' || prop.type === 'edited'}
  <span class="v-text muted">{databases.text(row, prop)}</span>
{:else if prop.type === 'id'}
  <span class="v-text muted num">{databases.text(row, prop)}</span>
{:else if computed instanceof FormulaError}
  <span class="v-error" data-tip={computed.message}><Icon name="info" size={13} /> {compact ? '' : t('dbEdit.value.error')}</span>
{:else if typeof computed === 'number'}
  {@render number(computed)}
{:else if typeof computed === 'boolean'}
  <span class="v-check round readonly" class:on={computed} role="img" aria-label={computed ? t('common.yes') : t('common.no')}></span>
{:else if computed instanceof FDate}
  <span class="v-text">{fDate(computed)}</span>
{:else if Array.isArray(computed)}
  <span class="pills" class:wrap>
    {#each computed as item, i (i)}<span class="pill"><span>{item instanceof FDate ? fDate(item) : String(item)}</span></span>{/each}
  </span>
{:else if computed !== null && computed !== undefined}
  <span class="v-text" class:wrap>{String(computed)}</span>
{/if}

<style>
  .v-title {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: var(--fw-500);
  }
  .v-title .t,
  .v-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wrap .t,
  .v-text.wrap {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .emoji {
    flex: none;
    font-size: 15px;
    line-height: 1;
  }
  .emoji.small {
    font-size: 12px;
  }
  .muted {
    color: var(--text-3);
  }
  .num,
  .v-num {
    font-variant-numeric: tabular-nums;
  }
  .v-num {
    display: block;
    text-align: right;
    white-space: nowrap;
  }
  .pills {
    display: flex;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }
  .pills.wrap {
    flex-wrap: wrap;
  }
  .v-check {
    flex: none;
    display: inline-block;
    width: 16px;
    height: 16px;
    border-radius: 4.5px;
    box-shadow: inset 0 0 0 1.5px var(--text-4);
    background: transparent center / 12px no-repeat;
    transition:
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .v-check:not(.readonly):hover {
    box-shadow: inset 0 0 0 1.5px var(--text-3);
  }
  .v-check.on {
    background-color: var(--accent);
    background-image: var(--check);
    box-shadow: none;
  }
  .v-check.readonly {
    cursor: default;
  }
  .v-link {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    text-decoration: underline;
    text-decoration-color: var(--text-4);
    text-underline-offset: 3px;
  }
  .v-link:hover {
    text-decoration-color: var(--text-2);
  }
  .chip-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    max-width: 100%;
    height: 20px;
    padding: 0 6px;
    border-radius: 5px;
    background: var(--fill);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .chip-link:hover {
    background: var(--fill-3);
  }
  .chip-link > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-link :global(.icon) {
    flex: none;
    color: var(--text-2);
  }
  .v-error {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .bar-wrap,
  .ring-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  .bar {
    flex: 1;
    min-width: 24px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .bar > span {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transition: width var(--dur) var(--ease);
  }
  .bar-wrap .num {
    flex: none;
    min-width: 34px;
    text-align: right;
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .ring {
    flex: none;
  }
  .ring .track {
    fill: none;
    stroke: var(--fill-3);
    stroke-width: 2.5;
  }
  .ring .fill {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
  }
  .v-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 22px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-sm);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-600);
    color: var(--text);
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .v-button span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .v-button:hover {
    background: var(--fill-2);
  }
  .v-button:active {
    transform: translateY(0.5px);
  }
  .v-button.empty {
    color: var(--text-3);
  }
</style>
