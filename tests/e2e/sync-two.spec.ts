// Two app windows syncing one account through the real mailbox (server/, the
// Worker + Durable Object + local R2 that playwright.config.ts starts in test
// mode on port 8788). Each window is a browser context with its own in-memory
// stand-in for the Rust side (src/dev-mock.ts), and runs the real engine, real
// Yjs and the real editor. The two sign in as one fake account: the relay takes
// the fake cloud's `test.<uuid>` tokens, on this computer only. A fresh account
// per test, so tests never share a mailbox.
//
// Turning on, joining and turning off go through Settings. "Sync Now" is the
// engine's own (what the button calls), awaited by watching `lastSynced`, so
// typing in an open page is not interrupted by a modal. One test uses neither:
// it waits for the live socket and the timers.
import { RELAY_URL } from './relay';
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import { test as base, expect, open, MOD } from './fixtures';
import { FakeCloud } from './fake-cloud';

const MAILBOX = RELAY_URL;
const GB = 1024 ** 3;
const LONG = { timeout: 15_000 };
const T0 = 1_700_000_000_000;
const SHARED = '11111111-1111-4111-8111-111111111111';
const ALPHA = '22222222-2222-4222-8222-222222222222';
const BIG = '33333333-3333-4333-8333-333333333333';

// ------------------------------------------------------------------- seeds

interface Seed {
  id: string;
  title: string;
  paras?: string[];
  parentId?: string | null;
}

const para = (text: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const bodyOf = (paras: string[]) => JSON.stringify({ type: 'doc', content: paras.map(para) });

/** A page as the stand-in stores it. Every window seeded with the same id, body and time is "a copied notes folder". */
function seeded(seed: Seed, position: number) {
  const paras = seed.paras ?? [];
  return {
    id: seed.id,
    parentId: seed.parentId ?? null,
    title: seed.title,
    icon: '',
    position,
    favorite: 0,
    fullWidth: false,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    tags: [],
    kind: '',
    sharedRoom: null,
    content: paras.length ? bodyOf(paras) : '',
    text: paras.join('\n'),
  };
}

const TWO = ['Alpha one.', 'Alpha two.'];
const randomKey = () => {
  const chars = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  const group = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return Array.from({ length: 6 }, group).join('-');
};

// ------------------------------------------------------------------- windows

interface Hold {
  match: (request: Request) => boolean;
  /** Let the mailbox do it, but hold back the answer. */
  after?: boolean;
  gate: Promise<void>;
  held: () => void;
}

interface Win {
  name: 'A' | 'B';
  page: Page;
  ctx: BrowserContext;
  /** Console errors and uncaught exceptions of this window. */
  errors: string[];
  /** Every request to /sync fails, as with no network. */
  offline: boolean;
  /** The next pushes are answered with 413 (the account is full), by a stub: the real limit is 1 GiB. */
  full: boolean;
  /** Requests that wait until released (or, with `after`, whose answer does): the cycle that made them is stuck there meanwhile. */
  holds: Hold[];
  /** What the mailbox answered to pushes (status, and the request). */
  pushes: { status: number; request: string; response: string }[];
  /** Requests this window made to /sync. */
  requests: number;
  sockets: { url: string; frames: string[] }[];
}

interface World {
  a: Win;
  b: Win;
  accountId: string;
  key: string;
  /** Whether network errors in the logs are expected in this test. */
  networkErrors: boolean;
}

const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:1420', Vary: 'Origin' };

async function makeWindow(name: 'A' | 'B', page: Page, errors: string[], cloud: FakeCloud, user: ReturnType<FakeCloud['addUser']>, opts: { rows: Seed[]; live: boolean; key: string }): Promise<Win> {
  const ctx = page.context();
  const win: Win = { name, page, ctx, errors, offline: false, full: false, holds: [], pushes: [], requests: 0, sockets: [] };
  await cloud.attach(ctx);
  cloud.signIn(ctx, user);
  await ctx.addInitScript(
    ([rows, live, key, mailbox]) => {
      const w = window as unknown as Record<string, unknown>;
      w.__syncBeta = true;
      w.__syncUrl = mailbox;
      w.__syncRecoveryKey = key;
      if (!live) w.__syncNoLive = true;
      // The notes folder this computer starts with (and no sample database, which isn't synced).
      if (!localStorage.getItem('thoughtdesk.devmock.v2')) {
        localStorage.setItem('thoughtdesk.devmock.v2', JSON.stringify(rows));
        localStorage.setItem('thoughtdesk.devmock.databases.v1', JSON.stringify({ schemas: {}, rows: {} }));
      }
    },
    [opts.rows.map(seeded), opts.live, opts.key, MAILBOX] as const,
  );
  await ctx.route(`${MAILBOX}/sync/**`, async (route: Route) => {
    const request = route.request();
    win.requests++;
    if (win.offline) return route.abort('failed');
    if (request.method() === 'POST' && request.url().endsWith('/sync/push') && win.full)
      return route.fulfill({ status: 413, headers: CORS, contentType: 'application/json', body: JSON.stringify({ used: GB, limit: GB }) });
    const hold = win.holds.find((h) => h.match(request));
    if (hold) {
      win.holds.splice(win.holds.indexOf(hold), 1);
      hold.held();
      if (hold.after) {
        const answer = await route.fetch();
        await hold.gate;
        return route.fulfill({ response: answer });
      }
      await hold.gate;
    }
    return route.continue();
  });
  page.on('pageerror', (e) => name === 'B' && errors.push(`uncaught: ${e.stack ?? e}`));
  page.on('console', (m) => name === 'B' && m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('response', async (res) => {
    const req = res.request();
    if (req.method() === 'POST' && res.url().endsWith('/sync/push')) win.pushes.push({ status: res.status(), request: req.postData() ?? '', response: await res.text().catch(() => '') });
  });
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/sync/live')) return;
    const seen = { url: ws.url(), frames: [] as string[] };
    win.sockets.push(seen);
    ws.on('framereceived', (f) => seen.frames.push(String(f.payload)));
  });
  return win;
}

