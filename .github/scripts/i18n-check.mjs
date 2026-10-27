// Checks the interface's messages (src/locales) and their use in the code.
//
//   npm run i18n                     everything (CI runs this)
//   npm run i18n -- --area shell     only problems in that area (its English
//                                    file and the code's keys in it)
//   npm run i18n -- --no-unused      leave out "isn't used anywhere"
//   npm run i18n -- --missing es     list what a language hasn't translated yet
//
// English (src/locales/en) must have:
//   - keys of camelCase words ("newPage"), groups of them, no arrays, and no
//     group with a key called zero, one, two, few, many or other (that would
//     read as plural forms);
//   - plural forms English uses (one, other) plus exact counts ("=0"), each
//     category form with every placeholder `other` has;
//   - a note ("@newPage": "…") for every one-word message and every message
//     with {placeholders}, and no note without its message;
//   - tags that pair up (<kbd>…</kbd>, <icon/>) and don't nest;
//   - every message used in the code, and every key the code uses. Keys are
//     whole strings in the code: a key built at run time can't be checked.
// Another language must have a meta.json and a code Intl understands as
// written ("pt-BR"); only keys English has; plural forms where English has
// them, with exactly the categories the language uses; the same tags as the
// matching English form; no placeholder English doesn't have; no HTML
// entities ("&nbsp;": type the character). Messages it hasn't translated are
// counted, not errors: they show in English until they are.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = path.join(ROOT, 'src/locales');
const SRC = path.join(ROOT, 'src');
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? '');
};
const onlyArea = flag('--area');
const noUnused = args.includes('--no-unused');
const missingFor = flag('--missing');

const errors = [];
const warnings = [];
/** Records a problem, unless --area asks about another area. */
const fail = (area, msg) => {
  if (!onlyArea || area === onlyArea) errors.push(msg);
};
const warn = (area, msg) => {
  if (!onlyArea || area === onlyArea) warnings.push(msg);
};

const isForm = (k) => CATEGORIES.includes(k) || /^=\d+$/.test(k);
const isPlural = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.other === 'string' && Object.keys(v).every(isForm);
const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const texts = (msg) => (typeof msg === 'string' ? [msg] : Object.values(msg));
const PAIR = /<(\w+)>([^<]*)<\/\1>|<(\w+)\s*\/>/g;
/** The tags in a text, as parts() reads them ("kbd kbd icon/"), or null when they don't pair up or nest. */
function tagsOf(text) {
  const found = [];
  const rest = text.replace(PAIR, (_, open, inner, single) => {
    found.push(open ?? `${single}/`);
    return '';
  });
  if (/<\/?\w+[^>]*>/.test(rest)) return null;
  return found.sort().join(' ');
}

/** Every message in a language's files: key → { msg, area, file }; also its notes. */
function readLanguage(code) {
  const dir = path.join(LOCALES, code);
  const out = new Map();
  const notes = new Map();
  const areas = [];
  let meta = null;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const area = name.slice(0, -5);
    const file = `src/locales/${code}/${name}`;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      fail(area, `${file}: not valid JSON (${e.message})`);
      continue;
    }
    if (area === 'meta') {
      meta = data;
      continue;
    }
    areas.push(area);
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (k.startsWith('@')) {
          if (typeof v !== 'string') fail(area, `${file}: note "${key}" isn't text`);
          else notes.set(prefix ? `${prefix}.${k.slice(1)}` : k.slice(1), v);
          if (!(k.slice(1) in obj)) fail(area, `${file}: note "${key}" has no message "${k.slice(1)}"`);
          continue;
        }
        if (code === 'en' && !/^[A-Za-z][A-Za-z0-9]*$/.test(k)) fail(area, `${file}: key "${key}": keys are camelCase words (letters and digits)`);
        if (typeof v === 'string' || isPlural(v)) out.set(key, { msg: v, area, file });
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
          const formLike = Object.keys(v).filter((x) => CATEGORIES.includes(x));
          if (formLike.length) fail(area, `${file}: group "${key}" has a key named ${formLike.join(', ')}, which reads as a plural form: rename it ("otherOption")`);
          walk(v, key);
        } else fail(area, `${file}: "${key}" is neither text, plural forms nor a group (no arrays)`);
      }
    };
    walk(data, area);
  }
  return { messages: out, notes, areas, meta };
}

