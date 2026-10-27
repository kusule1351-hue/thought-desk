<script lang="ts">
  /** A row as a card (boards and galleries): picture, title, properties. */
  import PageIcon from '../components/PageIcon.svelte';
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Value from './Value.svelte';
  import { databases } from '../databases.svelte';
  import { fileUrl, normalizeFileUrl } from '../api';
  import { library } from '../library.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import type { DbRow, DbView, Property } from '../types';

  let {
    dbId,
    row,
    view,
    cover = 'none',
    editTitle = false,
    ondone,
  }: {
    dbId: string;
    row: DbRow;
    view: DbView;
    /** "page" (first image in it), a files property's id, or "none". */
    cover?: string;
    /** Just made: type its title right on the card. */
    editTitle?: boolean;
    ondone?: () => void;
  } = $props();

  const page = $derived(store.byId.get(row.id));
  const AUTO_SKIP = new Set(['title', 'created', 'edited', 'id', 'text']);

  /** What shows under the title: chosen properties, or the first few filled in. */
  const shown = $derived.by((): Property[] => {
    const props = databases.props(dbId);
    const chosen = view.config.shown;
    const filled = (p: Property) => {
      const v = databases.get(row, p);
      return !(v === null || v === '' || v === false || (Array.isArray(v) && !v.length));
    };
    if (chosen) return props.filter((p) => chosen.includes(p.id) && p.type !== 'title' && (filled(p) || p.type === 'checkbox'));
    return props.filter((p) => !AUTO_SKIP.has(p.type) && filled(p)).slice(0, 4);
  });

  const picture = $derived.by(() => {
    if (cover === 'none') return null;
    if (cover === 'page') {
      const src = databases.cover(row);
      return src ? normalizeFileUrl(src) : null;
    }
    const p = databases.prop(dbId, cover);
    if (!p) return null;
    for (const id of databases.get(row, p) as string[]) {
      const f = library.byId.get(id);
      if (f && f.mime.startsWith('image/')) return fileUrl(f.stored);
    }
    return null;
  });

  let input = $state<HTMLInputElement>();
  let title = $state('');
  // Naming starts once the card is marked (it may already be on screen).
  $effect(() => {
    if (!editTitle || !input) return;
    title = untrack(() => page?.title ?? '');
    input.focus();
  });

  function commit() {
    if (!editTitle) return;
    if (title !== (page?.title ?? '')) store.update(row.id, { title: title.trim() });
    ondone?.();
  }

  function menu(e: MouseEvent) {
    e.preventDefault();
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t('common.actions.open'), icon: 'expand', action: () => store.open(row.id) },
        { label: t('common.actions.duplicate'), icon: 'copy', action: () => void databases.duplicateRows([row.id]) },
        { separator: true },
        { label: t('common.actions.delete'), icon: 'trash', danger: true, action: () => void databases.deleteRows([row.id]) },
      ],
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="card" role="button" tabindex="0" onclick={() => !editTitle && store.open(row.id)} onkeydown={(e) => e.key === 'Enter' && !editTitle && store.open(row.id)} oncontextmenu={menu}>
  {#if picture}
    <div class="cover"><img src={picture} alt="" loading="lazy" draggable="false" /></div>
  {/if}
  <div class="body">
    {#if editTitle}
      <input
        class="title-input"
        bind:this={input}
        bind:value={title}
        placeholder={t('dbViews.nameIt')}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') commit();
        }}
        onblur={commit}
        aria-label={t('dbViews.titleField')}
      />
    {:else}
      <div class="title">
        {#if page?.icon}<span class="emoji"><PageIcon icon={page.icon} /></span>{/if}
        <span class:untitled={!page?.title}>{page?.title || t('common.untitled')}</span>
      </div>
    {/if}
    {#each shown as p (p.id)}
      <div class="prop" data-tip={p.name}>
        <Value {dbId} {row} prop={p} compact wrap={p.type === 'multiSelect' || p.type === 'tags'} />
      </div>
    {/each}
  </div>
  <button
    class="more"
    tabindex="-1"
    onclick={(e) => {
      e.stopPropagation();
      menu(e);
    }}
    aria-label={t('common.actions.more')}><Icon name="more" size={14} /></button
  >
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 1px 2px rgba(0, 0, 0, 0.05);
    overflow: hidden;
    cursor: pointer;
    transition:
      box-shadow var(--dur) var(--ease),
      transform var(--dur) var(--ease);
  }
  .card:hover {
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 4px 14px -4px rgba(0, 0, 0, 0.16);
  }
  .card:active {
    transform: scale(0.99);
  }
  .card:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--focus);
  }
  .cover {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    background: var(--bg-grouped);
    overflow: hidden;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px 12px;
    min-width: 0;
  }
  .title {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .emoji {
    flex: none;
  }
  .untitled {
    color: var(--text-3);
    font-weight: var(--fw-500);
  }
  .title-input {
    width: 100%;
    height: 24px;
    border: none;
    background: none;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600);
    color: var(--text);
    outline: none;
  }
  .prop {
    display: flex;
    min-width: 0;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .prop :global(.v-num) {
    text-align: left;
  }
  .more {
    position: absolute;
    top: 6px;
    right: 6px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: var(--r-xs);
    background: var(--material-strong);
    box-shadow: 0 0 0 0.5px var(--hairline);
    color: var(--text-2);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .card:hover .more {
    opacity: 1;
  }
</style>
