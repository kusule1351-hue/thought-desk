import { TextSelection } from '@tiptap/pm/state';
import { Extension, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Typography from '@tiptap/extension-typography';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Callout } from './callout';
import { Mention, PageLink } from './page-link';
import { SlashCommand } from './slash';
import { MentionSuggest } from './mention';
import { BlockHandle, type BlockHandleOptions } from './block-handle';
import { FloatSafe } from './float-safe';
import { ImageDrop } from './images';
import { FileBlock } from './file-block';
import { DatabaseNode } from './database-block.svelte';
import { Flashcard, FlashcardBack, FlashcardFront } from './flashcard';
import { InlineMath, MathBlock } from './math';
import { MathPaste } from './math-paste';
import { ColorHighlight, TextColor } from './text-color';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { RemoteGlow } from './remote-glow';
import type { Doc as YDoc } from 'yjs';
import { storedName } from '../api';
import { ui } from '../ui.svelte';
import { t } from '../i18n';

/** Editor-wide shortcuts that don't belong to a single node type. */
const Shortcuts = Extension.create({
  name: 'tdShortcuts',
  // Run after list/code keymaps so they get the first chance at Tab.
  priority: 50,
  addKeyboardShortcuts() {
    return {
      'Mod-k': ({ editor }) => {
        // Only selected text gets a link; otherwise Ctrl+K is search.
        const sel = editor.state.selection;
        if (sel.empty || !(sel instanceof TextSelection)) return false;
        // Only this editor's bubble menu answers (with two pages open side by side).
        window.dispatchEvent(new CustomEvent('td:edit-link', { detail: { editor } }));
        return true;
      },
      'Mod-d': ({ editor }) => {
        // Duplicate the current top-level block.
        const { $from } = editor.state.selection;
        if ($from.depth < 1) return false;
        const node = $from.node(1);
        const end = $from.after(1);
        editor.view.dispatch(editor.state.tr.insert(end, node));
        return true;
      },
      // Keep focus inside the editor instead of tabbing to other controls.
      Tab: () => true,
      'Shift-Tab': () => true,
    };
  },
});

/**
 * Enter at the end of an open toggle's summary moves into its body. The
 * stock handler always inserts a new paragraph, which strands the empty one
 * a freshly created toggle already has.
 */
const ToggleEnter = Extension.create({
  name: 'toggleEnter',
  priority: 200,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $head, empty } = state.selection;
        if (!empty || $head.parent.type.name !== 'detailsSummary') return false;
        if ($head.parentOffset !== $head.parent.content.size) return false;
        const details = $head.node(-1);
        const contentPos = $head.after();
        const content = state.doc.nodeAt(contentPos);
        const first = content?.firstChild;
        if (!details.attrs.open || content?.type.name !== 'detailsContent') return false;
        if (!first || first.type.name !== 'paragraph' || first.content.size !== 0) return false;
        return editor.commands.setTextSelection(contentPos + 2);
      },
    };
  },
});

