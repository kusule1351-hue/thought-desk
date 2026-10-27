import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { t } from '../i18n';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    flashcard: {
      insertFlashcard: () => ReturnType;
    };
  }
}

/** A side's text, with formulas as their LaTeX (for search). */
const sideText = (side: PMNode | null) =>
  side ? side.textBetween(0, side.content.size, ' ', (leaf) => (leaf.type.name === 'inlineMath' ? `$${leaf.attrs.latex}$` : (leaf.type.spec.leafText?.(leaf) ?? ''))) : '';

/** Short random ids; review progress is kept per page and card id. */
export const newCardId = () => Math.random().toString(36).slice(2, 10);

// data-label: the small heading over each side (app.css shows it).
export const FlashcardFront = Node.create({
  name: 'flashcardFront',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-fc-front]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-fc-front': '', 'data-label': t('blocks.flashcard.front'), class: 'fc-side fc-front' }), 0],
});

export const FlashcardBack = Node.create({
  name: 'flashcardBack',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-fc-back]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-fc-back': '', 'data-label': t('blocks.flashcard.back'), class: 'fc-side fc-back' }), 0],
});

/** Where the caret is, if it's in a flashcard. */
function cardAt(editor: Editor): { pos: number; card: PMNode; side: 'front' | 'back'; atStart: boolean; atEnd: boolean } | null {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.depth < 2) return null;
  const side = $from.parent.type.name;
  if (side !== 'flashcardFront' && side !== 'flashcardBack') return null;
  return {
    pos: $from.before($from.depth - 1),
    card: $from.node($from.depth - 1),
    side: side === 'flashcardFront' ? 'front' : 'back',
    atStart: $from.parentOffset === 0,
    atEnd: $from.parentOffset === $from.parent.content.size,
  };
}

const isEmptyCard = (card: PMNode) => card.textContent.trim() === '' && card.firstChild!.childCount === 0 && card.lastChild!.childCount === 0;

/** Moves the caret into a side: 0 = front, 1 = back; at its start or end. */
function focusSide(editor: Editor, cardPos: number, side: 0 | 1, end = false) {
  const { state } = editor;
  const card = state.doc.nodeAt(cardPos);
  if (!card) return false;
  const front = card.firstChild!;
  const sideStart = side === 0 ? cardPos + 2 : cardPos + 1 + front.nodeSize + 1;
  const sideNode = side === 0 ? front : card.lastChild!;
  const pos = end ? sideStart + sideNode.content.size : sideStart;
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
  return true;
}

/** A card turned back into an empty paragraph (leaving a run of cards). */
function unwrap(editor: Editor, pos: number, card: PMNode) {
  const { state } = editor;
  const tr = state.tr.replaceWith(pos, pos + card.nodeSize, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function addCardAfter(editor: Editor, pos: number, card: PMNode) {
  const { state } = editor;
  const { flashcard, flashcardFront, flashcardBack } = state.schema.nodes;
  const at = pos + card.nodeSize;
  const tr = state.tr.insert(at, flashcard.create({ id: newCardId() }, [flashcardFront.create(), flashcardBack.create()]));
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * A flashcard: a term or question on the front, the answer on the back.
 * Enter moves from front to back, and from the back to a new card, so a deck
 * can be typed in one go; Enter on an empty card ends the run.
 */
export const Flashcard = Node.create({
  name: 'flashcard',
  group: 'block',
  content: 'flashcardFront flashcardBack',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-card-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-card-id': attrs.id } : {}),
      },
    };
  },

  parseHTML: () => [{ tag: 'div[data-flashcard]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-flashcard': '', class: 'flashcard' }), 0],
  renderText: ({ node }) => `${sideText(node.firstChild)} :: ${sideText(node.lastChild)}`,

  addCommands() {
    return {
      insertFlashcard:
        () =>
        ({ state, tr, dispatch }) => {
          const { flashcard, flashcardFront, flashcardBack } = state.schema.nodes;
          const card = flashcard.create({ id: newCardId() }, [flashcardFront.create(), flashcardBack.create()]);
          const { $from } = state.selection;
          let pos: number;
          if ($from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth >= 1) {
            // An empty line becomes the card.
            pos = $from.before();
            tr.replaceWith(pos, $from.after(), card);
          } else {
            pos = $from.after($from.depth);
            tr.insert(pos, card);
          }
          if (dispatch) {
            tr.setSelection(TextSelection.create(tr.doc, pos + 2));
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const at = cardAt(editor);
        if (!at) return false;
        if (at.side === 'front') return focusSide(editor, at.pos, 1);
        if (isEmptyCard(at.card)) return unwrap(editor, at.pos, at.card);
        return addCardAfter(editor, at.pos, at.card);
      },
      Tab: ({ editor }) => {
        const at = cardAt(editor);
        if (!at) return false;
        if (at.side === 'front') return focusSide(editor, at.pos, 1);
        const next = editor.state.doc.nodeAt(at.pos + at.card.nodeSize);
        if (next?.type.name === 'flashcard') return focusSide(editor, at.pos + at.card.nodeSize, 0);
        return addCardAfter(editor, at.pos, at.card);
      },
      'Shift-Tab': ({ editor }) => {
        const at = cardAt(editor);
        if (!at) return false;
        if (at.side === 'back') return focusSide(editor, at.pos, 0, true);
        return true;
      },
      Backspace: ({ editor }) => {
        const at = cardAt(editor);
        if (!at || !at.atStart) return false;
        if (isEmptyCard(at.card)) return unwrap(editor, at.pos, at.card);
        if (at.side === 'back') return focusSide(editor, at.pos, 0, true);
        // Never merge the front into the block before it.
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    // Every card needs its own id (a duplicated or pasted card would share one).
    return [
      new Plugin({
        key: new PluginKey('flashcardIds'),
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((tx) => tx.docChanged)) return null;
          const seen = new Set<string>();
          const fix: number[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'flashcard') return true;
            const id = node.attrs.id as string | null;
            if (!id || seen.has(id)) fix.push(pos);
            else seen.add(id);
            return false;
          });
          if (!fix.length) return null;
          const tr = state.tr;
          for (const pos of fix) tr.setNodeAttribute(pos, 'id', newCardId());
          return tr;
        },
      }),
    ];
  },
});
