/**
 * Markdown as editor blocks: what the assistant writes becomes the same
 * content typing would have made. The reverse of ../markdown.ts, for the part
 * of Markdown a model writes: headings, lists (to-dos too), quotes, code,
 * tables, rules, formulas, links to pages (`[[Title]]`) and flashcards
 * (`front :: back`).
 *
 * It builds plain JSON and knows nothing of the editor; the caller checks the
 * result against the editor's schema (notes.ts).
 */

import { Lexer, type Token, type Tokens } from 'marked';
import { newCardId } from '../editor/flashcard';
import type { JNode } from '../markdown';

type Mark = NonNullable<JNode['marks']>[number];

/** The id of the page a `[[Title]]` means, or null when no one page has that title. */
export type Resolve = (title: string) => string | null;

const SAFE_LINK = /^(https?:|mailto:)/i;
/** `$x$` with nothing but the formula inside (no space just inside the dollars), and `[[Title]]`. */
const SPECIAL = /\$([^\s$](?:[^$\n]*[^\s$])?)\$|\[\[([^\[\]\n]{1,200})\]\]/g;

function text(value: string, marks: Mark[]): JNode[] {
  if (!value) return [];
  return [marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value }];
}

/** Plain text, with the formulas and page links in it picked out. */
function plain(value: string, marks: Mark[], resolve: Resolve): JNode[] {
  // Inside code nothing is special.
  if (marks.some((m) => m.type === 'code')) return text(value, marks);
  const out: JNode[] = [];
  let at = 0;
  for (const match of value.matchAll(SPECIAL)) {
    const [whole, latex, title] = match;
    const start = match.index ?? 0;
    let node: JNode | null = null;
    if (latex !== undefined) node = { type: 'inlineMath', attrs: { latex } };
    else {
      const id = resolve(title.trim());
      if (id) node = { type: 'mention', attrs: { id, kind: 'page' } };
    }
    if (!node) continue;
    out.push(...text(value.slice(at, start), marks), node);
    at = start + whole.length;
  }
  out.push(...text(value.slice(at), marks));
  return out;
}

function inline(tokens: Token[] | undefined, marks: Mark[], resolve: Resolve): JNode[] {
  const out: JNode[] = [];
  for (const token of tokens ?? []) {
    const t = token as Tokens.Generic;
    switch (t.type) {
      case 'strong':
        out.push(...inline(t.tokens, [...marks, { type: 'bold' }], resolve));
        break;
      case 'em':
        out.push(...inline(t.tokens, [...marks, { type: 'italic' }], resolve));
        break;
      case 'del':
        out.push(...inline(t.tokens, [...marks, { type: 'strike' }], resolve));
        break;
      case 'codespan':
        // Code takes no other formatting in the editor.
        out.push(...text(t.text, [{ type: 'code' }]));
        break;
      case 'link':
        if (SAFE_LINK.test(t.href)) out.push(...inline(t.tokens, [...marks, { type: 'link', attrs: { href: t.href } }], resolve));
        else out.push(...inline(t.tokens, marks, resolve));
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'image':
        // A picture can't be made from an address alone: its words stay.
        out.push(...text(t.text || t.href, marks));
        break;
      case 'checkbox':
        break;
      default:
        // Text, an escaped character, or HTML (kept as the text it is: nothing a model writes is run).
        if (t.tokens?.length) out.push(...inline(t.tokens, marks, resolve));
        else out.push(...plain(t.text ?? t.raw ?? '', marks, resolve));
    }
  }
  return out;
}

const paragraph = (content: JNode[]): JNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

/** One side of a flashcard, or any single line of text. */
export function inlineFromMarkdown(markdown: string, resolve: Resolve = () => null): JNode[] {
  return inline(Lexer.lexInline(markdown.replace(/\s*\n\s*/g, ' ').trim()), [], resolve);
}

