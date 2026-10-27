<script lang="ts">
  /** A list: one line per row, title on the left and properties on the right. */
  import PageIcon from '../components/PageIcon.svelte';
  import { tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Value from './Value.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { Progressive, takeGrouped } from '../progressive.svelte';
  import { pinFirst, type Group } from './query';
  import type { DbRow, DbView, Property } from '../types';

  let { dbId, view, rows, groups }: { dbId: string; view: DbView; rows: DbRow[]; groups: Group[] | null } = $props();

  const c = $derived(view.config);
  const AUTO_SKIP = new Set(['title', 'created', 'edited', 'text', 'id']);
  const allProps = $derived(databases.props(dbId));
  const lazy = new Progressive(80, 150);
  /** Rows added here come first (on screen at once) until the view is left. */
  let fresh = $state<string[]>([]);
  // Sub-items sit under their parent (folded until opened).
  const nested = $derived((c.subItems ?? 'nested') === 'nested' && !!databases.subItems(dbId));
  const shaped = $derived.by(() => {
    const depth = new Map<string, number>();
    const kids = new Map<string, number>();
    const fold = (list: DbRow[]): DbRow[] => {
      const n = nested ? databases.nest(dbId, list) : null;
      if (!n) return pinFirst(list, fresh);
      n.depth.forEach((v, k) => depth.set(k, v));
      n.kids.forEach((v, k) => kids.set(k, v));
      return pinFirst(n.rows, fresh);
    };
    const folded = groups
      ? groups.filter((g) => g.rows.length || (!c.hideEmptyGroups && g.key !== '')).map((g) => ({ ...g, total: g.rows.length, rows: fold(g.rows) }))
      : null;
    const plain = folded ? [] : fold(rows);
    const sections = folded ? takeGrouped(folded, (g) => g.rows, lazy.limit) : [{ group: null as (Group & { total?: number }) | null, items: plain.slice(0, lazy.limit) }];
    const count = folded ? folded.reduce((n, g) => n + g.rows.length, 0) : plain.length;
    return { sections, depth, kids, count };
  });
  const sections = $derived(shaped.sections);
  const depth = $derived(shaped.depth);
  const kids = $derived(shaped.kids);
  const total = $derived(shaped.count);
  let editing = $state<{ id: string; title: string } | null>(null);
  let input = $state<HTMLInputElement>();

  function shownFor(row: DbRow): Property[] {
    const filled = (p: Property) => {
      const v = databases.get(row, p);
      return !(v === null || v === '' || v === false || (Array.isArray(v) && !v.length));
    };
    if (c.shown) return allProps.filter((p) => c.shown!.includes(p.id) && p.type !== 'title' && (filled(p) || p.type === 'checkbox'));
    return allProps.filter((p) => !AUTO_SKIP.has(p.type) && filled(p)).slice(0, 4);
  }

  async function add(group?: Group | null, parent?: DbRow) {
    const row = parent ? await databases.addSubItem(parent, view) : await databases.addRow(dbId, { view, group: group && c.group ? { prop: c.group, key: group.key } : undefined });
    if (!row) return;
    if (!parent) fresh = [row.id, ...fresh];
    editing = { id: row.id, title: '' };
    await tick();
    input?.focus();
  }

  function commit() {
    if (!editing) return;
    if (editing.title.trim()) store.update(editing.id, { title: editing.title.trim() });
    editing = null;
  }

  function menu(e: MouseEvent, row: DbRow) {
    e.preventDefault();
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t('common.actions.open'), icon: 'expand', action: () => store.open(row.id) },
        ...(databases.subItems(dbId) ? [{ label: t('dbViews.list.addSubItem'), icon: 'corner-down-right', action: () => void add(null, row) }] : []),
        { label: t('common.actions.duplicate'), icon: 'copy', action: () => void databases.duplicateRows([row.id]) },
        { label: t('dbViews.list.saveAsTemplate'), icon: 'template', action: () => void databases.newTemplate(dbId, row) },
        { separator: true },
        { label: t('common.actions.delete'), icon: 'trash', danger: true, action: () => void databases.deleteRows([row.id]) },
      ],
    });
  }
</script>

