/**
 * Notes, as the assistant reads and changes them.
 *
 * A note is read as its top-level blocks, numbered, each as Markdown, with a
 * `version` that names exactly that content. An edit names blocks by number
 * and carries the version it was planned against: if the note has changed
 * since (someone typed, another device synced), the edit is refused and the
 * model reads again. No text is ever searched for and replaced by guesswork.
 *
 * A change goes the way typing goes. A note that is open is changed through
 * its editor (so it saves, syncs, shows at once and undoes with Ctrl+Z); one
 * that is closed has its stored body rewritten, the way Home ticks a to-do.
 * Only the blocks that differ are touched.
 *
 * Markdown can't say everything a note holds (a picture, a database, coloured
 * text, a link to an assignment). A block with any of that is `locked`: the
 * assistant can add around it, never rewrite or remove it.
 */

import { getText, getTextSerializersFromSchema, type Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { api } from '../api';
import { cowork } from '../cowork.svelte';
import { editorsOf } from '../editor/open-editors';
import { titleOf } from '../editor/page-link';
import { blocksMarkdown, type JNode } from '../markdown';
import { docOf } from '../page-actions';
import { prefs } from '../prefs.svelte';
import { store } from '../store.svelte';
import { syncAvailable } from '../sync/flag';
import { syncSchema } from '../sync/schema';
import { syncState } from '../sync/state.svelte';
import type { PageMeta } from '../types';
import { keptFromAssistant, pageFor } from './access';
import { flashcard, fromMarkdown, type Resolve } from './from-markdown';
import { ToolError } from './types';

/** The most of one note handed to the model at a time (characters of Markdown). */
export const READ_LIMIT = 40_000;

// ------------------------------------------------------------------ reading

/** FNV-1a, as eight hex digits: enough to tell two states of one note apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const versionOf = (blocks: JNode[]) => hash(JSON.stringify(blocks));

/** What Markdown can carry, and bring back unchanged. */
const PLAIN_NODES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'flashcard', 'flashcardFront', 'flashcardBack', 'mathBlock', 'inlineMath', 'text', 'hardBreak', 'mention',
]);
const PLAIN_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);

/** Whether rewriting this block from its Markdown would lose something. */
function locked(node: JNode): boolean {
  if (!PLAIN_NODES.has(node.type)) return true;
  if (node.type === 'mention' && (node.attrs?.kind ?? 'page') !== 'page') return true;
  if ((node.type === 'tableCell' || node.type === 'tableHeader') && ((node.attrs?.colspan ?? 1) !== 1 || (node.attrs?.rowspan ?? 1) !== 1)) return true;
  if (node.marks?.some((m) => !PLAIN_MARKS.has(m.type))) return true;
  return !!node.content?.some(locked);
}

/** A block the model can't see as text, named instead. */
function standIn(node: JNode): string | null {
  if (node.type === 'databaseBlock') return `(a database: "${titleOf(node.attrs?.id)}", id ${node.attrs?.id}; read it with read_database)`;
  if (node.type === 'image') return '(a picture)';
  if (node.type === 'fileBlock') return `(a file: "${titleOf(node.attrs?.id, 'file')}")`;
  return null;
}

export interface Block {
  markdown: string;
  locked: boolean;
}

export interface NoteState {
  page: PageMeta;
  version: string;
  /** The note's blocks as stored (editor JSON). */
  json: JNode[];
  blocks: Block[];
  /** The editors showing it now (none when it is closed). */
  editors: Editor[];
}

/** The note as it is this moment: from its open editor, else from what is stored. */
export async function noteState(id: unknown): Promise<NoteState> {
  const page = pageFor(id);
  if (page.kind === 'database') throw new ToolError('That is a database, not a note. Use read_database.');
  const editors = editorsOf(page.id);
  let json: JNode[];
  if (editors.length) json = (editors[0].getJSON() as JNode).content ?? [];
  else {
    // What was just typed elsewhere is written down first.
    window.dispatchEvent(new Event('td:flush'));
    await store.flush();
    json = docOf((await api.getPage(page.id)).content).content ?? [];
  }
  const markdown = blocksMarkdown(json, titleOf);
  const blocks = json.map((node, i) => ({ markdown: standIn(node) ?? markdown[i], locked: locked(node) }));
  return { page: store.untracked.get(page.id) ?? page, version: versionOf(json), json, blocks, editors };
}

