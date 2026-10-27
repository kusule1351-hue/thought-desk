import { Node, mergeAttributes } from '@tiptap/core';
import { t } from '../i18n';
import { ui } from '../ui.svelte';
import { renderIcon } from '../page-icon';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: () => ReturnType;
    };
  }
}

/** A highlighted box with an icon (a line icon or an emoji), holding any blocks. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      icon: {
        default: 'icon:lightbulb:yellow',
        parseHTML: (el) => el.getAttribute('data-icon') || 'icon:lightbulb:yellow',
        renderHTML: (attrs) => ({ 'data-icon': attrs.icon }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'callout';
      dom.dataset.callout = '';

      const icon = document.createElement('button');
      icon.className = 'callout-icon';
      icon.contentEditable = 'false';
      icon.tabIndex = -1;
      renderIcon(icon, node.attrs.icon);
      icon.dataset.tip = t('blocks.callout.changeIcon');

      const content = document.createElement('div');
      content.className = 'callout-content';
      dom.append(icon, content);

      icon.addEventListener('mousedown', (e) => e.preventDefault());
      icon.addEventListener('click', () => {
        if (!editor.isEditable) return;
        ui.pickIcon(
          icon,
          (picked) => {
            const pos = getPos();
            if (typeof pos === 'number') {
              editor.view.dispatch(editor.view.state.tr.setNodeAttribute(pos, 'icon', picked));
            }
          },
          undefined,
          node.attrs.icon,
        );
      });

      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type.name !== 'callout') return false;
          if (updated.attrs.icon !== node.attrs.icon) renderIcon(icon, updated.attrs.icon);
          node = updated;
          return true;
        },
        stopEvent: (e) => icon.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => icon.contains(m.target),
      };
    };
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
});
