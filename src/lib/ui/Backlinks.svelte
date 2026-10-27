<script lang="ts">
  /** Pages that link to this page, assignment, event or file ("Linked from"). */
  import PageIcon from '../components/PageIcon.svelte';
  import Icon from '../components/Icon.svelte';
  import { api } from '../api';
  import { t } from '../i18n';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import type { PageMeta } from '../types';

  let { id, inSheet = false }: { id: string; inSheet?: boolean } = $props();

  let ids = $state<string[]>([]);

  $effect(() => {
    const target = id;
    let cancelled = false;
    void store
      .flush()
      .then(() => api.backlinks(target))
      .then((list) => !cancelled && (ids = list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  const pages = $derived(ids.map((pid) => store.byId.get(pid)).filter((p): p is PageMeta => !!p && !p.deletedAt));

  function open(pid: string) {
    ui.assignmentSheet = null;
    ui.eventSheet = null;
    store.open(pid);
  }

  function pathOf(pid: string) {
    return store
      .ancestors(pid)
      .map((a) => a.title || t('common.untitled'))
      .join(' / ');
  }
</script>

{#if pages.length}
  <section class="backlinks" class:in-sheet={inSheet}>
    <h3 class="group-title">
      <span class="head"><Icon name="backlink" size={14} stroke={2} /> {t('sheets.backlinks.linkedFrom', { count: pages.length })}</span>
    </h3>
    <div class="group">
      {#each pages as p (p.id)}
        <button class="group-row link" onclick={() => open(p.id)}>
          <span class="icon">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name="page" size={16} />{/if}</span>
          <span class="text">
            <span class="title">{p.title || t('common.untitled')}</span>
            {#if pathOf(p.id)}<span class="path">{pathOf(p.id)}</span>{/if}
          </span>
          <Icon name="chevron-right" size={14} stroke={2} />
        </button>
      {/each}
    </div>
  </section>
{/if}

<style>
  .backlinks {
    margin: 32px 0 0;
    font-family: var(--font-ui);
  }
  .backlinks.in-sheet {
    margin: 0;
  }
  .head {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .link {
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    min-height: 44px;
    text-align: left;
    color: var(--text-3);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .link:hover {
    background: var(--fill);
  }
  .link:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .link:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 20px;
    font-size: 16px;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .path {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
