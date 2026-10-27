/**
 * Converts editor JSON into a Word document (.docx): headings, lists,
 * to-dos, quotes, callouts, toggles, code, tables, images, flashcards and
 * links, with real Word styles so the result stays editable.
 */

import type { JNode } from './markdown';
import type { ExportedImage } from './export-images';
import { zip } from './zip';
import { iconText } from './page-icon';
import { toOmml } from './math/omml';
import { loadKatex } from './math/katex';
import { t } from './i18n';

type Kind = 'page' | 'assignment' | 'event' | 'file';

export interface DocxContext {
  /** Title of a linked page, assignment, event or file. */
  titleOf: (id: string, kind?: Kind) => string;
  /** Loads an image as PNG, or null to leave it out. */
  image: (src: string) => Promise<ExportedImage | null>;
}

/** Formatting for whole runs, on top of their own marks. */
interface RunStyle {
  bold?: boolean;
  /** Hex colour, e.g. "7F7F7F". */
  color?: string;
}

/** Formatting a block inherits from what it's inside (a quote, a callout). */
interface Frame {
  /** Extra left indent, in twips. */
  indent: number;
  quote?: boolean;
  shade?: boolean;
  /** Every run bold (table header cells). */
  bold?: boolean;
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

/** Text safe inside XML (control characters dropped, specials escaped). */
function esc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Body width: 6.5 inches. */
const TEXT_TWIPS = 9360;
const TEXT_PX = 624;
const EMU_PER_PX = 9525;
const SHADE = 'F2F2F2';
/** Text colours and highlight tints (palette keys) in shades that print well. */
const TEXT_COLORS: Record<string, string> = {
  red: 'C62828', orange: 'D2560C', yellow: 'A07800', green: '2E7D32', teal: '00796B',
  blue: '1565C0', indigo: '3949AB', purple: '7B1FA2', pink: 'C2185B', gray: '6B6B6B',
};
const HIGHLIGHT_TINTS: Record<string, string> = {
  red: 'FDE2E1', orange: 'FDE9D7', yellow: 'FFF3BF', green: 'DDF3E0', teal: 'D5F1EE',
  blue: 'DCEBFB', indigo: 'E3E5F8', purple: 'EEE0F6', pink: 'FBE0EC', gray: 'ECECEC',
};
const HAIRLINE = 'D9D9D9';

class Writer {
  rels: string[] = [];
  media: { name: string; data: Uint8Array }[] = [];
  /** Numbered lists: each restarts at its own start number. */
  numbered: { id: number; start: number }[] = [];
  #rel = 10;
  #pic = 1;

  constructor(private ctx: DocxContext) {}

