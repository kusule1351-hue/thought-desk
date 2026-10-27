<script lang="ts">
  /**
   * Dropping a dragged page (from the sidebar, the title bar or the side
   * pane's header) into split view. Nothing shows until the pointer is over
   * the page area; then the layout makes room (split.preview: the page
   * slides aside for a new side, or the card to be replaced settles back)
   * and an outline with a small label marks where the page will land. The layer also keeps drops out of the editor, which would
   * paste the page's name as text.
   */
  import Icon from './Icon.svelte';
  import { drag, endDrag } from './TreeItem.svelte';
  import { split } from '../split.svelte';
  import { store } from '../store.svelte';
  import { t } from '../i18n';

  let { tiled, narrow }: { tiled: boolean; narrow: boolean } = $props();

  type Target = 'main' | 'side';
  let layer = $state<HTMLDivElement>();
  let target = $state<Target | null>(null);
  let ghost = $state({ left: 0, top: 0, width: 0, height: 0 });

  const page = $derived(drag.id ? store.byId.get(drag.id) : undefined);
  const label = $derived(
    target === 'main'
      ? drag.from === 'side'
        ? t('shell.splitDrop.moveHere')
        : t('shell.splitDrop.openHere')
      : drag.from === 'main' || (drag.id === store.currentId && store.view === 'page')
        ? t('shell.splitDrop.moveToSide')
        : t('shell.splitDrop.openBeside'),
  );

  /** Where the pointer is, which side that means, and the outline of where the page would go. */
  function locate(e: DragEvent) {
    const panes = layer?.parentElement;
    if (!panes) return null;
    const box = panes.getBoundingClientRect();
    const x = e.clientX - box.left;
    const inset = 10;
    let want: Target;
    let rect: DOMRect | { left: number; top: number; width: number; height: number };
    if (tiled) {
      const sideEl = panes.querySelector<HTMLElement>(':scope > .side');
      const mainEl = panes.querySelector<HTMLElement>(':scope > .scroller');
      const sideBox = sideEl?.getBoundingClientRect();
      want = sideBox && e.clientX >= sideBox.left - 5 ? 'side' : 'main';
      const r = (want === 'side' ? sideBox : mainEl?.getBoundingClientRect()) ?? box;
      rect = { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height };
    } else {
      want = !narrow && x > box.width / 2 ? 'side' : 'main';
      const w = box.width - inset * 2;
      // The page alone fills the area; beside it takes the split's share.
      const sideW = Math.round(w * split.ratio);
      rect =
        want === 'side'
          ? { left: box.width - inset - sideW, top: inset, width: sideW, height: box.height - inset * 2 }
          : { left: inset, top: inset, width: w, height: box.height - inset * 2 };
    }
    // Nothing to do dropping a page back where it came from.
    if ((want === 'main' && drag.from === 'main') || (want === 'side' && drag.from === 'side')) return null;
    return { want, rect };
  }

  function ondragover(e: DragEvent) {
    e.preventDefault();
    const hit = locate(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = hit ? 'move' : 'none';
    target = hit?.want ?? null;
    split.preview = target;
    if (hit) ghost = { left: hit.rect.left, top: hit.rect.top, width: hit.rect.width, height: hit.rect.height };
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    const hit = locate(e);
    const { id, from } = drag;
    target = null;
    split.preview = null;
    endDrag();
    if (id && hit) split.drop(id, from, hit.want);
  }
</script>

<!-- However a drag ends (dropped elsewhere, Esc), the layer goes. -->
<svelte:window ondragend={() => ((split.preview = null), drag.id && endDrag())} />

{#if page}
  <div
    class="layer"
    bind:this={layer}
    role="region"
    aria-label={t('shell.splitDrop.label', { title: page.title || t('common.untitled') })}
    {ondragover}
    ondragleave={(e) => {
      if (layer?.contains(e.relatedTarget as Node)) return;
      target = null;
      split.preview = null;
    }}
    {ondrop}
  >
    <div
      class="ghost"
      class:shown={!!target}
      style:left="{ghost.left}px"
      style:top="{ghost.top}px"
      style:width="{ghost.width}px"
      style:height="{ghost.height}px"
    >
      <div class="pill">
        <Icon name={target === 'side' ? 'split' : 'page'} size={14} />
        <span class="verb">{label}</span>
        <span class="name">{page.title || t('common.untitled')}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .layer {
    position: absolute;
    inset: 0;
    z-index: 20;
  }
  /* Where the page will go: a soft tinted outline, never a slab. */
  .ghost {
    position: absolute;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 16px;
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    box-shadow:
      inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 38%, transparent),
      0 0 0 4px color-mix(in srgb, var(--accent) 7%, transparent);
    opacity: 0;
    transform: scale(0.985);
    pointer-events: none;
    transition:
      left 200ms var(--ease-out),
      top 200ms var(--ease-out),
      width 200ms var(--ease-out),
      height 200ms var(--ease-out),
      opacity 140ms var(--ease),
      transform 200ms var(--ease-out);
  }
  .ghost.shown {
    opacity: 1;
    transform: none;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: calc(100% - 32px);
    height: 30px;
    padding: 0 13px 0 10px;
    border-radius: 999px;
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 4px 14px -4px rgb(0 0 0 / 0.18);
    font-size: var(--fs-ui);
    color: var(--text-2);
    white-space: nowrap;
  }
  .verb {
    font-weight: var(--fw-600, 600);
    color: var(--text);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-3);
  }
  .name::before {
    content: '·';
    margin-right: 7px;
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost {
      transition: opacity 80ms linear;
    }
  }
</style>
