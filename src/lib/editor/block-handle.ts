/**
 * Notion-style block gutter: hovering a block shows a "+" button (insert a
 * block below) and a grip that can be dragged to move the block or clicked
 * to open the block menu.
 */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { t } from '../i18n';

export interface BlockTarget {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
}

export interface BlockHandleOptions {
  onMenu: (target: BlockTarget, anchor: HTMLElement) => void;
}

const LIST_TAGS = new Set(['UL', 'OL']);
const ITEM_TYPES = new Set(['listItem', 'taskItem']);

const SVG_PLUS =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const SVG_GRIP =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5.5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="18.5" r="1.6"/><circle cx="15" cy="5.5" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="18.5" r="1.6"/></svg>';

class HandleView {
  root: HTMLDivElement;
  grip: HTMLButtonElement;
  target: BlockTarget | null = null;
  host: HTMLElement;
  frame = 0;

  constructor(
    private view: EditorView,
    private editor: Editor,
    private options: BlockHandleOptions,
  ) {
    this.host = view.dom.parentElement as HTMLElement;

    this.root = document.createElement('div');
    this.root.className = 'block-handle';
    this.root.contentEditable = 'false';

    const plus = document.createElement('button');
    plus.className = 'block-handle-btn';
    plus.dataset.tip = t('editor.blockHandle.add');
    plus.innerHTML = SVG_PLUS;
    plus.addEventListener('mousedown', (e) => e.preventDefault());
    plus.addEventListener('click', () => this.insertBelow());

    this.grip = document.createElement('button');
    this.grip.className = 'block-handle-btn grip';
    this.grip.dataset.tip = t('editor.blockHandle.drag');
    this.grip.dataset.tipKey = t('editor.blockHandle.options');
    this.grip.innerHTML = SVG_GRIP;
    this.grip.draggable = true;
    this.grip.addEventListener('mousedown', (e) => e.stopPropagation());
    this.grip.addEventListener('click', () => {
      if (this.target) this.options.onMenu(this.target, this.grip);
    });
    this.grip.addEventListener('dragstart', this.onDragStart);
    this.grip.addEventListener('dragend', this.onDragEnd);

    this.root.append(plus, this.grip);
    this.host.appendChild(this.root);

    this.host.addEventListener('mousemove', this.onMouseMove);
    this.host.addEventListener('mouseleave', this.onMouseLeave);
    view.dom.addEventListener('keydown', this.hide);
  }