<div class="list">
  {#each sections as s (s.group?.key ?? 'all')}
    {#if s.group}
      <div class="group">
        {#if s.group.color}<span class="pill" style:--pill={s.group.color}><span>{s.group.label}</span></span>{:else}<span class="g-label">{s.group.label}</span>{/if}
        <span class="count">{fmt.number(s.group.total ?? s.group.rows.length, { useGrouping: false })}</span>
      </div>
    {/if}
    {#each s.items as row (row.id)}
      {@const page = store.byId.get(row.id)}
      {@const d = depth.get(row.id) ?? 0}
      {#if editing?.id === row.id}
        <div class="line editing" style:padding-left="{8 + d * 22}px">
          <span class="lead">{#if page?.icon}<PageIcon icon={page.icon} />{:else}<Icon name="page" size={15} />{/if}</span>
          <input
            bind:this={input}
            bind:value={editing.title}
            placeholder={t('dbViews.nameIt')}
            onkeydown={(e) => (e.key === 'Enter' || e.key === 'Escape') && commit()}
            onblur={commit}
            aria-label={t('dbViews.titleField')}
          />
        </div>
      {:else}
        {@const k = kids.get(row.id) ?? 0}
        <div class="line-wrap" style:--indent="{d * 22}px">
          {#if k}
            <button
              class="twisty"
              class:open={databases.expanded[row.id]}
              onclick={() => databases.toggleExpanded(row.id)}
              aria-label={databases.expanded[row.id] ? t('dbViews.list.hideSubItems') : t('dbViews.list.showSubItems')}
              aria-expanded={!!databases.expanded[row.id]}
              data-tip={t('dbViews.list.subItems', { count: k })}><Icon name="chevron-right" size={12} stroke={2.4} /></button
            >
          {/if}
        <button class="line" class:nested onclick={() => store.open(row.id)} oncontextmenu={(e) => menu(e, row)}>
          <span class="lead">{#if page?.icon}<PageIcon icon={page.icon} />{:else}<Icon name="page" size={15} />{/if}</span>
          <span class="title" class:untitled={!page?.title}>{page?.title || t('common.untitled')}</span>
          <span class="allProps">
            {#each shownFor(row) as p (p.id)}<span class="prop" data-tip={p.name}><Value {dbId} {row} prop={p} compact /></span>{/each}
          </span>
        </button>
        </div>
      {/if}
    {/each}
  {/each}
  {#if sections.reduce((n, s) => n + s.items.length, 0) < total}<div class="more" {@attach lazy.more}></div>{/if}
  <button class="line add" onclick={() => add()}><span class="lead"><Icon name="plus" size={15} /></span><span class="title">{t('common.actions.new')}</span></button>
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    margin-top: 10px;
    padding: 0 8px;
  }
  .g-label {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    color: var(--text-2);
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 38px;
    padding: 4px 8px;
    border-radius: var(--r-sm);
    text-align: left;
    box-shadow: inset 0 -1px 0 var(--separator);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .line:hover {
    background: var(--fill);
  }
  .line-wrap {
    position: relative;
    content-visibility: auto;
    contain-intrinsic-block-size: auto 38px;
  }
  .line.nested {
    padding-left: calc(8px + var(--indent) + 22px);
  }
  .twisty {
    position: absolute;
    z-index: 1;
    top: 50%;
    left: calc(6px + var(--indent));
    translate: 0 -50%;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: var(--r-xs);
    color: var(--text-3);
  }
  .twisty:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .twisty :global(.icon) {
    transition: transform var(--dur-fast) var(--ease);
  }
  .twisty.open :global(.icon) {
    transform: rotate(90deg);
  }
  .lead {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    color: var(--text-3);
    font-size: 15px;
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .untitled {
    color: var(--text-3);
  }
  .allProps {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 60%;
    overflow: hidden;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .prop {
    display: flex;
    min-width: 0;
    max-width: 200px;
  }
  .editing input {
    flex: 1;
    height: 26px;
    border: none;
    background: none;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    outline: none;
  }
  .add {
    color: var(--text-3);
    box-shadow: none;
  }
  .add .title {
    font-weight: var(--fw-400);
    font-size: var(--fs-ui);
  }
  .add:hover {
    color: var(--text);
  }
  .more {
    height: 1px;
  }
</style>
