<script lang="ts">
  /** A file embedded in a page: tile, name and size; click to preview. */
  import Icon from '../components/Icon.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import { fileMenuItems } from '../file-actions';
  import { t } from '../i18n';
  import { KINDS, fileKind, library } from '../library.svelte';
  import { formatBytes } from '../time';
  import { ui } from '../ui.svelte';

  let { id }: { id: string } = $props();

  const file = $derived(library.byId.get(id));
  const gone = $derived(!file || !!file.deletedAt);

  function open(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!gone) library.preview(id);
  }

  function more(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!gone) ui.openMenuAt(e.currentTarget as Element, fileMenuItems(id), { alignRight: true });
  }
</script>

<span class="card" class:gone role="button" tabindex="-1" onclick={open} onkeydown={(e) => e.key === 'Enter' && !gone && library.preview(id)}>
  {#if file && !gone}
    <FileTile {file} size={40} />
    <span class="text">
      <span class="name">{file.name}</span>
      <span class="meta">{KINDS[fileKind(file)].label} · {file.missing ? t('blocks.file.missing') : formatBytes(file.size)}</span>
    </span>
    <span class="acts">
      <button class="act" onclick={(e) => { e.stopPropagation(); void library.open(id); }} data-tip={t('blocks.file.openInDefaultApp')}><Icon name="external" size={15} /></button>
      <button class="act" onclick={more} data-tip={t('common.actions.more')}><Icon name="more" size={15} /></button>
    </span>
  {:else}
    <span class="tile-gone"><Icon name="file" size={18} /></span>
    <span class="text"><span class="name">{t('blocks.file.deleted')}</span><span class="meta">{t('blocks.file.restoreFromTrash')}</span></span>
  {/if}
</span>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px 12px 8px 8px;
    margin: 4px 0;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-family: var(--font-ui);
    cursor: default;
    user-select: none;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .card:hover {
    background: var(--fill-2);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    line-height: 1.35;
  }
  .name {
    font-size: var(--fs-callout);
    font-weight: var(--fw-550);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .acts {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .card:hover .acts {
    opacity: 1;
  }
  .act {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-sm);
    color: var(--text-2);
  }
  .act:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .gone .name {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .tile-gone {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--r-md);
    background: var(--fill);
    color: var(--text-4);
  }
</style>
