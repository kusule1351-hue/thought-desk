<script lang="ts">
  /** An item's tags as chips, plus a button to add more. */
  import Icon from '../components/Icon.svelte';
  import { store } from '../store.svelte';
  import { t } from '../i18n';
  import { tags } from '../tags.svelte';
  import { ui } from '../ui.svelte';
  import type { TrashTable } from '../types';

  let { table, id, compact = false }: { table: TrashTable; id: string; compact?: boolean } = $props();

  const list = $derived(tags.of(table, id));

  function open(name: string) {
    ui.assignmentSheet = null;
    ui.eventSheet = null;
    ui.filePreview = null;
    store.openTag(name);
  }
</script>

<div class="tag-row" class:compact>
  {#each list as name (name)}
    <span class="tag round" style:--c={tags.color(name)}>
      <button class="tag-name" onclick={() => open(name)} data-tip={t('sheets.tag.showTagged', { name })}>#{name}</button>
      <button class="tag-x round" onclick={() => tags.set(table, id, list.filter((other) => other !== name))} aria-label={t('sheets.tag.remove', { name })}>
        <Icon name="x" size={10} stroke={2.6} />
      </button>
    </span>
  {/each}
  <button class="add round" onclick={(e) => ui.pickTags(e.currentTarget as Element, table, id)}>
    <Icon name="tag" size={12} stroke={2} />
    {list.length ? t('sheets.tag.addMore') : t('sheets.tag.add')}
  </button>
</div>

<style>
  .tag-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .tag-row.compact {
    justify-content: flex-end;
  }
  /* Tags are pills: 24px tall, tinted with the tag's colour. */
  .tag {
    display: inline-flex;
    align-items: center;
    height: var(--h-xs);
    padding: 0 2px 0 10px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--c) 14%, transparent);
    color: color-mix(in srgb, var(--c) 72%, var(--text));
    font-size: var(--fs-ui);
    font-weight: var(--fw-550);
  }
  .tag-name {
    height: 100%;
    padding-right: 2px;
  }
  .tag-name:hover {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  /* 24px pill − 2px inset = a 20px button with 10px corners. */
  .tag-x {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 10px;
    opacity: 0.55;
    transition:
      opacity var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .tag-x:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--c) 22%, transparent);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-xs);
    padding: 0 10px;
    border-radius: 12px;
    box-shadow: inset 0 0 0 1px var(--separator-strong);
    font-size: var(--fs-ui);
    color: var(--text-3);
    transition:
      color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .add:hover {
    color: var(--text);
    background: var(--fill);
  }
</style>
