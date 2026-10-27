<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import SearchField from '../ui/SearchField.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { fileMenuItems } from '../file-actions';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { KINDS, fileKind, library, pickFiles, type FileKind } from '../library.svelte';
  import { prefs, type FilesLayout } from '../prefs.svelte';
  import { Progressive } from '../progressive.svelte';
  import { formatBytes, relativeTime } from '../time';
  import { ui } from '../ui.svelte';
  import type { FileMeta } from '../types';

  type Filter = 'all' | 'images' | 'docs' | 'media' | 'other' | 'unused';
  type Sort = 'newest' | 'name' | 'size';

  let filter = $state<Filter>('all');
  let sort = $state<Sort>('newest');
  let query = $state('');
  let dropping = $state(false);

  const GROUPS: Record<Exclude<Filter, 'all' | 'unused'>, FileKind[]> = {
    images: ['image'],
    docs: ['pdf', 'doc', 'sheet', 'slides', 'text'],
    media: ['audio', 'video'],
    other: ['archive', 'code', 'other'],
  };
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: t('library.files.filter.all') },
    { value: 'images', label: t('library.files.filter.images') },
    { value: 'docs', label: t('library.files.filter.documents') },
    { value: 'media', label: t('library.files.filter.media') },
    { value: 'other', label: t('library.files.filter.otherKinds') },
    { value: 'unused', label: t('library.files.filter.unused') },
  ];
  const layouts: { value: FilesLayout; label: string; icon: string }[] = [
    { value: 'grid', label: t('library.files.grid'), icon: 'grid' },
    { value: 'list', label: t('library.files.list'), icon: 'rows' },
  ];
  const sorts: Record<Sort, string> = {
    newest: t('library.files.sort.dateAdded'),
    name: t('library.files.sort.name'),
    size: t('library.files.sort.size'),
  };

  // Usage changes as pages are edited elsewhere; refresh on the way in.
  onMount(() => void library.refreshUsage());

  const uses = (f: FileMeta) => library.useCount(f.id);
  // One collator for the whole sort (localeCompare with options builds one per call).
  const byName = fmt.collator({ numeric: true }).compare;

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = library.live.filter((f) => {
      if (filter === 'unused' && uses(f) > 0) return false;
      if (filter !== 'all' && filter !== 'unused' && !GROUPS[filter].includes(fileKind(f))) return false;
      return !q || f.name.toLowerCase().includes(q);
    });
    if (sort === 'name') return [...list].sort((a, b) => byName(a.name, b.name));
    if (sort === 'size') return [...list].sort((a, b) => b.size - a.size);
    return list;
  });

  const counts = $derived.by(() => {
    const c: Record<Filter, number> = { all: library.live.length, images: 0, docs: 0, media: 0, other: 0, unused: 0 };
    for (const f of library.live) {
      const k = fileKind(f);
      for (const [g, kinds] of Object.entries(GROUPS)) if (kinds.includes(k)) c[g as Filter]++;
      if (uses(f) === 0) c.unused++;
    }
    return c;
  });

  // Files render as you scroll; a new filter or sort starts at the top.
  const lazy = new Progressive(80, 200);
  $effect(() => {
    void [filter, sort, query];
    lazy.reset();
  });
  const visible = $derived(shown.length > lazy.limit ? shown.slice(0, lazy.limit) : shown);

  function toastAdded(added: FileMeta[]) {
    if (added.length === 1) ui.toast(t('library.files.addedFile', { name: added[0].name }));
    else if (added.length) ui.toast(t('library.files.addedFiles', { count: added.length }));
  }

  async function importFiles() {
    toastAdded(await library.add(await pickFiles()));
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropping = true;
  }

  async function onDrop(e: DragEvent) {
    dropping = false;
    const list = Array.from(e.dataTransfer?.files ?? []);
    if (!list.length) return;
    e.preventDefault();
    toastAdded(await library.add(list));
  }

  let menuFor = $state<string | null>(null);
  function menu(e: MouseEvent, f: FileMeta, anchor?: Element) {
    e.preventDefault();
    e.stopPropagation();
    menuFor = f.id;
    const items = fileMenuItems(f.id);
    const onClose = () => (menuFor = null);
    if (anchor) ui.openMenuAt(anchor, items, { alignRight: true, onClose });
    else ui.openMenu({ x: e.clientX, y: e.clientY, items, onClose });
  }

  function sortMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { header: t('library.files.sortBy') },
        ...(Object.keys(sorts) as Sort[]).map((s) => ({ label: sorts[s], checked: sort === s, action: () => (sort = s) })),
      ],
      { alignRight: true },
    );
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="view files"
  class:dropping
  ondragover={onDragOver}
  ondragleave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && (dropping = false)}
  ondrop={onDrop}
