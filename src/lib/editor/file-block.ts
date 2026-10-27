import { Node, mergeAttributes } from '@tiptap/core';
import { mount, unmount } from 'svelte';
import FileCard from './FileCard.svelte';
import { t } from '../i18n';
import { library } from '../library.svelte';

/** A library file shown as a card inside a page. */
export const FileBlock = Node.create({
  name: 'fileBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes: () => ({
    id: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-file-id'),
      renderHTML: (attrs: Record<string, any>) => ({ 'data-file-id': attrs.id }),
    },
  }),
  parseHTML: () => [{ tag: 'div[data-file-block]' }],
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-file-block': '' })];
  },
  renderText: ({ node }) => library.byId.get(node.attrs.id)?.name ?? t('blocks.file.fallbackName'),

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'file-block';
      dom.contentEditable = 'false';
      const id = node.attrs.id as string;
      const card = mount(FileCard, { target: dom, props: { id } });
      return {
        dom,
        update: (updated) => updated.type.name === 'fileBlock' && updated.attrs.id === id,
        destroy: () => void unmount(card),
        ignoreMutation: () => true,
      };
    };
  },
});
