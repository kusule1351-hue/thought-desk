// The marketing film, pass 1: the app itself, recorded frame by frame.
//
// The app runs in the browser preview with its stand-in backend, a stand-in account and a scripted model, as the
// website's pictures do (site/scripts/screenshots.mjs). Nothing is recorded in real time: the page's clock is
// stopped, and for each frame it is moved on by a thirtieth of a second, every animation with it, and a picture is
// taken. So the film is the real interface, exactly as smooth as the frames are many, whatever the computer.
//
//   node marketing/film/app.mjs <folder for the frames>
//
// Writes 00000.jpg, 00001.jpg, … and marks.json: which frame each thing happens on, and where on the screen.

import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NOW, workspace } from '../../site/scripts/workspace.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.argv[2];
if (!OUT) throw new Error('Name a folder for the frames.');
const APP = 'http://localhost:1420';
const VIEWPORT = { width: 1280, height: 720 };
const FPS = 30;
const THEME = process.env.FILM_THEME || 'light';
/** Only every so many frames are saved (a quick look at the timing, not a film). */
const SKIP = Number(process.env.FILM_SKIP || 1);

// ------------------------------------------------------------------ the story

const QUESTION = 'Which way does water move when the outside is more dilute?';
const ANSWER =
  'From [[Osmosis and water potential]]: water moves toward the side with the **lower** water potential, so it flows into the cell when the solution outside is more dilute.\n\nWant these as flashcards for the midterm?';
const YES = 'Yes, make them';
const CARDS = {
  title: 'Osmosis: midterm cards',
  markdown:
    'Osmosis :: Water moving across a membrane toward more dissolved solute\n\nWater potential :: How freely water can move, in megapascals\n\nSolute potential :: The pull of dissolved solute: zero or below',
};
const DONE = 'Done. Three cards, ready to study.';

// ------------------------------------------------------- the stand-in model

