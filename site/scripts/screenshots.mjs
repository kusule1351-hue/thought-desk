// Screenshots of the app for the website, and the picture shown when a link
// to it is shared (og.png). They're taken in the browser preview with its
// stand-in backend (src/dev-mock.ts), seeded with the workspace below, and
// saved in public/: each view in light and dark, as WebP.
//
//   npm run screenshots      (in site/; starts the preview if it isn't running)

import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const APP = 'http://localhost:1420';
const VIEWPORT = { width: 1280, height: 800 };

// ------------------------------------------------------------- the workspace

/** Days from today to this week's weekday (1 is Monday). */
const weekday = (n, from = new Date()) => n - (((from.getDay() + 6) % 7) + 1);
/** The app's clock in the screenshots: this week's Wednesday, 8:40 in the
 * morning, a day with a lecture ahead and the week view at the start of it. */
const NOW = new Date();
NOW.setDate(NOW.getDate() + weekday(3, NOW));
NOW.setHours(8, 40, 0, 0);

const iso = (offset) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const tasks = (...items) => ({ type: 'taskList', content: items.map(([checked, ...content]) => ({ type: 'taskItem', attrs: { checked }, content: [p(...content)] })) });
const bullets = (...items) => ({ type: 'bulletList', content: items.map((text) => ({ type: 'listItem', content: [p(t(text))] })) });
const math = (latex) => ({ type: 'inlineMath', attrs: { latex } });
const mention = (id, kind = 'page') => ({ type: 'mention', attrs: { id, kind } });
const card = (id, front, back) => ({
  type: 'flashcard',
  attrs: { id },
  content: [
    { type: 'flashcardFront', content: [t(front)] },
    { type: 'flashcardBack', content: [t(back)] },
  ],
});
const doc = (...content) => JSON.stringify({ type: 'doc', content });

