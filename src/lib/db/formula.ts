/**
 * Formulas: a small expression language for computed properties.
 *
 *   {Price} * {Quantity}
 *   if({Status} == "Done", "✓", daysUntil({Due}) + " days left")
 *   formatDate(dateAdd({Start}, 2, "weeks"), "MMM D")
 *
 * Properties are written in braces ({Due date}); a one-word name works on
 * its own (Price * 2), and prop("Due date") works too. Empty values count as
 * 0 in arithmetic unless every input is empty (then the result is empty).
 *
 * The language itself is English in every interface language, since it's
 * saved in people's formulas: function names, the words and/or/not/true/false,
 * units ("weeks"), date patterns ("MMM D") and what formatDate() and toText()
 * write. What people read about it (the reference's descriptions, errors) is
 * translated, with any formula code in it passed in as a parameter.
 */
import { t, type TextKey } from '../i18n';
import { fmt } from '../i18n/format';

/** A date (or date and time) inside a formula. */
export class FDate {
  constructor(
    readonly ms: number,
    readonly time: boolean,
  ) {}
}

export type FValue = number | string | boolean | FDate | FValue[] | null;

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly at = -1,
  ) {
    super(message);
  }
}

// --------------------------------------------------------------------- parsing

type TokenKind = 'num' | 'str' | 'prop' | 'id' | 'op' | '(' | ')' | ',' | '?' | ':' | 'eof';
interface Token {
  t: TokenKind;
  v: string;
  at: number;
}

export type Node =
  | { k: 'lit'; v: FValue; at: number }
  | { k: 'prop'; name: string; at: number }
  | { k: 'call'; name: string; args: Node[]; at: number }
  | { k: 'un'; op: string; a: Node; at: number }
  | { k: 'bin'; op: string; a: Node; b: Node; at: number }
  | { k: 'if'; c: Node; a: Node; b: Node; at: number };

const OPS2 = ['==', '!=', '<=', '>=', '&&', '||'];
const OPS1 = '+-*/%^<>!=≠≤≥&';
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const num = /(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/iy;
  const ident = /[A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF]*/uy;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    num.lastIndex = i;
    const n = num.exec(src);
    if (n && /[\d.]/.test(c)) {
      out.push({ t: 'num', v: n[0], at });
      i += n[0].length;
      continue;
    }
    if (QUOTES[c]) {
      const close = QUOTES[c];
      let s = '';
      i++;
      while (i < src.length && src[i] !== close && !(close === '”' && src[i] === '"')) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[++i];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new FormulaError(t('dbAuto.formula.error.unclosedText'), at);
      i++;
      out.push({ t: 'str', v: s, at });
      continue;
    }
    if (c === '{') {
      const end = src.indexOf('}', i + 1);
      if (end < 0) throw new FormulaError(t('dbAuto.formula.error.unclosedProperty', { brace: '}' }), at);
      out.push({ t: 'prop', v: src.slice(i + 1, end).trim(), at });
      i = end + 1;
      continue;
    }
    ident.lastIndex = i;
    const id = ident.exec(src);
    if (id) {
      out.push({ t: 'id', v: id[0], at });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ t: 'op', v: two, at });
      i += 2;
      continue;
    }
    if ('(),?:'.includes(c)) {
      out.push({ t: c as TokenKind, v: c, at });
      i++;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push({ t: 'op', v: c, at });
      i++;
      continue;
    }
    throw new FormulaError(t('dbAuto.formula.error.unknownChar', { char: c }), at);
  }
  out.push({ t: 'eof', v: '', at: src.length });
  return out;
}

/** Binary operators: canonical name, precedence, right-associative. */
function binary(tok: Token): { op: string; prec: number; right?: boolean } | null {
  const v = tok.t === 'id' ? tok.v.toLowerCase() : tok.t === 'op' ? tok.v : '';
  switch (v) {
    case 'or':
    case '||':
      return { op: 'or', prec: 1 };
    case 'and':
    case '&&':
      return { op: 'and', prec: 2 };
    case '==':
    case '=':
      return { op: '==', prec: 4 };
    case '!=':
    case '≠':
      return { op: '!=', prec: 4 };
    case '<':
    case '>':
      return { op: v, prec: 4 };
    case '<=':
    case '≤':
      return { op: '<=', prec: 4 };
    case '>=':
    case '≥':
      return { op: '>=', prec: 4 };
    case '+':
    case '-':
    case '&':
      return { op: v === '&' ? '+' : v, prec: 5 };
    case '*':
    case '/':
    case '%':
      return { op: v, prec: 6 };
    case '^':
      return { op: '^', prec: 8, right: true };
  }
  return null;
}

class Parser {
  i = 0;
  constructor(private toks: Token[]) {}

  peek(): Token {
    return this.toks[this.i];
  }

  next(): Token {
    return this.toks[this.i++];
  }

  /** The next token must be `kind` (":" or ")"), which is also what the error names. */
  expect(kind: ':' | ')') {
    const tok = this.next();
    if (tok.t !== kind)
      throw new FormulaError(
        tok.t === 'eof' ? t('dbAuto.formula.error.missingAtEnd', { char: kind }) : t('dbAuto.formula.error.expectedBefore', { char: kind, token: tok.v }),
        tok.at,
      );
  }