>
  <header class="view-head">
    <div>
      <h1 class="view-title">{t('common.views.files')}</h1>
      <p class="view-sub">
        {#if library.live.length}
          {t('library.files.subtitle', { count: library.live.length, size: formatBytes(library.totalBytes) })}
        {:else}
          {t('library.files.emptySubtitle')}
        {/if}
      </p>
    </div>
    <div class="view-actions">
      <Segmented options={layouts} value={prefs.filesLayout} onchange={(v) => (prefs.filesLayout = v)} label={t('library.files.layout')} iconOnly />
      <button class="btn primary" onclick={importFiles}><Icon name="upload" size={15} stroke={2.2} /> {t('library.files.addFiles')}</button>
    </div>
  </header>

  <div class="toolbar">
    <div class="kinds" role="radiogroup" aria-label={t('library.files.kindFilter')}>
      {#each filters as f (f.value)}
        {#if f.value === 'all' || counts[f.value] > 0}
          <button class="chip" class:on={filter === f.value} role="radio" aria-checked={filter === f.value} onclick={() => (filter = f.value)}>
            {f.label}
            <span class="n">{fmt.number(counts[f.value])}</span>
          </button>
        {/if}
      {/each}
    </div>
    <span class="spacer"></span>
    <button class="btn small sort" onclick={sortMenu}><Icon name="arrow-down" size={13} stroke={2} />{sorts[sort]}</button>
    <SearchField bind:value={query} placeholder={t('library.files.search')} width={200} small />
  </div>

  {#if shown.length && prefs.filesLayout === 'grid'}
    <div class="grid">
      {#each visible as f (f.id)}
        {@const n = uses(f)}
        <div
          class="card"
          class:menu-open={menuFor === f.id}
          role="button"
          tabindex="0"
          onclick={() => library.preview(f.id)}
          ondblclick={() => library.open(f.id)}
          onkeydown={(e) => e.key === 'Enter' && library.preview(f.id)}
          oncontextmenu={(e) => menu(e, f)}
        >
          <div class="thumb" class:image={fileKind(f) === 'image' && !f.missing}>
            <FileTile file={f} size={fileKind(f) === 'image' && !f.missing ? 160 : 56} />
          </div>
          <div class="card-text">
            <span class="name" title={f.name}>{f.name}</span>
            <span class="meta">
              {f.missing ? t('library.files.missing') : formatBytes(f.size)}
              {#if n}<span class="uses" data-tip={t('library.files.usedInPlaces', { count: n })}><Icon name="link" size={11} stroke={2.2} />{fmt.number(n)}</span>{/if}
            </span>
          </div>
          <button class="card-more" tabindex="-1" onclick={(e) => menu(e, f, e.currentTarget as Element)} aria-label={t('common.actions.more')}><Icon name="more" size={15} /></button>
        </div>
      {/each}
    </div>
    {#if visible.length < shown.length}<div {@attach lazy.more}></div>{/if}
  {:else if shown.length}
    <div class="group">
      {#each visible as f (f.id)}
        {@const n = uses(f)}
        <div
          class="group-row f-row"
          class:menu-open={menuFor === f.id}
          role="button"
          tabindex="0"
          onclick={() => library.preview(f.id)}
          ondblclick={() => library.open(f.id)}
          onkeydown={(e) => e.key === 'Enter' && library.preview(f.id)}
          oncontextmenu={(e) => menu(e, f)}
        >
          <FileTile file={f} size={32} />
          <div class="f-main">
            <span class="name">{f.name}</span>
            <span class="meta">{KINDS[fileKind(f)].label} · {f.missing ? t('library.files.missing') : formatBytes(f.size)}</span>
          </div>
          <span class="f-uses">{t('library.files.uses', { count: n })}</span>
          <span class="f-date">{relativeTime(f.createdAt)}</span>
          <button class="act" tabindex="-1" onclick={(e) => menu(e, f, e.currentTarget as Element)} aria-label={t('common.actions.more')}><Icon name="more" size={15} /></button>
        </div>
      {/each}
    </div>
    {#if visible.length < shown.length}<div {@attach lazy.more}></div>{/if}
  {:else}
    <EmptyState
      icon="files"
      title={query ? t('library.files.noMatches') : library.live.length ? t('library.files.nothingHere') : t('library.files.empty')}
      text={query
        ? t('library.files.noMatchesText')
        : library.live.length
          ? t('library.files.nothingHereText')
          : t('library.files.emptyText')}
    >
      {#if !library.live.length}
        <button class="btn primary" onclick={importFiles}><Icon name="upload" size={15} stroke={2.2} /> {t('library.files.addFiles')}</button>
      {/if}
    </EmptyState>
  {/if}

  {#if dropping}
    <div class="drop-hint">
      <span class="drop-badge"><Icon name="upload" size={22} stroke={2} /></span>
      <strong>{t('library.files.dropToAdd')}</strong>
    </div>
  {/if}
</div>

<style>
  .files {
    position: relative;
    min-height: 100%;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .n {
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
  }
  .sort {
    gap: 6px;
    background: none;
    color: var(--text-2);
  }
  .sort:hover {
    background: var(--fill);
    color: var(--text);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
    gap: 16px;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    outline: none;
    cursor: default;
    transition:
      background-color var(--dur-fast) var(--ease),
      transform var(--dur) var(--ease-out),
      box-shadow var(--dur) var(--ease);
  }
  .card:hover,
  .card.menu-open {
    background: var(--fill-2);
  }
  .card:active {
    transform: scale(0.985);
  }
  .card:focus-visible {
    box-shadow: 0 0 0 2px var(--focus);
  }
  .thumb {
    display: grid;
    place-items: center;
    height: 124px;
    margin: 6px 6px 0;
    border-radius: calc(var(--r-lg) - 4px);
    overflow: hidden;
  }
  .thumb.image :global(.tile) {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }
  .card-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 10px 12px 12px;
    min-width: 0;
  }
  .name {
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .uses {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--tint);
  }
  .card-more {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: var(--h-sm);
    height: var(--h-sm);
    border-radius: var(--r-sm);
    background: var(--material-strong);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    box-shadow: var(--shadow-sm);
    color: var(--text-2);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .card:hover .card-more,
  .card.menu-open .card-more {
    opacity: 1;
  }

  .f-row {
    gap: 12px;
    min-height: 52px;
    padding: 8px 8px 8px 12px;
    cursor: default;
    outline: none;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .f-row:hover,
  .f-row.menu-open {
    background: var(--fill);
  }
  .f-row:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .f-row:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .f-row:focus-visible {
    box-shadow: inset 0 0 0 1.5px var(--focus);
  }
  .f-row + :global(.f-row)::before {
    left: 56px;
  }
  .f-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .f-uses,
  .f-date {
    flex: none;
    width: 96px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .act {
    flex: none;
    display: grid;
    place-items: center;
    width: var(--h-xs);
    height: var(--h-xs);
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .f-row:hover .act,
  .f-row.menu-open .act {
    opacity: 1;
  }
  .act:hover {
    background: var(--fill-2);
    color: var(--text);
  }

  .drop-hint {
    position: absolute;
    inset: 24px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 12px;
    border-radius: var(--r-xl);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    box-shadow: inset 0 0 0 2px var(--accent);
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
    pointer-events: none;
    z-index: 5;
  }
  .drop-badge {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: var(--r-lg);
    background: var(--accent);
    color: var(--on-accent);
  }
  .drop-hint strong {
    font-size: var(--fs-callout);
    font-weight: var(--fw-600);
  }
  :global([data-below-640]) .f-date {
    display: none;
  }
</style>