function workspace() {
  const now = NOW.getTime();
  const page = (title, icon, parentId, position, content = '', extra = {}) => ({
    id: randomUUID(),
    parentId,
    title,
    icon,
    position,
    favorite: 0,
    fullWidth: false,
    createdAt: now,
    updatedAt: now - position * 60_000,
    deletedAt: null,
    tags: [],
    kind: '',
    sharedRoom: null,
    content,
    text: '',
    ...extra,
  });
  const course = (name, color, position, pageId, extra = {}) => ({
    id: randomUUID(),
    name,
    color,
    position,
    createdAt: now,
    teacher: '',
    email: '',
    officeHours: '',
    room: '',
    pageId,
    weights: {},
    ...extra,
  });
  const assignment = (title, courseId, dueDate, extra = {}) => ({
    id: randomUUID(),
    title,
    courseId,
    dueDate,
    dueTime: null,
    status: 'todo',
    priority: 0,
    notes: '',
    pageId: null,
    fileIds: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    tags: [],
    sourceUid: null,
    score: null,
    maxScore: null,
    category: '',
    ...extra,
  });
  const event = (title, startDate, startTime, endTime, extra = {}) => ({
    id: randomUUID(),
    title,
    startDate,
    startTime,
    endDate: startDate,
    endTime,
    color: '',
    courseId: null,
    location: '',
    notes: '',
    repeat: 'none',
    repeatUntil: null,
    pageId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: [],
    exdates: [],
    sourceUid: null,
    ...extra,
  });

  const biology = page('Biology', 'icon:dna:green', null, 0);
  const history = page('History', 'icon:landmark:orange', null, 1);
  const cs = page('Computer Science', 'icon:code:blue', null, 2);
  const bio = course('Biology', 'green', 0, biology.id, { teacher: 'Dr. Rivera', room: 'Science 204', officeHours: 'Tue 2–4 PM', weights: { Exams: 60, Labs: 40 } });
  const hist = course('History', 'orange', 1, history.id, { teacher: 'Prof. Okafor', room: 'Hall 3' });
  const comp = course('Computer Science', 'blue', 2, cs.id, { teacher: 'Dr. Lindqvist', room: 'Lab 2' });

  const lab = assignment('Lab report: osmosis', bio.id, iso(1), { dueTime: '23:59', priority: 3, status: 'doing', tags: ['lab'], category: 'Labs' });
  const deck = page(
    'Cell vocabulary',
    'icon:layers:green',
    biology.id,
    1,
    doc(
      p(t('Key terms for the midterm.')),
      card('k1', 'Mitochondria', 'Makes the cell’s energy (ATP)'),
      card('k2', 'Osmosis', 'Water moving across a membrane toward more solute'),
      card('k3', 'Ribosome', 'Builds proteins'),
      card('k4', 'Nucleus', 'Holds the cell’s DNA'),
      card('k5', 'Cell membrane', 'Controls what enters and leaves the cell'),
      card('k6', 'Chloroplast', 'Turns light into chemical energy'),
      card('k7', 'Vacuole', 'Stores water and keeps a plant cell firm'),
      card('k8', 'Diffusion', 'Particles spreading from high to low concentration'),
    ),
  );
  const lecture = page(
    'Osmosis and water potential',
    'icon:notebook-pen:green',
    biology.id,
    0,
    doc(
      { type: 'callout', attrs: { icon: 'icon:lightbulb:yellow' }, content: [p(t('On the midterm: '), t('osmosis, water potential and the microscope lab.', 'bold'))] },
      p(t('Osmosis', 'bold'), t(' is water moving across a membrane toward the side with more dissolved solute. A cell gains or loses water until the pull on both sides is equal.')),
      h(2, 'Water potential'),
      p(t('Water flows from higher to lower water potential, '), math('\\Psi'), t(', measured in megapascals:')),
      { type: 'mathBlock', attrs: { latex: '\\Psi = \\Psi_s + \\Psi_p' } },
      p(t('Here '), math('\\Psi_s'), t(' is the solute potential, zero or below, and '), math('\\Psi_p'), t(' is the pressure potential, the push of the cell wall.')),
      h(2, 'To do'),
      tasks([true, t('Read chapter 4, pages 88–104')], [false, t('Finish '), mention(lab.id, 'assignment')], [false, t('Review '), mention(deck.id)]),
    ),
    { favorite: now },
  );
  const pages = [
    biology,
    lecture,
    deck,
    page('Microscope lab', 'icon:microscope:green', biology.id, 2, doc(p(t('Onion skin at 400×: the cell walls are easy to see, the nuclei need the stain.')))),
    history,
    page(
      'Essay outline: the printing press',
      'icon:scroll-text:orange',
      history.id,
      0,
      doc(h(2, 'Thesis'), p(t('Cheap printing spread ideas faster than anyone could control them.')), h(2, 'Points'), bullets('Luther’s pamphlets', 'Scientific journals', 'Newspapers and rumour')),
    ),
    cs,
    page('Problem set 3 notes', 'icon:binary:blue', cs.id, 0, doc(p(t('Merge sort: split, sort each half, merge. '), math('O(n \\log n)'), t(' every time.')))),
    page(
      'Semester plan',
      'icon:target:purple',
      null,
      3,
      doc(p(t('Goals for this semester:')), tasks([false, t('Keep a B+ or better in Biology')], [false, t('Finish the History reading list')], [true, t('Start the CS project early')])),
      { favorite: now - 1 },
    ),
    page('Ideas', 'icon:lightbulb:yellow', null, 4, doc(bullets('A study timer that pauses with your calendar', 'Ask about the summer research program'))),
    page('Journal', 'icon:feather:pink', null, 5, doc(p(t('Long day, good lab. The osmosis results finally made sense.')))),
  ];

  // Weekly classes started a few weeks ago, so every week has them.
  const weekly = (title, day, start, end, courseId, location) =>
    event(title, iso(weekday(day, NOW) - 21), start, end, { courseId, location, repeat: 'weekly' });
  const planner = {
    courses: [bio, hist, comp],
    assignments: [
      lab,
      assignment('Read chapter 4', hist.id, iso(0), { priority: 1 }),
      assignment('Problem set 3', comp.id, iso(2), { dueTime: '17:00', priority: 2 }),
      assignment('Essay outline', hist.id, iso(5)),
      assignment('Group project proposal', comp.id, iso(9)),
      assignment('Quiz 1: cells', bio.id, iso(-10), { status: 'done', completedAt: now, score: 17, maxScore: 20, category: 'Exams' }),
      assignment('Lab: microscopes', bio.id, iso(-6), { status: 'done', completedAt: now, score: 46, maxScore: 50, category: 'Labs' }),
      assignment('Weekly reflection', null, iso(-3), { status: 'done', completedAt: now }),
    ],
    events: [
      weekly('Biology lecture', 1, '09:00', '10:30', bio.id, 'Hall B'),
      weekly('Biology lecture', 3, '09:00', '10:30', bio.id, 'Hall B'),
      weekly('History seminar', 2, '13:00', '14:00', hist.id, 'Hall 3'),
      weekly('History seminar', 4, '13:00', '14:00', hist.id, 'Hall 3'),
      weekly('CS lab', 5, '11:00', '13:00', comp.id, 'Lab 2'),
      event('Study group', iso(0), '16:00', '18:00', { color: 'purple', location: 'Library' }),
      event('Office hours', iso(weekday(2, NOW)), '14:00', '15:00', { courseId: bio.id, location: 'Science 204' }),
      event('Midterm exam', iso(weekday(3, NOW) + 7), '10:00', '12:00', { courseId: comp.id, tags: ['exam'] }),
      event('Fall break', iso(weekday(1, NOW) + 14), null, null, { endDate: iso(weekday(1, NOW) + 18), color: 'teal' }),
    ],
    files: [],
    tags: [
      { name: 'exam', color: 'red' },
      { name: 'lab', color: 'green' },
    ],
    sessions: [],
    reviews: [],
  };
  return { pages, planner, lecture };
}