/** `make(rowsA, rowsB)`: two windows, each starting with its own notes folder, signed in as one account. */
const test = base.extend<{ make: (rowsA: Seed[], rowsB: Seed[], opts?: { live?: boolean }) => Promise<World> }>({
  make: async ({ page, browser, errors }, use) => {
    const worlds: World[] = [];
    await use(async (rowsA, rowsB, { live = false } = {}) => {
      const cloud = new FakeCloud();
      const user = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
      const key = randomKey();
      const bContext = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'en-US' });
      const bPage = await bContext.newPage();
      const bErrors: string[] = [];
      const a = await makeWindow('A', page, errors, cloud, user, { rows: rowsA, live, key });
      const b = await makeWindow('B', bPage, bErrors, cloud, user, { rows: rowsB, live, key });
      const world: World = { a, b, accountId: user.id, key, networkErrors: false };
      worlds.push(world);
      for (const win of [a, b]) {
        await open(win.page);
        const gotIt = win.page.getByRole('button', { name: 'Got It' });
        if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
      }
      return world;
    });
    for (const world of worlds) {
      // Where a test makes the network fail on purpose, the browser's own note of each failure is the only thing the log may hold.
      if (world.networkErrors) {
        const only = (list: string[]) => list.splice(0, list.length, ...list.filter((e) => !/Failed to load resource/.test(e)));
        only(errors);
        only(world.b.errors);
      }
      await world.b.ctx.close();
      if (world.b.errors.length) throw new Error(`errors in window B: ${JSON.stringify(world.b.errors)}`);
    }
  },
});

// ------------------------------------------------------------------- helpers

const settings = (p: Page) => p.locator('.modal');
const editor = (p: Page) => p.locator('.scroller .ProseMirror');

async function openAccount(p: Page) {
  if (!(await settings(p).isVisible().catch(() => false))) await p.keyboard.press(`${MOD}+Comma`);
  await p.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
}

async function closeSettings(p: Page) {
  if (await settings(p).isVisible().catch(() => false)) await settings(p).getByRole('button', { name: 'Close' }).click();
  await expect(settings(p)).toHaveCount(0);
}

/** First computer: Settings → Turn On Sync → the key → tick the box → Continue. Returns the key shown. */
async function turnOn(win: Win, { wait = true } = {}): Promise<string> {
  const p = win.page;
  await openAccount(p);
  await p.getByRole('button', { name: 'Turn On Sync' }).click();
  const shown = p.getByLabel('Recovery key', { exact: true });
  const key = (await shown.innerText()).trim();
  const go = p.getByRole('button', { name: 'Continue' });
  await expect(go, 'the key has to be saved first').toBeDisabled();
  await p.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
  await go.click();
  if (wait) {
    await expect(p.getByText('Up to date')).toBeVisible({ timeout: 30_000 });
    await closeSettings(p);
  }
  return key;
}

/** Another computer: Settings → Turn On Sync → the recovery key → Continue. */
async function join(win: Win, key: string, { wait = true } = {}) {
  const p = win.page;
  await openAccount(p);
  await p.getByRole('button', { name: 'Turn On Sync' }).click();
  await expect(p.getByText('Sync is already set up for this account. Enter the recovery key you saved then.')).toBeVisible();
  await p.getByRole('textbox', { name: 'Recovery key' }).fill(key.toLowerCase().replaceAll('-', ' '));
  await p.getByRole('button', { name: 'Continue' }).click();
  if (wait) {
    await expect(p.getByText('Up to date')).toBeVisible({ timeout: 30_000 });
    await closeSettings(p);
  }
}

/** A turns on, B joins, Settings closed on both. */
async function pair(w: World) {
  const key = await turnOn(w.a);
  expect(key).toBe(w.key);
  await join(w.b, key);
}

/**
 * Runs sync cycles and waits for them to be done: the engine's own "Sync Now", twice, each time until
 * `lastSynced` moves (a cycle already running when asked doesn't count as one that started after).
 */