/** Requests for an answer, in the order they came: each is held open and written to when the story says. */
const turns = [];
const model = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': '*',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = (body) => res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (path.endsWith('/assistant/usage')) return json({ used: 12_000, limit: 100_000, month: '2026-11', on: true, plan: 'free' });
  if (path.includes('/billing/plan')) return json({ on: true, plan: 'free', until: null, ending: false, terms: '2026-11-27' });
  if (!path.endsWith('/assistant/v1/messages')) return res.writeHead(404, cors).end();
  req.resume();
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: 'message_start', message: { id: `msg_${turns.length + 1}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  turns.push({
    send,
    end(stop) {
      send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
      send({ type: 'message_stop' });
      res.end();
    },
  });
});
await new Promise((done) => model.listen(0, '127.0.0.1', done));
const MODEL = `http://127.0.0.1:${model.address().port}`;

// ------------------------------------------------------------------ the app

const up = () => fetch(APP).then((r) => r.ok, () => false);
const real = (ms) => new Promise((done) => setTimeout(done, ms));

let server;
if (!(await up())) {
  console.log('Starting the preview…');
  server = spawn('npm run dev', { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await up()); i++) await real(500);
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const { pages, planner, lecture } = workspace();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: THEME, locale: 'en-US' });
  await context.clock.install({ time: NOW });
  const me = { id: randomUUID(), email: 'maya@example.com' };
  const cloud = { user: me, myProfile: { id: me.id, username: 'maya', displayName: 'Maya', avatarUrl: null }, accessToken: `test.${me.id}`, friends: [], sessions: [], versions: { friends: 0, sessions: 0 }, nudges: 0 };
  await context.exposeBinding('__fakeCloud', (_source, method) => cloud[method] ?? null);
  await context.addInitScript(
    ({ pages, planner, prefs, model }) => {
      window.__assistantBeta = true;
      window.__assistantUrl = model;
      if (localStorage.getItem('thoughtdesk.devmock.v2')) return;
      localStorage.setItem('thoughtdesk.devmock.v2', JSON.stringify(pages));
      localStorage.setItem('thoughtdesk.devmock.planner.v1', JSON.stringify(planner));
      localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify(prefs));
    },
    { pages, planner, model: MODEL, prefs: { theme: THEME, name: 'Maya', welcomed: true, calendarMode: 'week', sidebarHidden: { friends: true, tags: true, cowork: true }, assistantOn: true, assistantOpen: true, assistantWidth: 400 } },
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));
  await page.goto(APP);
  const sidebar = page.locator('.sidebar');
  await sidebar.getByText(lecture.title, { exact: true }).first().click();
  await page.locator('.ProseMirror').waitFor();
  const panel = page.locator('aside.assistant');
  await panel.waitFor();
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  await page.waitForTimeout(1500);

  // From here the clock only moves when a frame is taken.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 200));

  let n = 0;
  const marks = { fps: FPS, viewport: VIEWPORT, theme: THEME };
  /** Where a thing is on the screen, for the film's pointer: its middle, in the app's own pixels. */
  const middle = async (locator) => {
    const box = await locator.boundingBox();
    return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) } : null;
  };
  const mark = (name, extra = {}) => {
    marks[name] = { frame: n, ...extra };
    console.log(String(n).padStart(4), name);
  };

  /** One frame: time moves on, timers and animations with it, and the picture is saved. */
  const frame = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      const ms = Math.round(((n + 1) * 1000) / FPS) - Math.round((n * 1000) / FPS);
      await page.clock.runFor(ms);
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          if (a.playState === 'finished' || a.playState === 'idle') continue;
          const end = a.effect?.getComputedTiming().endTime ?? Infinity;
          const to = (Number(a.currentTime) || 0) + ms;
          if (to >= Number(end)) a.finish();
          else {
            a.pause();
            a.currentTime = to;
          }
        }
      }, ms);
      if (n % SKIP === 0) await writeFile(`${OUT}/${String(n).padStart(5, '0')}.jpg`, await page.screenshot({ type: 'jpeg', quality: 95 }));
      n += 1;
    }
  };
  /** Frames until something is so (what arrives over the network takes real time, which taking a frame gives it). */
  const until = async (so, what, most = 240) => {
    for (let i = 0; i < most; i++) {
      if (await so()) return;
      await frame();
      await real(15);
    }
    throw new Error(`Never happened: ${what}`);
  };
  const turn = async (k) => {
    await until(() => turns.length > k, `request ${k + 1} for the model`);
    return turns[k];
  };
  /** Typed as a quick typist does: about 24 letters a second. */
  const type = async (text) => {
    let due = 0;
    for (const ch of text) {
      await page.keyboard.type(ch);
      due += 30 / 24;
      const frames = Math.floor(due);
      due -= frames;
      if (frames) await frame(frames);
    }
  };
  /** The model's words, arriving a few at a time. */
  const say = async (t, text, perFrame = 0.55) => {
    t.send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    // A link to a note and bold words each arrive whole: half of one would show its brackets or stars for a frame.
    const words = text.match(/\[\[[^\]]*\]\]\S*\s*|\*\*[^*]*\*\*\S*\s*|\S+\s*|\n+/g);
    let due = 0;
    for (const word of words) {
      t.send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } });
      await real(20);
      due += 1 / perFrame;
      const frames = Math.floor(due);
      due -= frames;
      if (frames) await frame(frames);
    }
    t.send({ type: 'content_block_stop', index: 0 });
    t.end('end_turn');
  };
  const use = (t, id, name, input) => {
    t.send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
    t.send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    t.send({ type: 'content_block_stop', index: 0 });
    t.end('tool_use');
  };

  // A breath on the open note, then the question.
  const box = panel.locator('textarea');
  mark('start', { box: await middle(box), panel: await panel.boundingBox() });
  await frame(24);
  await box.click();
  mark('ask');
  await type(QUESTION);
  await frame(6);
  await page.keyboard.press('Enter');
  mark('asked');
  let t = await turn(0);
  await frame(10);
  use(t, 'tu_1', 'search_notes', { query: 'water potential' });
  t = await turn(1);
  mark('searching');
  await frame(14);
  mark('answer');
  await say(t, ANSWER);
  await until(async () => (await page.evaluate(async () => (await import('/src/lib/assistant/assistant.svelte.ts')).assistant.status)) === 'idle', 'the answer finishing');
  mark('answered');
  await frame(48);

  // Yes: the cards, shown first, waiting for a yes.
  await box.click();
  mark('yes');
  await type(YES);
  await frame(5);
  await page.keyboard.press('Enter');
  t = await turn(2);
  await frame(8);
  use(t, 'tu_2', 'create_note', CARDS);
  const change = panel.locator('.item.change');
  await until(async () => (await change.getAttribute('data-state').catch(() => null)) === 'asking', 'the change asking');
  await frame(6);
  mark('asking', { allow: await middle(change.locator('button.allow')), card: await change.boundingBox() });
  await frame(84);
  mark('allow', { allow: await middle(change.locator('button.allow')) });
  await change.locator('button.allow').click();
  t = await turn(3);
  await frame(6);
  mark('done');
  await say(t, DONE);
  await until(async () => (await page.evaluate(async () => (await import('/src/lib/assistant/assistant.svelte.ts')).assistant.status)) === 'idle', 'the last answer finishing');
  await frame(40);

  // And the cards he made, studied.
  const cards = sidebar.getByText('Flashcards', { exact: true });
  mark('toCards', { at: await middle(cards) });
  await cards.click();
  await frame(26);
  const study = page.getByRole('button', { name: 'Study 3', exact: true });
  mark('study', { at: await middle(study) });
  await study.click();
  await frame(36);
  mark('flip');
  await page.keyboard.press('Space');
  await frame(54);
  mark('end');

  await writeFile(`${OUT}/marks.json`, JSON.stringify({ ...marks, frames: n }, null, 1));
  console.log(`${n} frames, ${(n / FPS).toFixed(1)} s`);
  await context.close();
} finally {
  await browser.close();
  model.close();
  if (server) {
    if (process.platform === 'win32') execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    else server.kill();
  }
}