/** Ctrl/Cmd-click opens links in the system browser. */
const LinkOpener = Extension.create({
  name: 'linkOpener',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('linkOpener'),
        props: {
          handleClick(_view, _pos, event) {
            const a = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
            if (!a) return false;
            if (event.ctrlKey || event.metaKey || !_view.editable) {
              event.preventDefault();
              openUrl(a.href).catch(ui.error);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** Pictures from the web shown here since the app started (see SharedImage). */
const shownRemote = new Set<string>();

/** In a page written together, a picture from a web address waits for a
 *  click: the other person may have put it there, and loading it tells that
 *  site your IP address. Pictures from the library load as usual. */
const SharedImage = Image.extend({
  addNodeView() {
    const parent = this.parent?.();
    return (props) => {
      const src = String(props.node.attrs.src ?? '');
      if (!/^https?:\/\//i.test(src) || storedName(src) || shownRemote.has(src)) {
        if (parent) return parent(props);
        const img = document.createElement('img');
        img.src = src;
        return { dom: img };
      }
      let host = src;
      try {
        host = new URL(src).host;
      } catch {
        /* shown as written */
      }
      const dom = document.createElement('div');
      dom.className = 'remote-image';
      dom.contentEditable = 'false';
      const label = document.createElement('span');
      label.textContent = t('editor.remoteImage.label', { host });
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'btn small';
      show.textContent = t('common.actions.show');
      show.addEventListener('click', () => {
        shownRemote.add(src);
        const img = document.createElement('img');
        img.src = src;
        img.alt = String(props.node.attrs.alt ?? '');
        img.decoding = 'async';
        dom.replaceChildren(img);
        dom.classList.add('shown');
      });
      dom.append(label, show);
      return {
        dom,
        // The same picture keeps what's showing; another one is drawn afresh.
        update: (node) => node.type === props.node.type && node.attrs.src === src,
        ignoreMutation: () => true,
        stopEvent: (e) => e.target === show,
      };
    };
  },
});

/** A shared page's editor (see cowork.svelte.ts): its document, connection and who's typing. */
export interface CollabSetup {
  doc: YDoc;
  provider: unknown;
  user: { name: string; color: string; id: number };
  /** The other person's cursor colour, for the glow on what they just typed. */
  friendColor: () => string | undefined;
  /** Whether a person's name is showing now (Session.isAwake). */
  awake: (id: number) => boolean;
}

/** Another person's cursor, marked with their client id so their name can
 *  show only while they're active (Session.showName in cowork.svelte.ts).
 *  The editor redraws a cursor while its person types; a new one starts with
 *  its name showing, or the name would drop out until the next keystroke. */
function caret(user: Record<string, unknown>, awake: (id: number) => boolean): HTMLElement {
  const cursor = document.createElement('span');
  cursor.className = awake(Number(user.id)) ? 'collaboration-carets__caret awake' : 'collaboration-carets__caret';
  cursor.style.borderColor = String(user.color);
  cursor.dataset.who = String(Number(user.id) || '');
  const label = document.createElement('div');
  label.className = 'collaboration-carets__label';
  label.style.backgroundColor = String(user.color);
  label.textContent = String(user.name ?? '');
  cursor.append(label);
  return cursor;
}

export function buildExtensions(handle: BlockHandleOptions, collab?: CollabSetup): AnyExtension[] {
  return [
    ...(collab
      ? [
          Collaboration.configure({ document: collab.doc }),
          CollaborationCaret.configure({ provider: collab.provider, user: collab.user, render: (user) => caret(user, collab.awake) }),
          RemoteGlow.configure({ color: collab.friendColor }),
        ]
      : []),
    StarterKit.configure({
      // A shared page's undo comes with Collaboration (and undoes only your own edits).
      ...(collab ? { undoRedo: false as const } : {}),
      heading: { levels: [1, 2, 3] },
      dropcursor: { color: 'var(--text)', width: 2 },
      codeBlock: { enableTabIndentation: true, tabSize: 2, HTMLAttributes: { spellcheck: 'false' } },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
      a11y: { checkboxLabel: (node) => (node.textContent ? t('editor.taskCheckbox', { text: node.textContent }) : t('editor.taskCheckboxEmpty')) },
    }),
    Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }),
    DetailsSummary,
    DetailsContent,
    ToggleEnter,
    TableKit.configure({ table: { resizable: true, cellMinWidth: 80 } }),
    (collab ? SharedImage : Image).configure({
      inline: false,
      allowBase64: false,
      // A page of hundreds of photos only loads and decodes what's on screen.
      HTMLAttributes: { loading: 'lazy', decoding: 'async' },
      resize: { enabled: true, directions: ['left', 'right'], minWidth: 80, minHeight: 40, alwaysPreserveAspectRatio: true },
    }),
    ColorHighlight,
    TextColor,
    Typography,
    CharacterCount,
    Placeholder.configure({
      includeChildren: true,
      showOnlyCurrent: true,
      // Decided from the node alone: this runs while the new document is
      // being drawn, when looking positions up in editor.state (still the old
      // one) can throw. Paragraphs in lists and tables are handled in app.css.
      placeholder: ({ node }) => {
        // Only lines of text get a hint. Containers count as "empty" too
        // (a new table, an empty quote), and would show it over their cells.
        if (!node.isTextblock) return '';
        if (node.type.name === 'heading') return t('editor.placeholder.heading', { level: Number(node.attrs.level) });
        if (node.type.name === 'detailsSummary') return t('editor.placeholder.toggle');
        if (node.type.name === 'codeBlock') return '';
        if (node.type.name === 'flashcardFront') return t('editor.placeholder.flashcardFront');
        if (node.type.name === 'flashcardBack') return t('editor.placeholder.flashcardBack');
        return t('editor.placeholder.paragraph');
      },
    }),
    Callout,
    PageLink,
    Mention,
    FileBlock,
    DatabaseNode,
    InlineMath,
    MathBlock,
    MathPaste,
    Flashcard,
    FlashcardFront,
    FlashcardBack,
    SlashCommand,
    MentionSuggest,
    ImageDrop,
    LinkOpener,
    Shortcuts,
    BlockHandle.configure(handle),
    FloatSafe,
  ];
}