  parse(): Node {
    if (this.peek().t === 'eof') return { k: 'lit', v: null, at: 0 };
    const node = this.expr(0);
    const tok = this.peek();
    if (tok.t !== 'eof') throw new FormulaError(tok.t === ')' ? t('dbAuto.formula.error.strayClose') : t('dbAuto.formula.error.unexpectedMissingOperator', { token: tok.v }), tok.at);
    return node;
  }

  expr(min: number): Node {
    let left = this.prefix();
    for (;;) {
      const tok = this.peek();
      if (tok.t === '?' && min <= 0) {
        this.next();
        const a = this.expr(0);
        this.expect(':');
        const b = this.expr(0);
        left = { k: 'if', c: left, a, b, at: tok.at };
        continue;
      }
      const op = binary(tok);
      if (!op || op.prec < min) break;
      this.next();
      const right = this.expr(op.right ? op.prec : op.prec + 1);
      left = { k: 'bin', op: op.op, a: left, b: right, at: tok.at };
    }
    return left;
  }

  prefix(): Node {
    const tok = this.next();
    switch (tok.t) {
      case 'num':
        return { k: 'lit', v: Number(tok.v), at: tok.at };
      case 'str':
        return { k: 'lit', v: tok.v, at: tok.at };
      case 'prop':
        return { k: 'prop', name: tok.v, at: tok.at };
      case '(': {
        const inner = this.expr(0);
        this.expect(')');
        return inner;
      }
      case 'op':
        if (tok.v === '-' || tok.v === '+') return { k: 'un', op: tok.v, a: this.expr(7), at: tok.at };
        if (tok.v === '!') return { k: 'un', op: 'not', a: this.expr(3), at: tok.at };
        break;
      case 'id': {
        const word = tok.v.toLowerCase();
        if (word === 'true' || word === 'false') return { k: 'lit', v: word === 'true', at: tok.at };
        if (word === 'not' && this.peek().t !== '(') return { k: 'un', op: 'not', a: this.expr(3), at: tok.at };
        if (this.peek().t === '(') {
          this.next();
          const args: Node[] = [];
          if (this.peek().t !== ')') {
            for (;;) {
              args.push(this.expr(0));
              if (this.peek().t === ',') this.next();
              else break;
            }
          }
          this.expect(')');
          if (word === 'prop') {
            const arg = args[0];
            if (args.length !== 1 || arg.k !== 'lit' || typeof arg.v !== 'string') {
              throw new FormulaError(t('dbAuto.formula.error.propTakesName', { fn: 'prop()' }), tok.at);
            }
            return { k: 'prop', name: arg.v, at: tok.at };
          }
          if (!FUNCTIONS[word]) throw new FormulaError(t('dbAuto.formula.error.noFunction', { fn: `${tok.v}()` }), tok.at);
          const fn = FUNCTIONS[word];
          if (args.length < fn.min || (fn.max !== undefined && args.length > fn.max)) {
            throw new FormulaError(t(fn.takes, { fn: `${fn.name}()` }), tok.at);
          }
          return { k: 'call', name: word, args, at: tok.at };
        }
        // A one-word property name.
        return { k: 'prop', name: tok.v, at: tok.at };
      }
    }
    if (tok.t === 'eof') throw new FormulaError(t('dbAuto.formula.error.endsTooSoon'), tok.at);
    throw new FormulaError(t('dbAuto.formula.error.unexpected', { token: tok.v }), tok.at);
  }
}

const parsed = new Map<string, Node | FormulaError>();

/** Parses a formula (cached); throws FormulaError with where it went wrong. */
export function parse(src: string): Node {
  let hit = parsed.get(src);
  if (!hit) {
    try {
      hit = new Parser(tokenize(src)).parse();
    } catch (e) {
      hit = e instanceof FormulaError ? e : new FormulaError(String(e));
    }
    if (parsed.size > 500) parsed.clear();
    parsed.set(src, hit);
  }
  if (hit instanceof FormulaError) throw hit;
  return hit;
}

/** Property names a formula uses (to find loops and to rename). */
export function references(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case 'prop':
      out.add(node.name.toLowerCase());
      break;
    case 'call':
      node.args.forEach((a) => references(a, out));
      break;
    case 'un':
      references(node.a, out);
      break;
    case 'bin':
      references(node.a, out);
      references(node.b, out);
      break;
    case 'if':
      references(node.c, out);
      references(node.a, out);
      references(node.b, out);
      break;
  }
  return out;
}

/** The formula with a property renamed everywhere it appears. */
export function renameProperty(src: string, from: string, to: string): string {
  let toks: Token[];
  try {
    toks = tokenize(src);
  } catch {
    return src;
  }
  const lower = from.toLowerCase();
  let out = '';
  let last = 0;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const bare = tok.t === 'id' && toks[i + 1]?.t !== '(' && !['and', 'or', 'not', 'true', 'false'].includes(tok.v.toLowerCase());
    if ((tok.t === 'prop' || bare) && tok.v.toLowerCase() === lower) {
      const end = tok.t === 'prop' ? src.indexOf('}', tok.at) + 1 : tok.at + tok.v.length;
      out += src.slice(last, tok.at) + `{${to}}`;
      last = end;
    } else if (tok.t === 'id' && tok.v.toLowerCase() === 'prop' && toks[i + 1]?.t === '(' && toks[i + 2]?.t === 'str' && toks[i + 2].v.toLowerCase() === lower && toks[i + 3]?.t === ')') {
      out += src.slice(last, tok.at) + `{${to}}`;
      last = toks[i + 3].at + 1;
      i += 3;
    }
  }
  return out + src.slice(last);
}

