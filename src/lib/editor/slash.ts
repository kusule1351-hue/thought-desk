import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { clock } from '../clock.svelte';
import { comboLabel } from '../shortcuts.svelte';
import { planner } from '../planner.svelte';
import { store } from '../store.svelte';
import { ui } from '../ui.svelte';
import { databases } from '../databases.svelte';
import { insertFiles, insertImage, pickImageFile } from './images';
import { rank, suggestionRenderer, type MenuEntry } from './suggestion.svelte';
import { iconText } from '../page-icon';
import { searchText, t } from '../i18n';
import { fmt } from '../i18n/format';

const clear = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

/** The caret's position on screen, for anchoring popovers. */
function caretRect(editor: Editor): DOMRect {
  const c = editor.view.coordsAtPos(editor.state.selection.from);
  return new DOMRect(c.left, c.top, 0, c.bottom - c.top);
}

/** Inserts an inline link to a just-created assignment or event. */
function linkCreated(editor: Editor, kind: 'assignment' | 'event') {
  return (id: string) => {
    if (editor.isDestroyed) return;
    editor
      .chain()
      .focus()
      .insertContent([{ type: 'mention', attrs: { id, kind } }, { type: 'text', text: ' ' }])
      .run();
  };
}

type SlashGroup = 'basic' | 'media' | 'planner' | 'pages' | 'study' | 'inline';
/** The "/" menu's sections and what each is called. */
export const SLASH_GROUP_LABELS: Record<SlashGroup, string> = {
  basic: t('editor.slash.group.basic'),
  media: t('editor.slash.group.media'),
  planner: t('editor.slash.group.planner'),
  pages: t('editor.slash.group.pages'),
  study: t('editor.slash.group.study'),
  inline: t('editor.slash.group.inline'),
};

