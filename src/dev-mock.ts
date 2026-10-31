/**
 * In-memory stand-in for the Rust backend, used only when the UI runs in a
 * plain browser during development (`npm run dev`). Never bundled in builds.
 */

import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Assignment, CalEvent, CardReview, CellValue, Course, DatabaseSchema, DbRow, FileMeta, OccurrencePage, PageMeta, Tag } from './lib/types';
import { TEMPLATES } from './lib/db/templates';
import { prefs } from './lib/prefs.svelte';

type Row = PageMeta & { content: string; text: string };

const KEY = 'thoughtdesk.devmock.v2';
// `?fresh` in the address: start like a new install (just the welcome page,
// no sample courses, assignments or databases) to see the first run.
// Marks the browser stand-in (see platform.ts).
(window as any).__TD_MOCK__ = true;
const FRESH = new URLSearchParams(location.search).has('fresh');
if (FRESH) for (const k of Object.keys(localStorage)) if (k.startsWith('thoughtdesk.')) localStorage.removeItem(k);
// The welcome screen only shows in the preview with `?welcome` (so test runs,
// each a "new install", go straight to the app).
prefs.welcomed = !new URLSearchParams(location.search).has('welcome');
const load = (): Row[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as Row[];
  } catch {
    return [];
  }
};
// Data saved by older previews has no tags yet.
let rows: Row[] = load().map((r) => ({ ...r, tags: r.tags ?? [], kind: r.kind ?? '' }));
const persist = () => localStorage.setItem(KEY, JSON.stringify(rows));
/** Shared pages' Yjs state (kept in SQLite by the real backend). */
const yjs = new Map<string, Uint8Array>();

function make(parentId: string | null, title = '', icon = '', content = ''): Row {
  const ts = Date.now();
  return {
    id: crypto.randomUUID(),
    parentId,
    title,
    icon,
    position: 0,
    favorite: 0,
    fullWidth: false,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    tags: [],
    kind: '',
    sharedRoom: null,
    content,
    text: '',
  };
}

function place(id: string, parentId: string | null, index: number | null) {
  const sibs = rows
    .filter((r) => r.parentId === parentId && r.id !== id && !r.deletedAt)
    .sort((a, b) => a.position - b.position);
  const me = rows.find((r) => r.id === id)!;
  sibs.splice(index === null ? sibs.length : Math.min(index, sibs.length), 0, me);
  sibs.forEach((r, i) => (r.position = i));
}

const subtree = (id: string, pred: (r: Row) => boolean = () => true): Row[] => {
  const out: Row[] = [];
  const walk = (pid: string) => {
    for (const r of rows.filter((x) => x.parentId === pid && pred(x))) {
      out.push(r);
      walk(r.id);
    }
  };
  const root = rows.find((r) => r.id === id);
  if (root) {
    out.push(root);
    walk(id);
  }
  return out;
};

const meta = ({ content: _c, text: _t, ...m }: Row): PageMeta => m;

if (rows.length === 0) {
  const welcome = make(
    null,
    'Getting started',
    'icon:compass:blue',
    '<p>This is the <strong>browser preview</strong> with an in-memory backend.</p><h2>Try it</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Open this page</p></li><li data-type="taskItem" data-checked="false"><p>Type <code>/</code> for blocks</p></li></ul><div data-callout="" data-icon="icon:lightbulb:yellow"><p>Callouts hold any blocks.</p></div><p></p>',
  );
  rows.push(welcome);
  const projects = make(null, 'Projects', 'icon:folder:orange');
  projects.position = 1;
  rows.push(projects);
  const child = make(projects.id, 'Roadmap', 'icon:map:teal');
  rows.push(child);
  const notes = make(projects.id, 'Meeting notes');
  notes.position = 1;
  rows.push(notes);
  // Every block type on one page, for design review.
  const showcase = make(
    null,
    'Design review',
    'icon:palette:pink',
    `<p>Thought Desk is a <strong>quiet place</strong> to write. Text can be <em>italic</em>, <u>underlined</u>, <s>struck</s>, <code>inline code</code>, <mark>highlighted</mark> or a <a href="https://example.com">link</a>. Long paragraphs should wrap with a comfortable measure and an even rhythm from line to line, without orphans.</p>
<h1>Heading one</h1>
<p>Body text directly after a heading.</p>
<h2>Heading two</h2>
<ul><li><p>Bulleted item</p><ul><li><p>Nested item</p><ul><li><p>Third level</p></li></ul></li></ul></li><li><p>Another item</p></li></ul>
<ol><li><p>First step</p></li><li><p>Second step</p></li><li><p>Third step</p></li></ol>
<h3>Heading three</h3>
<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>A finished task</p></li><li data-type="taskItem" data-checked="false"><p>Something still to do</p></li></ul>
<blockquote><p>Simplicity is the ultimate sophistication.</p></blockquote>
<div data-callout="" data-icon="icon:lightbulb:yellow"><p>Callouts hold any blocks and draw the eye to what matters.</p></div>
<details open=""><summary>A toggle that is open</summary><div data-type="detailsContent"><p>Hidden content, revealed.</p></div></details>
<pre><code>fn main() {
    println!("Hello, Thought Desk");
}</code></pre>
<hr>
<table><tbody><tr><th><p>Name</p></th><th><p>Status</p></th><th><p>Due</p></th></tr><tr><td><p>Launch</p></td><td><p>In progress</p></td><td><p>Oct 20</p></td></tr><tr><td><p>Docs</p></td><td><p>Done</p></td><td><p>Oct 12</p></td></tr></tbody></table>
<p></p>`,
  );
  showcase.position = 2;
  showcase.favorite = Date.now();
  rows.push(showcase);
  // A page saved as editor JSON, so its to-dos roll up onto Home.
  const plan = make(null, 'Study plan', 'icon:book-open:purple');
  plan.position = 3;
  plan.tags = ['exam'];
  const task = (text: string, checked = false) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  plan.content = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before the midterm:' }] },
      { type: 'taskList', content: [task('Review chapters 1–3', true), task('Redo practice exam'), task('Make flashcards for cell parts')] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Linked from ' }, { type: 'mention', attrs: { id: welcome.id } }] },
    ],
  });
  rows.push(plan);
  persist();
}