// ------------------------------------------------------------------ evaluation

export interface Scope {
  /** A property's value by name (any case); undefined when there's none. */
  prop(name: string): FValue | undefined;
  /** "Now", fixed for one render. */
  now: number;
}

const isNum = (v: FValue): v is number => typeof v === 'number';

export function isEmpty(v: FValue): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v));
}

function truthy(v: FValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof FDate) return true;
  return !!v;
}

/** An operation that needs numbers (or, comparing, dates), as its errors name it. */
type Op = 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder' | 'power' | 'compare' | 'minus';
/** What needed a value, for the error when it can't have it: an operation, or a function by its name ("round()"). */
type Need = Op | `${string}()`;
/** A message without plural forms. */
type Key = TextKey;

/** "Adding needs a number, not a list": one message for each operation and each kind of value it can't use. */
const NEEDS_NUMBER: Record<Op | 'function', { list: Key; text: Key }> = {
  add: { list: 'dbAuto.formula.error.needsNumber.addingList', text: 'dbAuto.formula.error.needsNumber.addingText' },
  subtract: { list: 'dbAuto.formula.error.needsNumber.subtractingList', text: 'dbAuto.formula.error.needsNumber.subtractingText' },
  multiply: { list: 'dbAuto.formula.error.needsNumber.multiplyingList', text: 'dbAuto.formula.error.needsNumber.multiplyingText' },
  divide: { list: 'dbAuto.formula.error.needsNumber.dividingList', text: 'dbAuto.formula.error.needsNumber.dividingText' },
  remainder: { list: 'dbAuto.formula.error.needsNumber.remainderList', text: 'dbAuto.formula.error.needsNumber.remainderText' },
  power: { list: 'dbAuto.formula.error.needsNumber.powerList', text: 'dbAuto.formula.error.needsNumber.powerText' },
  compare: { list: 'dbAuto.formula.error.needsNumber.comparingList', text: 'dbAuto.formula.error.needsNumber.comparingText' },
  minus: { list: 'dbAuto.formula.error.needsNumber.minusList', text: 'dbAuto.formula.error.needsNumber.minusText' },
  function: { list: 'dbAuto.formula.error.needsNumber.functionList', text: 'dbAuto.formula.error.needsNumber.functionText' },
};

/** Text quoted in an error: its first 20 characters. */
const clip = (s: string) => (s.length > 20 ? s.slice(0, 20) + '…' : s);

function num(v: FValue, what: Need): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    if (v.trim() && !Number.isNaN(n)) return n;
  }
  if (v instanceof FDate) return v.ms;
  if (Array.isArray(v) && v.length === 1) return num(v[0], what);
  // What's left is text that isn't a number, or a list of none or several.
  const keys = NEEDS_NUMBER[what.endsWith('()') ? 'function' : (what as Op)];
  throw new FormulaError(Array.isArray(v) ? t(keys.list, { fn: what }) : t(keys.text, { fn: what, text: clip(v) }));
}

/** A number without floating-point noise (0.1 + 0.2 shows as 0.3). */
export function cleanNumber(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(12)) : n;
}

// What formatDate() writes is a formula's value (sorted, filtered, compared
// with text in other formulas, exported), so it's English in every language.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDateValue(d: FDate, pattern?: string): string {
  const date = new Date(d.ms);
  const p = pattern ?? (d.time ? 'MMM D, YYYY h:mm A' : 'MMM D, YYYY');
  const pad = (n: number) => String(n).padStart(2, '0');
  return p.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|A|a/g, (tok, lit) => {
    if (lit !== undefined) return lit;
    const h = date.getHours();
    switch (tok) {
      case 'YYYY':
        return String(date.getFullYear());
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'MMMM':
        return MONTHS[date.getMonth()];
      case 'MMM':
        return MONTHS[date.getMonth()].slice(0, 3);
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'dddd':
        return WEEKDAYS[date.getDay()];
      case 'ddd':
        return WEEKDAYS[date.getDay()].slice(0, 3);
      case 'DD':
        return pad(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'HH':
        return pad(h);
      case 'H':
        return String(h);
      case 'hh':
        return pad(h % 12 || 12);
      case 'h':
        return String(h % 12 || 12);
      case 'mm':
        return pad(date.getMinutes());
      case 'A':
        return h < 12 ? 'AM' : 'PM';
      case 'a':
        return h < 12 ? 'am' : 'pm';
    }
    return tok;
  });
}

/** A formula value as text (for joining text, and for showing results). */
export function toText(v: FValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(cleanNumber(v)) : v > 0 ? '∞' : v < 0 ? '-∞' : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof FDate) return formatDateValue(v);
  return v.map(toText).filter(Boolean).join(', ');
}

/** "Comparing needs a date, not a list": one message for each kind of value a date can't be read from. */
const NEEDS_DATE: Record<'compare' | 'function', { list: Key; text: Key; boolean: Key }> = {
  compare: {
    list: 'dbAuto.formula.error.needsDate.comparingList',
    text: 'dbAuto.formula.error.needsDate.comparingText',
    boolean: 'dbAuto.formula.error.needsDate.comparingBoolean',
  },
  function: {
    list: 'dbAuto.formula.error.needsDate.functionList',
    text: 'dbAuto.formula.error.needsDate.functionText',
    boolean: 'dbAuto.formula.error.needsDate.functionBoolean',
  },
};

