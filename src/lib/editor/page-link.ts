import { Node, mergeAttributes } from '@tiptap/core';
import { mount, unmount } from 'svelte';
import ItemChip from './ItemChip.svelte';
import { t } from '../i18n';
import { library } from '../library.svelte';
import { planner } from '../planner.svelte';
import { store } from '../store.svelte';

/** What a mention points at. Old documents have no kind: those are pages. */
export type MentionKind = 'page' | 'assignment' | 'event' | 'file';

export function titleOf(id: string, kind: MentionKind = 'page'): string {
  if (kind === 'assignment') return planner.assignmentById.get(id)?.title || t('common.untitled');
  if (kind === 'event') return planner.eventById.get(id)?.title || t('common.untitled');
  if (kind === 'file') return library.byId.get(id)?.name || t('blocks.file.fallbackName');
  return store.byId.get(id)?.title || t('common.untitled');
}

function chipView(block: boolean) {
  return ({ node }: { node: { attrs: Record<string, any> } }) => {
    const dom = document.createElement(block ? 'div' : 'span');
    dom.className = block ? 'page-link' : 'page-mention';
    dom.contentEditable = 'false';
    const { id, kind, date } = node.attrs as { id: string; kind: MentionKind; date?: string | null };
    const chip = mount(ItemChip, { target: dom, props: { id, kind: kind ?? 'page', block, date: date ?? undefined } });
    return {
      dom,
      update: (updated: { type: { name: string }; attrs: Record<string, any> }) =>
        updated.type.name === (block ? 'pageLink' : 'mention') &&
        updated.attrs.id === id &&
        updated.attrs.kind === kind &&
        (updated.attrs.date ?? null) === (date ?? null),
      destroy: () => void unmount(chip),
      ignoreMutation: () => true,
    };
  };
}

const idAttr = {
  id: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-page-id'),
    renderHTML: (attrs: Record<string, any>) => ({ 'data-page-id': attrs.id }),
  },
};

/** A block that links to a (usually child) page. */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes: () => ({ ...idAttr, kind: { default: 'page', rendered: false } }),
  parseHTML: () => [{ tag: 'div[data-page-link]' }],
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-link': '' })];
  },
  renderText: ({ node }) => titleOf(node.attrs.id),
  addNodeView: () => chipView(true),
});

/** An inline link to a page, assignment, event or file, inserted with "@". */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes: () => ({
    ...idAttr,
    kind: {
      default: 'page',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') || 'page',
      renderHTML: (attrs: Record<string, any>) => (attrs.kind && attrs.kind !== 'page' ? { 'data-kind': attrs.kind } : {}),
    },
    /** For an event: the one session meant (lecture notes link their class). */
    date: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-date'),
      renderHTML: (attrs: Record<string, any>) => (attrs.date ? { 'data-date': attrs.date } : {}),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-page-mention]' }],
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-page-mention': '' })];
  },
  renderText: ({ node }) => titleOf(node.attrs.id, node.attrs.kind),
  addNodeView: () => chipView(false),
});
