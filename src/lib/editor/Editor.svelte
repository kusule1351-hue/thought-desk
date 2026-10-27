<script lang="ts">
  import { Editor, type JSONContent } from '@tiptap/core';
  import { Selection } from '@tiptap/pm/state';
  import { onMount } from 'svelte';
  import { normalizeFileUrl } from '../api';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import type { Page, PagePatch } from '../types';
  import { blockMenuItems } from './blocks';
  import { buildExtensions } from './extensions';
  import { cowork, type Session } from '../cowork.svelte';
  import BubbleMenu from './BubbleMenu.svelte';
  import TableMenu from './TableMenu.svelte';
  import { t } from '../i18n';

  let {
    page,
    onstats,
    onempty,
  }: {
    page: Page;
    onstats?: (words: number) => void;
    /** Whether the page body is empty (told on start and as it changes). */
    onempty?: (empty: boolean) => void;
  } = $props();

  let host: HTMLDivElement;
  let editor = $state<Editor | null>(null);

  const SAVE_DELAY = 350;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Fixes stored image URLs for this platform; walks the doc in place. */
  function normalize(node: JSONContent) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      node.attrs.src = normalizeFileUrl(node.attrs.src);
    }
    node.content?.forEach(normalize);
  }

  function parseContent(raw: string): { content: JSONContent | string; legacy: boolean } {
    if (!raw) return { content: '', legacy: false };
    try {
      const json = JSON.parse(raw) as JSONContent;
      normalize(json);
      return { content: json, legacy: false };
    } catch {
      // Seeded pages are stored as HTML until their first save.
      return { content: raw, legacy: true };
    }
  }

  /** The search text last sent; re-indexing is skipped when it's unchanged. */
  let savedText: string | undefined;

  function save() {
    clearTimeout(timer);
    if (!dirty || !editor || editor.isDestroyed) return;
    dirty = false;
    const patch: PagePatch = { content: JSON.stringify(editor.getJSON()) };
    // Formatting, moving blocks and ticking boxes don't change the words.
    const text = editor.getText({ blockSeparator: '\n' });
    if (text !== savedText) patch.text = savedText = text;
    store.update(page.id, patch, { immediate: true });
  }

  function stats() {
    if (editor && !editor.isDestroyed) onstats?.(editor.storage.characterCount.words());
  }

  /**
   * Puts the caret at the start or end right away. TipTap's focus() waits a
   * frame, and a key typed in that frame (Enter in the title, then straight
   * on typing) would still land where focus was.
   */
  function focusAt(where: 'start' | 'end') {
    if (!editor || editor.isDestroyed) return;
    const { state, view } = editor;
    view.dispatch(state.tr.setSelection(where === 'start' ? Selection.atStart(state.doc) : Selection.atEnd(state.doc)).scrollIntoView());
    view.focus();
  }

  export function focusStart() {
    focusAt('start');
  }

  export function focusEnd() {
    focusAt('end');
  }

  /** Fills an empty page with starter blocks, the caret in the first empty line. */
  export function start(content: JSONContent[]) {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setContent({ type: 'doc', content }, { emitUpdate: true });
    let at: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (at !== null) return false;
      if (node.isTextblock && node.content.size === 0) at = pos + 1;
      return true;
    });
    editor.chain().focus(at ?? 'end').run();
  }

  /** Puts a database (made from the page's starter row) into the page. */
  export function insertDatabase(id: string) {
    if (!editor || editor.isDestroyed) return;
    editor.chain().focus('end').insertContent([{ type: 'databaseBlock', attrs: { id } }, { type: 'paragraph' }]).run();
  }

  onMount(() => {
    let ed: Editor | null = null;
    let session: Session | null = null;
    let unwatch: (() => void) | null = null;
    let gone = false;

    /** Builds the editor: on the shared document for a shared page, else on the stored body. */
    function mount() {
      const { content, legacy } = session ? { content: undefined, legacy: false } : parseContent(page.content);
      const handle = {
        onMenu: (target: Parameters<typeof blockMenuItems>[1], anchor: HTMLElement) => {
          const rect = anchor.getBoundingClientRect();
          if (ed) ui.openMenu({ x: rect.left, y: rect.bottom + 4, items: blockMenuItems(ed, target) });
        },
      };
      const made = new Editor({
        element: host,
        content,
        extensions: buildExtensions(
          handle,
          session
            ? { doc: session.doc, provider: { awareness: session.awareness }, user: session.user, friendColor: () => session?.people.find((p) => !p.me)?.color, awake: (id) => !!session?.isAwake(id) }
            : undefined,
        ),
        editorProps: {
          attributes: {
            class: 'prose',
            spellcheck: String(prefs.spellcheck),
            'aria-label': t('editor.pageContent'),
          },
        },
        // A shared page renders its document while the editor is still being made.
        onUpdate: ({ editor: e }) => {
          onempty?.(e.isEmpty);
          dirty = true;
          clearTimeout(timer);
          timer = setTimeout(() => {
            save();
            stats();
          }, SAVE_DELAY);
        },
      });
      ed = made;
      editor = made;
      if (import.meta.env.DEV) (window as any).__editor = made;
      onempty?.(made.isEmpty);
      stats();
      if (legacy) {
        // Convert seeded HTML into stored JSON right away.
        dirty = true;
        save();
      }
    }

    if (page.sharedRoom && cowork.isLive(page.id)) {
      void cowork.open(page.id, page.sharedRoom).then(
        (s) => {
          if (gone) return cowork.release(page.id);
          session = s;
          mount();
          // Being at the page keeps the session connected (or reconnects it).
          unwatch = s.watch(host);
        },
        (e) => ui.error(e),
      );
    } else mount();

    const flushOnHide = () => document.visibilityState === 'hidden' && save();
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('td:flush', save);
    // Quick Capture adding a to-do to this page while it's open.
    const appendTodo = (e: Event) => {
      const { pageId, text } = (e as CustomEvent<{ pageId: string; text: string }>).detail;
      if (pageId !== page.id || !ed || ed.isDestroyed) return;
      const item = { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
      ed.chain().insertContentAt(ed.state.doc.content.size, { type: 'taskList', content: [item] }).run();
    };
    window.addEventListener('td:append-todo', appendTodo);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('td:flush', save);
      window.removeEventListener('td:append-todo', appendTodo);
      save();
      ed?.destroy();
      unwatch?.();
      if (session) cowork.release(page.id);
    };
  });

  // Live-apply the spellcheck preference.
  $effect(() => {
    const value = String(prefs.spellcheck);
    editor?.view.dom.setAttribute('spellcheck', value);
  });
</script>

<!-- --list-hint: the hint app.css shows in an empty list item (a CSS string, hence the quotes). -->
<div class="editor-host" bind:this={host} style:--list-hint={JSON.stringify(t('editor.placeholder.listItem'))}></div>
{#if editor}
  <BubbleMenu {editor} />
  <TableMenu {editor} />
{/if}