// ------------------------------------------------- planner and file library

interface PlannerData {
  courses: Course[];
  assignments: Assignment[];
  events: CalEvent[];
  files: FileMeta[];
  tags: Tag[];
  sessions: OccurrencePage[];
  reviews: (CardReview & { pageId: string; cardId: string })[];
}
const PLANNER_KEY = 'thoughtdesk.devmock.planner.v1';
const BLOBS_KEY = 'thoughtdesk.devmock.blobs.v1';
const iso = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const loadPlanner = (): PlannerData | null => {
  try {
    return JSON.parse(localStorage.getItem(PLANNER_KEY) ?? '') as PlannerData;
  } catch {
    return null;
  }
};
/** File bytes as data URLs, keyed by stored name (stands in for the files/ folder). */
const blobs: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(BLOBS_KEY) ?? '{}');
  } catch {
    return {};
  }
})();
const persistBlobs = () => {
  try {
    localStorage.setItem(BLOBS_KEY, JSON.stringify(blobs));
  } catch {
    /* over quota: files just won't survive a reload */
  }
};

let planner: PlannerData =
  loadPlanner() ?? (FRESH ? { courses: [], assignments: [], events: [], files: [], tags: [], sessions: [], reviews: [] } : seedPlanner());
// Older preview data predates tags.
planner.tags ??= [];
for (const x of [...planner.assignments, ...planner.events, ...planner.files]) x.tags ??= [];
// …and course details, skipped dates and session notes.
planner.sessions ??= [];
for (const c of planner.courses) Object.assign(c, { ...newCourse(c.name, c.color, c.position), ...c });
for (const x of planner.assignments) Object.assign(x, { ...newAssignment(), ...x });
planner.reviews ??= [];
for (const x of planner.events) {
  x.exdates ??= [];
  x.sourceUid ??= null;
}
const persistPlanner = () => localStorage.setItem(PLANNER_KEY, JSON.stringify(planner));

function newCourse(name: string, color: string, position: number): Course {
  return { id: crypto.randomUUID(), name, color, position, createdAt: Date.now(), teacher: '', email: '', officeHours: '', room: '', pageId: null, weights: {} };
}

function newAssignment(): Assignment {
  const ts = Date.now();
  return { id: crypto.randomUUID(), title: '', courseId: null, dueDate: null, dueTime: null, status: 'todo', priority: 0, notes: '', pageId: null, fileIds: [], createdAt: ts, updatedAt: ts, completedAt: null, deletedAt: null, tags: [], sourceUid: null, score: null, maxScore: null, category: '' };
}

function newEvent(startDate: string): CalEvent {
  const ts = Date.now();
  return { id: crypto.randomUUID(), title: '', startDate, startTime: null, endDate: startDate, endTime: null, color: '', courseId: null, location: '', notes: '', repeat: 'none', repeatUntil: null, pageId: null, createdAt: ts, updatedAt: ts, deletedAt: null, tags: [], exdates: [], sourceUid: null };
}

