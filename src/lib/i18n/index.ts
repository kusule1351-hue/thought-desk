/**
 * The interface's words in the reader's language.
 *
 * Messages live in src/locales/<language>/<area>.json. English (en) is
 * complete; every other language falls back to it, message by message, so a
 * half-done translation still works. Keys are typed from the English files
 * (en.ts): `t('shell.newPage')` is checked, a misspelt key doesn't compile.
 * A key starting with "@" is a note for translators about the message of
 * the same name ("@open": "button that opens the page"), never shown.
 *
 * The language is chosen in Settings (or follows the system's) and kept in
 * localStorage under its own key. It is read once, when this module is first
 * imported, before anything else asks for a message; changing it reloads the
 * window (App.svelte, td:reload), so every menu, list and editor placeholder
 * worked out at start-up comes out in the new language. That's also why the
 * message tables here aren't reactive: they never change while the app runs.
 *
 * A message is plain text with {name} placeholders, or plural forms: the
 * CLDR categories the language uses (zero, one, two, few, many, other), each
 * with {count} in it, plus exact counts ("=0": "No pages") for wording that
 * fits one number only. The `count` parameter picks the form. Numbers in
 * parameters are written the locale's way ("1,234"); pass a string for one
 * that mustn't be (a year). Text with markup in the middle (<kbd>,
 * <strong>, a styled span) goes through parts() or Rich.svelte.
 */
import { en, type Messages } from './en';
import { pseudo } from './pseudo';

// ------------------------------------------------------------------ types

/** CLDR's plural categories. */
export type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
/** Plural forms: `other` always, the rest as the language needs them, and exact counts. */
export type Plural = { other: string } & { [form: string]: string };
type Leaf = string | Plural;
type Join<P extends string, K extends string> = P extends '' ? K : `${P}.${K}`;
/** An object whose keys are all plural forms (or exact counts) is a plural message; any other object is a group. */
type IsPlural<T> = T extends { other: string } ? (Exclude<keyof T, PluralForm | `=${number}`> extends never ? true : false) : false;
type Paths<T, P extends string = '', Only extends 'all' | 'plural' = 'all'> = {
  [K in keyof T & string]: K extends `@${string}`
    ? never
    : T[K] extends string
      ? Only extends 'all'
        ? Join<P, K>
        : never
      : IsPlural<T[K]> extends true
        ? Join<P, K>
        : Paths<T[K], Join<P, K>, Only>;
}[keyof T & string];

/** Every message's key, from the English files. */
export type MessageKey = Paths<Messages>;
/** The keys whose messages have plural forms: they need a `count`. */
export type PluralKey = Paths<Messages, '', 'plural'>;
/** The keys of plain-text messages: what a table of labels holds (`Record<Id, TextKey>`), so `t(table[id])` compiles. */
export type TextKey = Exclude<MessageKey, PluralKey>;
/** Values for a message's {placeholders}. Numbers are written the locale's way; `count` also picks the plural form. */
export type Params = { count?: number } & Record<string, string | number>;

/** A language the interface can be shown in. */
export interface Language {
  /** BCP 47 code, the folder name in src/locales ("en", "es", "pt-BR"). */
  code: string;
  /** Its own name for itself ("Español"). */
  name: string;
  /** Its name in English ("Spanish"). */
  english: string;
  dir: 'ltr' | 'rtl';
}

const FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const isForm = (k: string) => FORMS.has(k) || /^=\d+$/.test(k);
function isPlural(v: unknown): v is Plural {
  return !!v && typeof v === 'object' && typeof (v as Plural).other === 'string' && Object.keys(v).every(isForm);
}

// ---------------------------------------------------------- the languages

interface Meta {
  name: string;
  english: string;
  dir?: 'ltr' | 'rtl';
}

/** Every bundled language's files, by language and then area ("es" → "shell" → {...}). */
const files = import.meta.glob<Record<string, unknown>>('../../locales/*/*.json', { eager: true, import: 'default' });
const bundled = new Map<string, { meta: Meta | null; areas: Record<string, unknown> }>();
for (const [path, data] of Object.entries(files)) {
  const [, code, area] = path.match(/locales\/([^/]+)\/([^/]+)\.json$/)!;
  const entry = bundled.get(code) ?? { meta: null, areas: {} };
  if (area === 'meta') entry.meta = data as unknown as Meta;
  else entry.areas[area] = data;
  bundled.set(code, entry);
}

/** A code Intl understands as written ("pt-BR", not "pt_BR" or "pt-br"): anything else would throw when its dates are formatted. */
function validCode(code: string): boolean {
  try {
    return Intl.getCanonicalLocales(code)[0] === code;
  } catch {
    return false;
  }
}