  onMouseMove = (e: MouseEvent) => {
    if (!this.editor.isEditable || this.view.dragging) return;
    if (this.root.contains(e.target as Node)) return;
    const { clientX: x, clientY: y } = e;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const hit = this.findTarget(y);
      if (!hit) return this.hide();
      if (this.target?.dom === hit.dom && this.target.pos === hit.pos && this.root.classList.contains('visible')) return;
      this.show(hit, x);
    });
  };

  onMouseLeave = (e: MouseEvent) => {
    if (this.root.contains(e.relatedTarget as Node)) return;
    this.hide();
  };

  hide = () => {
    cancelAnimationFrame(this.frame);
    this.root.classList.remove('visible');
  };

  show(target: BlockTarget, _x: number) {
    this.target = target;
    const hostRect = this.host.getBoundingClientRect();
    const rect = target.dom.getBoundingClientRect();

    // Center the handle on the block's first line of text.
    let lineEl: HTMLElement = target.dom;
    if (ITEM_TYPES.has(target.node.type.name)) {
      lineEl = (target.dom.querySelector('p, h1, h2, h3') as HTMLElement) ?? target.dom;
    } else if (target.node.type.name === 'callout' || target.node.type.name === 'details' || target.node.type.name === 'blockquote') {
      lineEl = (target.dom.querySelector('p, h1, h2, h3, summary') as HTMLElement) ?? target.dom;
    }
    const lineRect = lineEl.getBoundingClientRect();
    const style = getComputedStyle(lineEl);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 24;
    const padTop = parseFloat(style.paddingTop) || 0;
    const firstLine = target.node.isTextblock || lineEl !== target.dom ? Math.min(lineHeight, lineRect.height) : Math.min(24, rect.height);
    // Aim at the optical centre of the first line (Inter sits ~0.094em low).
    const optical = target.node.isTextblock || lineEl !== target.dom ? (parseFloat(style.fontSize) || 16) * 0.094 : 0;
    const centerY = (lineEl !== target.dom || target.node.isTextblock ? lineRect.top + padTop : rect.top) + firstLine / 2 + optical;

    const top = centerY - hostRect.top - 12;
    // A top-level list item's box reaches back over its bullet (app.css), so the handle lines up with its text.
    const edge = target.node.type.name === 'listItem' ? (target.dom.firstElementChild?.getBoundingClientRect().left ?? rect.left) : rect.left;
    const left = edge - hostRect.left - 48 - (ITEM_TYPES.has(target.node.type.name) ? 18 : 0);
    this.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    this.root.classList.add('visible');
  }

  /** The block under the given y, preferring list items over whole lists. */
  findTarget(y: number): BlockTarget | null {
    let el = hitChild(this.view.dom, y);
    while (el && LIST_TAGS.has(el.tagName)) {
      const li = hitChild(el, y);
      if (!li) break;
      const nested = Array.from(li.querySelectorAll<HTMLElement>(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol')).find((list) => {
        const r = list.getBoundingClientRect();
        return y >= r.top && y <= r.bottom;
      });
      el = nested ?? li;
      if (!nested) break;
    }
    return el ? this.resolve(el) : null;
  }

  resolve(el: HTMLElement): BlockTarget | null {
    const view = this.view;
    let inner: number;
    try {
      inner = view.posAtDOM(el, 0);
    } catch {
      return null;
    }
    const doc = view.state.doc;
    for (const candidate of [inner - 1, inner]) {
      if (candidate < 0 || candidate > doc.content.size) continue;
      const node = doc.nodeAt(candidate);
      if (node && view.nodeDOM(candidate) === el) return { pos: candidate, node, dom: el };
    }
    const $pos = doc.resolve(Math.min(inner, doc.content.size));
    for (let d = $pos.depth; d > 0; d--) {
      const before = $pos.before(d);
      if (view.nodeDOM(before) === el) return { pos: before, node: $pos.node(d), dom: el };
    }
    return null;
  }

  insertBelow() {
    const target = this.target;
    if (!target) return;
    const { node, pos } = target;
    const chain = this.editor.chain().focus();
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      chain.setTextSelection(pos + 1).insertContent('/').run();
    } else if (ITEM_TYPES.has(node.type.name)) {
      const at = pos + node.nodeSize;
      chain
        .insertContentAt(at, { type: node.type.name, content: [{ type: 'paragraph', content: [{ type: 'text', text: '/' }] }] })
        .setTextSelection(at + 3)
        .run();
    } else {
      const at = pos + node.nodeSize;
      chain
        .insertContentAt(at, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
        .setTextSelection(at + 2)
        .run();
    }
    this.hide();
  }

  onDragStart = (e: DragEvent) => {
    const target = this.target;
    if (!target || !e.dataTransfer) return;
    const { view } = this;
    const selection = NodeSelection.create(view.state.doc, target.pos);
    view.dispatch(view.state.tr.setSelection(selection));
    const slice = selection.content();
    const { dom, text } = view.serializeForClipboard(slice);
    e.dataTransfer.clearData();
    e.dataTransfer.setData('text/html', dom.innerHTML);
    e.dataTransfer.setData('text/plain', text);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setDragImage(target.dom, 0, 0);
    view.dragging = { slice, move: true };
    this.root.classList.add('dragging');
  };

  onDragEnd = () => {
    this.root.classList.remove('dragging');
    this.hide();
    // The drop handler clears this; a drop outside the editor doesn't.
    setTimeout(() => {
      if (this.view.dragging) this.view.dragging = null;
    }, 50);
  };

  destroy() {
    cancelAnimationFrame(this.frame);
    this.host.removeEventListener('mousemove', this.onMouseMove);
    this.host.removeEventListener('mouseleave', this.onMouseLeave);
    this.view.dom.removeEventListener('keydown', this.hide);
    this.root.remove();
  }
}

/** The child of `parent` whose vertical extent best covers y. */
function hitChild(parent: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const child of Array.from(parent.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains('ProseMirror-widget') || child.classList.contains('ProseMirror-gapcursor')) continue;
    if (child.tagName === 'BR') continue;
    const r = child.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.top - 8 > y) break;
    best = child;
    if (y <= r.bottom) break;
  }
  if (best) {
    const r = best.getBoundingClientRect();
    if (y > r.bottom + 16) return null;
  }
  return best;
}

export const BlockHandle = Extension.create<BlockHandleOptions>({
  name: 'blockHandle',
  addOptions() {
    return { onMenu: () => {} };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => new HandleView(view, editor, options),
      }),
    ];
  },
});