function seedPlanner(): PlannerData {
  const ts = Date.now();
  // Biology's notes folder holds a flashcard deck.
  const folder = make(null, 'Biology', 'icon:dna:green');
  folder.position = 4;
  const deck = make(folder.id, 'Cell vocabulary', 'icon:layers:green');
  const fc = (id: string, front: string, back: string) => ({
    type: 'flashcard',
    attrs: { id },
    content: [
      { type: 'flashcardFront', content: [{ type: 'text', text: front }] },
      { type: 'flashcardBack', content: [{ type: 'text', text: back }] },
    ],
  });
  deck.content = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Key terms for the midterm.' }] },
      fc('k1', 'Mitochondria', 'Makes the cell’s energy (ATP)'),
      fc('k2', 'Ribosome', 'Builds proteins'),
      fc('k3', 'Osmosis', 'Water moving across a membrane toward more solute'),
      fc('k4', 'Nucleus', 'Holds the DNA'),
    ],
  });
  rows.push(folder, deck);
  persist();
  const bio = {
    ...newCourse('Biology', 'green', 0),
    teacher: 'Dr. Rivera',
    room: 'Science 204',
    officeHours: 'Tue 2–4 PM',
    pageId: folder.id,
    weights: { Exams: 60, Labs: 40 },
  };
  const hist = newCourse('History', 'orange', 1);
  const cs = newCourse('Computer Science', 'blue', 2);
  const assignment = (title: string, c: Course | null, dueDate: string | null, extra: Partial<Assignment> = {}): Assignment => ({
    ...newAssignment(),
    title,
    courseId: c?.id ?? null,
    dueDate,
    ...extra,
  });
  const event = (title: string, startDate: string, startTime: string | null, endTime: string | null, extra: Partial<CalEvent> = {}): CalEvent => ({
    ...newEvent(startDate),
    title,
    startTime,
    endTime,
    ...extra,
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#e8f5e9"/><circle cx="320" cy="210" r="120" fill="#34c759" opacity=".35"/><circle cx="320" cy="210" r="60" fill="#34c759"/><text x="320" y="390" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#1d1d1f">Plant cell</text></svg>`;
  const text = 'Week 1 — Introduction\nWeek 2 — Cells\nWeek 3 — Genetics\nMidterm in week 7.';
  const file = (name: string, mime: string, data: string): FileMeta => {
    const stored = `${crypto.randomUUID().replace(/-/g, '')}.${name.split('.').pop()}`;
    blobs[stored] = data;
    return { id: crypto.randomUUID(), name, stored, mime, size: data.length, createdAt: ts, updatedAt: ts, deletedAt: null, missing: false, tags: [] };
  };
  const diagram = file('Plant cell.svg', 'image/svg+xml', `data:image/svg+xml;base64,${btoa(svg)}`);
  const syllabus = file('Biology syllabus.txt', 'text/plain', `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`);
  persistBlobs();
  return {
    courses: [bio, hist, cs],
    assignments: [
      assignment('Lab report: osmosis', bio, iso(1), { dueTime: '23:59', priority: 3, status: 'doing', fileIds: [diagram.id], tags: ['lab'], category: 'Labs' }),
      assignment('Quiz 1: cells', bio, iso(-10), { status: 'done', completedAt: ts, score: 17, maxScore: 20, category: 'Exams' }),
      assignment('Lab: microscopes', bio, iso(-6), { status: 'done', completedAt: ts, score: 46, maxScore: 50, category: 'Labs' }),
      assignment('Read chapter 4', hist, iso(0), { priority: 1 }),
      assignment('Problem set 3', cs, iso(4), { dueTime: '17:00', priority: 2 }),
      assignment('Essay outline', hist, iso(-1)),
      assignment('Group project proposal', cs, iso(9)),
      assignment('Flashcards for quiz', bio, null),
      assignment('Weekly reflection', null, iso(-3), { status: 'done', completedAt: ts }),
    ],
    events: [
      event('Biology lecture', iso(-2), '09:00', '10:30', { courseId: bio.id, repeat: 'weekly', location: 'Hall B' }),
      event('History seminar', iso(-1), '13:00', '14:00', { courseId: hist.id, repeat: 'weekly' }),
      event('Study group', iso(1), '16:00', '18:00', { color: 'purple', location: 'Library' }),
      event('Midterm exam', iso(6), '10:00', '12:00', { courseId: cs.id, tags: ['exam'] }),
      event('Spring break', iso(12), null, null, { endDate: iso(16), color: 'teal' }),
    ],
    files: [diagram, syllabus],
    tags: [
      { name: 'exam', color: 'red' },
      { name: 'lab', color: 'green' },
    ],
    sessions: [],
    reviews: [],
  };
}

const cleanTag = (t: string) =>
  t.trim().replace(/^#+/, '').split(/\s+/).filter(Boolean).join('-').replace(/[",]/g, '').slice(0, 40).toLowerCase();

const itemList = (table: string): { id: string; tags: string[]; deletedAt: number | null }[] =>
  table === 'pages' ? rows : (planner as any)[table];

function walkTodos(node: any, f: (item: any) => void) {
  if (node?.type === 'taskItem') f(node);
  for (const child of node?.content ?? []) walkTodos(child, f);
}

function itemText(item: any, titles: boolean): string {
  const run = (n: any): string => {
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return ' ';
    if (n.type === 'inlineMath') return `$${n.attrs?.latex ?? ''}$`;
    if (n.type === 'mention') {
      if (!titles) return n.attrs?.id ?? '';
      const id = n.attrs?.id;
      return (
        rows.find((r) => r.id === id)?.title ||
        planner.assignments.find((x) => x.id === id)?.title ||
        planner.events.find((x) => x.id === id)?.title ||
        planner.files.find((x) => x.id === id)?.name ||
        'Untitled'
      );
    }
    return (n.content ?? []).map(run).join('');
  };
  return item.content?.[0] ? run(item.content[0]).split(/\s+/).filter(Boolean).join(' ') : '';
}

const WORD_CHAR = /[\p{Alphabetic}\p{N}]/u;
// CJK ideographs, Hiragana and Katakana are written without spaces, so each
// character counts as a word.
const SPACELESS = /[一-鿿㐀-䶿\u{20000}-\u{2A6DF}豈-﫿぀-ゟ゠-ヿ]/u;

// Thai, Lao, Myanmar and Khmer are written without spaces too, but only a
// dictionary can find their words, so a run of them is an estimate.
const UNSPACED = /[฀-໿က-႟ក-៿]/u;
// Combining marks (accents, vowel signs, vowel points) belong to the letter before them.
const MARK = /\p{M}/u;

/** Words in a text, counted as the backend does: runs of letters and digits,
 *  except that each character in a script without spaces is a word, and a
 *  run of Thai, Lao, Myanmar or Khmer is one word per 4 letters, rounded up.
 *  Marks never start or end a word. */
function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  let run = 0;
  for (const c of text) {
    if (MARK.test(c)) continue;
    const letter = WORD_CHAR.test(c);
    if (letter && UNSPACED.test(c)) {
      if (run++ % 4 === 0) count++;
      inWord = false;
      continue;
    }
    run = 0;
    if (!letter) inWord = false;
    else if (SPACELESS.test(c)) {
      count++;
      inWord = false;
    } else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

/** A page's text without its markup, for the sample pages, which were never
 *  saved from the editor and so have no `text`. Content is editor JSON or HTML. */
function plainText(content: string): string {
  try {
    // Every node but text ends in a space, so words in neighbouring blocks stay apart.
    const walk = (n: any): string => (n?.type === 'text' ? (n.text ?? '') : (n?.content ?? []).map(walk).join('') + ' ');
    if (content.startsWith('{')) return walk(JSON.parse(content));
  } catch {
    /* an HTML page */
  }
  return content.replace(/<[^>]*>|&[#\w]+;/g, ' ');
}

const patchFields = <T extends object>(target: T, patch: Record<string, any>, keys: (keyof T)[]) => {
  for (const k of keys) if (patch[k as string] !== undefined) (target as any)[k] = patch[k as string];
};

mockWindows('main');
mockConvertFileSrc('windows');
{
  const internals = (window as any).__TAURI_INTERNALS__;
  const convert = internals.convertFileSrc;
  internals.convertFileSrc = (path: string, protocol: string) => blobs[path] ?? convert(path, protocol);
}
/** Every card in live pages (what list_cards returns). */
function mockCards(): any[] {
  const out: unknown[] = [];
  const walk = (n: any, f: (c: any) => void) => {
    if (n?.type === 'flashcard') return f(n);
    for (const c of n?.content ?? []) walk(c, f);
  };
  for (const r of rows.filter((x) => !x.deletedAt)) {
    let doc: any;
    try {
      doc = JSON.parse(r.content);
    } catch {
      continue;
    }
    walk(doc, (c) => {
      const side = (i: number) => (c.content?.[i] ? itemText({ content: [c.content[i]] }, true) : '');
      const front = side(0);
      if (!c.attrs?.id || !front) return;
      const rv = planner.reviews.find((x) => x.pageId === r.id && x.cardId === c.attrs.id);
      const review = rv ? { due: rv.due, interval: rv.interval, ease: rv.ease, reps: rv.reps, lapses: rv.lapses } : null;
      const content = (i: number) => c.content?.[i]?.content ?? [];
      out.push({ pageId: r.id, id: c.attrs.id, front, back: side(1), frontContent: content(0), backContent: content(1), review });
    });
  }
  return out;
}

// ------------------------------------------------------------------ databases

interface MockDb {
  schemas: Record<string, DatabaseSchema & { nextNumber: number }>;
  rows: Record<string, { sortKey: string; number: number; cells: Record<string, CellValue>; template?: boolean }>;
}
const DB_KEY = 'thoughtdesk.devmock.databases.v1';
const dbData: MockDb = (() => {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY) ?? '') as MockDb;
  } catch {
    return { schemas: {}, rows: {} };
  }
})();
const persistDb = () => localStorage.setItem(DB_KEY, JSON.stringify(dbData));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const mockRow = (id: string, known?: Row): DbRow => {
  const r = dbData.rows[id];
  const page = known ?? rows.find((x) => x.id === id);
  let cover: string | null = null;
  try {
    const walk = (n: any): string | null => (n?.type === 'image' ? n.attrs?.src : (n?.content ?? []).map(walk).find(Boolean)) ?? null;
    if (page?.content.includes('"image"')) cover = walk(JSON.parse(page.content));
  } catch {
    /* an HTML page */
  }
  return { id, dbId: page?.parentId ?? '', sortKey: r.sortKey, number: r.number, cells: clone(r.cells), cover, ...(r.template ? { template: true } : {}) };
};
function mockCreateRows(
  dbId: string,
  list: { title: string; icon?: string; sortKey: string; cells: Record<string, CellValue>; template?: boolean; fromTemplate?: string }[],
) {
  const schema = dbData.schemas[dbId];
  if (!schema) throw 'Database not found';
  return list.map((n) => {
    const tpl = n.fromTemplate ? rows.find((x) => x.id === n.fromTemplate && x.parentId === dbId && dbData.rows[x.id]) : undefined;
    if (n.fromTemplate && !tpl) throw 'That template no longer exists';
    const page = make(dbId, n.title, n.icon ?? '');
    if (tpl) {
      page.content = tpl.content;
      page.tags = [...(tpl.tags ?? [])];
    }
    rows.push(page);
    dbData.rows[page.id] = { sortKey: n.sortKey, number: n.template ? 0 : schema.nextNumber++, cells: clone(n.cells ?? {}), ...(n.template ? { template: true } : {}) };
    return { page: meta(page), row: mockRow(page.id, page) };
  });
}
function mockCreateDatabase(parentId: string | null, title: string, icon: string, input: any) {
  const page = make(parentId, title, icon);
  page.kind = 'database';
  rows.push(page);
  place(page.id, parentId, null);
  const properties = clone(input.properties ?? []);
  if (!properties.some((p: any) => p.id === 'title')) properties.unshift({ id: 'title', name: 'Name', type: 'title', config: {}, sortKey: 'a0' });
  const views = clone(input.views?.length ? input.views : [{ id: 'table', name: 'Table', type: 'table', config: {}, sortKey: 'a0' }]);
  const automations = clone(input.automations ?? []);
  dbData.schemas[page.id] = { id: page.id, description: input.description ?? '', properties, views, automations, nextNumber: 1 };
  const created = mockCreateRows(page.id, input.rows ?? []);
  const { nextNumber: _n, ...database } = dbData.schemas[page.id];
  return { page: meta(page), database: clone(database), rows: created };
}

// A database to look at in the preview.
if (!FRESH && !Object.keys(dbData.schemas).length && !localStorage.getItem(DB_KEY)) {
  const t = TEMPLATES.find((x) => x.key === 'reading')!;
  const books: [string, string, string, string[], number, string?][] = [
    ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'finished', ['fiction'], 304, 'r5'],
    ['Sapiens', 'Yuval Noah Harari', 'reading', ['history', 'science'], 443],
    ['The Selfish Gene', 'Richard Dawkins', 'want', ['science', 'course'], 360],
    ['Middlemarch', 'George Eliot', 'want', ['fiction', 'course'], 880],
  ];
  mockCreateDatabase(null, 'Reading list', 'icon:book-open:purple', {
    properties: t.properties,
    views: t.views,
    rows: books.map(([title, author, status, genre, pages, rating], i) => ({
      title,
      sortKey: `a${i}`,
      cells: { author, status, genre, pages, ...(rating ? { rating } : {}) },
    })),
  });
  persistDb();
}

mockIPC((cmd, payload) => {
  const a = (payload ?? {}) as Record<string, any>;
  const find = (id: string) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw 'Page not found';
    return r;
  };
  try {
    switch (cmd) {
      case 'list_databases':
        return Object.values(dbData.schemas).map(({ nextNumber: _n, ...d }) => clone({ ...d, automations: d.automations ?? [] }));
      case 'list_rows':
        {
          const pages = new Map(rows.map((r) => [r.id, r]));
          const only: Set<string> | null = a.dbIds ? new Set(a.dbIds) : null;
          return Object.keys(dbData.rows).flatMap((id) => {
            const page = pages.get(id);
            return page && (!only || only.has(page.parentId ?? '')) ? [mockRow(id, page)] : [];
          });
        }
      case 'list_rows_head': {
        const live = rows.filter((r) => r.parentId === a.dbId && !r.deletedAt && dbData.rows[r.id] && !dbData.rows[r.id].template);
        const key = (r: Row) => dbData.rows[r.id].sortKey;
        live.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : x.id < y.id ? -1 : 1));
        return live.slice(0, a.limit).map((r) => mockRow(r.id, r));
      }
      case 'row_counts': {
        const counts: Record<string, number> = {};
        for (const r of rows) {
          const row = dbData.rows[r.id];
          if (row && !row.template && !r.deletedAt && r.parentId) counts[r.parentId] = (counts[r.parentId] ?? 0) + 1;
        }
        return counts;
      }
      case 'create_database':
        return mockCreateDatabase(a.parentId ?? null, a.title ?? '', a.icon ?? '', a.input ?? {});
      case 'update_database':
        dbData.schemas[a.id].description = a.description;
        return null;
      case 'save_property':
      case 'save_view':
      case 'save_automation': {
        const s = dbData.schemas[a.dbId];
        s.automations ??= [];
        const list = (cmd === 'save_property' ? s.properties : cmd === 'save_view' ? s.views : s.automations) as any[];
        const item = clone(cmd === 'save_property' ? a.property : cmd === 'save_view' ? a.view : a.automation);
        const i = list.findIndex((x) => x.id === item.id);
        if (i >= 0) list[i] = item;
        else list.push(item);
        list.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
        return null;
      }
      case 'delete_property':
      case 'delete_view':
      case 'delete_automation': {
        const s = dbData.schemas[a.dbId];
        if (cmd === 'delete_property') s.properties = s.properties.filter((x) => x.id !== a.id);
        else if (cmd === 'delete_automation') s.automations = (s.automations ?? []).filter((x) => x.id !== a.id);
        else if (s.views.length > 1) s.views = s.views.filter((x) => x.id !== a.id);
        return null;
      }
      case 'create_rows':
        return mockCreateRows(a.dbId, a.rows ?? []);
      case 'update_rows': {
        const ts = Date.now();
        for (const ch of a.changes ?? []) {
          const r = dbData.rows[ch.id];
          if (!r) continue;
          if (ch.cells) {
            for (const [k, v] of Object.entries(ch.cells)) {
              if (v === null) delete r.cells[k];
              else r.cells[k] = v as CellValue;
            }
            const page = rows.find((x) => x.id === ch.id);
            if (page) page.updatedAt = ts;
          }
          if (ch.sortKey) r.sortKey = ch.sortKey;
        }
        return ts;
      }
      case 'list_pages':
        return rows.map(meta);
      case 'get_page':
        return { ...find(a.id) };
      case 'create_page': {
        if (a.parentId && dbData.schemas[a.parentId]) throw 'Add rows to a database with its New button';
        const r = make(a.parentId ?? null, a.title ?? '', a.icon ?? '');
        rows.push(r);
        place(r.id, r.parentId, a.index ?? null);
        return meta(r);
      }
      case 'update_page': {
        const r = find(a.id);
        const p = a.patch ?? {};
        if (p.title !== undefined) r.title = p.title;
        if (p.icon !== undefined) r.icon = p.icon;
        if (p.content !== undefined) r.content = p.content;
        if (p.text !== undefined) r.text = p.text;
        if (p.favorite !== undefined) r.favorite = p.favorite ? Date.now() : 0;
        if (p.fullWidth !== undefined) r.fullWidth = p.fullWidth;
        if (p.title !== undefined || p.icon !== undefined || p.content !== undefined) r.updatedAt = Date.now();
        return r.updatedAt;
      }
      case 'move_page': {
        const r = find(a.id);
        const old = r.parentId;
        r.parentId = a.parentId ?? null;
        place(r.id, r.parentId, a.index);
        rows.filter((x) => x.parentId === old && !x.deletedAt).sort((x, y) => x.position - y.position).forEach((x, i) => (x.position = i));
        return null;
      }
      case 'duplicate_page': {
        const src = find(a.id);
        const copy = { ...src, id: crypto.randomUUID(), title: src.title ? `${src.title} (copy)` : '', favorite: 0 };
        rows.push(copy);
        place(copy.id, copy.parentId, src.position + 1);
        const row = dbData.rows[src.id];
        if (row) {
          const s = dbData.schemas[src.parentId ?? ''];
          dbData.rows[copy.id] = { sortKey: `${row.sortKey}V`, number: s && !row.template ? s.nextNumber++ : 0, cells: clone(row.cells), ...(row.template ? { template: true } : {}) };
        }
        const schema = dbData.schemas[src.id];
        if (schema) {
          dbData.schemas[copy.id] = { ...clone(schema), id: copy.id };
          for (const child of rows.filter((x) => x.parentId === src.id && !x.deletedAt)) {
            const c = { ...child, id: crypto.randomUUID(), parentId: copy.id };
            rows.push(c);
            dbData.rows[c.id] = clone(dbData.rows[child.id]);
          }
        }
        return meta(copy);
      }
      case 'trash_page': {
        const ts = Date.now();
        for (const r of subtree(a.id, (x) => !x.deletedAt)) if (!r.deletedAt) r.deletedAt = ts;
        return ts;
      }
      case 'restore_page': {
        const r = find(a.id);
        // A row brings its trashed database back with it.
        const dbPage = r.parentId ? rows.find((x) => x.id === r.parentId && x.kind === 'database' && x.deletedAt) : undefined;
        if (dbPage) {
          const t = dbPage.deletedAt;
          for (const x of subtree(dbPage.id, (y) => y.deletedAt === t)) x.deletedAt = null;
        }
        const ts = r.deletedAt;
        for (const x of subtree(a.id, (y) => y.deletedAt === ts)) x.deletedAt = null;
        const parent = rows.find((x) => x.id === r.parentId);
        if (parent?.deletedAt) r.parentId = null;
        place(r.id, r.parentId, null);
        return null;
      }
      case 'delete_page': {
        const gone = new Set(subtree(a.id).map((r) => r.id));
        rows = rows.filter((r) => !gone.has(r.id));
        return null;
      }
      case 'empty_trash':
        rows = rows.filter((r) => !r.deletedAt);
        planner.assignments = planner.assignments.filter((x) => !x.deletedAt);
        planner.events = planner.events.filter((x) => !x.deletedAt);
        for (const f of planner.files.filter((x) => x.deletedAt)) delete blobs[f.stored];
        planner.files = planner.files.filter((x) => !x.deletedAt);
        persistBlobs();
        return null;
      case 'list_courses':
        return planner.courses;
      case 'create_course': {
        const c = newCourse(a.name, a.color, planner.courses.length);
        planner.courses.push(c);
        return c;
      }
      case 'reorder_courses': {
        const at = new Map<string, number>((a.ids as string[]).map((id, i) => [id, i]));
        for (const c of planner.courses) if (at.has(c.id)) c.position = at.get(c.id)!;
        planner.courses.sort((x, y) => x.position - y.position);
        return null;
      }
      case 'update_course': {
        const c = planner.courses.find((x) => x.id === a.id)!;
        patchFields(c, a.patch, ['name', 'color', 'teacher', 'email', 'officeHours', 'room', 'pageId', 'weights']);
        return c;
      }
      case 'delete_course':
        planner.courses = planner.courses.filter((x) => x.id !== a.id);
        for (const x of [...planner.assignments, ...planner.events]) if (x.courseId === a.id) x.courseId = null;
        return null;
      case 'list_assignments':
        return planner.assignments;
      case 'create_assignment':
      case 'update_assignment': {
        let x = planner.assignments.find((y) => y.id === a.id);
        const p = (a.patch ?? a.input) as Record<string, any>;
        if (!x) {
          x = newAssignment();
          planner.assignments.push(x);
        }
        if (p.status !== undefined && p.status !== x.status) x.completedAt = p.status === 'done' ? Date.now() : null;
        patchFields(x, p, ['title', 'courseId', 'dueDate', 'dueTime', 'status', 'priority', 'notes', 'pageId', 'fileIds', 'sourceUid', 'score', 'maxScore', 'category']);
        if (!x.dueDate) x.dueTime = null;
        x.fileIds = x.fileIds.filter((id) => planner.files.some((f) => f.id === id));
        x.updatedAt = Date.now();
        return x;
      }
      case 'list_events':
        return planner.events;
      case 'create_event':
      case 'update_event': {
        let x = planner.events.find((y) => y.id === a.id);
        const p = (a.patch ?? a.input) as Record<string, any>;
        if (!x) {
          x = newEvent(p.startDate);
          planner.events.push(x);
        }
        patchFields(x, p, ['title', 'startDate', 'startTime', 'endDate', 'endTime', 'color', 'courseId', 'location', 'notes', 'repeat', 'repeatUntil', 'pageId', 'sourceUid']);
        if (p.exdates !== undefined) x.exdates = [...new Set(p.exdates as string[])].sort();
        if (x.endDate < x.startDate) x.endDate = x.startDate;
        if (!x.startTime) x.endTime = null;
        else if (!x.endTime || (x.endDate === x.startDate && x.endTime < x.startTime)) x.endTime = x.startTime;
        x.updatedAt = Date.now();
        return { ...x };
      }
      case 'list_files':
        return planner.files.map((f) => ({ ...f, missing: !blobs[f.stored] }));
      case 'update_file': {
        const f = planner.files.find((x) => x.id === a.id)!;
        if (a.patch?.name) f.name = a.patch.name;
        return f;
      }
      case 'file_usage':
        return planner.files
          .filter((f) => !f.deletedAt)
          .map((f) => ({ fileId: f.id, pageIds: rows.filter((r) => !r.deletedAt && (r.content.includes(f.id) || r.content.includes(f.stored))).map((r) => r.id) }))
          .filter((u) => u.pageIds.length);
      case 'open_file':
      case 'reveal_file':
        console.info(`[dev] ${cmd}`, a.id);
        return null;
      case 'export_file':
        return `C:\\Downloads\\${planner.files.find((f) => f.id === a.id)?.name}`;
      case 'list_tags':
        return [...planner.tags].sort((x, y) => x.name.localeCompare(y.name));
      case 'set_item_tags': {
        const clean = [...new Set((a.tags as string[]).map(cleanTag).filter(Boolean))];
        itemList(a.table).find((x) => x.id === a.id)!.tags = clean;
        for (const t of clean) if (!planner.tags.some((x) => x.name === t)) planner.tags.push({ name: t, color: '' });
        return clean;
      }
      case 'set_tag_color': {
        const t = planner.tags.find((x) => x.name === a.name);
        if (t) t.color = a.color;
        else planner.tags.push({ name: a.name, color: a.color });
        return null;
      }
      case 'rename_tag': {
        const to = a.to === null ? null : cleanTag(a.to);
        for (const table of ['pages', 'assignments', 'events', 'files']) {
          for (const x of itemList(table)) {
            if (!x.tags.includes(a.from)) continue;
            x.tags = [...new Set(x.tags.flatMap((t) => (t === a.from ? (to ? [to] : []) : [t])))];
          }
        }
        const old = planner.tags.find((x) => x.name === a.from);
        planner.tags = planner.tags.filter((x) => x.name !== a.from);
        if (to && !planner.tags.some((x) => x.name === to)) planner.tags.push({ name: to, color: old?.color ?? '' });
        return null;
      }
      case 'backlinks':
        return rows.filter((r) => !r.deletedAt && r.id !== a.id && r.content.includes(a.id)).map((r) => r.id);
      case 'link_graph': {
        const live = rows.filter((r) => !r.deletedAt);
        return live.flatMap((r) => live.filter((t) => t.id !== r.id && r.content.includes(t.id)).map((t) => [r.id, t.id]));
      }
      case 'page_words':
        return rows
          .filter((r) => !r.deletedAt)
          .map((r): [string, number] => [r.id, countWords(r.text || plainText(r.content))])
          .filter(([, n]) => n > 0);
      case 'galaxy_seed': {
        // `?seed=<number>` in the address shows someone else's galaxy. Otherwise
        // one is made once and kept (`?fresh` clears it, like a new workspace).
        const asked = Number(new URLSearchParams(location.search).get('seed') ?? NaN);
        if (Number.isInteger(asked)) return asked >>> 0;
        const key = 'thoughtdesk.devmock.seed';
        let seed = Number(localStorage.getItem(key) ?? NaN);
        if (!Number.isInteger(seed)) {
          seed = crypto.getRandomValues(new Uint32Array(1))[0];
          localStorage.setItem(key, String(seed));
        }
        return seed;
      }
      case 'list_todos': {
        const out: { pageId: string; index: number; text: string; key: string }[] = [];
        for (const r of rows.filter((x) => !x.deletedAt)) {
          let doc: any;
          try {
            doc = JSON.parse(r.content);
          } catch {
            continue;
          }
          let index = 0;
          walkTodos(doc, (item) => {
            if (!item.attrs?.checked) {
              const text = itemText(item, true);
              if (text) out.push({ pageId: r.id, index, text, key: itemText(item, false) });
            }
            index++;
          });
        }
        return out;
      }
      case 'set_todo': {
        const r = find(a.pageId);
        const doc = JSON.parse(r.content);
        let at = 0;
        let found = false;
        walkTodos(doc, (item) => {
          if (at === a.index && itemText(item, false) === a.key) {
            item.attrs.checked = a.checked;
            found = true;
          }
          at++;
        });
        if (!found) throw 'That to-do changed. Refresh and try again.';
        r.content = JSON.stringify(doc);
        r.updatedAt = Date.now();
        return r.updatedAt;
      }
      case 'list_occurrence_pages':
        return planner.sessions.filter((s) => rows.some((r) => r.id === s.pageId) && planner.events.some((e) => e.id === s.eventId));
      case 'set_occurrence_page':
        planner.sessions = planner.sessions.filter((s) => !(s.eventId === a.eventId && s.date === a.date));
        planner.sessions.push({ eventId: a.eventId, date: a.date, pageId: a.pageId });
        return null;
      case 'list_cards':
        return mockCards();
      case 'list_decks': {
        const decks = new Map<string, any>();
        for (const c of mockCards()) {
          let d = decks.get(c.pageId);
          if (!d) decks.set(c.pageId, (d = { pageId: c.pageId, count: 0, due: 0, fresh: 0, mastered: 0 }));
          d.count++;
          if (!c.review) d.fresh++;
          else {
            if (c.review.due <= a.today) d.due++;
            if (c.review.interval >= 21) d.mastered++;
          }
        }
        return [...decks.values()];
      }
      case 'save_review':
        planner.reviews = planner.reviews.filter((x) => !(x.pageId === a.pageId && x.cardId === a.cardId));
        planner.reviews.push({ pageId: a.pageId, cardId: a.cardId, ...a.review });
        return null;
      case 'forget_review':
        planner.reviews = planner.reviews.filter((x) => !(x.pageId === a.pageId && x.cardId === a.cardId));
        return null;
      case 'reset_reviews':
        planner.reviews = planner.reviews.filter((x) => x.pageId !== a.pageId);
        return null;
      case 'trim_memory':
        return null;
      case 'export_pdf':
        window.print();
        return `Downloads/${a.title}.pdf`;
      case 'set_reminders':
        console.info('[dev] reminders', a.list);
        return null;
      case 'set_capture_shortcut':
        return null;
      case 'trash_item':
      case 'restore_item':
      case 'delete_item': {
        const list = (planner as any)[a.table] as { id: string; deletedAt: number | null }[];
        const ts = Date.now();
        if (cmd === 'trash_item') list.find((x) => x.id === a.id)!.deletedAt = ts;
        else if (cmd === 'restore_item') list.find((x) => x.id === a.id)!.deletedAt = null;
        else {
          (planner as any)[a.table] = list.filter((x) => x.id !== a.id);
          if (a.table === 'files') {
            const f = planner.files.find((x) => x.id === a.id);
            if (f) delete blobs[f.stored];
            for (const x of planner.assignments) x.fileIds = x.fileIds.filter((id) => id !== a.id);
            persistBlobs();
          }
        }
        return ts;
      }
      case 'search': {
        const q = String(a.query ?? '').trim().toLowerCase();
        const live = rows.filter((r) => !r.deletedAt).map((r) => ({ ...r, text: r.text || plainText(r.content) }));
        const hits = q
          ? live.filter((r) => r.title.toLowerCase().includes(q) || r.text.toLowerCase().includes(q))
          : [...live].sort((x, y) => y.updatedAt - x.updatedAt);
        return hits.slice(0, a.limit ?? 30).map((r) => {
          const i = r.text.toLowerCase().indexOf(q);
          const snippet = q && i >= 0 ? `${r.text.slice(Math.max(0, i - 30), i)}\u0001${r.text.slice(i, i + q.length)}\u0002${r.text.slice(i + q.length, i + 80)}` : '';
          return { id: r.id, title: r.title, icon: r.icon, snippet, updatedAt: r.updatedAt };
        });
      }
      case 'data_info':
        return {
          dataDir: (window as any).__dataDir ?? 'C:\\(browser preview)',
          defaultDir: 'C:\\(browser preview)',
          chosenDir: !!(window as any).__dataDir,
          envDir: false,
          missingDir: (window as any).__missingDir ?? null,
          dbBytes: JSON.stringify(rows).length + JSON.stringify(planner).length,
          fileBytes: planner.files.reduce((n, f) => n + f.size, 0),
          fileCount: planner.files.filter((f) => !f.deletedAt).length,
          pageCount: rows.filter((r) => !r.deletedAt).length,
          assignmentCount: planner.assignments.filter((x) => !x.deletedAt).length,
          eventCount: planner.events.filter((x) => !x.deletedAt).length,
          version: 'dev',
        };
      case 'plugin:dialog|open':
        // Tests set the folder a person would pick.
        return (window as any).__pickFolder ?? null;
      case 'data_folder_check':
        return { hasNotes: !!(window as any).__folderHasNotes, modified: null };
      case 'data_folder_move':
      case 'data_folder_reset':
        (window as any).__folderMoves = [...((window as any).__folderMoves ?? []), { cmd, ...a }];
        return null;
      case 'set_page_shared': {
        const r = find(a.id);
        if (a.room && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.room)) throw "That isn't a session";
        r.sharedRoom = a.room ?? null;
        if (!a.room) yjs.delete(a.id);
        return null;
      }
      case 'get_page_yjs':
        return (yjs.get(a.id) ?? new Uint8Array()).slice().buffer;
      case 'page_contents':
        return (a.ids ?? []).flatMap((id: string) => rows.filter((r) => r.id === id).map((r) => ({ id, content: r.content })));
      case 'export_begin':
        // What a workspace export wrote, by path: a text, or the file it copied.
        (window as any).__workspaceExport = {};
        return `C:\\Downloads\\${a.name}`;
      case 'export_write':
        for (const e of a.entries ?? []) (window as any).__workspaceExport[e.path] = e.text ?? { copied: e.stored };
        return null;
      case 'auth_listen':
        return 0;
      case 'notify':
        (window as any).__notifications = [...((window as any).__notifications ?? []), { title: a.title, body: a.body }];
        return null;
      case 'export_reveal':
        return null;
      case 'export_markdown':
        console.info(a.markdown);
        return `C:\\Downloads\\${a.title}.md`;
      case 'plugin:window|is_maximized':
        return false;
      default:
        return null;
    }
  } finally {
    // A preview stress-tested with tens of thousands of rows stays in memory:
    // saving it all after every call would be slow and overflow storage.
    if (rows.length < 5000) {
      try {
        persist();
        persistPlanner();
        persistDb();
      } catch {
        /* storage full: keep going in memory */
      }
    }
  }
});