function date(v: FValue, what: 'compare' | `${string}()`): FDate | null {
  if (v === null || v === '') return null;
  if (v instanceof FDate) return v;
  if (Array.isArray(v) && v.length === 1) return date(v[0], what);
  if (typeof v === 'string') {
    const d = parseDateText(v);
    if (d) return d;
  }
  if (typeof v === 'number') return new FDate(v, true);
  // What's left is text that isn't a date, true/false, or a list of none or several.
  const keys = NEEDS_DATE[what === 'compare' ? 'compare' : 'function'];
  if (Array.isArray(v)) throw new FormulaError(t(keys.list, { fn: what }));
  if (typeof v === 'string') throw new FormulaError(t(keys.text, { fn: what, text: clip(v) }));
  throw new FormulaError(t(keys.boolean, { fn: what }));
}

/** "2026-10-14", "2026-10-14T09:30" or anything Date.parse reads. */
export function parseDateText(s: string): FDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(s.trim());
  if (m) {
    const [, y, mo, d, h, mi] = m;
    return new FDate(new Date(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0).getTime(), !!h);
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new FDate(ms, /\d:\d/.test(s));
}

function text(v: FValue): string {
  return toText(v);
}

function list(v: FValue): FValue[] {
  return Array.isArray(v) ? v : v === null ? [] : [v];
}

/** Flattens the arguments of sum(), min() and friends (lists count too). */
function numbers(args: FValue[], what: Need): number[] {
  const out: number[] = [];
  for (const a of args.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    const n = num(a, what);
    if (n !== null) out.push(n);
  }
  return out;
}

const UNITS: Record<string, string> = {
  year: 'years', years: 'years', y: 'years',
  quarter: 'quarters', quarters: 'quarters',
  month: 'months', months: 'months',
  week: 'weeks', weeks: 'weeks', w: 'weeks',
  day: 'days', days: 'days', d: 'days',
  hour: 'hours', hours: 'hours', h: 'hours',
  minute: 'minutes', minutes: 'minutes', min: 'minutes', mins: 'minutes',
};

function unit(v: FValue): string {
  const u = UNITS[text(v).trim().toLowerCase()];
  // The unit words are the formula's own (English) ones, quoted as they're typed.
  if (!u) throw new FormulaError(t('dbAuto.formula.error.units', { units: '"years", "months", "weeks", "days", "hours"', last: '"minutes"' }));
  return u;
}

function addTo(d: FDate, n: number, u: string): FDate {
  const x = new Date(d.ms);
  switch (u) {
    case 'years':
      x.setFullYear(x.getFullYear() + n);
      break;
    case 'quarters':
      x.setMonth(x.getMonth() + 3 * n);
      break;
    case 'months':
      x.setMonth(x.getMonth() + n);
      break;
    case 'weeks':
      x.setDate(x.getDate() + 7 * n);
      break;
    case 'days':
      x.setDate(x.getDate() + n);
      break;
    case 'hours':
      return new FDate(d.ms + n * 3_600_000, true);
    case 'minutes':
      return new FDate(d.ms + n * 60_000, true);
  }
  return new FDate(x.getTime(), d.time);
}

/** Calendar days from b to a (ignoring times and daylight-saving shifts). */
function dayDiff(a: FDate, b: FDate): number {
  const day = (d: FDate) => {
    const x = new Date(d.ms);
    return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  };
  return day(a) - day(b);
}

function between(a: FDate, b: FDate, u: string): number {
  const trunc = Math.trunc;
  const da = new Date(a.ms);
  const db = new Date(b.ms);
  switch (u) {
    case 'years':
    case 'quarters':
    case 'months': {
      let months = (da.getFullYear() - db.getFullYear()) * 12 + da.getMonth() - db.getMonth();
      // A month only counts once its day has come round.
      if (months > 0 && da.getDate() < db.getDate()) months--;
      if (months < 0 && da.getDate() > db.getDate()) months++;
      return u === 'years' ? trunc(months / 12) : u === 'quarters' ? trunc(months / 3) : months;
    }
    case 'weeks':
      return trunc(dayDiff(a, b) / 7);
    case 'days':
      return a.time && b.time ? trunc((a.ms - b.ms) / 86_400_000) : dayDiff(a, b);
    case 'hours':
      return trunc((a.ms - b.ms) / 3_600_000);
    default:
      return trunc((a.ms - b.ms) / 60_000);
  }
}

function startOfToday(now: number): FDate {
  const d = new Date(now);
  return new FDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), false);
}

function equal(a: FValue, b: FValue): boolean {
  if (a instanceof FDate && b instanceof FDate) return a.ms === b.ms;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isEmpty(a) && isEmpty(b)) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  // A select's option compared with text, a one-item list with its item.
  if (Array.isArray(a) && a.length === 1) return equal(a[0], b);
  if (Array.isArray(b) && b.length === 1) return equal(a, b[0]);
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b.trim();
  if (typeof b === 'number' && typeof a === 'string') return String(b) === a.trim();
  return a === b;
}

