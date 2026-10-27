/** Block-level actions used by the block menu and the bubble menu. */

import type { Editor } from '@tiptap/core';
import { comboLabel } from '../shortcuts.svelte';
import { TextSelection } from '@tiptap/pm/state';
import type { MenuItem } from '../ui.svelte';
import type { BlockTarget } from './block-handle';
import { t } from '../i18n';

export type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock' | 'callout';

export const KINDS: { kind: BlockKind; label: string; icon: string }[] = [
  { kind: 'paragraph', label: t('editor.blockType.paragraph'), icon: 'text' },
  { kind: 'h1', label: t('editor.blockType.h1'), icon: 'h1' },
  { kind: 'h2', label: t('editor.blockType.h2'), icon: 'h2' },
  { kind: 'h3', label: t('editor.blockType.h3'), icon: 'h3' },
  { kind: 'bulletList', label: t('editor.blockType.bulletList'), icon: 'list' },
  { kind: 'orderedList', label: t('editor.blockType.orderedList'), icon: 'list-ordered' },
  { kind: 'taskList', label: t('editor.blockType.taskList'), icon: 'todo' },
  { kind: 'blockquote', label: t('editor.blockType.blockquote'), icon: 'quote' },
  { kind: 'codeBlock', label: t('editor.blockType.codeBlock'), icon: 'code' },
  { kind: 'callout', label: t('editor.blockType.callout'), icon: 'callout' },
];

const LISTS = ['bulletList', 'orderedList', 'taskList'] as const;

/** The kind of block the selection is in, for the "Turn into" label. */
export function currentKind(editor: Editor): BlockKind {
  if (editor.isActive('heading', { level: 1 })) return 'h1';
  if (editor.isActive('heading', { level: 2 })) return 'h2';
  if (editor.isActive('heading', { level: 3 })) return 'h3';
  if (editor.isActive('codeBlock')) return 'codeBlock';
  if (editor.isActive('taskList')) return 'taskList';
  if (editor.isActive('orderedList')) return 'orderedList';
  if (editor.isActive('bulletList')) return 'bulletList';
  if (editor.isActive('callout')) return 'callout';
  if (editor.isActive('blockquote')) return 'blockquote';
  return 'paragraph';
}

/** Converts the block containing the selection. */
export function turnInto(editor: Editor, kind: BlockKind) {
  const chain = editor.chain().focus();
  const inList = LISTS.find((l) => editor.isActive(l));
  const needsPlainBlock = ['paragraph', 'h1', 'h2', 'h3', 'codeBlock'].includes(kind);

  // Leave the current list first when converting to a non-list block.
  if (inList && needsPlainBlock) {
    chain.liftListItem(inList === 'taskList' ? 'taskItem' : 'listItem');
  }
  switch (kind) {
    case 'paragraph':
      chain.setParagraph();
      if (editor.isActive('blockquote')) chain.lift('blockquote');
      if (editor.isActive('callout')) chain.lift('callout');
      break;
    case 'h1':
    case 'h2':
    case 'h3':
      chain.setHeading({ level: Number(kind[1]) as 1 | 2 | 3 });
      break;
    case 'bulletList':
      if (inList !== 'bulletList') chain.setParagraph().toggleBulletList();
      break;
    case 'orderedList':
      if (inList !== 'orderedList') chain.setParagraph().toggleOrderedList();
      break;
    case 'taskList':
      if (inList !== 'taskList') chain.setParagraph().toggleTaskList();
      break;
    case 'blockquote':
      if (!editor.isActive('blockquote')) chain.setParagraph().toggleBlockquote();
      break;
    case 'codeBlock':
      chain.setCodeBlock();
      break;
    case 'callout':
      if (!editor.isActive('callout')) chain.setParagraph().setCallout();
      break;
  }
  chain.run();
}

function selectInside(editor: Editor, pos: number) {
  const { state, view } = editor;
  const $pos = state.doc.resolve(Math.min(pos + 1, state.doc.content.size));
  view.dispatch(state.tr.setSelection(TextSelection.near($pos)));
}

/** Items for the grip menu of a block. */
export function blockMenuItems(editor: Editor, target: BlockTarget): MenuItem[] {
  const { node, pos } = target;
  const items: MenuItem[] = [];
  const convertible = node.isTextblock || ['listItem', 'taskItem', 'blockquote', 'callout'].includes(node.type.name);

  if (convertible && node.type.name !== 'codeBlock' && node.type.name !== 'detailsSummary') {
    items.push({ header: t('editor.blockMenu.turnInto') });
    for (const k of KINDS) {
      items.push({
        label: k.label,
        icon: k.icon,
        action: () => {
          selectInside(editor, pos);
          turnInto(editor, k.kind);
        },
      });
    }
    items.push({ separator: true });
  }

  const $pos = editor.state.doc.resolve(pos);
  const parent = $pos.parent;
  const index = $pos.index();

  items.push(
    {
      label: t('common.actions.duplicate'),
      icon: 'copy',
      hint: comboLabel('Mod+KeyD'),
      action: () => {
        const { tr } = editor.state;
        editor.view.dispatch(tr.insert(pos + node.nodeSize, node));
      },
    },
    {
      label: t('editor.blockMenu.moveUp'),
      icon: 'arrow-up',
      disabled: index === 0,
      action: () => {
        if (index === 0) return;
        const prev = parent.child(index - 1);
        const tr = editor.state.tr.delete(pos, pos + node.nodeSize).insert(pos - prev.nodeSize, node);
        editor.view.dispatch(tr);
      },
    },
    {
      label: t('editor.blockMenu.moveDown'),
      icon: 'arrow-down',
      disabled: index >= parent.childCount - 1,
      action: () => {
        if (index >= parent.childCount - 1) return;
        const next = parent.child(index + 1);
        const tr = editor.state.tr.delete(pos, pos + node.nodeSize).insert(pos + next.nodeSize, node);
        editor.view.dispatch(tr);
      },
    },
    { separator: true },
    {
      label: t('common.actions.delete'),
      icon: 'trash',
      danger: true,
      action: () => {
        editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
        editor.commands.focus();
      },
    },
  );
  return items;
}
