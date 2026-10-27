<script lang="ts">
  import { cowork } from '../cowork.svelte';
  /**
   * The side of split view: one page or database next to the main one,
   * with its own header (swap sides, open it full, close). Empty, it offers
   * recent pages and a search to pick one.
   */
  import { paneSize } from '../pane-size';
  import { dragLater, endDrag, pageDragImage } from './TreeItem.svelte';
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import PageIcon from './PageIcon.svelte';
  import PageView from './PageView.svelte';
  import DatabaseView from '../db/DatabaseView.svelte';
  import { api } from '../api';
  import { databases } from '../databases.svelte';
  import { split } from '../split.svelte';
  import { store } from '../store.svelte';
  import { relativeTime } from '../time';
  import { ui } from '../ui.svelte';
  import { searchText, t } from '../i18n';
  import type { Page, PageMeta } from '../types';

  let page = $state<Page | null>(null);
  let scroller = $state<HTMLDivElement>();
  let query = $state('');
  let searchEl = $state<HTMLInputElement>();

  const meta = $derived(split.pageId ? store.byId.get(split.pageId) : undefined);
  const showing = $derived(split.duplicate ? null : (meta ?? null));

  // Its id and kind, not the page object: that's new on every edit.
  const showingId = $derived(showing?.id);
  const showingKind = $derived(showing?.kind);
  const showingRoom = $derived(showing?.sharedRoom ?? null);

  // Load the page (with its body) whenever what the pane shows changes.
  $effect(() => {
    const id = showingId;
    void showingRoom;
    if (!id || showingKind === 'database') {
      page = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await store.flush();
        const full = await api.getPage(id);
        if (cancelled) return;
        page = full;
        if (scroller) scroller.scrollTop = 0;
      } catch (e) {
        if (!cancelled) ui.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // An empty pane is ready for typing a page's name.
  $effect(() => {
    if (!showing && !split.duplicate) void tick().then(() => searchEl?.focus());
  });

  /** Pages to pick from: matches for what's typed, else the most recently edited. */
  const choices = $derived.by(() => {
    const q = query.trim().toLowerCase();
    // An untitled page is found by the name it shows, in the interface's language or English.
    const untitled = searchText('common.untitled');
    const out: PageMeta[] = [];
    for (const p of store.all) {
      if (p.deletedAt || store.isRow(p) || (store.view === 'page' && p.id === store.currentId)) continue;
      if (q && !(p.title || untitled).toLowerCase().includes(q)) continue;
      out.push(p);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, 12);
  });

  function onPickKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && choices[0]) split.show(choices[0].id);
    if (e.key === 'Escape') split.close();
  }
</script>

<section class="pane" aria-label={t('shell.splitPane.label')}>
  <header class="pane-head">
    {#if showing}
      <button
        class="title"
        draggable="true"
        onclick={() => split.expand()}
        ondragstart={(e) => {
          const id = showing.id;
          e.dataTransfer?.setData('text/plain', showing.title || t('common.untitled'));
          pageDragImage(e, showing.title, showing.icon);
          dragLater(id, 'side');
        }}
        ondragend={endDrag}
        data-tip={t('shell.splitPane.dragHint')}
      >
        <span class="lead">{#if showing.icon}<PageIcon icon={showing.icon} />{:else}<Icon name={showing.kind === 'database' ? 'database' : 'page'} size={14} />{/if}</span>
        <span class="name">{showing.title || t('common.untitled')}</span>
      </button>
    {:else}
      <span class="title static"><Icon name="split" size={14} /><span class="name">{t('shell.splitView')}</span></span>
    {/if}
    <div class="actions">
      {#if showing}
        <button class="icon-btn" onclick={() => split.swap()} data-tip={t('shell.splitPane.swapSides')} aria-label={t('shell.splitPane.swapSides')}><Icon name="swap" size={15} /></button>
        <button class="icon-btn" onclick={() => split.expand()} data-tip={t('shell.splitPane.openInMain')} aria-label={t('shell.splitPane.openInMain')}><Icon name="expand" size={15} /></button>
      {/if}
      <button class="icon-btn" onclick={() => split.close()} data-tip={t('shell.closeSplitView')} aria-label={t('shell.closeSplitView')}><Icon name="x" size={15} /></button>
    </div>
  </header>

  <div class="pane-scroller" bind:this={scroller} use:paneSize>
    {#if showing?.kind === 'database'}
      {#if databases.loaded}
        {#key showing.id}<DatabaseView id={showing.id} />{/key}
      {/if}
    {:else if showing && page && page.id === showing.id}
      {#key `${page.id}:${page.sharedRoom ?? ''}:${cowork.isLive(page.id)}`}<PageView {page} />{/key}
    {:else if split.duplicate}
      <div class="picker">
        <p class="hint">{t('shell.splitPane.openOnLeft')}</p>
        <button class="btn raised small" onclick={() => split.clear()}>{t('shell.splitPane.chooseAnother')}</button>
      </div>
    {:else if !showing}
      <div class="picker">
        <h2>{t('shell.splitPane.pickTitle')}</h2>
        <p class="hint">{t('shell.splitPane.pickHint')}</p>
        <label class="search">
          <Icon name="search" size={14} />
          <input bind:this={searchEl} bind:value={query} placeholder={t('shell.splitPane.findPage')} spellcheck="false" onkeydown={onPickKey} />
        </label>
        <ul class="choices">
          {#each choices as p (p.id)}
            <li>
              <button onclick={() => split.show(p.id)}>
                <span class="lead">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name={p.kind === 'database' ? 'database' : 'page'} size={15} />{/if}</span>
                <span class="name">{p.title || t('common.untitled')}</span>
                <span class="when">{relativeTime(p.updatedAt)}</span>
              </button>
            </li>
          {:else}
            <li class="none">{t('shell.splitPane.noMatches')}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    flex: none;
    padding: 0 8px 0 10px;
    border-bottom: 1px solid var(--separator);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600, 600);
    color: var(--text);
  }
  button.title:hover {
    background: var(--fill);
  }
  .title.static {
    color: var(--text-2);
  }
  .lead {
    display: grid;
    place-items: center;
    flex: none;
    font-size: 16px;
    color: var(--text-2);
  }
  .actions .icon-btn {
    color: var(--text-2);
  }
  .actions .icon-btn:hover {
    color: var(--text);
  }
  .name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }
  .pane-scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 440px;
    margin: 0 auto;
    padding: 56px 24px 32px;
  }
  .picker h2 {
    margin: 0;
    font-size: 19px;
    font-weight: var(--fw-650, 650);
    letter-spacing: -0.01em;
  }
  .hint {
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.5;
    color: var(--text-3);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--h-md);
    margin-top: 6px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    background: var(--fill-2);
    color: var(--text-3);
  }
  .search:focus-within {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font-size: var(--fs-ui);
    color: var(--text);
    outline: none;
  }
  .choices {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .choices button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 34px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    text-align: left;
    font-size: var(--fs-ui);
    color: var(--text);
  }
  .choices button:hover {
    background: var(--fill);
  }
  .choices .name {
    flex: 1;
  }
  .when {
    flex: none;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .none {
    padding: 8px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
</style>