function compare(a: FValue, b: FValue, op: string): boolean {
  if (a === null || b === null) return false;
  let x: number | string;
  let y: number | string;
  if (a instanceof FDate || b instanceof FDate) {
    x = date(a, 'compare')!.ms;
    y = date(b, 'compare')!.ms;
  } else if (typeof a === 'string' && typeof b === 'string') {
    x = a.toLowerCase();
    y = b.toLowerCase();
  } else {
    x = num(a, 'compare') ?? 0;
    y = num(b, 'compare') ?? 0;
  }
  switch (op) {
    case '<':
      return x < y;
    case '>':
      return x > y;
    case '<=':
      return x <= y;
    default:
      return x >= y;
  }
}

function arithmetic(op: string, a: FValue, b: FValue): FValue {
  if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return text(a) + text(b);
  if (op === '+' && Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (op === '-' && a instanceof FDate && b instanceof FDate) return dayDiff(a, b);
  if (isEmpty(a) && isEmpty(b)) return null;
  const names: Record<string, Op> = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'remainder', '^': 'power' };
  const x = num(a, names[op]) ?? 0;
  const y = num(b, names[op]) ?? 0;
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      if (y === 0) throw new FormulaError(t('dbAuto.formula.error.divideByZero'));
      return x / y;
    case '%':
      if (y === 0) throw new FormulaError(t('dbAuto.formula.error.divideByZero'));
      return x % y;
    default:
      return x ** y;
  }
}

/** The sections of the function reference, in order, and what each is called. */
export const FN_GROUPS = ['logic', 'math', 'text', 'dates', 'lists'] as const;
export type FnGroup = (typeof FN_GROUPS)[number];
export const FN_GROUP_LABELS: Record<FnGroup, string> = {
  logic: t('dbAuto.formula.group.logic'),
  math: t('dbAuto.formula.group.math'),
  text: t('dbAuto.formula.group.text'),
  dates: t('dbAuto.formula.group.dates'),
  lists: t('dbAuto.formula.group.lists'),
};

/**
 * What a function takes, in words: shown after its name in the reference
 * ("round() · a number, decimal places"), and as a whole sentence in the
 * error when it's given too few or too many values ("round() takes a number,
 * decimal places"). One message for each, so neither is fitted into the other.
 */
const ARGS = {
  if: { sig: 'dbAuto.formula.args.if', takes: 'dbAuto.formula.error.takes.if' },
  ifs: { sig: 'dbAuto.formula.args.ifs', takes: 'dbAuto.formula.error.takes.ifs' },
  conditions: { sig: 'dbAuto.formula.args.conditions', takes: 'dbAuto.formula.error.takes.conditions' },
  condition: { sig: 'dbAuto.formula.args.condition', takes: 'dbAuto.formula.error.takes.condition' },
  value: { sig: 'dbAuto.formula.args.value', takes: 'dbAuto.formula.error.takes.value' },
  ifEmpty: { sig: 'dbAuto.formula.args.ifEmpty', takes: 'dbAuto.formula.error.takes.ifEmpty' },
  round: { sig: 'dbAuto.formula.args.round', takes: 'dbAuto.formula.error.takes.round' },
  number: { sig: 'dbAuto.formula.args.number', takes: 'dbAuto.formula.error.takes.number' },
  pow: { sig: 'dbAuto.formula.args.pow', takes: 'dbAuto.formula.error.takes.pow' },
  mod: { sig: 'dbAuto.formula.args.mod', takes: 'dbAuto.formula.error.takes.mod' },
  numbers: { sig: 'dbAuto.formula.args.numbers', takes: 'dbAuto.formula.error.takes.numbers' },
  text: { sig: 'dbAuto.formula.args.text', takes: 'dbAuto.formula.error.takes.text' },
  texts: { sig: 'dbAuto.formula.args.texts', takes: 'dbAuto.formula.error.takes.texts' },
  textOrList: { sig: 'dbAuto.formula.args.textOrList', takes: 'dbAuto.formula.error.takes.textOrList' },
  contains: { sig: 'dbAuto.formula.args.contains', takes: 'dbAuto.formula.error.takes.contains' },
  startsWith: { sig: 'dbAuto.formula.args.startsWith', takes: 'dbAuto.formula.error.takes.startsWith' },
  endsWith: { sig: 'dbAuto.formula.args.endsWith', takes: 'dbAuto.formula.error.takes.endsWith' },
  replace: { sig: 'dbAuto.formula.args.replace', takes: 'dbAuto.formula.error.takes.replace' },
  slice: { sig: 'dbAuto.formula.args.slice', takes: 'dbAuto.formula.error.takes.slice' },
  split: { sig: 'dbAuto.formula.args.split', takes: 'dbAuto.formula.error.takes.split' },
  repeat: { sig: 'dbAuto.formula.args.repeat', takes: 'dbAuto.formula.error.takes.repeat' },
  date: { sig: 'dbAuto.formula.args.date', takes: 'dbAuto.formula.error.takes.date' },
  dateAmountUnit: { sig: 'dbAuto.formula.args.dateAmountUnit', takes: 'dbAuto.formula.error.takes.dateAmountUnit' },
  dateBetween: { sig: 'dbAuto.formula.args.dateBetween', takes: 'dbAuto.formula.error.takes.dateBetween' },
  formatDate: { sig: 'dbAuto.formula.args.formatDate', takes: 'dbAuto.formula.error.takes.formatDate' },
  list: { sig: 'dbAuto.formula.args.list', takes: 'dbAuto.formula.error.takes.list' },
  at: { sig: 'dbAuto.formula.args.at', takes: 'dbAuto.formula.error.takes.at' },
  join: { sig: 'dbAuto.formula.args.join', takes: 'dbAuto.formula.error.takes.join' },
} satisfies Record<string, { sig: Key; takes: Key }>;
type Args = keyof typeof ARGS;