export function flashcard(front: string, back: string, resolve: Resolve = () => null): JNode {
  const side = (type: string, value: string): JNode => {
    const content = inlineFromMarkdown(value, resolve);
    return content.length ? { type, content } : { type };
  };
  return { type: 'flashcard', attrs: { id: newCardId() }, content: [side('flashcardFront', front), side('flashcardBack', back)] };
}

/** `front :: back` on every line of a paragraph: the cards it is. */
function cards(raw: string, resolve: Resolve): JNode[] | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const out: JNode[] = [];
  for (const line of lines) {
    const at = line.indexOf(' :: ');
    if (at < 1 || at + 4 >= line.length) return null;
    out.push(flashcard(line.slice(0, at), line.slice(at + 4), resolve));
  }
  return out;
}

function listItems(list: Tokens.List, resolve: Resolve): JNode {
  const tasks = list.items.some((i) => i.task);
  const items = list.items.map((item): JNode => {
    const content = blocks(item.tokens, resolve);
    const filled = content.length ? content : [paragraph([])];
    // An item starts with a line of text in the editor.
    if (filled[0].type !== 'paragraph') filled.unshift(paragraph([]));
    return tasks ? { type: 'taskItem', attrs: { checked: !!item.checked }, content: filled } : { type: 'listItem', content: filled };
  });
  if (tasks) return { type: 'taskList', content: items };
  if (list.ordered) return { type: 'orderedList', attrs: { start: Number(list.start) || 1 }, content: items };
  return { type: 'bulletList', content: items };
}

function table(t: Tokens.Table, resolve: Resolve): JNode {
  const cell = (type: string, c: Tokens.TableCell): JNode => ({ type, content: [paragraph(inline(c.tokens, [], resolve))] });
  return {
    type: 'table',
    content: [{ type: 'tableRow', content: t.header.map((c) => cell('tableHeader', c)) }, ...t.rows.map((row) => ({ type: 'tableRow', content: row.map((c) => cell('tableCell', c)) }))],
  };
}

function blocks(tokens: Token[] | undefined, resolve: Resolve): JNode[] {
  const out: JNode[] = [];
  for (const token of tokens ?? []) {
    const t = token as Tokens.Generic;
    switch (t.type) {
      case 'space':
      case 'checkbox':
      case 'def':
        break;
      case 'heading':
        out.push({ type: 'heading', attrs: { level: Math.min(3, Math.max(1, t.depth)) }, content: inline(t.tokens, [], resolve) });
        break;
      case 'paragraph': {
        const raw = String(t.text ?? '');
        const math = /^\$\$\s*([\s\S]+?)\s*\$\$$/.exec(raw.trim());
        if (math) {
          out.push({ type: 'mathBlock', attrs: { latex: math[1] } });
          break;
        }
        const made = cards(raw, resolve);
        if (made) out.push(...made);
        else out.push(paragraph(inline(t.tokens, [], resolve)));
        break;
      }
      case 'text':
        // A line of a tight list.
        out.push(paragraph(t.tokens?.length ? inline(t.tokens, [], resolve) : plain(String(t.text ?? ''), [], resolve)));
        break;
      case 'list':
        out.push(listItems(t as Tokens.List, resolve));
        break;
      case 'blockquote': {
        const content = blocks(t.tokens, resolve);
        out.push({ type: 'blockquote', content: content.length ? content : [paragraph([])] });
        break;
      }
      case 'code': {
        const code = String(t.text ?? '');
        out.push({ type: 'codeBlock', attrs: { language: t.lang || null }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) });
        break;
      }
      case 'hr':
        out.push({ type: 'horizontalRule' });
        break;
      case 'table':
        out.push(table(t as Tokens.Table, resolve));
        break;
      default: {
        // HTML and anything unknown: kept as the text it is.
        const raw = String(t.text ?? t.raw ?? '').trim();
        if (raw) out.push(paragraph(text(raw, [])));
      }
    }
  }
  return out;
}

/** Markdown as the editor's blocks. */
export function fromMarkdown(markdown: string, resolve: Resolve = () => null): JNode[] {
  return blocks(new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, '\n')), resolve);
}