/** A note for the model: numbered blocks, from block `from`, as much as fits. */
export function describe(state: NoteState, from = 1): string {
  const { page, blocks, version } = state;
  const lines = [`Note "${page.title || 'Untitled'}" (id ${page.id}), version ${version}, ${blocks.length} block${blocks.length === 1 ? '' : 's'}.`];
  if (!blocks.length) lines.push('(The note is empty.)');
  let used = 0;
  let i = Math.max(1, Math.floor(from) || 1);
  for (; i <= blocks.length; i++) {
    const b = blocks[i - 1];
    const text = `[${i}]${b.locked ? ' (locked)' : ''} ${b.markdown || '(empty line)'}`;
    if (used && used + text.length > READ_LIMIT) break;
    lines.push(text);
    used += text.length;
  }
  if (i <= blocks.length) lines.push(`(Blocks ${i} to ${blocks.length} are not shown. Read them with from: ${i}.)`);
  return lines.join('\n\n');
}

/** The one live, visible page with this title, for `[[Title]]`. */
export const pageTitled: Resolve = (title) => {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  let found: string | null = null;
  for (const p of store.untracked.values()) {
    if (p.deletedAt || p.title.trim().toLowerCase() !== want || keptFromAssistant(p.id)) continue;
    if (found) return null;
    found = p.id;
  }
  return found;
};

// ------------------------------------------------------------------ planning an edit

export type NoteEdit = { op: 'replace'; from: number; to?: number; markdown: string } | { op: 'insert'; after: number; markdown: string } | { op: 'delete'; from: number; to?: number };

export interface Plan {
  /** The note's blocks once the edits are made. */
  next: JNode[];
  /** The text that goes, and the text that comes, as Markdown (either may be empty). */
  before: string;
  after: string;
}

const int = (value: unknown, what: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError(`${what} must be a whole number (a block number from read_note).`);
  return value;
};

/** Checks blocks against the editor's schema; the error says what the model should fix. */
function checked(blocks: JNode[], schema: Schema): JNode[] {
  try {
    const doc = schema.topNodeType.create(null, Fragment.fromArray(blocks.map((b) => schema.nodeFromJSON(b))));
    doc.check();
  } catch (e) {
    throw new ToolError(`That Markdown made something a note can't hold (${e instanceof Error ? e.message : 'unknown'}). Use simpler Markdown: headings, paragraphs, lists, tables, code, quotes.`);
  }
  return blocks;
}

/** Markdown as blocks a note can hold. */
export function blocksFrom(markdown: unknown, schema: Schema = syncSchema()): JNode[] {
  if (typeof markdown !== 'string') throw new ToolError('markdown must be text.');
  return checked(fromMarkdown(markdown, pageTitled), schema);
}

/** A rewritten card keeps the id of the card it replaces, and with it what was learned. */
function keepCardIds(old: JNode[], made: JNode[]) {
  const ids = old.filter((n) => n.type === 'flashcard').map((n) => n.attrs?.id);
  let k = 0;
  for (const n of made) if (n.type === 'flashcard' && ids[k]) n.attrs = { ...n.attrs, id: ids[k++] };
}

/** The kinds of list a note has. */
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * A list written right after a list of the same kind is more of that list, and
 * one written right before it is its start: they become one block. Asked to add
 * an item, a model writes a new list beside the old one, and left as two lists
 * that shows as a gap in the middle of one. Two lists that were already apart
 * stay apart, even with a new one between them.
 */
function joinLists(blocks: JNode[], fresh: boolean[]): JNode[] {
  const out: JNode[] = [];
  /** Whether the last block of `out` is wholly new. */
  let lastNew = false;
  blocks.forEach((block, i) => {
    const last = out[out.length - 1];
    if (last && LISTS.has(block.type) && last.type === block.type && (fresh[i] || lastNew)) {
      // The list that was there keeps what it is (where its numbers start); the new one only brings its items.
      const kept = lastNew && !fresh[i] ? block : last;
      out[out.length - 1] = { ...kept, content: [...(last.content ?? []), ...(block.content ?? [])] };
      lastNew = lastNew && fresh[i];
      return;
    }
    out.push(block);
    lastNew = fresh[i];
  });
  return out;
}