// save_file sends raw bytes with the name in headers, which mockIPC drops.
{
  const internals = (window as any).__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
    if (cmd === 'save_page_yjs') {
      const id = options?.headers?.['x-id'] ?? '';
      if (!rows.find((r) => r.id === id)?.sharedRoom) throw "That page isn't shared";
      yjs.set(id, new Uint8Array(args as Uint8Array));
      return null;
    }
    if (cmd === 'export_document') {
      const name = decodeURIComponent(options?.headers?.['x-name'] ?? 'Untitled');
      const ext = options?.headers?.['x-ext'] ?? 'bin';
      // Hand the file to the browser so it can be checked by hand.
      const url = URL.createObjectURL(new Blob([args as BlobPart]));
      const link = Object.assign(document.createElement('a'), { href: url, download: `${name}.${ext}` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      (window as any).__lastExport = { name, ext, bytes: args };
      return `C:\\Downloads\\${name}.${ext}`;
    }
    if (cmd !== 'save_file') return invoke(cmd, args, options);
    const bytes = args as Uint8Array;
    const name = decodeURIComponent(options?.headers?.['x-name'] ?? 'Untitled');
    const mime = decodeURIComponent(options?.headers?.['x-mime'] ?? '') || 'application/octet-stream';
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'bin';
    const stored = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
    blobs[stored] = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
    });
    persistBlobs();
    const ts = Date.now();
    const meta: FileMeta = { id: crypto.randomUUID(), name, stored, mime, size: bytes.byteLength, createdAt: ts, updatedAt: ts, deletedAt: null, missing: false, tags: [] };
    planner.files.push(meta);
    persistPlanner();
    return meta;
  };
}

console.info('[dev] Using in-memory backend mock');
