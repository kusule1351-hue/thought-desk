<script lang="ts">
  /**
   * A board: one column per choice (status, select, course…). Dragging a
   * card to another column changes that property; within a column it sets
   * the order (when the view isn't sorted).
   */
  import { tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Card from './Card.svelte';
  import { databases, type CellSet } from '../databases.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { newOption, options } from './schema';
  import { pinFirst, type Group } from './query';
  import type { CellValue, DbRow, DbView } from '../types';

  let { dbId, view, groups, onsettings }: { dbId: string; view: DbView; groups: Group[] | null; onsettings: () => void } = $props();

  const c = $derived(view.config);
  const prop = $derived(databases.prop(dbId, c.group));
  const hidden = $derived(new Set(c.collapsed ?? []));
  const columns = $derived((groups ?? []).filter((g) => !hidden.has(g.key) && (g.key !== '' || g.rows.length) && !(c.hideEmptyGroups && !g.rows.length)));
  const hiddenGroups = $derived((groups ?? []).filter((g) => hidden.has(g.key)));
  const manual = $derived(!(c.sorts ?? []).length);
  const movable = $derived(!!prop && ['select', 'status', 'multiSelect', 'course', 'checkbox', 'text'].includes(prop.type));
  const width = $derived(c.cardSize === 'small' ? 220 : c.cardSize === 'large' ? 320 : 264);

  let editing = $state<string | null>(null);

  // A column shows its first cards and more on request: a column of 20,000
  // cards would take the board down with it.
  const PAGE = 50;
  let limits = $state<Record<string, number>>({});
  const limitOf = (key: string) => limits[key] ?? PAGE;
  /** A column's card count: the locale's digits, no thousands separator (as it always was). */
  const badge = (n: number) => fmt.number(n, { useGrouping: false });

  /** Cards added here come first in their column until the view is left. */
  let fresh = $state<string[]>([]);
  const cardsOf = (g: Group) => {
    const list = pinFirst(g.rows, fresh);
    return list.length > limitOf(g.key) ? list.slice(0, limitOf(g.key)) : list;
  };

  async function add(g: Group) {
    const row = await databases.addRow(dbId, { view, group: prop ? { prop: prop.id, key: g.key } : undefined });
    if (row) {
      fresh = [row.id, ...fresh];
      editing = row.id;
      await tick();
    }
  }

  // ----------------------------------------------------------- drag & drop

  let drag = $state<{ id: string; from: string } | null>(null);
  let over = $state<{ group: string; before: string | null } | null>(null);

  function onCardOver(e: DragEvent, g: Group, row: DbRow) {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const i = g.rows.indexOf(row);
    const before = e.clientY < r.top + r.height / 2 ? row.id : (g.rows[i + 1]?.id ?? null);
    over = { group: g.key, before };
  }

  function onColumnOver(e: DragEvent, g: Group) {
    if (!drag) return;
    e.preventDefault();
    if (over?.group !== g.key) over = { group: g.key, before: null };
  }

  function valueFor(row: DbRow, from: string, to: string): CellValue {
    if (!prop) return null;
    switch (prop.type) {
      case 'multiSelect': {
        const cur = (row.cells[prop.id] as string[] | undefined) ?? [];
        const rest = cur.filter((x) => x !== from);
        return to && !rest.includes(to) ? [...rest, to] : rest;
      }
      case 'checkbox':
        return to === 'true';
      default:
        return to || null;
    }
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    const d = drag;
    const o = over;
    drag = null;
    over = null;
    if (!d || !o || !prop) return;
    const row = databases.rows[d.id];
    if (!row) return;
    if (o.group !== d.from && movable) {
      const change: CellSet = { row, prop, value: valueFor(row, d.from, o.group) };
      const to = columns.find((g) => g.key === o.group)?.label;
      databases.set([change], {
        label:
          to !== undefined
            ? { undone: t('dbViews.board.undoMove', { column: to }), redone: t('dbViews.board.redoMove', { column: to }) }
            : { undone: t('dbViews.board.undoMoveColumn'), redone: t('dbViews.board.redoMoveColumn') },
      });
    }
    if (manual) {
      const list = (groups ?? []).find((g) => g.key === o.group)?.rows.filter((r) => r.id !== d.id) ?? [];
      const at = o.before ? list.findIndex((r) => r.id === o.before) : list.length;
      if (list.length) databases.moveRow(d.id, list[at - 1]?.id ?? null, list[at]?.id ?? null);
    }
  }

  // --------------------------------------------------------------- columns

  function hide(key: string) {
    databases.updateView(dbId, view.id, { collapsed: [...(c.collapsed ?? []), key] });
  }

  function show(key: string) {
    databases.updateView(dbId, view.id, { collapsed: (c.collapsed ?? []).filter((k) => k !== key) });
  }

  async function addGroup() {
    if (!prop || !['select', 'status', 'multiSelect'].includes(prop.type)) return;
    const res = await ui.prompt({ title: t('dbViews.board.newColumn'), placeholder: t('common.name'), confirmLabel: t('common.actions.add') });
    if (!res) return;
    databases.updateProperty(dbId, prop.id, { config: { ...prop.config, options: [...options(prop), newOption(prop, res.value)] } }, { immediate: true });
  }

  function columnMenu(e: MouseEvent, g: Group) {
    ui.openMenuAt(e.currentTarget as Element, [
      { label: t('dbViews.board.newCardHere'), icon: 'plus', action: () => void add(g) },
      { label: t('dbViews.board.hideColumn'), icon: 'eye-off', action: () => hide(g.key) },
    ]);
  }
</script>

{#if !prop}
  <div class="setup">
    <p>{t('dbViews.board.setupHint')}</p>
    <button class="btn small raised" onclick={onsettings}><Icon name="sliders" size={14} /> {t('dbViews.board.chooseColumns')}</button>
  </div>
{:else}
  <div class="board" role="list">
    {#each columns as g (g.key)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="column" class:over={over?.group === g.key && drag?.from !== g.key} style:width="{width}px" ondragover={(e) => onColumnOver(e, g)} ondrop={drop}>
        <div class="col-head">
          {#if g.color}
            <span class="pill" class:status={prop.type === 'status'} style:--pill={g.color}><span>{g.label}</span></span>
          {:else}
            <span class="label">{g.label}</span>
          {/if}
          <span class="count">{badge(g.rows.length)}</span>
          <span class="spacer"></span>
          <button class="icon-btn small" onclick={(e) => columnMenu(e, g)} aria-label={t('dbViews.board.columnOptions')}><Icon name="more" size={14} /></button>
          <button class="icon-btn small" onclick={() => add(g)} aria-label={t('dbViews.board.newCardIn', { column: g.label })} data-tip={t('dbViews.board.newCard')}><Icon name="plus" size={14} /></button>
        </div>
        <div class="cards">
          {#each cardsOf(g) as row (row.id)}
            <div
              class="slot"
              class:before={over?.group === g.key && over.before === row.id}
              class:dragging={drag?.id === row.id}
              draggable={editing !== row.id}
              role="listitem"
              ondragstart={(e) => {
                drag = { id: row.id, from: g.key };
                e.dataTransfer?.setData('text/plain', databases.title(row));
              }}
              ondragend={() => {
                drag = null;
                over = null;
              }}
              ondragover={(e) => onCardOver(e, g, row)}
            >
              <Card {dbId} {row} {view} cover={c.cover ?? 'none'} editTitle={editing === row.id} ondone={() => (editing = null)} />
            </div>
          {/each}
          {#if g.rows.length > limitOf(g.key)}
            <button class="add" onclick={() => (limits[g.key] = limitOf(g.key) + 200)}>
              <Icon name="chevron-down" size={14} /> {t('dbViews.board.showMore', { count: g.rows.length - limitOf(g.key) })}
            </button>
          {/if}
          {#if over?.group === g.key && over.before === null && drag}<div class="drop-end"></div>{/if}
          <button class="add" onclick={() => add(g)}><Icon name="plus" size={14} /> {t('common.actions.new')}</button>
        </div>
      </div>
    {/each}

    <div class="side">
      {#if ['select', 'status', 'multiSelect'].includes(prop.type)}
        <button class="add-col" onclick={addGroup}><Icon name="plus" size={14} /> {t('dbViews.board.addColumn')}</button>
      {/if}
      {#if hiddenGroups.length}
        <div class="hidden-list">
          <div class="eyebrow">{t('dbViews.board.hiddenColumns')}</div>
          {#each hiddenGroups as g (g.key)}
            <button class="hidden-col" onclick={() => show(g.key)} data-tip={t('dbViews.board.showAgain')}>
              {#if g.color}<span class="pill" style:--pill={g.color}><span>{g.label}</span></span>{:else}<span>{g.label}</span>{/if}
              <span class="count">{badge(g.rows.length)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .board {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    overflow-x: auto;
    padding: 0 var(--edge, 0px) 16px;
    min-height: 200px;
  }
  .column {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .column.over {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .col-head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 2px 0 4px;
  }
  .label {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    color: var(--text-2);
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 40px;
  }
  .slot {
    position: relative;
  }
  .slot.dragging {
    opacity: 0.4;
  }
  .slot.before::before,
  .drop-end {
    content: '';
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .slot.before::before {
    position: absolute;
    left: 0;
    right: 0;
    top: -6px;
  }
  .add {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .add:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .side {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 200px;
  }
  .add-col {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 12px;
    border-radius: var(--r-lg);
    font-size: var(--fs-ui);
    color: var(--text-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .add-col:hover {
    background: var(--fill);
    color: var(--text);
  }
  .hidden-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hidden-col {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
  }
  .hidden-col:hover {
    background: var(--fill);
  }
  .setup {
    margin: 0 var(--edge, 0px);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 24px 0;
    color: var(--text-2);
    font-size: var(--fs-ui);
  }
</style>