async function round(win: Win) {
  await win.page.evaluate(async () => {
    const { loadEngine } = await import('/src/lib/sync/entry.svelte.ts');
    const { syncState } = await import('/src/lib/sync/state.svelte.ts');
    const { engine } = await loadEngine();
    for (let i = 0; i < 2; i++) {
      const before = syncState.lastSynced;
      const started = Date.now();
      engine.syncNow();
      while (syncState.lastSynced === before) {
        if (Date.now() - started > 25_000) throw new Error(`sync did not finish (status: ${syncState.status})`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
}

/** A, B, A: what one did has reached the other, and what came back is merged. */
async function settle(w: World, times = 1) {
  for (let i = 0; i < times; i++) {
    await round(w.a);
    await round(w.b);
    await round(w.a);
  }
}

const invoke = <T>(p: Page, cmd: string, args: object = {}) => p.evaluate(([cmd, args]) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>, [cmd, args] as const);

interface Stored {
  id: string;
  title: string;
  content: string;
  text: string;
  updatedAt: number;
  deletedAt: number | null;
  parentId: string | null;
}
const stored = (p: Page, id: string) => invoke<Stored>(p, 'get_page', { id });

const textOf = (n: any): string => (n.type === 'text' ? n.text : (n.content ?? []).map(textOf).join(''));
/** The text of each block of a stored body (empty ones left out). */
const blocksOf = (content: string): string[] => (content ? (JSON.parse(content).content ?? []).map(textOf).filter(Boolean) : []);
const storedBlocks = async (p: Page, id: string) => blocksOf((await stored(p, id)).content);

/** The blocks the open editor shows. */
const shown = (p: Page) =>
  p.evaluate(() => {
    const textOf = (n: any): string => (n.type === 'text' ? n.text : (n.content ?? []).map(textOf).join(''));
    return ((window as any).__editor.getJSON().content ?? []).map(textOf).filter(Boolean) as string[];
  });

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** Opens a page from the sidebar and waits for the editor to be the synced kind (bound to its document). */
async function openPage(win: Win, title: string) {
  const p = win.page;
  await p.locator('.sidebar').getByText(title, { exact: true }).click();
  await expect(editor(p)).toBeVisible();
  await expect.poll(() => p.evaluate(() => (window as any).__editor?.extensionManager.extensions.some((e: { name: string }) => e.name === 'collaboration')), LONG).toBe(true);
}

/** Puts the caret at the end of the block that holds `text`, and types. */
async function typeAfter(p: Page, text: string, typed: string, delay?: number) {
  await editor(p).locator('p', { hasText: text }).first().click();
  await p.keyboard.press('End');
  await p.keyboard.type(typed, delay ? { delay } : undefined);
}

/** What the mailbox says about the account, asked straight from the test. */
async function mailbox(w: World) {
  const res = await fetch(`${MAILBOX}/sync/info`, { headers: { Authorization: `Bearer test.${w.accountId}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as { seq: number; used: number; limit: number; wrappedKey: string | null };
}

/** Both sides' pages in the sidebar. */
const sidebar = (win: Win) => win.page.locator('.sidebar');

// =================================================================== the tests

test.describe('two computers, one account', () => {
  test('A turns on and sees a recovery key, B joins with it (a wrong one is refused), and A\'s pages arrive', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Bravo', paras: ['Bravo only.'] }]);

    await openAccount(w.a.page);
    await w.a.page.getByRole('button', { name: 'Turn On Sync' }).click();
    const key = w.a.page.getByLabel('Recovery key', { exact: true });
    await expect(key).toHaveText(w.key);
    await expect(w.a.page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await w.a.page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await w.a.page.getByRole('button', { name: 'Continue' }).click();
    await expect(w.a.page.getByText('Up to date')).toBeVisible({ timeout: 30_000 });
    await closeSettings(w.a.page);
    expect((await mailbox(w)).wrappedKey).not.toBeNull();

    // B: a wrong key says so and does not turn sync on; the right one does.
    await openAccount(w.b.page);
    await w.b.page.getByRole('button', { name: 'Turn On Sync' }).click();
    await w.b.page.getByRole('textbox', { name: 'Recovery key' }).fill('AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
    await w.b.page.getByRole('button', { name: 'Continue' }).click();
    await expect(w.b.page.getByRole('alert')).toHaveText("That recovery key doesn't open your synced notes. Check it and try again.");
    await expect(w.b.page.getByText('Up to date')).toHaveCount(0);
    await w.b.page.getByRole('textbox', { name: 'Recovery key' }).fill(w.key.toLowerCase());
    await w.b.page.getByRole('button', { name: 'Continue' }).click();
    await expect(w.b.page.getByText('Up to date')).toBeVisible({ timeout: 30_000 });
    await closeSettings(w.b.page);

    // A's page is in B, with its words; B's page reaches A once A looks.
    await expect(sidebar(w.b).getByText('Alpha', { exact: true })).toBeVisible(LONG);
    await openPage(w.b, 'Alpha');
    expect(await shown(w.b.page)).toEqual(TWO);
    expect(await storedBlocks(w.b.page, ALPHA)).toEqual(TWO);
    await round(w.a);
    await expect(sidebar(w.a).getByText('Bravo', { exact: true })).toBeVisible(LONG);
  });

  test('typing in A\'s open page appears in B\'s open page; B\'s caret and what B is typing survive', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');

    await typeAfter(w.a.page, 'Alpha one.', ' from A');
    await round(w.a);
    await round(w.b);
    await expect.poll(() => shown(w.b.page), LONG).toEqual(['Alpha one. from A', 'Alpha two.']);

    // B types in its second block, and has not synced yet; A types in the first and syncs; B syncs while its caret is there.
    await typeAfter(w.b.page, 'Alpha two.', ' B1');
    await typeAfter(w.a.page, 'Alpha one.', ' A2');
    await round(w.a);
    const caret = () => w.b.page.evaluate(() => {
      const { selection, doc } = (window as any).__editor.state;
      return { before: doc.textBetween(Math.max(0, selection.from - 3), selection.from), focused: (window as any).__editor.isFocused };
    });
    expect(await caret()).toEqual({ before: ' B1', focused: true });
    await round(w.b);
    await expect.poll(() => shown(w.b.page), LONG).toEqual(['Alpha one. from A A2', 'Alpha two. B1']);
    // The caret is where it was (after B1, in the second block), and B goes on typing from there.
    expect(await caret()).toEqual({ before: ' B1', focused: true });
    await w.b.page.keyboard.type(' B2');
    await settle(w);
    const want = ['Alpha one. from A A2', 'Alpha two. B1 B2'];
    expect(await shown(w.b.page)).toEqual(want);
    await expect.poll(() => shown(w.a.page), LONG).toEqual(want);
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(want);
    expect(await storedBlocks(w.b.page, ALPHA)).toEqual(want);
  });

  test('both typing at once: everyone\'s words are on both sides once, and B\'s undo undoes only B', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    // Both push the page's record at once now and then: the server answers one with 409, which the browser notes in its log.
    w.networkErrors = true;
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');
    await editor(w.a.page).locator('p', { hasText: 'Alpha one.' }).click();
    await w.a.page.keyboard.press('End');
    await editor(w.b.page).locator('p', { hasText: 'Alpha one.' }).click();
    await w.b.page.keyboard.press('End');

    // Both type into the same block while cycles run in between.
    let typing = 2;
    const rounds = (async () => {
      while (typing) {
        await round(w.a);
        await round(w.b);
      }
    })();
    await Promise.all([
      w.a.page.keyboard.type(' alpha-one alpha-two alpha-three', { delay: 40 }).finally(() => typing--),
      w.b.page.keyboard.type(' bravo-one bravo-two bravo-three', { delay: 40 }).finally(() => typing--),
    ]);
    await rounds;
    await settle(w, 2);

    for (const win of [w.a, w.b]) {
      const blocks = await shown(win.page);
      const all = blocks.join('\n');
      for (const word of ['alpha-one', 'alpha-two', 'alpha-three', 'bravo-one', 'bravo-two', 'bravo-three']) expect(count(all, word), `${word} in ${win.name}`).toBe(1);
      expect(blocks.at(-1)).toBe('Alpha two.');
    }
    expect(await shown(w.a.page)).toEqual(await shown(w.b.page));
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(await storedBlocks(w.b.page, ALPHA));

    // B's undo takes back B's words and nothing of A's.
    await editor(w.b.page).locator('p', { hasText: 'Alpha one.' }).click();
    for (let i = 0; i < 6; i++) await w.b.page.keyboard.press(`${MOD}+z`);
    await expect.poll(async () => (await shown(w.b.page)).join('\n'), LONG).not.toContain('bravo');
    const afterUndo = (await shown(w.b.page)).join('\n');
    for (const word of ['alpha-one', 'alpha-two', 'alpha-three']) expect(count(afterUndo, word)).toBe(1);
    expect(afterUndo).toContain('Alpha two.');
    await settle(w);
    const onA = (await shown(w.a.page)).join('\n');
    expect(onA).not.toContain('bravo');
    for (const word of ['alpha-one', 'alpha-two', 'alpha-three']) expect(count(onA, word)).toBe(1);
  });

  test('both offline, both edit the same page in different blocks: back online, both edits are on both, nothing doubled', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    w.networkErrors = true;
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');

    w.a.offline = w.b.offline = true;
    await typeAfter(w.a.page, 'Alpha one.', ' edited offline on A');
    await typeAfter(w.b.page, 'Alpha two.', ' edited offline on B');
    // A cycle meets the failure and says so, without a toast.
    for (const win of [w.a, w.b]) {
      await win.page.evaluate(async () => (await (await import('/src/lib/sync/entry.svelte.ts')).loadEngine()).engine.syncNow());
      await expect.poll(() => win.page.evaluate(async () => (await import('/src/lib/sync/state.svelte.ts')).syncState.status), LONG).toBe('offline');
      await expect(win.page.locator('.toast')).toHaveCount(0);
    }
    // Nothing reached the other side meanwhile, and nothing is lost here.
    expect(await shown(w.a.page)).toEqual(['Alpha one. edited offline on A', 'Alpha two.']);
    expect(await shown(w.b.page)).toEqual(['Alpha one.', 'Alpha two. edited offline on B']);

    w.a.offline = w.b.offline = false;
    await settle(w, 2);
    const want = ['Alpha one. edited offline on A', 'Alpha two. edited offline on B'];
    expect(await shown(w.a.page)).toEqual(want);
    expect(await shown(w.b.page)).toEqual(want);
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(want);
    expect(await storedBlocks(w.b.page, ALPHA)).toEqual(want);
  });
});

const SENTENCES = ['Shared sentence.', 'Another line.'];

test.describe('the doubled-text trap', () => {
  const shared: Seed = { id: SHARED, title: 'Shared', paras: SENTENCES };

  test('(a) the same page, same body, on both sides before either syncs: A first, then B joins', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([shared], [shared]);
    await pair(w);
    await settle(w, 2);
    expect(await storedBlocks(w.a.page, SHARED)).toEqual(SENTENCES);
    expect(await storedBlocks(w.b.page, SHARED)).toEqual(SENTENCES);
    // Seen in the editors too, and still right after the edit is typed on top.
    await openPage(w.a, 'Shared');
    await openPage(w.b, 'Shared');
    expect(await shown(w.a.page)).toEqual(SENTENCES);
    expect(await shown(w.b.page)).toEqual(SENTENCES);
    await typeAfter(w.b.page, 'Another line.', ' More.');
    await settle(w);
    await expect.poll(() => shown(w.a.page), LONG).toEqual(['Shared sentence.', 'Another line. More.']);
    expect(await storedBlocks(w.b.page, SHARED)).toEqual(['Shared sentence.', 'Another line. More.']);
  });

  test('(b) the same, while B has the page open in an editor when it joins', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([shared], [shared]);
    const key = await turnOn(w.a);
    await round(w.a);
    // B opens it before sync is on: a plain editor, which the engine leaves alone until it can be bound.
    await sidebar(w.b).getByText('Shared', { exact: true }).click();
    await expect(editor(w.b.page)).toBeVisible();
    expect(await shown(w.b.page)).toEqual(SENTENCES);
    await join(w.b, key);
    // The editor was rebuilt on the synced document.
    await expect.poll(() => w.b.page.evaluate(() => (window as any).__editor?.extensionManager.extensions.some((e: { name: string }) => e.name === 'collaboration')), LONG).toBe(true);
    await settle(w, 2);
    await expect.poll(() => shown(w.b.page), LONG).toEqual(SENTENCES);
    expect(await storedBlocks(w.b.page, SHARED)).toEqual(SENTENCES);
    expect(await storedBlocks(w.a.page, SHARED)).toEqual(SENTENCES);
    // And typing there still goes to A.
    await typeAfter(w.b.page, 'Shared sentence.', ' Typed.');
    await settle(w);
    await expect.poll(() => storedBlocks(w.a.page, SHARED), LONG).toEqual(['Shared sentence. Typed.', 'Another line.']);
  });

  test('(c) both push the page\'s first text at once: the server refuses one (409) and it adopts the other\'s', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([shared], [shared]);
    // Both wait with their first text push until the other has one too.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held: string[] = [];
    const firstText = (r: Request) => r.method() === 'POST' && r.url().endsWith('/sync/push') && /"kind":"y"[^}]*"first":true|"first":true[^}]*"kind":"y"/.test(r.postData() ?? '');
    for (const win of [w.a, w.b]) win.holds.push({ match: firstText, gate, held: () => held.push(win.name) });

    await turnOn(w.a, { wait: false });
    await expect.poll(() => held, LONG).toEqual(['A']);
    await join(w.b, w.key, { wait: false });
    await expect.poll(() => held.length, LONG).toBe(2);
    release();

    for (const win of [w.a, w.b]) {
      await expect(win.page.getByText('Up to date')).toBeVisible({ timeout: 40_000 });
      await closeSettings(win.page);
    }
    // One of them was really refused by the server.
    const refused = [...w.a.pushes, ...w.b.pushes].filter((p) => p.status === 409 && p.request.includes('"first":true'));
    expect(refused.length, 'a first push the server refused').toBeGreaterThan(0);
    w.networkErrors = true;
    await settle(w, 2);
    expect(await storedBlocks(w.a.page, SHARED)).toEqual(SENTENCES);
    expect(await storedBlocks(w.b.page, SHARED)).toEqual(SENTENCES);
    await openPage(w.a, 'Shared');
    await openPage(w.b, 'Shared');
    expect(await shown(w.a.page)).toEqual(SENTENCES);
    expect(await shown(w.b.page)).toEqual(SENTENCES);
  });
});

test.describe('what crosses', () => {
  test('a page closed on B receives A\'s edit: its body and search text update, and updated_at is only what the record says', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await settle(w);
    await openPage(w.a, 'Alpha');
    // B is not on the page: it shows something else.
    await sidebar(w.b).getByText('Alpha', { exact: true }).waitFor();
    const before = await stored(w.b.page, ALPHA);

    await typeAfter(w.a.page, 'Alpha two.', ' written on A');
    await expect.poll(async () => (await stored(w.a.page, ALPHA)).content, LONG).toContain('written on A');
    await settle(w);
    await expect.poll(async () => (await stored(w.b.page, ALPHA)).content, LONG).toContain('written on A');
    const onA = await stored(w.a.page, ALPHA);
    const onB = await stored(w.b.page, ALPHA);
    expect(blocksOf(onB.content)).toEqual(['Alpha one.', 'Alpha two. written on A']);
    expect(onB.text).toContain('written on A');
    // The time is the one A's record carries, not a new one made by writing the body.
    expect(onB.updatedAt).toBe(onA.updatedAt);
    expect(onA.updatedAt).toBeGreaterThan(before.updatedAt);
    // It stays like that: more rounds neither change it nor send it back.
    const seq = (await mailbox(w)).seq;
    await settle(w);
    expect((await stored(w.b.page, ALPHA)).updatedAt).toBe(onA.updatedAt);
    expect((await mailbox(w)).seq).toBe(seq);
  });

  test('a change from elsewhere does not echo: the mailbox\'s seq stops moving once everything has settled', async ({ make }) => {
    test.setTimeout(150_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }, { id: SHARED, title: 'Shared', paras: SENTENCES }], [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Bravo', paras: ['Bravo only.'] }]);
    await pair(w);
    await settle(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');
    await typeAfter(w.a.page, 'Alpha one.', ' A edit');
    await typeAfter(w.b.page, 'Alpha two.', ' B edit');
    // A page open on one side only, a page that is closed on both, a rename and a trashed page.
    await invoke(w.b.page, 'update_page', { id: SHARED, patch: { title: 'Shared, renamed' } });
    await invoke(w.a.page, 'trash_page', { id: 'bbbbbbbb-0000-4000-8000-000000000001' });

    // Settled: the number stops moving between rounds.
    let last = -1;
    for (let i = 0; i < 8; i++) {
      await settle(w);
      const now = (await mailbox(w)).seq;
      if (now === last) break;
      last = now;
    }
    const settled = (await mailbox(w)).seq;
    expect(settled).toBeGreaterThan(0);
    await round(w.a);
    await round(w.b);
    await round(w.a);
    await round(w.b);
    expect((await mailbox(w)).seq, 'two more Sync Nows on each, and the mailbox did not move').toBe(settled);
    expect(await shown(w.a.page)).toEqual(['Alpha one. A edit', 'Alpha two. B edit']);
    expect(await shown(w.b.page)).toEqual(['Alpha one. A edit', 'Alpha two. B edit']);
    expect((await stored(w.a.page, SHARED)).title).toBe('Shared, renamed');
    expect((await stored(w.b.page, 'bbbbbbbb-0000-4000-8000-000000000001')).deletedAt).not.toBeNull();
  });

  test('a title renamed on A appears in B\'s sidebar and open page', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');
    await expect(sidebar(w.b).getByText('Alpha', { exact: true })).toBeVisible(LONG);

    const title = w.a.page.locator('.scroller h1.title');
    await title.click();
    await w.a.page.keyboard.press(`${MOD}+a`);
    await w.a.page.keyboard.type('Renamed on A');
    await w.a.page.keyboard.press('Enter');
    await expect.poll(async () => (await stored(w.a.page, ALPHA)).title, LONG).toBe('Renamed on A');
    await settle(w);
    await expect(sidebar(w.b).getByText('Renamed on A', { exact: true })).toBeVisible(LONG);
    await expect(w.b.page.locator('.scroller h1.title')).toHaveText('Renamed on A', LONG);
    await expect(sidebar(w.b).getByText('Alpha', { exact: true })).toHaveCount(0);
    // The words of the open page were not disturbed.
    expect(await shown(w.b.page)).toEqual(TWO);
  });

  test('a page bigger than 64 KB goes up as a blob (local R2) and arrives, and the meter shows the server\'s used', async ({ make }) => {
    test.setTimeout(150_000);
    const long = Array.from({ length: 260 }, (_, i) => `Paragraph ${i + 1}: ` + 'lorem ipsum dolor sit amet '.repeat(12).trim());
    const w = await make([{ id: BIG, title: 'Big page', paras: long }], []);
    const blobs: string[] = [];
    w.a.page.on('request', (r) => r.method() === 'PUT' && r.url().includes('/sync/blob/') && blobs.push(r.url()));
    const pulledBlob: string[] = [];
    w.b.page.on('response', async (r) => r.url().includes('/sync/pull') && pulledBlob.push(await r.text().catch(() => '')));
    await pair(w);
    await settle(w);

    expect(blobs.length, 'the big update went to R2 first').toBeGreaterThan(0);
    expect(w.a.pushes.some((p) => p.request.includes('"blob":"') && p.request.includes('"size":'))).toBe(true);
    expect(pulledBlob.some((t) => t.includes('"blob":"'))).toBe(true);
    const arrived = await storedBlocks(w.b.page, BIG);
    expect(arrived).toEqual(long);
    expect((await stored(w.b.page, BIG)).text).toContain('Paragraph 260');

    // The meter in Settings shows what the server counts.
    const info = await mailbox(w);
    expect(info.used).toBeGreaterThan(64 * 1024);
    for (const win of [w.a, w.b]) {
      await openAccount(win.page);
      const bar = win.page.getByRole('progressbar', { name: 'Sync storage' });
      await expect(bar).toBeVisible();
      await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow')), LONG).toBe(info.used);
      await expect(win.page.getByRole('group', { name: 'Sync storage' })).toContainText('of 1 GB used');
      await closeSettings(win.page);
    }
  });

  test('a full account: the status says so, nothing is lost here, and it catches up when there is room', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    w.networkErrors = true;
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');

    // The real limit is 1 GiB: the one answer is stubbed for this window, so the others run on the real server.
    w.a.full = true;
    await typeAfter(w.a.page, 'Alpha one.', ' typed while full');
    await expect.poll(async () => (await stored(w.a.page, ALPHA)).content, LONG).toContain('typed while full');
    await w.a.page.evaluate(async () => (await (await import('/src/lib/sync/entry.svelte.ts')).loadEngine()).engine.syncNow());
    await expect.poll(() => w.a.page.evaluate(async () => (await import('/src/lib/sync/state.svelte.ts')).syncState.status), LONG).toBe('full');
    await openAccount(w.a.page);
    await expect(w.a.page.getByText('Sync storage is full', { exact: true })).toBeVisible();
    await closeSettings(w.a.page);
    await expect(w.a.page.locator('.toast')).toHaveCount(0);
    expect(w.a.pushes.some((p) => p.status === 413)).toBe(true);
    // Nothing lost: it's in the editor and in the stored body, and B has not seen it.
    expect(await shown(w.a.page)).toEqual(['Alpha one. typed while full', 'Alpha two.']);
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(['Alpha one. typed while full', 'Alpha two.']);
    await round(w.b);
    expect(await shown(w.b.page)).toEqual(TWO);

    // There is room again.
    w.a.full = false;
    await settle(w);
    await expect.poll(() => w.a.page.evaluate(async () => (await import('/src/lib/sync/state.svelte.ts')).syncState.status), LONG).toBe('idle');
    await expect.poll(() => shown(w.b.page), LONG).toEqual(['Alpha one. typed while full', 'Alpha two.']);
    expect(await storedBlocks(w.b.page, ALPHA)).toEqual(['Alpha one. typed while full', 'Alpha two.']);
  });
});

test.describe('turning off and deleting', () => {
  test('a key someone else set on an empty copy: A starts a new copy instead, and loses nothing', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    // A sign-in that leaked sets a key and a proof nobody here has.
    const proof = Buffer.from(new Uint8Array(32).fill(9)).toString('base64url');
    const planted = await fetch(`${MAILBOX}/sync/key`, {
      method: 'PUT',
      headers: { Authorization: `Bearer test.${w.accountId}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrappedKey: 'planted', proof }),
    });
    expect(planted.status).toBe(204);

    const p = w.a.page;
    await openAccount(p);
    await p.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(p.getByText('Enter your recovery key')).toBeVisible();
    await p.getByRole('button', { name: 'Start a New Copy' }).click();
    await p.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await p.getByRole('button', { name: 'Continue' }).click();
    await expect(p.getByText('Up to date')).toBeVisible({ timeout: 30_000 });
    const now = await mailbox(w);
    expect(now.wrappedKey).not.toBe('planted');
    expect(now.seq, "A's notes went up to the new copy").toBeGreaterThan(0);
    expect(await storedBlocks(p, ALPHA)).toEqual(TWO);
  });

  test('turn off on B: B stops, A goes on', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');

    await openAccount(w.b.page);
    await settings(w.b.page).getByRole('button', { name: 'Turn Off Sync' }).click();
    await w.b.page.getByRole('alertdialog').getByRole('button', { name: 'Turn Off Sync' }).click();
    await expect(w.b.page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    await closeSettings(w.b.page);
    const asked = w.b.requests;
    const seq = (await mailbox(w)).seq;

    await typeAfter(w.a.page, 'Alpha one.', ' A goes on');
    await expect.poll(async () => (await stored(w.a.page, ALPHA)).content, LONG).toContain('A goes on');
    await round(w.a);
    expect((await mailbox(w)).seq, 'A is still pushing').toBeGreaterThan(seq);
    await expect.poll(() => storedBlocks(w.a.page, ALPHA)).toEqual(['Alpha one. A goes on', 'Alpha two.']);
    // B did not ask the mailbox for anything, and has not changed. (Its editor is the plain one again.)
    expect(w.b.requests).toBe(asked);
    expect(await storedBlocks(w.b.page, ALPHA)).toEqual(TWO);
    await typeAfter(w.b.page, 'Alpha two.', ' only on B');
    await expect.poll(async () => (await stored(w.b.page, ALPHA)).content, LONG).toContain('only on B');
    await round(w.a);
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(['Alpha one. A goes on', 'Alpha two.']);
    expect(w.b.requests).toBe(asked);
  });

  test('Delete Synced Copy on A: B stops and says so instead of pushing with the old key', async ({ make }) => {
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await openAccount(w.a.page);
    await settings(w.a.page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await w.a.page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect.poll(async () => (await mailbox(w)).wrappedKey, LONG).toBeNull();
    const before = (await mailbox(w)).seq;

    await invoke(w.b.page, 'update_page', { id: ALPHA, patch: { title: 'Edited after the delete' } });
    await w.b.page.evaluate(async () => (await import('/src/lib/sync/engine.svelte.ts')).engine.syncNow());
    await openAccount(w.b.page);
    await expect(settings(w.b.page)).toContainText('The synced copy was deleted', LONG);
    expect((await mailbox(w)).seq, 'nothing went up with the old key').toBe(before);
    expect((await stored(w.b.page, ALPHA)).title, 'the notes here are untouched').toBe('Edited after the delete');
  });

  test('Delete Synced Copy on A: the mailbox has nothing left, and the notes stay', async ({ make }) => {
    test.setTimeout(120_000);
    const long = Array.from({ length: 260 }, (_, i) => `Paragraph ${i + 1}: ` + 'lorem ipsum dolor sit amet '.repeat(12).trim());
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }, { id: BIG, title: 'Big page', paras: long }], []);
    await pair(w);
    await settle(w);
    const before = await mailbox(w);
    expect(before.seq).toBeGreaterThan(0);
    expect(before.used).toBeGreaterThan(64 * 1024);

    await openAccount(w.a.page);
    await settings(w.a.page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await w.a.page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect(w.a.page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    await closeSettings(w.a.page);
    await expect.poll(() => mailbox(w), LONG).toMatchObject({ seq: 0, used: 0, wrappedKey: null });
    // Nothing comes back later from a cycle that was in flight.
    await w.a.page.waitForTimeout(1500);
    expect(await mailbox(w)).toMatchObject({ seq: 0, used: 0, wrappedKey: null });
    expect(await storedBlocks(w.a.page, ALPHA)).toEqual(TWO);
    expect(await storedBlocks(w.a.page, BIG)).toEqual(long);
  });
});

test.describe('deleting while a cycle runs', () => {
  test('Delete Synced Copy while a cycle is in the middle of pulling: it does not push anything after the delete', async ({ make }) => {
    test.setTimeout(120_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await settle(w);
    await openPage(w.a, 'Alpha');

    // A cycle with something to send stops at its pull; the server deletes while it waits, and its answer is held back.
    let letPull!: () => void;
    const pullGate = new Promise<void>((resolve) => (letPull = resolve));
    let pulling = false;
    w.a.holds.push({ match: (r) => r.method() === 'GET' && r.url().includes('/sync/pull'), gate: pullGate, held: () => (pulling = true) });
    let letDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => (letDelete = resolve));
    let deleting = false;
    w.a.holds.push({ match: (r) => r.method() === 'DELETE' && r.url().endsWith('/sync/account'), after: true, gate: deleteGate, held: () => (deleting = true) });

    // B has sent something A has not pulled yet, so A's cycle has a pull to make.
    await openPage(w.b, 'Alpha');
    await typeAfter(w.b.page, 'Alpha two.', ' from B');
    await round(w.b);
    // A has a page nobody has seen yet, which the mailbox would take as new.
    await invoke(w.a.page, 'create_page', { parentId: null, title: 'Made just now' });
    await w.a.page.evaluate(async () => (await (await import('/src/lib/sync/entry.svelte.ts')).loadEngine()).engine.syncNow());
    await expect.poll(() => pulling, LONG).toBe(true);
    await openAccount(w.a.page);
    await settings(w.a.page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await w.a.page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect.poll(() => deleting, LONG).toBe(true);
    await expect.poll(() => mailbox(w), LONG).toMatchObject({ seq: 0, used: 0, wrappedKey: null });
    // The cycle goes on while the delete's answer is still on its way.
    letPull();
    await w.a.page.waitForTimeout(1500);
    letDelete();
    await expect(w.a.page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible(LONG);
    expect(await mailbox(w), 'nothing was pushed after the delete').toMatchObject({ seq: 0, used: 0, wrappedKey: null });
    w.networkErrors = true;
  });
});

test.describe('by itself', () => {
  test('without Sync Now: the live socket tells B, and the timers send A\'s typing', async ({ make }) => {
    test.setTimeout(180_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], [], { live: true });
    await pair(w);
    await openPage(w.a, 'Alpha');
    await openPage(w.b, 'Alpha');
    await expect.poll(() => w.b.sockets.length, LONG).toBeGreaterThan(0);

    const pushed: number[] = [];
    w.a.page.on('response', (r) => r.request().method() === 'POST' && r.url().endsWith('/sync/push') && r.status() === 200 && r.request().postData()?.includes('"kind":"y"') && pushed.push(Date.now()));
    await typeAfter(w.a.page, 'Alpha one.', ' by itself');
    // A's cycle starts a few seconds after the save, at most every 30 s; then the socket tells B.
    await expect.poll(() => shown(w.b.page), { timeout: 70_000 }).toEqual(['Alpha one. by itself', 'Alpha two.']);
    const arrived = Date.now();
    expect(pushed.length, 'A sent it by its own timers').toBeGreaterThan(0);
    expect(arrived - pushed[0], 'B had it within seconds of the push, not a minute (its own timer)').toBeLessThan(15_000);
    expect(w.b.sockets.some((s) => s.frames.some((f) => /"seq":\d+/.test(f))), 'B was told over the socket').toBe(true);
  });
});

test.describe('a replaced copy', () => {
  test('Delete Synced Copy from the computer that lost its copy is refused, and the new copy survives', async ({ make }) => {
    test.setTimeout(150_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await settle(w);

    // A deletes the copy and starts another with a new key.
    await openAccount(w.a.page);
    await settings(w.a.page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await w.a.page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect(w.a.page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible(LONG);
    await closeSettings(w.a.page);
    const newKey = randomKey();
    await w.a.page.evaluate((k) => ((window as any).__syncRecoveryKey = k), newKey);
    expect(await turnOn(w.a)).toBe(newKey);
    const fresh = await mailbox(w);
    expect(fresh.wrappedKey).not.toBeNull();

    // B finds out, and is not offered Delete; asked anyway, the app refuses.
    await w.b.page.evaluate(async () => (await import('/src/lib/sync/engine.svelte.ts')).engine.syncNow());
    await openAccount(w.b.page);
    await expect(settings(w.b.page)).toContainText('The synced copy was deleted', LONG);
    await expect(settings(w.b.page).getByRole('button', { name: 'Delete Synced Copy' })).toHaveCount(0);
    const refused = await w.b.page.evaluate(async () => {
      const { engine } = await import('/src/lib/sync/engine.svelte.ts');
      try {
        await engine.deleteSyncedCopy();
        return 'deleted';
      } catch (e) {
        return (e as Error).constructor.name;
      }
    });
    expect(refused).toBe('CopyGone');
    expect((await mailbox(w)).wrappedKey, 'the new copy is there').toBe(fresh.wrappedKey);

    // And the mailbox itself would refuse B's proof, were the app bypassed.
    const proof = await invoke<string>(w.b.page, 'sync_vault_proof');
    const res = await fetch(`${MAILBOX}/sync/account`, { method: 'DELETE', headers: { Authorization: `Bearer test.${w.accountId}`, 'X-Vault-Proof': proof } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ proof: false });
    expect((await mailbox(w)).wrappedKey).toBe(fresh.wrappedKey);
    w.networkErrors = true;
  });
});

test.describe('turning off and on again', () => {
  test('B turns off, edits, turns on again with the recovery key: the same copy, and the edit made while off arrives', async ({ make }) => {
    test.setTimeout(150_000);
    const w = await make([{ id: ALPHA, title: 'Alpha', paras: TWO }], []);
    await pair(w);
    await settle(w);
    const before = await mailbox(w);

    await openAccount(w.b.page);
    await settings(w.b.page).getByRole('button', { name: 'Turn Off Sync' }).click();
    await w.b.page.getByRole('alertdialog').getByRole('button', { name: 'Turn Off Sync' }).click();
    await expect(w.b.page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    await closeSettings(w.b.page);
    const calls = () => w.b.page.evaluate(() => (window as any).__syncMock.calls as string[]);
    const off = await calls();
    expect(off.indexOf('sync_vault_forget'), 'the key is forgotten here').toBeGreaterThan(off.lastIndexOf('sync_turn_off') - 1);

    await invoke(w.b.page, 'update_page', { id: ALPHA, patch: { title: 'Renamed on B while off' } });
    // The recovery key opens the same copy (no new vault is made), then the audit, then the first cycle.
    await join(w.b, w.key);
    const on = await calls();
    expect(on.filter((c) => c === 'sync_vault_create')).toHaveLength(0);
    expect(on.lastIndexOf('sync_audit')).toBeGreaterThan(on.lastIndexOf('sync_turn_on'));
    expect((await mailbox(w)).wrappedKey).toBe(before.wrappedKey);

    await settle(w);
    await expect(sidebar(w.a).getByText('Renamed on B while off', { exact: true })).toBeVisible(LONG);
    expect((await stored(w.a.page, ALPHA)).title).toBe('Renamed on B while off');
  });
});