/** The development-only pseudo-language: English with accents and brackets, a third longer, so text that was missed (still plain English) and text that doesn't fit stand out. */
const PSEUDO = 'qps';

export const LANGUAGES: Language[] = [...bundled.entries()]
  .filter(([code, l]) => l.meta && validCode(code))
  .map(([code, l]) => ({ code, name: l.meta!.name, english: l.meta!.english, dir: l.meta!.dir ?? 'ltr' }))
  .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.english.localeCompare(b.english)));
if (import.meta.env.DEV) LANGUAGES.push({ code: PSEUDO, name: '[Ƥşḗŭḓǿ]', english: 'Pseudo (development)', dir: 'ltr' });

// ------------------------------------------------------ choosing one

const STORE = 'thoughtdesk.language';
/** "system" or a language's code. */
export type Choice = string;

function readChoice(): Choice {
  try {
    return localStorage.getItem(STORE) || 'system';
  } catch {
    return 'system';
  }
}

const preferred = (): readonly string[] =>
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
const base = (tag: string) => tag.split('-')[0].toLowerCase();

/** The best bundled language for the system's preferred ones: an exact match, then the same language anywhere ("es-MX" → "es"), then English. */
function systemLanguage(): string {
  const codes = LANGUAGES.map((l) => l.code).filter((c) => c !== PSEUDO);
  for (const tag of preferred()) {
    const exact = codes.find((c) => c.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const same = codes.find((c) => base(c) === base(tag));
    if (same) return same;
  }
  return 'en';
}

function resolve(choice: Choice): string {
  if (choice !== 'system' && LANGUAGES.some((l) => l.code === choice)) return choice;
  return systemLanguage();
}

const choice = readChoice();
const language = resolve(choice);

/**
 * The locale dates and numbers are written in: the system's own when it's
 * the same language (en-GB keeps its day-month order), else the interface's
 * language with the system's region (English on a German system: English
 * month names, German date order and decimal comma). Always the Gregorian
 * calendar, which the planner and the calendar are built on.
 */
function formatLocale(): string {
  const lang = language === PSEUDO ? 'en' : language;
  const tags = preferred();
  const same = tags.find((tag) => base(tag) === base(lang));
  let region: string | undefined;
  try {
    region = new Intl.Locale(same ?? tags[0] ?? lang).region;
  } catch {
    region = undefined;
  }
  for (const candidate of [same, region && !new Intl.Locale(lang).region ? `${lang}-${region}` : undefined, lang]) {
    if (!candidate) continue;
    try {
      return new Intl.Locale(candidate, { calendar: 'gregory' }).toString();
    } catch {
      /* not a locale this engine knows: try the next */
    }
  }
  return 'en';
}

// ------------------------------------------------------ the messages

function flatten(obj: unknown, prefix: string, out: Map<string, Leaf>) {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('@')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    // An empty translation (some tools export them for "not done yet") falls back to English.
    if (typeof v === 'string') {
      if (v.trim()) out.set(key, v);
    } else if (isPlural(v)) {
      const forms = Object.fromEntries(Object.entries(v).filter(([, text]) => typeof text === 'string' && text.trim()));
      if (typeof forms.other === 'string') out.set(key, forms as Plural);
    } else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

const english = flatten(en, '', new Map());
const tables = new Map<string, Map<string, Leaf>>([['en', english]]);
function table(code: string): Map<string, Leaf> {
  let found = tables.get(code);
  if (!found) {
    found = code === PSEUDO ? pseudo(english) : flatten(bundled.get(code)?.areas ?? {}, '', new Map());
    tables.set(code, found);
  }
  return found;
}
const current = table(language);

/** Each language's plural rules: a message is pluralised by the rules of the language it's written in, even when it's English standing in for a missing translation. */
const ruleCache = new Map<string, Intl.PluralRules>();
function rules(code: string): Intl.PluralRules {
  const lang = code === PSEUDO ? 'en' : code;
  let found = ruleCache.get(lang);
  if (!found) {
    try {
      found = new Intl.PluralRules(lang);
    } catch {
      found = new Intl.PluralRules('en');
    }
    ruleCache.set(lang, found);
  }
  return found;
}

/** A message and the language it's written in: the interface's, else English. */
function lookup(key: string): [Leaf | undefined, string] {
  const own = current.get(key);
  return own !== undefined ? [own, language] : [english.get(key), 'en'];
}

/** The text of a message before its placeholders are filled: the plural form for `count` if it has forms. */
function pick(msg: Leaf | undefined, code: string, params: Params | undefined, key: string): string {
  if (msg === undefined) {
    if (import.meta.env.DEV) console.warn(`i18n: no message "${key}"`);
    return key;
  }
  if (typeof msg === 'string') return msg;
  const n = params?.count;
  if (typeof n !== 'number') {
    if (import.meta.env.DEV) console.warn(`i18n: "${key}" has plural forms but no count`);
    return msg.other;
  }
  return msg[`=${n}`] ?? msg[rules(code).select(n)] ?? msg.other;
}

let numbers: Intl.NumberFormat | null = null;
function fill(text: string, params: Params | undefined, key: string): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.hasOwn(params, name)) {
      if (import.meta.env.DEV) console.warn(`i18n: "${key}" has {${name}} but no value for it`);
      return whole;
    }
    const v = params[name];
    return typeof v === 'number' ? (numbers ??= new Intl.NumberFormat(i18n.locale)).format(v) : v;
  });
}