/** The plural categories a language actually uses for whole numbers 0–1,000, with examples. */
function categoriesOf(code) {
  let rules;
  try {
    rules = new Intl.PluralRules(code);
  } catch {
    return null;
  }
  const examples = new Map();
  for (let n = 0; n <= 1000; n++) {
    const c = rules.select(n);
    if (!examples.has(c)) examples.set(c, []);
    if (examples.get(c).length < 4) examples.get(c).push(n);
  }
  return examples;
}

// --------------------------------------------------------------- English

const english = readLanguage('en');
const AREAS = new Set(english.areas);
const enCategories = categoriesOf('en');
for (const [key, { msg, area, file }] of english.messages) {
  for (const text of texts(msg)) {
    if ((text.match(/\{/g) ?? []).length !== (text.match(/\}/g) ?? []).length) fail(area, `${file}: "${key}" has unbalanced braces`);
    if (/\{(?!\w+\})/.test(text)) fail(area, `${file}: "${key}" has a brace that isn't a {placeholder}`);
    if (tagsOf(text) === null) fail(area, `${file}: "${key}" has tags that don't pair up, or nest (<b>…</b>, <icon/>; one level only)`);
  }
  if (typeof msg !== 'string') {
    const need = placeholders(msg.other);
    for (const [form, text] of Object.entries(msg)) {
      if (!form.startsWith('=') && !enCategories.has(form)) fail(area, `${file}: "${key}" has a "${form}" form, which English never uses (use "=0" for zero)`);
      if (!form.startsWith('=')) for (const p of need) if (!placeholders(text).has(p)) fail(area, `${file}: "${key}" form "${form}" lacks {${p}}: put wording for one exact number in "=1"`);
    }
  }
  const one = typeof msg === 'string' && !/\s/.test(msg.trim());
  const params = texts(msg).some((t) => placeholders(t).size);
  if ((one || params) && !english.notes.has(key)) fail(area, `${file}: "${key}" needs a note for translators ("@${key.split('.').pop()}": where it appears, what it means${params ? ', what each {placeholder} is' : ''})`);
}

// --------------------------------------------------------- the other languages