  relId(type: string, target: string, external = false): string {
    const id = `rId${this.#rel++}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return id;
  }

  // -------------------------------------------------------------- inline

  /** One run of text. Word wants run properties in schema order. */
  run(text: string, marks: { type: string; attrs?: Record<string, any> }[] = [], style: RunStyle = {}): string {
    const has = (type: string) => marks.some((m) => m.type === type);
    const textColor = TEXT_COLORS[marks.find((m) => m.type === 'textColor')?.attrs?.color ?? ''];
    const tint = HIGHLIGHT_TINTS[marks.find((m) => m.type === 'highlight')?.attrs?.color ?? ''];
    let rPr = '';
    if (has('link')) rPr += '<w:rStyle w:val="Hyperlink"/>';
    if (has('code')) rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
    if (has('bold') || style.bold) rPr += '<w:b/>';
    if (has('italic')) rPr += '<w:i/>';
    if (has('strike')) rPr += '<w:strike/>';
    if (style.color || textColor) rPr += `<w:color w:val="${style.color ?? textColor}"/>`;
    if (has('code')) rPr += '<w:sz w:val="20"/>';
    if (has('highlight') && !tint) rPr += '<w:highlight w:val="yellow"/>';
    if (has('underline')) rPr += '<w:u w:val="single"/>';
    // Shading is one property: code's grey wins over a coloured highlight.
    if (has('code') || tint) rPr += `<w:shd w:val="clear" w:color="auto" w:fill="${has('code') ? SHADE : tint}"/>`;
    const lines = text.split('\n');
    const body = lines.map((l, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(l)}</w:t>`).join('');
    return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${body}</w:r>`;
  }

  inline(nodes: JNode[] | undefined, style: RunStyle = {}): string {
    let out = '';
    for (const n of nodes ?? []) {
      if (n.type === 'text') {
        const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
        const r = this.run(n.text ?? '', n.marks, style);
        out += link ? `<w:hyperlink r:id="${this.relId('hyperlink', link, true)}">${r}</w:hyperlink>` : r;
      } else if (n.type === 'hardBreak') {
        out += '<w:r><w:br/></w:r>';
      } else if (n.type === 'inlineMath') {
        const latex = String(n.attrs?.latex ?? '');
        out += toOmml(latex, false) ?? this.run(latex, [{ type: 'code' }], style);
      } else if (n.type === 'mention') {
        out += this.run(this.ctx.titleOf(n.attrs?.id, n.attrs?.kind ?? 'page'), [{ type: 'underline' }], style);
      } else if (n.content) {
        out += this.inline(n.content, style);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- blocks

  para(runs: string, frame: Frame, opts: { style?: string; num?: [number, number]; indent?: number; hanging?: number; keepNext?: boolean; center?: boolean; border?: 'bottom' } = {}): string {
    let pPr = '';
    if (opts.style) pPr += `<w:pStyle w:val="${opts.style}"/>`;
    else if (frame.quote) pPr += '<w:pStyle w:val="Quote"/>';
    if (opts.keepNext) pPr += '<w:keepNext/>';
    if (opts.num) pPr += `<w:numPr><w:ilvl w:val="${opts.num[1]}"/><w:numId w:val="${opts.num[0]}"/></w:numPr>`;
    if (opts.border === 'bottom') pPr += `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${HAIRLINE}"/></w:pBdr>`;
    if (frame.shade) pPr += `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>`;
    let left = frame.indent + (opts.indent ?? 0);
    let hanging = opts.hanging ?? 0;
    // Inside a callout or toggle, a list item moves over with it.
    if (opts.num && frame.indent) {
      left = frame.indent + 720 * (opts.num[1] + 1);
      hanging = 360;
    }
    if ((left && !opts.num) || (opts.num && frame.indent) || hanging) {
      pPr += `<w:ind w:left="${left}"${hanging ? ` w:hanging="${hanging}"` : ''}/>`;
    }
    if (opts.center) pPr += '<w:jc w:val="center"/>';
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
  }