const ITEMS: (MenuEntry & { group: SlashGroup })[] = [
  {
    id: 'text',
    group: 'basic',
    title: t('editor.blockType.paragraph'),
    description: t('editor.slash.text.description'),
    icon: 'text',
    keywords: searchText('editor.blockType.paragraph', 'editor.slash.text.keywords'),
    run: (e, r) => clear(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    group: 'basic',
    title: t('editor.blockType.h1'),
    description: t('editor.slash.h1.description'),
    label: t('editor.slash.h1.glyph'),
    hint: '#',
    keywords: searchText('editor.blockType.h1', 'editor.slash.h1.keywords'),
    run: (e, r) => clear(e, r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    group: 'basic',
    title: t('editor.blockType.h2'),
    description: t('editor.slash.h2.description'),
    label: t('editor.slash.h2.glyph'),
    hint: '##',
    keywords: searchText('editor.blockType.h2', 'editor.slash.h2.keywords'),
    run: (e, r) => clear(e, r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    group: 'basic',
    title: t('editor.blockType.h3'),
    description: t('editor.slash.h3.description'),
    label: t('editor.slash.h3.glyph'),
    hint: '###',
    keywords: searchText('editor.blockType.h3', 'editor.slash.h3.keywords'),
    run: (e, r) => clear(e, r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'todo',
    group: 'basic',
    title: t('editor.blockType.taskList'),
    description: t('editor.slash.todo.description'),
    icon: 'todo',
    hint: '[]',
    keywords: searchText('editor.blockType.taskList', 'editor.slash.todo.keywords'),
    run: (e, r) => clear(e, r).toggleTaskList().run(),
  },
  {
    id: 'bullet',
    group: 'basic',
    title: t('editor.blockType.bulletList'),
    description: t('editor.slash.bullet.description'),
    icon: 'list',
    hint: '-',
    keywords: searchText('editor.blockType.bulletList', 'editor.slash.bullet.keywords'),
    run: (e, r) => clear(e, r).toggleBulletList().run(),
  },
  {
    id: 'numbered',
    group: 'basic',
    title: t('editor.blockType.orderedList'),
    description: t('editor.slash.numbered.description'),
    icon: 'list-ordered',
    hint: '1.',
    keywords: searchText('editor.blockType.orderedList', 'editor.slash.numbered.keywords'),
    run: (e, r) => clear(e, r).toggleOrderedList().run(),
  },
  {
    id: 'toggle',
    group: 'basic',
    title: t('editor.slash.toggle.title'),
    description: t('editor.slash.toggle.description'),
    icon: 'toggle',
    keywords: searchText('editor.slash.toggle.title', 'editor.slash.toggle.keywords'),
    // New toggles start open so Enter in the summary moves into the body.
    run: (e, r) => clear(e, r).setParagraph().setDetails().updateAttributes('details', { open: true }).run(),
  },
  {
    id: 'quote',
    group: 'basic',
    title: t('editor.blockType.blockquote'),
    description: t('editor.slash.quote.description'),
    icon: 'quote',
    hint: '>',
    keywords: searchText('editor.blockType.blockquote', 'editor.slash.quote.keywords'),
    run: (e, r) => clear(e, r).setParagraph().toggleBlockquote().run(),
  },
  {
    id: 'callout',
    group: 'basic',
    title: t('editor.blockType.callout'),
    description: t('editor.slash.callout.description'),
    icon: 'callout',
    keywords: searchText('editor.blockType.callout', 'editor.slash.callout.keywords'),
    run: (e, r) => clear(e, r).setParagraph().setCallout().run(),
  },
  {
    id: 'divider',
    group: 'basic',
    title: t('editor.slash.divider.title'),
    description: t('editor.slash.divider.description'),
    icon: 'divider',
    hint: '---',
    keywords: searchText('editor.slash.divider.title', 'editor.slash.divider.keywords'),
    run: (e, r) => clear(e, r).setHorizontalRule().run(),
  },
  {
    id: 'code',
    group: 'basic',
    title: t('editor.blockType.codeBlock'),
    description: t('editor.slash.code.description'),
    icon: 'code',
    hint: '```',
    keywords: searchText('editor.blockType.codeBlock', 'editor.slash.code.keywords'),
    run: (e, r) => clear(e, r).setCodeBlock().run(),
  },
  {
    id: 'math',
    group: 'basic',
    title: t('editor.slash.math.title'),
    description: t('editor.slash.math.description'),
    icon: 'sigma',
    hint: '$$',
    keywords: searchText('editor.slash.math.title', 'editor.slash.math.keywords'),
    run: (e, r) => clear(e, r).insertMathBlock().run(),
  },
  {
    id: 'inline-math',
    group: 'basic',
    title: t('editor.slash.inlineMath.title'),
    description: t('editor.slash.inlineMath.description'),
    icon: 'function',
    hint: comboLabel('Mod+Shift+KeyE'),
    keywords: searchText('editor.slash.inlineMath.title', 'editor.slash.inlineMath.keywords'),
    run: (e, r) => clear(e, r).insertInlineMath().run(),
  },
  {
    id: 'table',
    group: 'basic',
    title: t('editor.slash.table.title'),
    description: t('editor.slash.table.description'),
    icon: 'table',
    keywords: searchText('editor.slash.table.title', 'editor.slash.table.keywords'),
    run: (e, r) => clear(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'image',
    group: 'media',
    title: t('editor.slash.image.title'),
    description: t('editor.slash.image.description'),
    icon: 'image',
    keywords: searchText('editor.slash.image.title', 'editor.slash.image.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      void pickImageFile().then((file) => file && insertImage(e, file));
    },
  },
  {
    id: 'file',
    group: 'media',
    title: t('editor.slash.file.title'),
    description: t('editor.slash.file.description'),
    icon: 'paperclip',
    keywords: searchText('editor.slash.file.title', 'editor.slash.file.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      ui.pickFile(caretRect(e), (files) => insertFiles(e, files));
    },
  },
  {
    id: 'assignment',
    group: 'planner',
    title: t('editor.slash.assignment.title'),
    description: t('editor.slash.assignment.description'),
    icon: 'assignment',
    keywords: searchText('editor.slash.assignment.title', 'editor.slash.assignment.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      ui.assignmentSheet = { id: null, draft: {}, onCreated: linkCreated(e, 'assignment') };
    },
  },
  {
    id: 'event',
    group: 'planner',
    title: t('editor.slash.event.title'),
    description: t('editor.slash.event.description'),
    icon: 'calendar',
    keywords: searchText('editor.slash.event.title', 'editor.slash.event.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      ui.eventSheet = {
        id: null,
        draft: { startDate: clock.today, endDate: clock.today },
        onCreated: linkCreated(e, 'event'),
      };
    },
  },
  {
    id: 'page',
    group: 'pages',
    title: t('editor.slash.page.title'),
    description: t('editor.slash.page.description'),
    icon: 'page-plus',
    keywords: searchText('editor.slash.page.title', 'editor.slash.page.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      const parent = store.currentId;
      void store.create(parent, { open: false }).then((meta) => {
        if (!meta || e.isDestroyed) return;
        e.chain().focus().insertContent({ type: 'pageLink', attrs: { id: meta.id } }).run();
        store.open(meta.id);
        ui.focusTitle = meta.id;
      });
    },
  },
  {
    id: 'database',
    group: 'pages',
    title: t('editor.slash.database.title'),
    description: t('editor.slash.database.description'),
    icon: 'database',
    keywords: searchText('editor.slash.database.title', 'editor.slash.database.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      ui.newDatabase = {
        parentId: store.currentId,
        onCreated: (id) => {
          if (!e.isDestroyed) e.chain().focus().insertContent([{ type: 'databaseBlock', attrs: { id } }, { type: 'paragraph' }]).run();
        },
      };
    },
  },
  {
    id: 'linked-database',
    group: 'pages',
    title: t('editor.slash.linkedDatabase.title'),
    description: t('editor.slash.linkedDatabase.description'),
    icon: 'database',
    keywords: searchText('editor.slash.linkedDatabase.title', 'editor.slash.linkedDatabase.keywords'),
    run: (e, r) => {
      clear(e, r).run();
      const rect = caretRect(e);
      const list = databases.list;
      ui.openMenu({
        x: rect.left,
        y: rect.bottom + 6,
        items: list.length
          ? [
              { header: t('editor.slash.linkedDatabase.menuHeader') },
              ...list.map((d) => ({
                label: d.title || t('common.untitledDatabase'),
                icon: 'database',
                hint: iconText(d.icon) || undefined,
                action: () => {
                  if (!e.isDestroyed) e.chain().focus().insertContent([{ type: 'databaseBlock', attrs: { id: d.id } }, { type: 'paragraph' }]).run();
                },
              })),
            ]
          : [{ label: t('editor.slash.linkedDatabase.none'), icon: 'plus', action: () => (ui.newDatabase = { parentId: null }) }],
      });
    },
  },
  {
    id: 'link',
    group: 'pages',
    title: t('editor.slash.link.title'),
    description: t('editor.slash.link.description'),
    icon: 'at',
    hint: '@',
    keywords: searchText('editor.slash.link.title', 'editor.slash.link.keywords'),
    run: (e, r) => clear(e, r).insertContent('@').run(),
  },
  {
    id: 'flashcard',
    group: 'study',
    title: t('editor.slash.flashcard.title'),
    description: t('editor.slash.flashcard.description'),
    icon: 'cards',
    keywords: searchText('editor.slash.flashcard.title', 'editor.slash.flashcard.keywords'),
    run: (e, r) => clear(e, r).insertFlashcard().run(),
  },
  {
    id: 'date',
    group: 'inline',
    title: t('editor.slash.date.title'),
    description: fmt.date(new Date(), { dateStyle: 'long' }),
    icon: 'calendar',
    keywords: searchText('editor.slash.date.title', 'editor.slash.date.keywords'),
    run: (e, r) =>
      clear(e, r)
        .insertContent(fmt.date(new Date(), { dateStyle: 'long' }) + ' ')
        .run(),
  },
];

export const SLASH_ITEMS: MenuEntry[] = ITEMS.map((i) => ({ ...i, groupLabel: SLASH_GROUP_LABELS[i.group] }));

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<MenuEntry, MenuEntry>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock' && !$from.parent.type.spec.code;
        },
        items: ({ query }) =>
          query ? rank(SLASH_ITEMS, query, 12).map((i) => ({ ...i, group: undefined })) : SLASH_ITEMS,
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestionRenderer(t('editor.slash.empty')),
      }),
    ];
  },
});
