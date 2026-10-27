/**
 * Math: inline formulas ($x^2$) and display blocks ($$ … $$), stored as
 * LaTeX and typeset with KaTeX. Click one (or select it and press Enter) to
 * edit; the formula updates as you type.
 *
 * Typing: `$x^2$` makes an inline formula, `$$` then Space or Enter on an
 * empty line makes a block, Ctrl+Shift+E makes selected text (or nothing)
 * a formula. Pasted KaTeX or MathML (ChatGPT, Wikipedia) keeps its LaTeX.
 */

import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { t } from '../i18n';
import { renderMath } from '../math/katex';
import { openMath, type MathDone, type MathSession } from '../math/session';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** An inline formula from the selected text, or an empty one to fill in. */
      insertInlineMath: () => ReturnType;
      /** A display formula in place of the current empty line (or after it). */
      insertMathBlock: (latex?: string) => ReturnType;
    };
  }
}

/** Node views by their DOM, so a command can open the one it just made. */
const openers = new WeakMap<Element, () => void>();

/** Opens the formula at `pos` for editing. */
export function editMathAt(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof Element) openers.get(dom)?.();
}

/** LaTeX from pasted KaTeX or MathML: the TeX it was written in, when it says. */
function texOf(el: HTMLElement): string | null {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  const tex = ann?.textContent ?? el.getAttribute('data-latex') ?? el.getAttribute('alttext');
  return tex?.trim() ? tex.trim().replace(/^\\displaystyle\s*/, '') : null;
}

/** Where the caret goes once a formula is done with. */
function leave(editor: Editor, pos: number, size: number, how: MathDone, block: boolean) {
  const { state, view } = editor;
  const tr = state.tr;
  const back = how === 'left' || how === 'up';
  if (!block) {
    tr.setSelection(TextSelection.create(tr.doc, back ? pos : pos + size));
  } else if (back) {
    tr.setSelection(Selection.near(tr.doc.resolve(pos), -1));
  } else {
    // Below a block: the next line, or a new one if it's the last thing.
    const after = pos + size;
    if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, state.schema.nodes.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** What the inline and block views share: drawing, opening, and writing back. */
function mathView(node: PMNode, editor: Editor, getPos: () => number | undefined, block: boolean) {
  const dom = document.createElement(block ? 'div' : 'span');
  dom.className = block ? 'math-block' : 'math-inline';
  dom.contentEditable = 'false';
  const out = document.createElement(block ? 'div' : 'span');
  out.className = 'math-out';
  dom.append(out);
  let host: HTMLElement | null = null;

  let current = node;
  let session: MathSession | null = null;

  const draw = (latex: string) => {
    if (latex.trim()) {
      out.classList.remove('math-empty');
      renderMath(out, latex, block);
    } else {
      delete out.dataset.pending;
      out.classList.add('math-empty');
      out.textContent = block ? t('blocks.math.emptyBlock') : t('blocks.math.emptyInline');
    }
  };
  draw(node.attrs.latex);

  const open = () => {
    if (session || !editor.isEditable) return;
    dom.classList.add('editing');
    if (block) {
      host = dom.appendChild(document.createElement('div'));
      host.className = 'math-host';
    }
    session = openMath({
      latex: current.attrs.latex,
      display: block,
      anchor: out,
      host: host ?? undefined,
      onchange: draw,
      ondone: (latex, how) => {
        session = null;
        dom.classList.remove('editing');
        host?.remove();
        host = null;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const { state, view } = editor;
        // Emptied (or Backspace on nothing): the formula goes, leaving the caret there.
        if (how === 'delete' || (!latex.trim() && how !== 'blur')) {
          const tr = block
            ? state.tr.replaceWith(pos, pos + current.nodeSize, state.schema.nodes.paragraph.create())
            : state.tr.delete(pos, pos + current.nodeSize);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, block ? pos + 1 : pos)));
          view.focus();
          return;
        }
        if (latex !== current.attrs.latex) view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex }));
        else draw(latex);
        if (how !== 'blur') leave(editor, pos, current.nodeSize, how, block);
      },
    });
  };
  openers.set(dom, open);

  // A click edits (instead of selecting the node first).
  dom.addEventListener('mousedown', (e) => {
    if (!editor.isEditable || (host && host.contains(e.target as globalThis.Node))) return;
    e.preventDefault();
  });
  dom.addEventListener('click', (e) => {
    if (host && host.contains(e.target as globalThis.Node)) return;
    open();
  });

  return {
    dom,
    update(updated: PMNode) {
      if (updated.type !== current.type) return false;
      const changed = updated.attrs.latex !== current.attrs.latex;
      current = updated;
      if (changed && !session) draw(updated.attrs.latex);
      return true;
    },
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
    stopEvent: (e: Event) => !!host && host.contains(e.target as globalThis.Node),
    ignoreMutation: () => true,
    destroy() {
      openers.delete(dom);
      session?.close();
    },
  };
}

/** Enter on a selected formula edits it. */
function enterEdits(editor: Editor, name: string) {
  const sel = editor.state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== name) return false;
  editMathAt(editor, sel.from);
  return true;
}