interface FnDef {
  /** As it's typed in formulas (English in every language). */
  name: string;
  /** What it takes, in words ("a number, decimal places"); empty for none. */
  sig: string;
  /** The error when it's given too few or too many values ("{fn} takes a number, decimal places"). */
  takes: Key;
  /** What it does, in words, with any example formula as written ("Rounds: round(3.14159, 2) is 3.14"); a few are only an example. */
  doc: string;
  group: FnGroup;
  min: number;
  max?: number;
  /** Gets its arguments unevaluated (if, ifs, and, or). */
  lazy?: (args: Node[], scope: Scope) => FValue;
  run?: (args: FValue[], scope: Scope) => FValue;
}

/** A function: `args` says what it takes (null for nothing, like now()). */
function def(group: FnDef['group'], name: string, args: Args | null, doc: string, min: number, max: number | undefined, run: FnDef['run'], lazy?: FnDef['lazy']): FnDef {
  const sig = args ? t(ARGS[args].sig) : '';
  const takes = args ? ARGS[args].takes : 'dbAuto.formula.error.takesNothing';
  return { name, sig, takes, doc, group, min, max, run, lazy };
}

const round = (n: number, places = 0) => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export const FUNCTIONS: Record<string, FnDef> = Object.fromEntries(
  [
    def('logic', 'if', 'if', t('dbAuto.formula.doc.if', { example: 'if({Done}, "✓", "")' }), 2, 3, undefined, (args, s) =>
      truthy(evaluate(args[0], s)) ? evaluate(args[1], s) : args[2] ? evaluate(args[2], s) : null,
    ),
    def('logic', 'ifs', 'ifs', t('dbAuto.formula.doc.ifs', { example: 'ifs({Score} >= 90, "A", {Score} >= 80, "B", "C")' }), 2, undefined, undefined, (args, s) => {
      for (let i = 0; i + 1 < args.length; i += 2) if (truthy(evaluate(args[i], s))) return evaluate(args[i + 1], s);
      return args.length % 2 ? evaluate(args[args.length - 1], s) : null;
    }),
    def('logic', 'and', 'conditions', t('dbAuto.formula.doc.and'), 1, undefined, undefined, (args, s) => args.every((a) => truthy(evaluate(a, s)))),
    def('logic', 'or', 'conditions', t('dbAuto.formula.doc.or'), 1, undefined, undefined, (args, s) => args.some((a) => truthy(evaluate(a, s)))),
    def('logic', 'not', 'condition', t('dbAuto.formula.doc.not'), 1, 1, ([a]) => !truthy(a)),
    def('logic', 'empty', 'value', t('dbAuto.formula.doc.empty', { example: 'empty({Due})' }), 1, 1, ([a]) => isEmpty(a)),
    def('logic', 'ifEmpty', 'ifEmpty', t('dbAuto.formula.doc.ifEmpty'), 2, 2, ([a, b]) => (isEmpty(a) ? b : a)),

    def('math', 'round', 'round', t('dbAuto.formula.doc.round', { example: 'round(3.14159, 2)', result: '3.14' }), 1, 2, ([a, p]) => {
      const n = num(a, 'round()');
      return n === null ? null : round(n, num(p ?? 0, 'round()') ?? 0);
    }),
    def('math', 'floor', 'number', t('dbAuto.formula.doc.floor'), 1, 1, ([a]) => (num(a, 'floor()') === null ? null : Math.floor(num(a, 'floor()')!))),
    def('math', 'ceil', 'number', t('dbAuto.formula.doc.ceil'), 1, 1, ([a]) => (num(a, 'ceil()') === null ? null : Math.ceil(num(a, 'ceil()')!))),
    def('math', 'abs', 'number', t('dbAuto.formula.doc.abs'), 1, 1, ([a]) => (num(a, 'abs()') === null ? null : Math.abs(num(a, 'abs()')!))),
    def('math', 'sqrt', 'number', t('dbAuto.formula.doc.sqrt'), 1, 1, ([a]) => {
      const n = num(a, 'sqrt()');
      if (n !== null && n < 0) throw new FormulaError(t('dbAuto.formula.error.negativeRoot', { fn: 'sqrt()' }));
      return n === null ? null : Math.sqrt(n);
    }),
    def('math', 'pow', 'pow', t('dbAuto.formula.doc.pow', { example: 'pow(2, 10)', result: '1024' }), 2, 2, ([a, b]) => arithmetic('^', a, b)),
    def('math', 'mod', 'mod', t('dbAuto.formula.doc.mod', { example: 'mod(10, 3)', result: '1' }), 2, 2, ([a, b]) => arithmetic('%', a, b)),
    def('math', 'min', 'numbers', t('dbAuto.formula.doc.min'), 1, undefined, (args) => {
      const ns = numbers(args, 'min()');
      return ns.length ? ns.reduce((a, b) => Math.min(a, b), Infinity) : null;
    }),
    def('math', 'max', 'numbers', t('dbAuto.formula.doc.max'), 1, undefined, (args) => {
      const ns = numbers(args, 'max()');
      return ns.length ? ns.reduce((a, b) => Math.max(a, b), -Infinity) : null;
    }),
    def('math', 'sum', 'numbers', t('dbAuto.formula.doc.sum', { example: 'sum({Q1}, {Q2}, {Q3})' }), 1, undefined, (args) => {
      const ns = numbers(args, 'sum()');
      return ns.length ? ns.reduce((x, y) => x + y, 0) : null;
    }),
    def('math', 'average', 'numbers', t('dbAuto.formula.doc.average'), 1, undefined, (args) => {
      const ns = numbers(args, 'average()');
      return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : null;
    }),
    def('math', 'toNumber', 'text', t('dbAuto.formula.doc.toNumber', { example: 'toNumber("42")', result: '42' }), 1, 1, ([a]) => {
      if (a === null || a === '') return null;
      const n = Number(text(a).replace(/[^\d.eE+-]/g, ''));
      return Number.isNaN(n) ? null : n;
    }),

    def('text', 'concat', 'texts', t('dbAuto.formula.doc.concat'), 1, undefined, (args) => args.map(text).join('')),
    def('text', 'length', 'textOrList', t('dbAuto.formula.doc.length'), 1, 1, ([a]) => (Array.isArray(a) ? a.length : text(a).length)),
    def('text', 'lower', 'text', t('dbAuto.formula.doc.lower'), 1, 1, ([a]) => text(a).toLowerCase()),
    def('text', 'upper', 'text', t('dbAuto.formula.doc.upper'), 1, 1, ([a]) => text(a).toUpperCase()),
    def('text', 'trim', 'text', t('dbAuto.formula.doc.trim'), 1, 1, ([a]) => text(a).trim()),
    def('text', 'contains', 'contains', t('dbAuto.formula.doc.contains', { example: 'contains({Tags}, "exam")' }), 2, 2, ([a, b]) =>
      Array.isArray(a) ? a.some((x) => equal(x, b)) : text(a).toLowerCase().includes(text(b).toLowerCase()),
    ),
    def('text', 'startsWith', 'startsWith', t('dbAuto.formula.doc.startsWith'), 2, 2, ([a, b]) => text(a).toLowerCase().startsWith(text(b).toLowerCase())),
    def('text', 'endsWith', 'endsWith', t('dbAuto.formula.doc.endsWith'), 2, 2, ([a, b]) => text(a).toLowerCase().endsWith(text(b).toLowerCase())),
    def('text', 'replace', 'replace', t('dbAuto.formula.doc.replace'), 3, 3, ([a, b, c]) => text(a).split(text(b)).join(text(c))),
    def('text', 'slice', 'slice', t('dbAuto.formula.doc.slice', { example: 'slice("Thought", 0, 3)', result: '"Tho"' }), 2, 3, ([a, b, c]) =>
      text(a).slice(num(b, 'slice()') ?? 0, c === undefined || c === null ? undefined : (num(c, 'slice()') ?? undefined)),
    ),
    def('text', 'split', 'split', t('dbAuto.formula.doc.split', { example: 'split("a, b", ", ")' }), 2, 2, ([a, b]) => text(a).split(text(b)).filter(Boolean)),
    def('text', 'format', 'value', t('dbAuto.formula.doc.format'), 1, 1, ([a]) => text(a)),
    def('text', 'repeat', 'repeat', 'repeat("★", {Rating})', 2, 2, ([a, b]) => text(a).repeat(Math.max(0, Math.min(1000, num(b, 'repeat()') ?? 0)))),

    def('dates', 'now', null, t('dbAuto.formula.doc.now'), 0, 0, (_a, s) => new FDate(s.now, true)),
    def('dates', 'today', null, t('dbAuto.formula.doc.today'), 0, 0, (_a, s) => startOfToday(s.now)),
    def('dates', 'date', 'text', t('dbAuto.formula.doc.date', { example: 'date("2026-10-14")' }), 1, 1, ([a]) => date(a, 'date()')),
    def('dates', 'dateAdd', 'dateAmountUnit', 'dateAdd({Due}, 2, "weeks")', 3, 3, ([a, n, u]) => {
      const d = date(a, 'dateAdd()');
      return d ? addTo(d, num(n, 'dateAdd()') ?? 0, unit(u)) : null;
    }),
    def('dates', 'dateSubtract', 'dateAmountUnit', 'dateSubtract({Due}, 3, "days")', 3, 3, ([a, n, u]) => {
      const d = date(a, 'dateSubtract()');
      return d ? addTo(d, -(num(n, 'dateSubtract()') ?? 0), unit(u)) : null;
    }),
    def('dates', 'dateBetween', 'dateBetween', t('dbAuto.formula.doc.dateBetween', { example: 'dateBetween({End}, {Start}, "days")' }), 3, 3, ([a, b, u]) => {
      const x = date(a, 'dateBetween()');
      const y = date(b, 'dateBetween()');
      return x && y ? between(x, y, unit(u)) : null;
    }),
    def('dates', 'daysUntil', 'date', t('dbAuto.formula.doc.daysUntil'), 1, 1, ([a], s) => {
      const d = date(a, 'daysUntil()');
      return d ? dayDiff(d, startOfToday(s.now)) : null;
    }),
    def('dates', 'formatDate', 'formatDate', 'formatDate({Due}, "dddd, MMM D") — YYYY, MMM, MM, D, dddd, h:mm A…', 1, 2, ([a, p]) => {
      const d = date(a, 'formatDate()');
      return d ? formatDateValue(d, p === undefined || p === null ? undefined : text(p)) : null;
    }),
    def('dates', 'year', 'date', t('dbAuto.formula.doc.year'), 1, 1, ([a]) => {
      const d = date(a, 'year()');
      return d ? new Date(d.ms).getFullYear() : null;
    }),
    def('dates', 'month', 'date', t('dbAuto.formula.doc.month'), 1, 1, ([a]) => {
      const d = date(a, 'month()');
      return d ? new Date(d.ms).getMonth() + 1 : null;
    }),
    def('dates', 'day', 'date', t('dbAuto.formula.doc.day'), 1, 1, ([a]) => {
      const d = date(a, 'day()');
      return d ? new Date(d.ms).getDate() : null;
    }),
    def('dates', 'weekday', 'date', t('dbAuto.formula.doc.weekday'), 1, 1, ([a]) => {
      const d = date(a, 'weekday()');
      return d ? new Date(d.ms).getDay() || 7 : null;
    }),
    def('dates', 'hour', 'date', t('dbAuto.formula.doc.hour'), 1, 1, ([a]) => {
      const d = date(a, 'hour()');
      return d ? new Date(d.ms).getHours() : null;
    }),
    def('dates', 'minute', 'date', t('dbAuto.formula.doc.minute'), 1, 1, ([a]) => {
      const d = date(a, 'minute()');
      return d ? new Date(d.ms).getMinutes() : null;
    }),

    def('lists', 'count', 'list', t('dbAuto.formula.doc.count'), 1, 1, ([a]) => list(a).filter((x) => !isEmpty(x)).length),
    def('lists', 'first', 'list', t('dbAuto.formula.doc.first'), 1, 1, ([a]) => list(a)[0] ?? null),
    def('lists', 'last', 'list', t('dbAuto.formula.doc.last'), 1, 1, ([a]) => list(a).at(-1) ?? null),
    def('lists', 'at', 'at', t('dbAuto.formula.doc.at'), 2, 2, ([a, i]) => list(a)[num(i, 'at()') ?? 0] ?? null),
    def('lists', 'join', 'join', t('dbAuto.formula.doc.join', { example: 'join({Tags}, " · ")' }), 1, 2, ([a, sep]) => list(a).map(text).join(sep === undefined ? ', ' : text(sep))),
    def('lists', 'unique', 'list', t('dbAuto.formula.doc.unique'), 1, 1, ([a]) => list(a).filter((x, i, all) => all.findIndex((y) => equal(x, y)) === i)),
    def('lists', 'sort', 'list', t('dbAuto.formula.doc.sort'), 1, 1, ([a]) => {
      const order = fmt.collator({ numeric: true });
      return [...list(a)].sort((x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : order.compare(text(x), text(y))));
    }),
  ].map((f) => [f.name.toLowerCase(), f]),
);