/** Works out what the edits make of the note, changing nothing. */
export function plan(state: NoteState, version: unknown, edits: unknown, schema: Schema = syncSchema()): Plan {
  if (version !== state.version) throw new ToolError(`The note has changed since you read it (it is now version ${state.version}). Read it again with read_note, then plan the edit against what it says now.`);
  if (!Array.isArray(edits) || !edits.length) throw new ToolError('edits must be a list with at least one edit.');
  const n = state.json.length;
  /** Blocks being replaced or deleted: [from, to, their new blocks]. */
  const ranges: { from: number; to: number; made: JNode[] }[] = [];
  const inserts = new Map<number, JNode[]>();
  for (const edit of edits as NoteEdit[]) {
    if (edit?.op === 'insert') {
      const after = int(edit.after, 'after');
      if (after < 0 || after > n) throw new ToolError(`after must be between 0 (the top) and ${n} (the end).`);
      inserts.set(after, [...(inserts.get(after) ?? []), ...blocksFrom(edit.markdown, schema)]);
    } else if (edit?.op === 'replace' || edit?.op === 'delete') {
      const from = int(edit.from, 'from');
      const to = edit.to === undefined ? from : int(edit.to, 'to');
      if (from < 1 || to > n || from > to) throw new ToolError(`Blocks ${from} to ${to} aren't in this note: it has blocks 1 to ${n}.`);
      for (let i = from; i <= to; i++) if (state.blocks[i - 1].locked) throw new ToolError(`Block ${i} is locked: it holds something text can't carry, so it can't be rewritten or removed. Insert before or after it instead.`);
      if (ranges.some((r) => from <= r.to && to >= r.from)) throw new ToolError('Two edits touch the same block. Put them in one edit.');
      const made = edit.op === 'replace' ? blocksFrom(edit.markdown, schema) : [];
      keepCardIds(state.json.slice(from - 1, to), made);
      ranges.push({ from, to, made });
    } else throw new ToolError('Each edit needs op: "replace", "insert" or "delete".');
  }

  const laid: JNode[] = [];
  /** Which of `laid` are new. */
  const fresh: boolean[] = [];
  const gone: JNode[] = [];
  const come: JNode[] = [];
  const add = (blocks: JNode[]) => {
    laid.push(...blocks);
    come.push(...blocks);
    for (let k = 0; k < blocks.length; k++) fresh.push(true);
  };
  add(inserts.get(0) ?? []);
  for (let i = 1; i <= n; i++) {
    const range = ranges.find((r) => r.from === i);
    let end = i;
    if (range) {
      gone.push(...state.json.slice(range.from - 1, range.to));
      add(range.made);
      end = range.to;
    } else {
      laid.push(state.json[i - 1]);
      fresh.push(false);
    }
    // Text asked for after a block inside a replaced run lands after the run.
    for (let j = i; j <= end; j++) add(inserts.get(j) ?? []);
    i = end;
  }
  const next = joinLists(laid, fresh);
  if (!next.length) next.push({ type: 'paragraph' });
  checked(next, schema);
  const md = (blocks: JNode[]) => blocksMarkdown(blocks, titleOf).join('\n\n');
  return { next, before: md(gone), after: md(come) };
}

// ------------------------------------------------------------------ writing

/** Replaces only the run of blocks that differs, in one step of the editor's history. */
function replaceDiffering(editor: Editor, blocks: JNode[]) {
  const { state, schema } = editor;
  const old = state.doc;
  const next = Fragment.fromArray(blocks.map((b) => schema.nodeFromJSON(b)));
  let head = 0;
  while (head < old.childCount && head < next.childCount && old.child(head).eq(next.child(head))) head++;
  let tail = 0;
  while (tail < old.childCount - head && tail < next.childCount - head && old.child(old.childCount - 1 - tail).eq(next.child(next.childCount - 1 - tail))) tail++;
  if (head === old.childCount && head === next.childCount) return;
  let from = 0;
  for (let i = 0; i < head; i++) from += old.child(i).nodeSize;
  let to = from;
  for (let i = head; i < old.childCount - tail; i++) to += old.child(i).nodeSize;
  const middle: PMNode[] = [];
  for (let i = head; i < next.childCount - tail; i++) middle.push(next.child(i));
  editor.view.dispatch(middle.length ? state.tr.replaceWith(from, to, middle) : state.tr.delete(from, to));
}

/** A closed page under sync: its document takes the new body in now, not when the page is next opened. */
async function syncNow(pageId: string) {
  if (!syncAvailable() || !syncState.on || !syncState.ready) return;
  try {
    const docs = await import('../sync/docs');
    await docs.release(pageId, await docs.open(pageId));
  } catch (e) {
    console.warn('Assistant: the change will sync when the page is next opened', e);
  }
}