  async blocks(nodes: JNode[] | undefined, frame: Frame): Promise<string> {
    let out = '';
    const list = nodes ?? [];
    const isTable = (n?: JNode) => n?.type === 'table' || n?.type === 'flashcard';
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.type === 'flashcard') {
        // Cards in a row become one two-column table.
        const cards: JNode[] = [];
        while (list[i + 1]?.type === 'flashcard') cards.push(list[i++]);
        cards.push(list[i]);
        out += this.cards(cards, frame);
      } else {
        out += await this.block(n, frame);
      }
      // Word merges tables that touch, and a cell or the page can't end on
      // one; keep a paragraph after.
      if (isTable(n) && (i === list.length - 1 || isTable(list[i + 1]))) out += this.para('', frame);
    }
    return out;
  }

  async block(n: JNode, frame: Frame): Promise<string> {
    switch (n.type) {
      case 'paragraph':
        return this.para(this.inline(n.content, { bold: frame.bold }), frame);
      case 'mathBlock': {
        const latex = String(n.attrs?.latex ?? '');
        const omml = toOmml(latex, true);
        return omml ? this.para(omml, frame) : this.para(this.run(latex, [{ type: 'code' }]), frame);
      }
      case 'heading': {
        const level = Math.min(3, Math.max(1, n.attrs?.level ?? 1));
        return this.para(this.inline(n.content, { bold: frame.bold }), frame, { style: `Heading${level}`, keepNext: true });
      }
      case 'bulletList':
      case 'orderedList':
        return this.list(n, frame, 0);
      case 'taskList':
        return this.tasks(n, frame, 0);
      case 'blockquote':
        return this.blocks(n.content, { ...frame, quote: true });
      case 'callout': {
        const inner = { ...frame, shade: true };
        const [first, ...rest] = n.content ?? [];
        const icon = this.run(`${iconText(n.attrs?.icon) || '💡'}  `);
        const head = first?.type === 'paragraph' ? this.para(icon + this.inline(first.content), inner) : this.para(icon, inner) + (first ? await this.block(first, inner) : '');
        return head + (await this.blocks(rest, inner));
      }
      case 'details': {
        const summary = n.content?.find((c) => c.type === 'detailsSummary');
        const body = n.content?.find((c) => c.type === 'detailsContent');
        return (
          this.para(this.run('▸ ') + this.inline(summary?.content, { bold: true }), frame, { keepNext: true }) +
          (await this.blocks(body?.content, { ...frame, indent: frame.indent + 360 }))
        );
      }
      case 'codeBlock': {
        const text = (n.content ?? []).map((c) => c.text ?? '').join('');
        return this.para(this.run(text), frame, { style: 'Code' });
      }
      case 'horizontalRule':
        return this.para('', frame, { border: 'bottom' });
      case 'table':
        return this.table(n, frame);
      case 'image':
        return this.picture(n, frame);
      case 'fileBlock':
        return this.para(this.run(`📎 ${this.ctx.titleOf(n.attrs?.id, 'file')}`), frame);
      case 'pageLink':
        return this.para(this.run(`📄 ${this.ctx.titleOf(n.attrs?.id, 'page')}`, [{ type: 'underline' }]), frame);
      default:
        if (n.content?.some((c) => c.type === 'text')) return this.para(this.inline(n.content), frame);
        return this.blocks(n.content, frame);
    }
  }

  async list(n: JNode, frame: Frame, level: number): Promise<string> {
    let num = 1;
    if (n.type === 'orderedList') {
      num = 2 + this.numbered.length;
      this.numbered.push({ id: num, start: n.attrs?.start ?? 1 });
    }
    let out = '';
    for (const item of n.content ?? []) {
      let first = true;
      for (const child of item.content ?? []) {
        if (child.type === 'bulletList' || child.type === 'orderedList') out += await this.list(child, frame, Math.min(level + 1, 8));
        else if (child.type === 'taskList') out += await this.tasks(child, frame, level + 1);
        else if (first && child.type === 'paragraph') out += this.para(this.inline(child.content), frame, { num: [num, level] });
        // Later paragraphs of an item line up with its text.
        else out += await this.block(child, { ...frame, indent: frame.indent + 720 * (level + 1) });
        first = false;
      }
    }
    return out;
  }

  async tasks(n: JNode, frame: Frame, level: number): Promise<string> {
    let out = '';
    for (const item of n.content ?? []) {
      const done = !!item.attrs?.checked;
      let first = true;
      for (const child of item.content ?? []) {
        if (child.type === 'taskList') out += await this.tasks(child, frame, level + 1);
        else if (first && child.type === 'paragraph') {
          const box = this.run(done ? '☑ ' : '☐ ');
          const text = this.inline(child.content, done ? { color: '7F7F7F' } : {});
          out += this.para(box + text, frame, { indent: 360 + 360 * level, hanging: 360 });
        } else out += await this.block(child, { ...frame, indent: frame.indent + 360 + 360 * level });
        first = false;
      }
    }
    return out;
  }

  async table(n: JNode, frame: Frame): Promise<string> {
    const rows = n.content ?? [];
    const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((k, c) => k + (c.attrs?.colspan ?? 1), 0)));
    // Column widths from the editor (px), scaled to fit the page.
    const px: number[] = [];
    for (const c of rows[0]?.content ?? []) {
      const span = c.attrs?.colspan ?? 1;
      const widths: (number | null)[] = c.attrs?.colwidth ?? [];
      for (let k = 0; k < span; k++) px.push(widths[k] ?? 0);
    }
    while (px.length < cols) px.push(0);
    const known = px.filter(Boolean);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const raw = px.map((w) => w || fallback);
    const total = raw.reduce((a, b) => a + b, 0);
    const available = TEXT_TWIPS - frame.indent;
    const twips = raw.map((w) => Math.max(400, Math.round((w / total) * available)));

    let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${available}" w:type="dxa"/>`;
    if (frame.indent) out += `<w:tblInd w:w="${frame.indent}" w:type="dxa"/>`;
    out += '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>';
    out += twips.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';
    for (const row of rows) {
      out += '<w:tr><w:trPr><w:cantSplit/></w:trPr>';
      let col = 0;
      for (const cell of row.content ?? []) {
        const span = cell.attrs?.colspan ?? 1;
        const width = twips.slice(col, col + span).reduce((a, b) => a + b, 0);
        col += span;
        const header = cell.type === 'tableHeader';
        let tcPr = `<w:tcW w:w="${width}" w:type="dxa"/>`;
        if (span > 1) tcPr += `<w:gridSpan w:val="${span}"/>`;
        if (header) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/>`;
        const body = await this.blocks(cell.content, { indent: 0, bold: header });
        out += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${body.includes('<w:p') ? body : '<w:p/>'}</w:tc>`;
      }
      out += '</w:tr>';
    }
    return out + '</w:tbl>';
  }

  cards(cards: JNode[], frame: Frame): string {
    const available = TEXT_TWIPS - frame.indent;
    const front = Math.round(available * 0.38);
    const back = available - front;
    let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${available}" w:type="dxa"/>`;
    if (frame.indent) out += `<w:tblInd w:w="${frame.indent}" w:type="dxa"/>`;
    out += `<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${front}"/><w:gridCol w:w="${back}"/></w:tblGrid>`;
    for (const c of cards) {
      const [f, b] = c.content ?? [];
      out +=
        '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        `<w:tc><w:tcPr><w:tcW w:w="${front}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/></w:tcPr><w:p>${this.inline(f?.content, { bold: true })}</w:p></w:tc>` +
        `<w:tc><w:tcPr><w:tcW w:w="${back}" w:type="dxa"/></w:tcPr><w:p>${this.inline(b?.content)}</w:p></w:tc>` +
        '</w:tr>';
    }
    return out + '</w:tbl>';
  }

  async picture(n: JNode, frame: Frame): Promise<string> {
    const src = n.attrs?.src;
    const img = src ? await this.ctx.image(src) : null;
    if (!img) return n.attrs?.alt ? this.para(this.run(t('pages.export.missingImage', { alt: String(n.attrs.alt) })), frame) : '';
    const name = `image${this.#pic}.png`;
    const id = this.#pic++;
    this.media.push({ name, data: img.bytes });
    const rel = this.relId('image', `media/${name}`);
    const wanted = Number(n.attrs?.width) || img.width;
    const width = Math.min(wanted, TEXT_PX - frame.indent / 15);
    const height = (width * img.height) / img.width;
    const cx = Math.round(width * EMU_PER_PX);
    const cy = Math.round(height * EMU_PER_PX);
    const alt = esc(n.attrs?.alt ?? '');
    const drawing =
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    return this.para(drawing, frame, { center: true });
  }
}

