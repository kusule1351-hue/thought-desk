<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n';

  let { editor }: { editor: Editor } = $props();
  let el: HTMLDivElement;

  /** The DOM table that contains the selection. */
  function currentTable(): HTMLElement | null {
    const { view, state } = editor;
    const dom = view.domAtPos(state.selection.from).node;
    const elem = dom instanceof HTMLElement ? dom : dom.parentElement;
    return (elem?.closest('.tableWrapper') as HTMLElement) ?? (elem?.closest('table') as HTMLElement) ?? null;
  }

  onMount(() => {
    const key = 'tableBubble';
    editor.registerPlugin(
      BubbleMenuPlugin({
        pluginKey: key,
        editor,
        element: el,
        updateDelay: 0,
        shouldShow: ({ editor }) => editor.isEditable && editor.isActive('table'),
        getReferencedVirtualElement: () => {
          const table = currentTable();
          return table ? { getBoundingClientRect: () => table.getBoundingClientRect() } : null;
        },
        options: { strategy: 'fixed', placement: 'top-end', offset: 8, flip: false, shift: { padding: 8 } },
      }),
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  });

  const run = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    fn();
  };
</script>

<div class="table-menu popover" bind:this={el} style="visibility: hidden">
  <button onmousedown={run(() => editor.chain().focus().addRowAfter().run())} data-tip={t('editor.table.addRow')}><Icon name="row-plus" size={15} /></button>
  <button onmousedown={run(() => editor.chain().focus().addColumnAfter().run())} data-tip={t('editor.table.addColumn')}><Icon name="col-plus" size={15} /></button>
  <span class="sep"></span>
  <button onmousedown={run(() => editor.chain().focus().deleteRow().run())} data-tip={t('editor.table.deleteRow')}><Icon name="row-minus" size={15} /></button>
  <button onmousedown={run(() => editor.chain().focus().deleteColumn().run())} data-tip={t('editor.table.deleteColumn')}><Icon name="col-minus" size={15} /></button>
  <span class="sep"></span>
  <button onmousedown={run(() => editor.chain().focus().toggleHeaderRow().run())} data-tip={t('editor.table.toggleHeader')}><Icon name="header" size={15} /></button>
  <button onmousedown={run(() => editor.chain().focus().deleteTable().run())} data-tip={t('editor.table.delete')}><Icon name="trash" size={15} /></button>
</div>

<style>
  .table-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 35;
    display: flex;
    align-items: center;
    gap: 2px;
    /* 36px bar − 4px padding = 28px buttons; 10px − 4px = 6px corners. */
    height: 36px;
    padding: 0 4px;
    border-radius: var(--r-md);
    animation: table-menu-in var(--dur) var(--ease-out);
  }
  @keyframes table-menu-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
  }
  button {
    display: grid;
    place-items: center;
    width: var(--h-sm);
    height: var(--h-sm);
    border-radius: var(--r-xs);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  button:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--hairline);
    margin: 0 2px;
  }
</style>