/** More books for the stand-in's sample reading list. */
const BOOKS = [
  ['Frankenstein', 'Mary Shelley', 'finished', ['fiction', 'course'], 280, 'r5'],
  ['The Gene', 'Siddhartha Mukherjee', 'reading', ['science'], 592],
  ['Brave New World', 'Aldous Huxley', 'finished', ['fiction', 'course'], 288, 'r4'],
  ['Guns, Germs, and Steel', 'Jared Diamond', 'want', ['history'], 480],
  ['A Short History of Nearly Everything', 'Bill Bryson', 'reading', ['science', 'history'], 544],
  ['The Structure of Scientific Revolutions', 'Thomas S. Kuhn', 'want', ['science', 'course'], 264],
];

// ------------------------------------------------------------------ helpers

const up = () => fetch(APP).then((r) => r.ok, () => false);

/** PNG → WebP, encoded by the browser. */
async function webp(page, png) {
  const b64 = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    canvas.getContext('2d').drawImage(img, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, png.toString('base64'));
  return Buffer.from(b64, 'base64');
}

const settle = (page) => page.waitForTimeout(900);

async function shoot(browser, theme) {
  const { pages, planner, lecture } = workspace();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US' });
  await context.clock.setFixedTime(NOW);
  // Seeds a new profile; after a reload, the stand-in's own saved state wins.
  await context.addInitScript(
    ({ pages, planner, prefs }) => {
      if (localStorage.getItem('thoughtdesk.devmock.v2')) return;
      localStorage.setItem('thoughtdesk.devmock.v2', JSON.stringify(pages));
      localStorage.setItem('thoughtdesk.devmock.planner.v1', JSON.stringify(planner));
      localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify(prefs));
    },
    { pages, planner, prefs: { theme, name: 'Maya', welcomed: true, calendarMode: 'week', sidebarHidden: { friends: true, tags: true } } },
  );
  const page = await context.newPage();
  await page.goto(APP);
  const sidebar = page.locator('.sidebar');
  await sidebar.getByText('Reading list', { exact: true }).waitFor();

  // More books. The stand-in saves after every call, so a reload shows them
  // everywhere (the app has already counted and cached the first four).
  await page.evaluate(async (books) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    // The stand-in's only database.
    const [{ id: dbId }] = await invoke('list_databases');
    await invoke('create_rows', {
      dbId,
      rows: books.map(([title, author, status, genre, pages, rating], i) => ({
        title,
        sortKey: `a${i + 4}`,
        cells: { author, status, genre, pages, ...(rating ? { rating } : {}) },
      })),
    });
  }, BOOKS);
  await page.reload();
  await sidebar.getByText('Reading list', { exact: true }).waitFor();

  const shots = {};
  const take = async (name) => {
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await settle(page);
    shots[name] = await page.screenshot();
  };

  await sidebar.getByText(lecture.title, { exact: true }).first().click();
  await page.locator('.ProseMirror').waitFor();
  await take('notes');

  await sidebar.getByText('Home', { exact: true }).click();
  await take('home');

  await sidebar.getByText('Calendar', { exact: true }).click();
  await take('calendar');

  await sidebar.getByText('Reading list', { exact: true }).click();
  await page.getByText('By status', { exact: true }).click();
  await take('database');

  await sidebar.getByText('Flashcards', { exact: true }).click();
  await page.getByRole('button', { name: /^Study \d/ }).last().click();
  await page.keyboard.press('Space');
  await take('flashcards');

  await context.close();
  return shots;
}

