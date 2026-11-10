/**
 * Page text as a Yjs document, kept apart from Svelte and Tauri so it can be
 * tested on its own (tests/e2e/sync-text.spec.ts). The editor's schema is
 * passed in; see schema.ts for the real one.
 *
 * Comparing is always done through the schema (`Node.eq`), never as text: Yjs
 * drops null attributes, so one document has two JSON forms. A picture's
 * address differs by platform (`http://tdfile.localhost/x`,
 * `tdfile://localhost/x`), so both compare and diff in one canonical form.
 */

import * as Y from 'yjs';
import { DOMParser as PMDOMParser, Node, type Schema } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';

export { Y };

/** The editor's field in the document (what Collaboration reads by default). */
export const FIELD = 'default';

/** Origins of changes to a document that are not typing: what the mailbox
 *  brought, and what was loaded from this computer. */
export const REMOTE = 'td-sync-remote';
export const LOAD = 'td-sync-load';

export interface Json {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  marks?: Json[];
  text?: string;
}

const EMPTY: Json = { type: 'doc', content: [] };
const FILE = /^(?:https?:\/\/tdfile\.localhost\/|tdfile:\/\/localhost\/)([A-Za-z0-9.]+)$/;

/** The one form a library file's address has inside a document. */
export function canonicalSrc(src: string): string {
  const name = FILE.exec(src)?.[1];
  return name ? `tdfile://localhost/${name}` : src;
}

/** A copy of `json` with every picture's address in the canonical form. */
export function canonical(json: Json): Json {
  const out: Json = { ...json };
  if (out.type === 'image' && typeof out.attrs?.src === 'string') out.attrs = { ...out.attrs, src: canonicalSrc(out.attrs.src) };
  if (out.content) out.content = out.content.map(canonical);
  return out;
}

/** A stored body (editor JSON, or HTML in a page nobody has edited yet) as JSON; null if it isn't one. */
export function bodyJson(content: string, schema: Schema): Json | null {
  if (!content) return EMPTY;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    try {
      const html = new window.DOMParser().parseFromString(content, 'text/html').body;
      return PMDOMParser.fromSchema(schema).parse(html).toJSON() as Json;
    } catch {
      return null;
    }
  }
}

/** The document, or null when this schema can't read it (a newer app's block). */
export function parse(json: Json, schema: Schema, keepSrc = false): Node | null {
  try {
    return Node.fromJSON(schema, keepSrc ? json : canonical(json));
  } catch {
    return null;
  }
}

/** No text and at most one empty paragraph: the same as a page with nothing in it. */
function blank(node: Node): boolean {
  if (node.childCount === 0) return true;
  const first = node.firstChild!;
  return node.childCount === 1 && first.type.name === 'paragraph' && first.childCount === 0;
}

function same(a: Node, b: Node): boolean {
  return (blank(a) && blank(b)) || a.eq(b);
}

/** Whether a body has nothing in it (nothing to add to a document that has the page's text already). */
export function isBlank(json: Json, schema: Schema): boolean {
  const node = parse(json, schema);
  return !!node && blank(node);
}

/** Whether two documents are the same page; null if either can't be read. */
export function docsEqual(a: Json, b: Json, schema: Schema): boolean | null {
  const x = parse(a, schema);
  const y = parse(b, schema);
  return x && y ? same(x, y) : null;
}

/** The text of a body, a block to a line (for search). */
export function textOf(node: Json): string {
  if (node.text) return node.text;
  const inner = (node.content ?? []).map(textOf);
  return node.type === 'doc' || node.type?.endsWith('List') || node.type === 'listItem' || node.type === 'taskItem' ? inner.join('\n') : inner.join('');
}

/** What the document holds: editor JSON and the words for search. */
export function read(doc: Y.Doc): { json: Json; text: string } {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FIELD)) as Json;
  return { json, text: textOf(json) };
}

function images(json: Json, out: string[] = []): string[] {
  if (json.type === 'image' && typeof json.attrs?.src === 'string') out.push(json.attrs.src);
  for (const c of json.content ?? []) images(c, out);
  return out;
}

/** `target` with each picture's address written the way the document already
 *  has it (when it is the same picture), so the diff leaves it alone; any
 *  other picture gets the canonical form. */
function aligned(target: Json, current: Json): Json {
  const have = new Map<string, string[]>();
  for (const src of images(current)) {
    const key = canonicalSrc(src);
    have.set(key, [...(have.get(key) ?? []), src]);
  }
  const walk = (node: Json): Json => {
    const out: Json = { ...node };
    if (out.type === 'image' && typeof out.attrs?.src === 'string') {
      const key = canonicalSrc(out.attrs.src);
      out.attrs = { ...out.attrs, src: have.get(key)?.shift() ?? key };
    }
    if (out.content) out.content = out.content.map(walk);
    return out;
  };
  return walk(target);
}

/**
 * Makes the document say `json`, changing as little of it as it can.
 * True if the document changed, false if it already said that, and null if
 * the schema can't read one of them (nothing is touched then).
 */
export function diffInto(doc: Y.Doc, json: Json, schema: Schema, origin: unknown = LOAD): boolean | null {
  const now = read(doc).json;
  const want = parse(json, schema);
  const have = parse(now, schema);
  if (!want || !have) return null;
  if (same(have, want)) return false;
  const target = parse(aligned(json, now), schema, true);
  if (!target) return null;
  let changed = false;
  const note = () => (changed = true);
  doc.on('update', note);
  try {
    // The meta is what y-tiptap itself passes: the mapping of nodes, and which marks overlap.
    doc.transact(() => updateYFragment(doc, doc.getXmlFragment(FIELD), target, { mapping: new Map(), isOMark: new Map() } as never), origin);
  } finally {
    doc.off('update', note);
  }
  return changed;
}

/** Puts a page's first body into an empty document. False if there was nothing to put. */
export function seed(doc: Y.Doc, json: Json, schema: Schema, origin: unknown = LOAD): boolean | null {
  if (doc.getXmlFragment(FIELD).length) return false;
  return diffInto(doc, json, schema, origin);
}

/** What changed in `doc` since `before` (a state vector), as one update. */
export function since(doc: Y.Doc, before: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, before);
}