const TAG = /<\/?\w+\s*\/?>/;
function warnTags(text: string, key: string) {
  if (import.meta.env.DEV && TAG.test(text)) console.warn(`i18n: "${key}" has markup: draw it with parts() or Rich.svelte`);
}

/** A message in the interface's language, its {placeholders} filled from `params`. */
export function t(key: PluralKey, params: Params & { count: number }): string;
export function t(key: Exclude<MessageKey, PluralKey>, params?: Params): string;
export function t(key: MessageKey, params?: Params): string {
  const [msg, code] = lookup(key);
  const text = pick(msg, code, params, key);
  warnTags(text, key);
  return fill(text, params, key);
}

/** A message in English, whatever the interface's language: for keywords that should keep matching (the slash menu finds "todo" in any language). */
export function tEn(key: PluralKey, params: Params & { count: number }): string;
export function tEn(key: Exclude<MessageKey, PluralKey>, params?: Params): string;
export function tEn(key: MessageKey, params?: Params): string {
  return fill(pick(english.get(key), 'en', params, key), params, key);
}

/**
 * A message in every bundled language (English first, no duplicates): for
 * recognising a name the app once wrote into someone's notes in whatever
 * language it was in then (an "Inbox" page, a view still called "Table").
 * Numbers in `params` are left unformatted.
 */
export function tAll(key: MessageKey, params?: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const l of LANGUAGES) {
    const msg = table(l.code).get(key);
    if (msg !== undefined) out.add(fill(pick(msg, l.code, params, key), params, key));
  }
  return [...out];
}

/** Words to search by: each message in the interface's language and in English, so a translated menu still finds what someone types in English. */
export function searchText(...keys: MessageKey[]): string {
  return [...new Set(keys.flatMap((k) => [lookup(k)[0], english.get(k)]).filter((m): m is string => typeof m === 'string'))].join(' ');
}

/** A piece of a message with markup: plain text, or text inside a tag (`<kbd>…</kbd>`, or `<icon/>` with no text). */
export type Part = { text: string; tag?: undefined } | { tag: string; text: string };

/**
 * A message cut at its tags, for text with markup in the middle ("Press
 * <kbd>{key}</kbd> to search"). Tags don't nest. The tags come from the
 * message, and the parameters are filled in afterwards, inside each piece,
 * so a name with a "<" in it stays text. Rich.svelte draws the pieces.
 */
export function parts(key: PluralKey, params: Params & { count: number }): Part[];
export function parts(key: Exclude<MessageKey, PluralKey>, params?: Params): Part[];
export function parts(key: MessageKey, params?: Params): Part[] {
  const [msg, code] = lookup(key);
  const text = pick(msg, code, params, key);
  const out: Part[] = [];
  const tag = /<(\w+)>([^<]*)<\/\1>|<(\w+)\s*\/>/g;
  let at = 0;
  for (let m: RegExpExecArray | null; (m = tag.exec(text)); ) {
    if (m.index > at) out.push({ text: fill(text.slice(at, m.index), params, key) });
    out.push(m[1] ? { tag: m[1], text: fill(m[2], params, key) } : { tag: m[3], text: '' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: fill(text.slice(at), params, key) });
  return out;
}

// ------------------------------------------------------ the public face

export const i18n = {
  /** What was chosen: "system" or a language's code. */
  choice,
  /** The language the interface is in ("en", "es"). */
  language,
  /** The locale for Intl and toLocale*: dates, numbers, sorting (format.ts has the helpers). */
  locale: formatLocale(),
  dir: LANGUAGES.find((l) => l.code === language)?.dir ?? 'ltr',
  /** The language the system's own preference resolves to (Settings: "System (English)"). */
  systemLanguage: systemLanguage(),
  /** Keeps a new choice for the next start; false if it couldn't be kept. The caller then reloads the window (td:reload). */
  choose(next: Choice): boolean {
    try {
      if (next === 'system') localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, next);
      this.choice = next;
      return true;
    } catch {
      return false;
    }
  },
};

if (typeof document !== 'undefined') {
  document.documentElement.lang = language === PSEUDO ? 'en' : language;
  document.documentElement.dir = i18n.dir;
}