/** The picture a shared link shows: 1200 × 630. */
async function og(browser, notes) {
  const [font, icon] = await Promise.all([readFile(`${PUBLIC}fonts/inter-latin.woff2`), readFile(`${PUBLIC}icon.svg`)]);
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <style>
      @font-face { font-family: Inter; font-weight: 100 900; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); }
      body { margin: 0; width: 1200px; height: 630px; overflow: hidden; position: relative; background: #f5f5f7; color: #1d1d1f; font-family: Inter, sans-serif; font-optical-sizing: auto; -webkit-font-smoothing: antialiased; }
      .text { position: absolute; left: 72px; top: 76px; width: 500px; }
      .brand { display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 650; letter-spacing: -0.01em; }
      .brand img { width: 52px; height: 52px; }
      h1 { margin: 52px 0 0; font-size: 58px; line-height: 1.04; font-weight: 700; letter-spacing: -0.036em; }
      p { margin: 24px 0 0; font-size: 24px; color: #6e6e73; }
      .shot { position: absolute; left: 620px; top: 92px; width: 1000px; border-radius: 14px; box-shadow: 0 0 0 0.5px rgba(0,0,0,.14), 0 40px 90px -30px rgba(0,0,0,.3); }
    </style>
    <div class="text">
      <div class="brand"><img src="data:image/svg+xml;base64,${icon.toString('base64')}">Thought Desk</div>
      <h1>Write, plan and study in one quiet place.</h1>
      <p>A free notes app for Windows</p>
    </div>
    <img class="shot" src="data:image/png;base64,${notes.toString('base64')}">`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot();
  await page.close();
  return png;
}

// --------------------------------------------------------------------- main

// ------------------------------------------------------------------ Socrates

/** An answer as the assistant's server streams it (as tests/e2e/assistant.spec.ts makes one). */
function sse(blocks, stop) {
  const out = [];
  const event = (data) => out.push(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  event({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    event({ type: 'content_block_stop', index });
  });
  event({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  event({ type: 'message_stop' });
  return out.join('');
}

/** What the stand-in model says, turn by turn: it looks in the notes, answers from them, then offers flashcards. */
const SOCRATES = [
  [{ type: 'tool_use', id: 'tu_1', name: 'search_notes', input: { query: 'water potential' } }],
  [
    {
      type: 'text',
      text: 'From [[Osmosis and water potential]]: water moves toward the side with the **lower** water potential, so it flows into a cell whenever the solution outside is more dilute than the cell’s contents.\n\nWant these as flashcards for the midterm?',
    },
  ],
  [
    {
      type: 'tool_use',
      id: 'tu_2',
      name: 'create_note',
      input: {
        title: 'Osmosis: midterm cards',
        markdown:
          'Osmosis :: Water moving across a membrane toward the side with more dissolved solute\n\nWater potential :: How freely water can move, measured in megapascals\n\nSolute potential :: The pull of dissolved solute: zero or below\n\nPressure potential :: The push of the cell wall on the water inside',
      },
    },
  ],
  [{ type: 'text', text: 'Four cards, ready when you allow them.' }],
];

/**
 * Socrates in his side chat, beside the lecture notes: a question answered from the notes, and flashcards he
 * offers, waiting for a yes. Then his own page. The account is a stand-in (nobody signs in), and so is the model.
 */
async function shootSocrates(browser, theme) {
  const { pages, planner, lecture } = workspace();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US' });
  await context.clock.setFixedTime(NOW);
  const me = { id: randomUUID(), email: 'maya@example.com' };
  const cloud = { user: me, myProfile: { id: me.id, username: 'maya', displayName: 'Maya', avatarUrl: null }, accessToken: `test.${me.id}`, friends: [], sessions: [], versions: { friends: 0, sessions: 0 }, nudges: 0 };
  await context.exposeBinding('__fakeCloud', (_source, method) => cloud[method] ?? null);
  let turn = 0;
  await context.route('**/__ai/assistant/v1/messages', (route) => {
    const blocks = SOCRATES[Math.min(turn++, SOCRATES.length - 1)];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(blocks, blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn') });
  });
  await context.route('**/__ai/assistant/usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ used: 12_000, limit: 100_000, month: '2026-11', on: true, plan: 'free' }) }));
  await context.route('**/__ai/billing/plan*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ on: true, plan: 'free', until: null, ending: false, terms: '2026-11-27' }) }));
  await context.addInitScript(
    ({ pages, planner, prefs }) => {
      window.__assistantBeta = true;
      window.__assistantUrl = location.origin + '/__ai';
      if (localStorage.getItem('thoughtdesk.devmock.v2')) return;
      localStorage.setItem('thoughtdesk.devmock.v2', JSON.stringify(pages));
      localStorage.setItem('thoughtdesk.devmock.planner.v1', JSON.stringify(planner));
      localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify(prefs));
    },
    { pages, planner, prefs: { theme, name: 'Maya', welcomed: true, calendarMode: 'week', sidebarHidden: { friends: true, tags: true, cowork: true }, assistantOn: true, assistantOpen: true, assistantWidth: 400 } },
  );
  const page = await context.newPage();
  await page.goto(APP);
  const sidebar = page.locator('.sidebar');
  await sidebar.getByText(lecture.title, { exact: true }).first().waitFor();

  const shots = {};
  const take = async (name) => {
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await settle(page);
    shots[name] = await page.screenshot();
  };
  const panel = page.locator('aside.assistant');
  const ask = async (box, text) => {
    await box.fill(text);
    await page.keyboard.press('Enter');
  };

  await sidebar.getByText(lecture.title, { exact: true }).first().click();
  await page.locator('.ProseMirror').waitFor();
  await panel.waitFor();
  await ask(panel.locator('textarea'), 'Which way does water move when the outside is more dilute?');
  await panel.locator('.item.answer').first().waitFor();
  // The answer is all there, and he is at rest, before the next thing is asked (a question asked while he works is dropped).
  const idle = () => page.evaluate(async () => (await import('/src/lib/assistant/assistant.svelte.ts')).assistant.status === 'idle');
  await panel.locator('.item.answer', { hasText: 'flashcards for the midterm' }).waitFor();
  for (let i = 0; i < 100 && !(await idle()); i++) await page.waitForTimeout(100);
  await ask(panel.locator('textarea'), 'Yes, make them');
  await panel.locator('.item.change[data-state="asking"]').waitFor();
  await take('socrates');

  // His own page, before anything is asked: the face, and what he can be asked.
  await page.evaluate(async () => {
    const { assistant } = await import('/src/lib/assistant/assistant.svelte.ts');
    assistant.clear();
  });
  await sidebar.getByText('Socrates', { exact: true }).click();
  await page.locator('section.assistant-page').waitFor();

  // His head, as the app draws it, for the website to show at any size and in either theme.
  shots.face = await page
    .locator('section.assistant-page svg.assistant-face')
    .last()
    .evaluate((svg) => {
      const copy = svg.cloneNode(true);
      copy.removeAttribute('class');
      copy.removeAttribute('style');
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      return { svg: copy.outerHTML, color: getComputedStyle(svg).color, ground: getComputedStyle(svg).getPropertyValue('--face-ground') };
    });

  await context.close();
  return shots;
}

let server;
if (!(await up())) {
  console.log('Starting the preview…');
  server = spawn('npm run dev', { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch();
try {
  await mkdir(`${PUBLIC}img`, { recursive: true });
  const encoder = await browser.newPage();
  for (const theme of ['light', 'dark']) {
    const { face, ...socrates } = await shootSocrates(browser, theme);
    // His drawing, kept in the scratch folder named by FACE_OUT (it is redrawn by hand for the site, not published).
    if (process.env.FACE_OUT) await writeFile(`${process.env.FACE_OUT}/socrates-face-${theme}.json`, JSON.stringify(face, null, 1));
    const shots = { ...(await shoot(browser, theme)), ...socrates };
    for (const [name, png] of Object.entries(shots)) {
      // The website shows Socrates on a dark panel in both themes, so only his dark picture is published.
      if (name === 'socrates' && theme === 'light') continue;
      await writeFile(`${PUBLIC}img/${name}-${theme}.webp`, await webp(encoder, png));
      console.log(`img/${name}-${theme}.webp`);
    }
    if (theme === 'light') {
      await writeFile(`${PUBLIC}og.png`, await og(browser, shots.notes));
      console.log('og.png');
    }
  }
} finally {
  await browser.close();
  if (server) {
    if (process.platform === 'win32') execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    else server.kill();
  }
}
