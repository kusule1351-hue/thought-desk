<script lang="ts">
  /** A database inside a page (the editor block's contents). */
  import Icon from '../components/Icon.svelte';
  import DatabaseView from './DatabaseView.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { t } from '../i18n';

  let { id, view, onview }: { id: string; view: string | null; onview: (view: string) => void } = $props();

  const meta = $derived(store.byId.get(id));
</script>

{#if !databases.loaded}
  <div class="gone">{t('common.loading')}</div>
{:else if !meta || !databases.isDatabase(id)}
  <div class="gone"><Icon name="database" size={15} /> {t('dbTable.block.deleted')}</div>
{:else if meta.deletedAt}
  <div class="gone">
    <Icon name="trash" size={15} /> {t('dbTable.block.inTrash', { title: meta.title || t('common.untitledDatabase') })}
    <button class="btn small raised" onclick={() => void store.restore(id)}>{t('common.actions.restore')}</button>
  </div>
{:else}
  <DatabaseView {id} embedded viewId={view} {onview} />
{/if}

<style>
  .gone {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .gone .btn {
    margin-left: auto;
  }
</style>
