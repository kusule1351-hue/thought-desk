/** Converts editor JSON into GitHub-flavored Markdown. */

import { iconText } from './page-icon';
import { t } from './i18n';

interface Mark {
  type: string;
  attrs?: Record<string, any>;
}

export interface JNode {
  type: string;
  attrs?: Record<string, any>;
  content?: JNode[];
  text?: string;
  marks?: Mark[];
}

/** Title of a linked page, assignment, event or file. */
type TitleOf = (id: string, kind?: 'page' | 'assignment' | 'event' | 'file') => string;

/** Where an export puts what a page points to outside itself. */
export interface Links {
  /** A library file's link from the page, or null to just name it. */
  file?: (id: string) => string | null;
  /** A picture's address from the page. */
  image?: (src: string) => string;
}

interface Cx extends Links {
  titleOf: TitleOf;
}

const imageSrc = (n: JNode, cx: Cx) => {
  const src = n.attrs?.src ?? '';
  return cx.image ? cx.image(src) : src;
};

/** A library file by name, linked when the export has a copy of it. */
function fileRef(id: string, cx: Cx, plain: (name: string) => string): string {
  const name = escapeText(cx.titleOf(id, 'file'));
  const href = cx.file?.(id);
  return href ? `[${name}](${href})` : plain(name);
}

/** The longest run of `ch` in `s`. */
function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
// `$` too: Markdown apps read "$5 and $10" as a formula.
const escapeText = (s: string) => s.replace(/([\\`*_[\]$])/g, '\\$1');

/** `$…$` only counts as math with no space just inside the dollars. */
const inlineMath = (latex: string) => (latex.trim() ? `$${latex.trim()}$` : '');

function wrapMarks(text: string, marks: Mark[] = []): string {
  if (marks.some((m) => m.type === 'code')) {
    // Fenced by one backtick more than the longest run inside, with a space
    // when it starts or ends with one (so ``` reads as ```` ``` ````).
    const ticks = '`'.repeat(longestRun(text, '`') + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    text = `${ticks}${pad}${text}${pad}${ticks}`;
  } else {
    text = escapeText(text);
  }
  // Keep surrounding whitespace outside the markers so they stay valid.
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!core) return text;
  let out = core;
  for (const m of marks) {
    if (m.type === 'bold') out = `**${out}**`;
    else if (m.type === 'italic') out = `_${out}_`;
    else if (m.type === 'strike') out = `~~${out}~~`;
    else if (m.type === 'highlight') out = `==${out}==`;
    else if (m.type === 'underline') out = `<u>${out}</u>`;
  }
  const link = marks.find((m) => m.type === 'link');
  if (link) out = `[${out}](${link.attrs?.href ?? ''})`;
  return lead + out + trail;
}

function sameMarks(a: Mark[] = [], b: Mark[] = []) {
  return a.length === b.length && a.every((m, i) => m.type === b[i].type && JSON.stringify(m.attrs) === JSON.stringify(b[i].attrs));
}

function inline(nodes: JNode[] | undefined, cx: Cx): string {
  if (!nodes) return '';
  // Merge adjacent text runs that share marks to avoid "**a****b**".
  const merged: JNode[] = [];
  for (const n of nodes) {
    const last = merged[merged.length - 1];
    if (n.type === 'text' && last?.type === 'text' && sameMarks(last.marks, n.marks)) {
      merged[merged.length - 1] = { ...last, text: (last.text ?? '') + (n.text ?? '') };
    } else merged.push(n);
  }
  return merged
    .map((n) => {
      if (n.type === 'text') return wrapMarks(n.text ?? '', n.marks);
      if (n.type === 'hardBreak') return '  \n';
      if (n.type === 'mention') {
        const kind = n.attrs?.kind ?? 'page';
        if (kind === 'file') return fileRef(n.attrs?.id, cx, (name) => `**${name}**`);
        return kind === 'page' ? `[[${cx.titleOf(n.attrs?.id)}]]` : `**${escapeText(cx.titleOf(n.attrs?.id, kind))}**`;
      }
      if (n.type === 'image') return `![${n.attrs?.alt ?? ''}](${imageSrc(n, cx)})`;
      if (n.type === 'inlineMath') return inlineMath(n.attrs?.latex ?? '');
      return inline(n.content, cx);
    })
    .join('');
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join('\n');
}

function listItem(item: JNode, marker: string, cx: Cx): string {
  const body = (item.content ?? []).map((c) => block(c, cx)).join('\n');
  return prefixLines(body, marker, ' '.repeat(marker.length));
}

function cellText(cell: JNode, cx: Cx): string {
  return (cell.content ?? [])
    .map((p) => inline(p.content, cx))
    .join('<br>')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function block(n: JNode, cx: Cx): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content, cx);
    case 'heading':
      return `${'#'.repeat(n.attrs?.level ?? 1)} ${inline(n.content, cx)}`;
    case 'bulletList':
      return (n.content ?? []).map((i) => listItem(i, '- ', cx)).join('\n');
    case 'orderedList': {
      const start = n.attrs?.start ?? 1;
      return (n.content ?? []).map((i, k) => listItem(i, `${start + k}. `, cx)).join('\n');
    }
    case 'taskList':
      return (n.content ?? []).map((i) => listItem(i, i.attrs?.checked ? '- [x] ' : '- [ ] ', cx)).join('\n');
    case 'blockquote':
      return prefixLines(blocks(n.content, cx), '> ', '> ');
    case 'callout':
      return prefixLines(`${iconText(n.attrs?.icon) || '💡'} ${blocks(n.content, cx)}`, '> ', '> ');
    case 'codeBlock': {
      const code = (n.content ?? []).map((c) => c.text ?? '').join('');
      const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
      return `${fence}${n.attrs?.language ?? ''}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'flashcard': {
      // "front :: back", the format flashcard tools read.
      const [front, back] = n.content ?? [];
      return `${inline(front?.content, cx)} :: ${inline(back?.content, cx)}`;
    }
    case 'mathBlock': {
      const latex = (n.attrs?.latex ?? '').trim();
      return latex ? `$$\n${latex}\n$$` : '';
    }
    case 'image':
      return `![${n.attrs?.alt ?? ''}](${imageSrc(n, cx)})`;
    case 'pageLink':
      return `[[${cx.titleOf(n.attrs?.id)}]]`;
    case 'fileBlock':
      return `📎 ${fileRef(n.attrs?.id, cx, (name) => name)}`;
    case 'details': {
      const [summary, content] = n.content ?? [];
      return `<details>\n<summary>${inline(summary?.content, cx)}</summary>\n\n${blocks(content?.content, cx)}\n\n</details>`;
    }
    case 'table': {
      const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => cellText(c, cx)));
      if (rows.length === 0) return '';
      const width = rows.map((r) => r.length).reduce((a, b) => Math.max(a, b), -Infinity);
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
      return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
    }
    default:
      return n.content ? blocks(n.content, cx) : inline([n], cx);
  }
}

function blocks(nodes: JNode[] | undefined, cx: Cx): string {
  return (nodes ?? []).map((n) => block(n, cx)).join('\n\n');
}

export function toMarkdown(doc: JNode, title: string, titleOf: TitleOf, links: Links = {}): string {
  const body = blocks(doc.content, { ...links, titleOf }).replace(/\n{3,}/g, '\n\n').trim();
  return `# ${title || t('common.untitled')}\n\n${body}\n`;
}