function stepOver(editor: Editor, name: string, dir: 1 | -1): boolean {
  const { state, view } = editor;
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === name) {
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, dir > 0 ? sel.to : sel.from)));
    return true;
  }
  if (!sel.empty) return false;
  const next = dir > 0 ? sel.$from.nodeAfter : sel.$from.nodeBefore;
  if (next?.type.name !== name) return false;
  view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, dir > 0 ? sel.from : sel.from - next.nodeSize)));
  return true;
}

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { latex: { default: '' } };
  },

  parseHTML() {
    return [
      { tag: 'span[data-math-inline]', getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute('data-latex') ?? '' }) },
      // KaTeX output (ChatGPT, many sites); a display one is a block.
      {
        tag: 'span.katex',
        priority: 60,
        getAttrs: (el) => {
          const tex = texOf(el as HTMLElement);
          return tex ? { latex: tex } : false;
        },
      },
      {
        tag: 'math',
        priority: 60,
        getAttrs: (el) => {
          if ((el as HTMLElement).getAttribute('display') === 'block') return false;
          const tex = texOf(el as HTMLElement);
          return tex ? { latex: tex } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '', 'data-latex': node.attrs.latex }), node.attrs.latex];
  },

  renderText: ({ node }) => `$${node.attrs.latex}$`,

  addNodeView() {
    return ({ node, editor, getPos }) => mathView(node, editor, getPos, false);
  },

  addCommands() {
    return {
      insertInlineMath:
        () =>
        ({ state, tr, dispatch, editor }) => {
          const { from, to, empty } = state.selection;
          const latex = empty ? '' : state.doc.textBetween(from, to, ' ').trim();
          if (!dispatch) return true;
          tr.replaceWith(from, to, this.type.create({ latex }));
          tr.setSelection(TextSelection.create(tr.doc, from + 1));
          dispatch(tr);
          if (!latex) queueMicrotask(() => editMathAt(editor, from));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-e': ({ editor }) => editor.commands.insertInlineMath(),
      Enter: ({ editor }) => enterEdits(editor, this.name),
      // Arrowing onto a formula stops on it (so Enter edits); the next press goes past.
      ArrowRight: ({ editor }) => stepOver(editor, this.name, 1),
      ArrowLeft: ({ editor }) => stepOver(editor, this.name, -1),
    };
  },

  addInputRules() {
    return [
      // $x^2$ — not after a letter, digit or $, and not with a space just
      // inside either dollar sign (so "$5 and $10" stays money).
      new InputRule({
        find: /(?<![\w$\\])\$([^\s$](?:[^$]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },
});

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  defining: true,

  addAttributes() {
    return { latex: { default: '' } };
  },

  parseHTML() {
    return [
      { tag: 'div[data-math-block]', getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute('data-latex') ?? '' }) },
      {
        tag: 'span.katex-display',
        priority: 70,
        getAttrs: (el) => {
          const tex = texOf(el as HTMLElement);
          return tex ? { latex: tex } : false;
        },
      },
      {
        tag: 'math[display="block"]',
        priority: 70,
        getAttrs: (el) => {
          const tex = texOf(el as HTMLElement);
          return tex ? { latex: tex } : false;
        },
      },
      // Wikipedia shows an image of each formula next to its MathML.
      { tag: 'img.mwe-math-fallback-image-inline', ignore: true },
      { tag: 'img.mwe-math-fallback-image-display', ignore: true },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '', 'data-latex': node.attrs.latex }), node.attrs.latex];
  },

  renderText: ({ node }) => `$$${node.attrs.latex}$$`,

  addNodeView() {
    return ({ node, editor, getPos }) => mathView(node, editor, getPos, true);
  },

  addCommands() {
    return {
      insertMathBlock:
        (latex = '') =>
        ({ state, tr, dispatch, editor }) => {
          const { $from } = state.selection;
          const node = this.type.create({ latex });
          if (!dispatch) return true;
          let at: number;
          // An empty line becomes the formula; otherwise it goes after the line.
          if ($from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0) {
            at = $from.before();
            tr.replaceWith(at, $from.after(), node);
          } else {
            at = $from.depth > 0 ? $from.after() : $from.pos;
            tr.insert(at, node);
          }
          tr.setSelection(NodeSelection.create(tr.doc, at));
          dispatch(tr.scrollIntoView());
          if (!latex) queueMicrotask(() => editMathAt(editor, at));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (enterEdits(editor, this.name)) return true;
        // "$$" then Enter on a line of its own.
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.textContent !== '$$') return false;
        return editor.chain().deleteRange({ from: $from.start(), to: $from.end() }).insertMathBlock().run();
      },
    };
  },

  addInputRules() {
    return [
      // "$$" then Space on an empty line.
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ chain, range, state }) => {
          if (state.doc.resolve(range.from).parent.type.name !== 'paragraph') return null;
          chain().deleteRange(range).insertMathBlock().run();
        },
      }),
      // $$E = mc^2$$ typed whole on its own line.
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ chain, range, match, state }) => {
          if (state.doc.resolve(range.from).parent.type.name !== 'paragraph') return null;
          chain().deleteRange(range).insertMathBlock(match[1].trim()).run();
        },
      }),
    ];
  },
});