const report = [];
const languages = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory() && d !== 'en').sort();
for (const code of languages) {
  const { messages, areas, meta } = readLanguage(code);
  let canonical = null;
  try {
    canonical = Intl.getCanonicalLocales(code)[0];
  } catch {
    /* not a locale */
  }
  if (canonical !== code) fail(code, `src/locales/${code}: "${code}" isn't a language code as Intl writes it${canonical ? ` (use "${canonical}")` : ''}`);
  if (!meta) fail(code, `src/locales/${code}: no meta.json ({ "name": its own name, "english": its English name })`);
  else {
    if (typeof meta.name !== 'string' || typeof meta.english !== 'string') fail(code, `src/locales/${code}/meta.json: needs "name" and "english"`);
    if (meta.dir !== undefined && meta.dir !== 'ltr' && meta.dir !== 'rtl') fail(code, `src/locales/${code}/meta.json: "dir" is "ltr" or "rtl"`);
    let intlDir;
    try {
      const l = new Intl.Locale(code);
      intlDir = (l.getTextInfo?.() ?? l.textInfo)?.direction;
    } catch {
      intlDir = undefined;
    }
    if (intlDir && (meta.dir ?? 'ltr') !== intlDir) fail(code, `src/locales/${code}/meta.json: this language is written ${intlDir}: set "dir": "${intlDir}"`);
  }
  const cats = categoriesOf(code) ?? enCategories;
  const needs = [...cats].map(([c, ex]) => `${c} (${ex.join(', ')}…)`).join(', ');
  for (const area of areas) if (!AREAS.has(area)) fail(area, `src/locales/${code}/${area}.json has no English file`);
  let identical = 0;
  for (const [key, { msg, area, file }] of messages) {
    const en = english.messages.get(key)?.msg;
    if (en === undefined) {
      fail(area, `${file}: "${key}" isn't an English message (renamed or removed?)`);
      continue;
    }
    if (isPlural(en) !== isPlural(msg)) {
      fail(area, `${file}: "${key}" ${isPlural(en) ? `needs plural forms, as in English: ${needs}` : 'is plain text in English, not plural forms'}`);
      continue;
    }
    if (JSON.stringify(en) === JSON.stringify(msg)) identical++;
    const allowed = new Set(texts(en).flatMap((t) => [...placeholders(t)]));
    for (const text of texts(msg)) {
      if (/&[a-z]+;|&#\d+;/i.test(text)) fail(area, `${file}: "${key}" has an HTML entity: type the character itself (a no-break space is U+00A0)`);
      if (/\{(?!\w+\})/.test(text) || (text.match(/\{/g) ?? []).length !== (text.match(/\}/g) ?? []).length) fail(area, `${file}: "${key}" has a brace that isn't a {placeholder} (ICU syntax isn't used here: plural forms are separate keys)`);
      for (const p of placeholders(text)) if (!allowed.has(p)) fail(area, `${file}: "${key}" has {${p}}, which English doesn't`);
      if (tagsOf(text) === null) fail(area, `${file}: "${key}" has tags that don't pair up, or nest`);
    }
    if (typeof msg === 'string') {
      if (tagsOf(msg) !== tagsOf(en)) fail(area, `${file}: "${key}" has tags "${tagsOf(msg)}", English has "${tagsOf(en)}"`);
      for (const p of placeholders(en)) if (!placeholders(msg).has(p)) warn(area, `${file}: "${key}" leaves out {${p}}`);
    } else {
      for (const [form, text] of Object.entries(msg)) {
        const enForm = en[form] ?? en.other;
        if (tagsOf(text) !== tagsOf(enForm)) fail(area, `${file}: "${key}" form "${form}" has tags "${tagsOf(text)}", English has "${tagsOf(enForm)}"`);
        if (!form.startsWith('=') && !cats.has(form)) fail(area, `${file}: "${key}" has a "${form}" form, which ${code} never uses. ${code} uses: ${needs}`);
        // A category that covers one number only (Spanish "one" is 1) may spell it out; any other needs {count}.
        const single = cats.get(form)?.length === 1;
        if (!form.startsWith('=') && !single && placeholders(en.other).has('count') && !placeholders(text).has('count')) fail(area, `${file}: "${key}" form "${form}" covers several numbers (${cats.get(form)?.join(', ')}…) but lacks {count}`);
      }
      const covered = new Set(Object.keys(msg).filter((f) => f.startsWith('=')).map((f) => Number(f.slice(1))));
      for (const [c, ex] of cats) if (!(c in msg) && !ex.every((n) => covered.has(n))) fail(area, `${file}: "${key}" lacks the "${c}" form (${ex.join(', ')}…). ${code} uses: ${needs}`);
    }
  }
  const done = [...english.messages.keys()].filter((k) => messages.has(k)).length;
  report.push(`${code}: ${done} of ${english.messages.size} messages translated (${Math.floor((done / english.messages.size) * 100)}%)${identical ? `, ${identical} still the same as English` : ''}`);
  if (missingFor === code) {
    for (const [key, { msg }] of english.messages) {
      const own = messages.get(key)?.msg;
      if (own === undefined) console.log(`  missing    ${key}: ${JSON.stringify(msg)}`);
      else if (JSON.stringify(own) === JSON.stringify(msg)) console.log(`  as English ${key}: ${JSON.stringify(msg)}`);
    }
  }
}

// ------------------------------------------------------------- the code

const used = new Set();
const AREA_LIST = [...AREAS].join('|');
const KEY = new RegExp(`(['"\`])((?:${AREA_LIST})\\.[A-Za-z0-9.]+)\\1`, 'g');
const BUILT = new RegExp(`\`(?:${AREA_LIST})\\.[^\`]*\\$\\{|(['"])(?:${AREA_LIST})\\.[A-Za-z0-9.]*\\1\\s*\\+`);
/** Blanks comments that start a line (doc blocks, line comments, HTML comments): their examples aren't uses. Line numbers stay. */
function code(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank)
    .replace(/^[ \t]*<!--[\s\S]*?-->/gm, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== LOCALES) scan(full);
      continue;
    }
    if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    code(fs.readFileSync(full, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        const built = line.match(BUILT);
        if (built) fail(built[0].replace(/^['"`]/, '').split('.')[0], `${rel}:${i + 1}: a key built at run time can't be checked: use a table of whole keys`);
        for (const m of line.matchAll(KEY)) {
          const key = m[2];
          used.add(key);
          if (!english.messages.has(key) && !english.messages.has(key.replace(/\.$/, ''))) fail(key.split('.')[0], `${rel}:${i + 1}: "${key}" isn't an English message`);
        }
      });
  }
}
scan(SRC);
if (!noUnused) for (const [key, { area }] of english.messages) if (!used.has(key)) fail(area, `en: "${key}" isn't used anywhere`);

// ---------------------------------------------------------------- result

console.log(`English: ${english.messages.size} messages in ${english.areas.length} areas.`);
for (const line of report) console.log(line);
for (const w of warnings) console.warn(`  note: ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}${onlyArea ? ` in ${onlyArea}` : ''}:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(onlyArea ? `Messages OK in ${onlyArea}.` : 'Messages OK.');