/** Makes the note hold exactly `blocks`. */
async function write(pageId: string, blocks: JNode[], editors: Editor[]) {
  const live = editorsOf(pageId);
  if (live.length) {
    // Editors on one shared document (sync, a live session) follow each other; plain ones each hold their own copy.
    const shared = live[0].extensionManager.extensions.some((e) => e.name === 'collaboration');
    for (const editor of shared ? live.slice(0, 1) : live) replaceDiffering(editor, blocks);
    window.dispatchEvent(new Event('td:flush'));
    await store.flush();
    return;
  }
  // It was open when read and has closed since: what is stored is what it held.
  void editors;
  const page = store.untracked.get(pageId);
  if (page?.sharedRoom && cowork.isLive(pageId)) throw new ToolError('This note is in a live session with a friend. Ask its owner to open it, then try again.');
  const schema = syncSchema();
  const doc = schema.topNodeType.create(null, Fragment.fromArray(blocks.map((b) => schema.nodeFromJSON(b))));
  const content = JSON.stringify(doc.toJSON());
  const text = getText(doc, { blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(schema) });
  store.update(pageId, { content, text }, { immediate: true });
  await store.flush();
  await syncNow(pageId);
}

/** A note as it was before a change, to put back. */
export interface Snapshot {
  pageId: string;
  title: string;
  json: JNode[];
  /** The version the change left; if the note still has it, undoing loses nothing else. */
  left: string;
}

/** Makes the planned edit (and a new title, if one was asked for). Returns what to put back. */
export async function applyPlan(state: NoteState, made: Plan, title?: string): Promise<Snapshot> {
  await write(state.page.id, made.next, state.editors);
  if (title !== undefined && title !== state.page.title) {
    store.update(state.page.id, { title }, { immediate: true });
    await store.flush();
  }
  // The version is read back, not worked out: storing a block fills in what the Markdown left unsaid.
  return { pageId: state.page.id, title: state.page.title, json: state.json, left: (await noteState(state.page.id)).version };
}

/** Whether the note still is what the change left (so undoing it loses nothing typed since). */
export async function untouchedSince(snapshot: Snapshot): Promise<boolean> {
  try {
    return (await noteState(snapshot.pageId)).version === snapshot.left;
  } catch {
    return false;
  }
}

/** Puts a note back as it was. */
export async function restore(snapshot: Snapshot) {
  const page = store.untracked.get(snapshot.pageId);
  if (!page || page.deletedAt) throw new Error('The note is gone.');
  await write(snapshot.pageId, snapshot.json.length ? snapshot.json : [{ type: 'paragraph' }], editorsOf(snapshot.pageId));
  if (page.title !== snapshot.title) {
    store.update(snapshot.pageId, { title: snapshot.title }, { immediate: true });
    await store.flush();
  }
}

/** A new note with this body. */
export async function createNote(title: string, blocks: JNode[], parentId: string | null): Promise<PageMeta> {
  const schema = syncSchema();
  // A model often repeats the title as the first heading: the page already shows it.
  const first = blocks[0];
  if (first?.type === 'heading' && (first.content ?? []).map((c) => c.text ?? '').join('').trim().toLowerCase() === title.trim().toLowerCase()) blocks = blocks.slice(1);
  const doc = schema.topNodeType.create(null, Fragment.fromArray((blocks.length ? blocks : [{ type: 'paragraph' }]).map((b) => schema.nodeFromJSON(b))));
  const content = JSON.stringify(doc.toJSON());
  const text = getText(doc, { blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(schema) });
  const meta = await api.createPage(parentId, null, title, '');
  await api.updatePage(meta.id, { content, text });
  await store.refresh();
  if (parentId) prefs.expanded[parentId] = true;
  // Lists that follow a page's body (flashcard counts, to-dos) hear of it like any save.
  window.dispatchEvent(new CustomEvent('td:page-saved', { detail: { id: meta.id, content } }));
  await syncNow(meta.id);
  return store.untracked.get(meta.id) ?? meta;
}

/** Cards as blocks, from fronts and backs. */
export function cardBlocks(cards: unknown): JNode[] {
  if (!Array.isArray(cards) || !cards.length) throw new ToolError('cards must be a list with at least one card.');
  if (cards.length > 100) throw new ToolError('At most 100 cards at a time.');
  return cards.map((c) => {
    const front = typeof c?.front === 'string' ? c.front.trim() : '';
    const back = typeof c?.back === 'string' ? c.back.trim() : '';
    if (!front || !back) throw new ToolError('Every card needs a front and a back.');
    return flashcard(front, back, pageTitled);
  });
}