export function evaluate(node: Node, scope: Scope): FValue {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'prop': {
      const v = scope.prop(node.name);
      if (v === undefined) throw new FormulaError(t('dbAuto.formula.error.noProperty', { name: node.name }), node.at);
      return v;
    }
    case 'if':
      return truthy(evaluate(node.c, scope)) ? evaluate(node.a, scope) : evaluate(node.b, scope);
    case 'un': {
      const a = evaluate(node.a, scope);
      if (node.op === 'not') return !truthy(a);
      const n = num(a, 'minus');
      return n === null ? null : node.op === '-' ? -n : n;
    }
    case 'bin': {
      if (node.op === 'and') return truthy(evaluate(node.a, scope)) && truthy(evaluate(node.b, scope));
      if (node.op === 'or') return truthy(evaluate(node.a, scope)) || truthy(evaluate(node.b, scope));
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      try {
        switch (node.op) {
          case '==':
            return equal(a, b);
          case '!=':
            return !equal(a, b);
          case '<':
          case '>':
          case '<=':
          case '>=':
            return compare(a, b, node.op);
          default: {
            const v = arithmetic(node.op, a, b);
            return isNum(v) ? cleanNumber(v) : v;
          }
        }
      } catch (e) {
        if (e instanceof FormulaError && e.at < 0) throw new FormulaError(e.message, node.at);
        throw e;
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      try {
        if (fn.lazy) return fn.lazy(node.args, scope);
        const v = fn.run!(
          node.args.map((a) => evaluate(a, scope)),
          scope,
        );
        return isNum(v) ? cleanNumber(v) : v;
      } catch (e) {
        if (e instanceof FormulaError && e.at < 0) throw new FormulaError(e.message, node.at);
        throw e;
      }
    }
  }
}

/** Runs a formula; errors come back as a FormulaError instead of throwing. */
export function run(src: string, scope: Scope): FValue | FormulaError {
  try {
    const v = evaluate(parse(src), scope);
    return typeof v === 'number' && !Number.isFinite(v) && !Number.isNaN(v) ? v : v;
  } catch (e) {
    return e instanceof FormulaError ? e : new FormulaError(e instanceof Error ? e.message : String(e));
  }
}
