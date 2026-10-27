/**
 * Ways to start an empty page: lecture notes, a study guide, a flashcard
 * deck, a checklist. Each is editor JSON, plus a title and line icon for a page
 * that has none yet. The titles and the text are written into the page in
 * the interface's language of the day; after that they're the page's own.
 */

import type { JSONContent } from '@tiptap/core';
import { newCardId } from './flashcard';
import { lineIcon } from '../page-icon';
import { t } from '../i18n';

export interface Starter {
  key: string;
  label: string;
  icon: string;
  /** Shown on hover. */
  hint: string;
  /** A title for a page that has none (today's date is filled in). */
  title: (date: string) => string;
  content: () => JSONContent[];
}

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const heading = (value: string, level = 2): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const paragraph = (value = ''): JSONContent => (value ? { type: 'paragraph', content: [text(value)] } : { type: 'paragraph' });
const bullets = (...items: string[]): JSONContent => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
});
const todos = (...items: string[]): JSONContent => ({
  type: 'taskList',
  content: items.map((item) => ({ type: 'taskItem', attrs: { checked: false }, content: [paragraph(item)] })),
});
const math = (latex = ''): JSONContent => ({ type: 'mathBlock', attrs: { latex } });
const card = (front = '', back = ''): JSONContent => ({
  type: 'flashcard',
  attrs: { id: newCardId() },
  content: [
    { type: 'flashcardFront', content: front ? [text(front)] : [] },
    { type: 'flashcardBack', content: back ? [text(back)] : [] },
  ],
});

export const STARTERS: Starter[] = [
  {
    key: 'lecture',
    label: t('editor.starters.lecture.label'),
    icon: lineIcon('notebook-pen', 'blue'),
    hint: t('editor.starters.lecture.hint'),
    title: (date) => t('editor.starters.lecture.title', { date }),
    content: () => [
      heading(t('editor.starters.lecture.keyIdeas')),
      bullets(''),
      heading(t('editor.starters.lecture.questions')),
      bullets(''),
      heading(t('editor.starters.lecture.summary')),
      paragraph(),
      heading(t('editor.starters.lecture.followUp')),
      todos(t('editor.starters.lecture.review')),
    ],
  },
  {
    key: 'study',
    label: t('editor.starters.study.label'),
    icon: lineIcon('graduation-cap', 'purple'),
    hint: t('editor.starters.study.hint'),
    title: () => t('editor.starters.study.title'),
    content: () => [
      heading(t('editor.starters.study.topics')),
      todos(''),
      heading(t('editor.starters.study.keyTerms')),
      paragraph(t('editor.starters.study.cardsIntro')),
      card(),
      heading(t('editor.starters.study.practice')),
      bullets(''),
    ],
  },
  {
    key: 'formulas',
    label: t('editor.starters.formulas.label'),
    icon: lineIcon('sigma', 'indigo'),
    hint: t('editor.starters.formulas.hint'),
    title: () => t('editor.starters.formulas.title'),
    content: () => [
      heading(t('editor.starters.formulas.keyFormulas')),
      math(),
      paragraph(t('editor.starters.formulas.where')),
      heading(t('editor.starters.formulas.workedExample')),
      paragraph(),
      heading(t('editor.starters.formulas.remember')),
      card(),
    ],
  },
  {
    key: 'cards',
    label: t('editor.starters.cards.label'),
    icon: lineIcon('layers', 'orange'),
    hint: t('editor.starters.cards.hint'),
    title: () => t('editor.starters.cards.title'),
    content: () => [card()],
  },
  {
    key: 'checklist',
    label: t('editor.starters.checklist.label'),
    icon: lineIcon('list-checks', 'green'),
    hint: t('editor.starters.checklist.hint'),
    title: () => t('editor.starters.checklist.title'),
    content: () => [todos('')],
  },
];