// ------------------------------------------------------------------ parts

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:keepLines/><w:shd w:val="clear" w:color="auto" w:fill="${SHADE}"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/><w:left w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="${HAIRLINE}"/>
</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function numbering(numbered: { id: number; start: number }[]): string {
  const bullets = ['•', '◦', '▪'];
  const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
  const level = (i: number, fmt: string, text: string, font = '') =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
  const bulletLevels = Array.from({ length: 9 }, (_, i) =>
    level(i, 'bullet', bullets[i % 3], '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>'),
  ).join('');
  const numberLevels = Array.from({ length: 9 }, (_, i) => level(i, formats[i % 3], `%${i + 1}.`)).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${numberLevels}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    numbered
      .map(
        (n) =>
          `<w:num w:numId="${n.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`,
      )
      .join('') +
    '</w:numbering>'
  );
}

/** US Letter where people use it, A4 elsewhere. */
function pageSize(): string {
  const letter = /^(en-US|en-CA|es-MX|fil|en-PH)/.test(navigator.language);
  return letter ? '<w:pgSz w:w="12240" w:h="15840"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
}

export async function toDocx(doc: JNode, title: string, ctx: DocxContext): Promise<Uint8Array> {
  // Equations are built from KaTeX's MathML.
  if (/"(inlineMath|mathBlock)"/.test(JSON.stringify(doc))) await loadKatex().catch(() => {});
  const w = new Writer(ctx);
  const titlePara = w.para(w.run(title || t('common.untitled')), { indent: 0 }, { style: 'Title' });
  const body = await w.blocks(doc.content, { indent: 0 });
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>` +
    titlePara +
    body +
    `<w:sectPr>${pageSize()}<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
    '</w:body></w:document>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(title)}</dc:title><dc:creator>Thought Desk</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
        '</cp:coreProperties>',
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: numbering(w.numbered) },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        w.rels.join('') +
        '</Relationships>',
    },
    ...w.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ]);
}
