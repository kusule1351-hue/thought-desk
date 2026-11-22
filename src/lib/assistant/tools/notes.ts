/** The assistant's tools for notes: finding and reading them, writing new ones, editing them, adding flashcards. */

import { api } from '../../api';
import { blocksMarkdown } from '../../markdown';
import { titleOf } from '../../editor/page-link';
import { t } from '../../i18n';
import { store } from '../../store.svelte';
import { keptFromAssistant, pageFor } from '../access';
import { applyPlan, blocksFrom, cardBlocks, createNote, describe, noteState, plan, restore, untouchedSince, type NoteEdit, type Snapshot } from '../notes';
import { ToolError, type Done, type Tool } from '../types';

const untitled = () => t('common.untitled');
const named = (title: string) => title || untitled();

/** A snippet's match markers (\u0001 … \u0002) taken out. */
const clean = (snippet: string) => snippet.replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();

const str = (value: unknown, what: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${what} must be text, and not empty.`);
  if (value.length > max) throw new ToolError(`${what} is too long (at most ${max} characters).`);
  return value.trim();
};

/** Where a path of titles leads: "Biology › Week 3". */
const pathOf = (id: string) => [...store.ancestors(id), store.untracked.get(id)!].map((p) => named(p.title)).join(' › ');

/** Puts a note back; the panel asks first when the note has changed again since. */
const undoEdit = (snapshot: Snapshot) => ({ undo: () => restore(snapshot), undoLoses: async () => !(await untouchedSince(snapshot)) });

const search: Tool<{ query: string; limit?: number }> = {
  name: 'search_notes',
  kind: 'read',
  description:
    'Searches the text and titles of every note and database row (full-text, each word matched by prefix). Returns up to `limit` matches (default 10, at most 30) as title, id and a short excerpt. Use it first whenever the answer could be in the notes; search for the distinctive words, not the whole question. Excerpts are short: read the note with read_note before relying on it.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'A few distinctive words.' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
    required: ['query'],
    additionalProperties: false,
  },
  label: (i) => t('assistant.tools.searching', { query: String(i.query ?? '') }),
  async run(i) {
    const query = str(i.query, 'query');
    const limit = Math.min(30, Math.max(1, Math.floor(Number(i.limit) || 10)));
    // Kept notes are left out, so more are asked for than are shown.
    const hits = (await api.search(query, 100)).filter((h) => !keptFromAssistant(h.id)).slice(0, limit);
    if (!hits.length) return `No note matches "${query}". Try fewer or different words.`;
    return hits.map((h) => `- "${named(h.title)}" (id ${h.id}), in ${pathOf(h.id)}: ${clean(h.snippet) || '(no excerpt)'}`).join('\n');
  },
};

const read: Tool<{ id: string; from?: number }> = {
  name: 'read_note',
  kind: 'read',
  description:
    'Reads one note. Returns its title, a `version`, and its blocks numbered [1], [2], … each as Markdown (flashcards read as `front :: back`, links to other notes as `[[Title]]`). A block marked (locked) holds something text cannot carry (a picture, a database, coloured text): it can be read but not rewritten. Long notes come in parts: pass `from` to continue. Always read a note before editing it, and use the version and block numbers from the latest read.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The note’s id.' }, from: { type: 'integer', minimum: 1, description: 'The first block to show (default 1).' } },
    required: ['id'],
    additionalProperties: false,
  },
  label: (i) => t('assistant.tools.reading', { title: named(store.untracked.get(i.id)?.title ?? '') }),
  async run(i) {
    return describe(await noteState(i.id), i.from);
  },
};

const list: Tool<{ parent_id?: string }> = {
  name: 'list_notes',
  kind: 'read',
  description:
    'Lists the notes directly inside a note (or at the top level when `parent_id` is left out), in sidebar order, with each one’s id and how many notes it holds. Use it to learn how the notes are organised or to choose where a new note belongs. Databases are not listed here: see list_databases.',
  input_schema: { type: 'object', properties: { parent_id: { type: 'string', description: 'A note’s id; leave out for the top level.' } }, additionalProperties: false },
  label: () => t('assistant.tools.listing'),
  async run(i) {
    const parent = i.parent_id ? pageFor(i.parent_id) : null;
    const pages = store.children(parent?.id ?? null).filter((p) => !keptFromAssistant(p.id));
    if (!pages.length) return parent ? `"${named(parent.title)}" holds no notes.` : 'There are no notes yet.';
    const shown = pages.slice(0, 200);
    const lines = shown.map((p) => {
      const inside = store.children(p.id).length;
      return `- "${named(p.title)}" (id ${p.id})${inside ? `, holds ${inside}` : ''}`;
    });
    if (pages.length > shown.length) lines.push(`(…and ${pages.length - shown.length} more.)`);
    return `${parent ? `Inside "${named(parent.title)}"` : 'Top level'}:\n${lines.join('\n')}`;
  },
};

const create: Tool<{ title: string; markdown: string; parent_id?: string }> = {
  name: 'create_note',
  kind: 'create',
  description:
    'Creates a new note. `markdown` is its body: headings (#, ##, ###), paragraphs, lists, to-dos (`- [ ] task`), tables, code, quotes, formulas ($x^2$ inline, $$ … $$ on their own lines), links to other notes (`[[Exact title]]`), and flashcards as one `front :: back` per line. Do not repeat the title as a heading. `parent_id` puts it inside another note; leave it out for the top level. The person is shown the note and decides before it is created. Returns the new note’s id.',
  input_schema: {
    type: 'object',
    properties: { title: { type: 'string' }, markdown: { type: 'string', description: 'The body, as Markdown.' }, parent_id: { type: 'string', description: 'The id of the note to put it inside.' } },
    required: ['title', 'markdown'],
    additionalProperties: false,
  },
  label: (i) => t('assistant.changes.createNote', { title: named(String(i.title ?? '')) }),
  preview(i) {
    const title = str(i.title, 'title');
    blocksFrom(i.markdown);
    const parent = i.parent_id ? pageFor(i.parent_id) : null;
    if (parent?.kind === 'database') throw new ToolError('A note can’t be put inside a database with this tool. Use add_rows to add a row.');
    return { title: t('assistant.changes.createNote', { title }), lines: parent ? [{ label: t('assistant.labels.inside'), value: pathOf(parent.id) }] : [], body: i.markdown };
  },
  async run(i): Promise<Done> {
    const title = str(i.title, 'title');
    const parent = i.parent_id ? pageFor(i.parent_id) : null;
    const page = await createNote(title, blocksFrom(i.markdown), parent?.id ?? null);
    return {
      summary: t('assistant.changes.createdNote', { title }),
      result: `Created the note "${title}" (id ${page.id}).`,
      place: { kind: 'page', id: page.id },
      // A note it made goes to the Trash, where it can still be had back.
      undo: () => store.trashPage(page.id),
    };
  },
};

interface EditInput {
  id: string;
  version: string;
  edits?: NoteEdit[];
  title?: string;
}

const edit: Tool<EditInput> = {
  name: 'edit_note',
  kind: 'edit',
  description:
    'Changes an existing note. Read it with read_note first and pass the `version` it gave. `edits` is a list, each one of: {"op":"replace","from":N,"to":M,"markdown":"…"} (rewrites blocks N to M; `to` defaults to N), {"op":"insert","after":N,"markdown":"…"} (adds after block N; 0 is the top, the last block’s number is the end), {"op":"delete","from":N,"to":M}. Block numbers are the ones read_note showed, and every edit in one call refers to that same numbering. Change as little as the request needs: replace only the blocks that change, and keep the rest of a block’s wording when fixing part of it. A whole list is one block: to add items to a list, insert them right after it (or right before it) as a list of the same kind, and they join it. Locked blocks can’t be replaced or deleted. `title` renames the note. The person is shown the change and decides before it is made. Afterwards the note has a new version: read it again before editing it further.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      version: { type: 'string', description: 'The version from the latest read_note.' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['replace', 'insert', 'delete'] },
            from: { type: 'integer' },
            to: { type: 'integer' },
            after: { type: 'integer' },
            markdown: { type: 'string' },
          },
          required: ['op'],
        },
      },
      title: { type: 'string', description: 'A new title, to rename the note.' },
    },
    required: ['id', 'version'],
    additionalProperties: false,
  },
  label: (i) => t('assistant.changes.editNote', { title: named(store.untracked.get(i.id)?.title ?? '') }),
  async preview(i) {
    const state = await noteState(i.id);
    const title = i.title === undefined ? undefined : str(i.title, 'title');
    if (!i.edits?.length && title === undefined) throw new ToolError('Nothing to change: give edits, a title, or both.');
    const made = i.edits?.length ? plan(state, i.version, i.edits) : null;
    return {
      title: t('assistant.changes.editNote', { title: named(state.page.title) }),
      lines: title !== undefined && title !== state.page.title ? [{ label: t('assistant.labels.newName'), value: title }] : [],
      ...(made ? { before: made.before, after: made.after } : {}),
    };
  },
  async run(i): Promise<Done> {
    const state = await noteState(i.id);
    const title = i.title === undefined ? undefined : str(i.title, 'title');
    const made = i.edits?.length ? plan(state, i.version, i.edits) : { next: state.json, before: '', after: '' };
    const snapshot = await applyPlan(state, made, title);
    const now = await noteState(i.id);
    return {
      summary: t('assistant.changes.editedNote', { title: named(now.page.title) }),
      result: `Done. The note is now version ${now.version} with ${now.blocks.length} blocks; its block numbers have changed, so read it again before another edit.`,
      place: { kind: 'page', id: state.page.id },
      ...undoEdit(snapshot),
    };
  },
};

const addCards: Tool<{ note_id: string; cards: { front: string; back: string }[] }> = {
  name: 'add_flashcards',
  kind: 'create',
  description:
    'Adds flashcards to the end of an existing note; they join the person’s spaced-repetition study. Each card is {"front": question or term, "back": answer}. Keep each side short and make each card test one thing. To make a new deck, create a note with create_note instead (one `front :: back` per line). At most 100 cards a call. The person is shown the cards and decides first.',
  input_schema: {
    type: 'object',
    properties: {
      note_id: { type: 'string' },
      cards: { type: 'array', items: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } }, required: ['front', 'back'] } },
    },
    required: ['note_id', 'cards'],
    additionalProperties: false,
  },
  label: (i) => t('assistant.changes.addCards', { count: Array.isArray(i.cards) ? i.cards.length : 0, title: named(store.untracked.get(i.note_id)?.title ?? '') }),
  async preview(i) {
    const state = await noteState(i.note_id);
    const blocks = cardBlocks(i.cards);
    return { title: t('assistant.changes.addCards', { count: blocks.length, title: named(state.page.title) }), body: blocksMarkdown(blocks, titleOf).join('\n') };
  },
  async run(i): Promise<Done> {
    const state = await noteState(i.note_id);
    const blocks = cardBlocks(i.cards);
    const next = [...state.json, ...blocks];
    const snapshot = await applyPlan(state, { next, before: '', after: '' });
    return {
      summary: t('assistant.changes.addedCards', { count: blocks.length, title: named(state.page.title) }),
      result: `Added ${blocks.length} flashcards to "${named(state.page.title)}".`,
      place: { kind: 'page', id: state.page.id },
      ...undoEdit(snapshot),
    };
  },
};

export const noteTools: Tool[] = [search, read, list, create, edit, addCards];
