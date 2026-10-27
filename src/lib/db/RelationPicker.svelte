<script lang="ts">
  /**
   * Links a row to rows of another (or the same) database: search, tick to
   * link or unlink, or make a new row there from what's typed.
   */
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { t } from '../i18n';
  import type { DbRow, Property } from '../types';

  let {
    row,
    prop,
    onchange,
    query: startQuery = '',
  }: { row: DbRow; prop: Property; onchange: (ids: string[]) => void; query?: string } = $props();

  const target = $derived(prop.config.database ?? '');
  const linked = $derived(databases.get(row, prop) as string[]);
  let query = $state(untrack(() => startQuery));
  let active = $state(0);
  let input: HTMLInputElement;
  onMount(() => input?.focus());

  const q = $derived(query.trim().toLowerCase());
  const candidates = $derived.by(() => {
    const rows = databases.rowsOf(target).filter((r) => r.id !== row.id);
    const hits = q ? rows.filter((r) => databases.title(r).toLowerCase().includes(q)) : rows;
    // Linked rows first, then the rest in their own order.
    return [...hits.filter((r) => linked.includes(r.id)), ...hits.filter((r) => !linked.includes(r.id))].slice(0, 200);
  });
  const canCreate = $derived(!!q && !candidates.some((r) => databases.title(r).toLowerCase() === q));
  const count = $derived(candidates.length + (canCreate ? 1 : 0));

  $effect(() => {
    void q;
    active = 0;
  });

  function toggle(r: DbRow) {
    // A row has one parent: picking another replaces it.
    if (prop.config.parent) onchange(linked.includes(r.id) ? [] : [r.id]);
    else onchange(linked.includes(r.id) ? linked.filter((x) => x !== r.id) : [...linked, r.id]);
  }

  async function create() {
    const made = await databases.addRow(target, { title: query.trim() });
    if (made) onchange(prop.config.parent ? [made.id] : [...linked, made.id]);
    query = '';
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % Math.max(1, count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + count) % Math.max(1, count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < candidates.length) toggle(candidates[active]);
      else if (canCreate) void create();
    }
  }

  const dbTitle = $derived(store.byId.get(target)?.title || t('common.untitled'));
</script>

<div class="rel">
  <input class="pop-input" bind:this={input} bind:value={query} onkeydown={onKey} placeholder={t('dbEdit.relation.searchPlaceholder', { database: dbTitle })} aria-label={t('dbEdit.relation.searchLabel')} />
  {#if !target || !databases.isDatabase(target)}
    <p class="none">{t('dbEdit.relation.noDatabase')}</p>
  {:else}
    <div class="list">
      {#each candidates as r, i (r.id)}
        {@const p = store.byId.get(r.id)}
        <button class="pop-item" class:active={i === active} onmousemove={() => (active = i)} onclick={() => toggle(r)}>
          {#if p?.icon}<span class="emoji"><PageIcon icon={p.icon} /></span>{:else}<Icon name="page" size={14} />{/if}
          <span class="grow">{p?.title || t('common.untitled')}</span>
          {#if linked.includes(r.id)}<Icon name="check" size={14} stroke={2.4} />{/if}
        </button>
      {/each}
      {#if canCreate}
        <button class="pop-item" class:active={active === candidates.length} onmousemove={() => (active = candidates.length)} onclick={create}>
          <Icon name="plus" size={14} /><span class="grow">{t('dbEdit.relation.newRow', { title: query.trim(), database: dbTitle })}</span>
        </button>
      {/if}
      {#if !count}<p class="none">{q ? t('dbEdit.relation.noMatches') : t('dbEdit.relation.noRows', { database: dbTitle })}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .rel {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .emoji {
    flex: none;
    width: 16px;
    text-align: center;
    font-size: 14px;
  }
  .none {
    margin: 4px 8px 6px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
</style>
