<script lang="ts">
  /** A gallery: rows as cards in a grid, with a picture from each page. */
  import { tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Card from './Card.svelte';
  import { databases } from '../databases.svelte';
  import { t } from '../i18n';
  import { Progressive } from '../progressive.svelte';
  import { pinFirst } from './query';
  import type { DbRow, DbView } from '../types';

  let { dbId, view, rows }: { dbId: string; view: DbView; rows: DbRow[] } = $props();

  const c = $derived(view.config);
  const min = $derived(c.cardSize === 'small' ? 180 : c.cardSize === 'large' ? 320 : 240);
  const lazy = new Progressive(60, 90);
  /** Cards added here come first (on screen at once) until the view is left. */
  let fresh = $state<string[]>([]);
  const shown = $derived(pinFirst(rows, fresh).slice(0, lazy.limit));
  let editing = $state<string | null>(null);

  async function add() {
    const row = await databases.addRow(dbId, { view });
    if (row) {
      fresh = [row.id, ...fresh];
      editing = row.id;
      await tick();
    }
  }
</script>

<div class="gallery" style:--min="{min}px" role="list">
  {#each shown as row (row.id)}
    <div role="listitem"><Card {dbId} {row} {view} cover={c.cover ?? 'page'} editTitle={editing === row.id} ondone={() => (editing = null)} /></div>
  {/each}
  <button class="new" onclick={add}><Icon name="plus" size={16} /> {t('common.actions.new')}</button>
</div>
{#if shown.length < rows.length}<div class="more" {@attach lazy.more}></div>{/if}

<style>
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: 14px;
    padding-bottom: 16px;
  }
  .new {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 72px;
    border-radius: var(--r-md);
    font-size: var(--fs-ui);
    color: var(--text-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .new:hover {
    background: var(--fill);
    color: var(--text);
  }
  .more {
    height: 1px;
  }
</style>
