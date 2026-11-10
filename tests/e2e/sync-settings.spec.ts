// Turning sync on and off in Settings → Account, how it reports itself, and the
// editor on a synced page. The mailbox is a small fake answering at the app's own
// address (no cross-origin errors), and the Rust side is the in-browser stand-in
// (src/dev-mock.ts), which has nothing to merge until a test gives it something.
import type { Page, Route } from '@playwright/test';
import { test, expect, open, MOD } from './fixtures';
import { FakeCloud } from './fake-cloud';

const GB = 1024 ** 3;
/** What the stand-in's recovery key is, as the stand-in wraps it. */
const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567';
const WRAPPED = 'wrapped.ABCDEFGHJKMNPQRSTVWXYZ01234567';

interface Box {
  wrappedKey: string | null;
  /** The proof stored with the key (null: not asked, any is accepted). */
  proof: string | null;
  seq: number;
  used: number;
  format: number;
  /** How far the server's clock is from this one. */
  skewMs: number;
  offline: boolean;
  /** Answer pushes with this status (once each, in order). */
  pushStatus: number[];
  /** The seq a 409 names for each key (default: the next one, which this computer has not seen). */
  conflictSeq: number | null;
  pushes: { items: { key: string; kind: string; base?: number }[] }[];
  deleted: boolean;
  /** The mailbox goes away once the key is stored. */
  dropAfterKey: boolean;
  /** Answer every request with 401 (the sign-in was refused). */
  unauthorized: boolean;
  /** What pull answers, in place of nothing. */
  pull: ((after: number) => unknown) | null;
  /** Requests that reached the mailbox, by kind. */
  infoCalls: number;
  /** Every request that reached it. */
  requests: number;
  blobs: string[];
  blobGets: string[];
  /** Blob names already stored: a PUT to one is 409 (names are written once). */
  existing: Set<string>;
  /** A GET of an existing name is 404 (the name is held, the bytes are not there). */
  missing: boolean;
  /** The X-Vault-Proof header of each push, blob and account call. */
  proofs: (string | null)[];
  /** The body of PUT /key. */
  keyBody: { wrappedKey: string; proof: string } | null;
  /** Pushes and blob PUTs wait for this before they are answered (the request has arrived). */
  hold: Promise<void> | null;
  arrived: string[];
  /** Calls that arrived after the account was deleted (other than the delete itself). */
  late: string[];
}

const newBox = (over: Partial<Box> = {}): Box => ({
  wrappedKey: null,
  proof: null,
  seq: 0,
  used: 0,
  format: 1,
  skewMs: 0,
  offline: false,
  pushStatus: [],
  conflictSeq: null,
  pushes: [],
  deleted: false,
  dropAfterKey: false,
  unauthorized: false,
  pull: null,
  infoCalls: 0,
  requests: 0,
  blobs: [],
  blobGets: [],
  existing: new Set(),
  missing: false,
  proofs: [],
  keyBody: null,
  hold: null,
  arrived: [],
  late: [],
  ...over,
});

/** The sync mailbox, answering at /__mail/sync/*. It enforces the vault proof the way the relay does. */
async function mailbox(page: Page, box: Box) {
  const answer = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/__mail/sync', '');
    box.requests++;
    if (box.offline) return route.abort('failed');
    const headers = { Date: new Date(Date.now() + box.skewMs).toUTCString() };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (box.deleted && !(request.method() === 'DELETE' && path === '/account')) box.late.push(`${request.method()} ${path}`);
    if (box.unauthorized) return json({ error: 'unauthorized' }, 401);
    if (path === '/info') {
      box.infoCalls++;
      return json({ seq: box.seq, used: box.used, limit: GB, wrappedKey: box.wrappedKey, format: box.format });
    }
    if (path === '/key') {
      if (box.wrappedKey) return route.fulfill({ status: 409, headers });
      box.keyBody = request.postDataJSON() as { wrappedKey: string; proof: string };
      box.wrappedKey = box.keyBody.wrappedKey;
      box.proof = box.keyBody.proof;
      if (box.dropAfterKey) box.offline = true;
      return route.fulfill({ status: 204, headers });
    }
    if (path === '/pull') {
      const after = Number(new URL(request.url()).searchParams.get('after'));
      return json(box.pull ? box.pull(after) : { items: [], seq: box.seq, more: false });
    }
    if (path.startsWith('/blob/') && request.method() === 'GET') {
      box.blobGets.push(path.slice(6));
      if (box.missing && box.existing.has(path.slice(6))) return route.fulfill({ status: 404, headers });
      return route.fulfill({ status: 200, headers, body: Buffer.alloc(box.existing.has(path.slice(6)) ? 4 : 9 * 1024 * 1024, 1) });
    }
    // Everything that changes or deletes needs the vault, and its proof.
    const proof = request.headers()['x-vault-proof'] ?? null;
    const refuse = () => {
      if (!box.wrappedKey) return json({ noVault: true }, 409);
      if (box.proof && proof !== box.proof) return json({ proof: false }, 403);
      return null;
    };
    if (path === '/push') {
      box.proofs.push(proof);
      box.arrived.push('push');
      if (box.hold) await box.hold;
      const refused = refuse();
      if (refused) return refused;
      const body = request.postDataJSON() as Box['pushes'][number];
      box.pushes.push(body);
      const status = box.pushStatus.shift();
      if (status === 409) return json({ conflicts: body.items.map((i) => ({ key: i.key, seq: box.conflictSeq ?? box.seq + 1 })) }, 409);
      if (status === 413) {
        box.used = GB;
        return json({ used: GB, limit: GB }, 413);
      }
      return json({ seq: ++box.seq, results: body.items.map((i) => ({ key: i.key, seq: box.seq })), used: box.used, limit: GB });
    }
    if (path.startsWith('/blob/')) {
      box.proofs.push(proof);
      box.arrived.push(`${request.method()} blob`);
      if (box.hold) await box.hold;
      const refused = refuse();
      if (refused) return refused;
      if (request.method() === 'PUT' && box.existing.has(path.slice(6))) return route.fulfill({ status: 409, headers });
      if (request.method() === 'PUT') box.blobs.push(path.slice(6));
      return request.method() === 'PUT' ? json({ used: box.used, limit: GB }) : route.fulfill({ status: 204, headers });
    }
    if (path === '/account') {
      box.proofs.push(proof);
      const refused = refuse();
      if (refused) return refused;
      box.deleted = true;
      box.wrappedKey = null;
      return route.fulfill({ status: 204, headers });
    }
    return route.fulfill({ status: 404, headers });
  };
  // A request the page gave up on (cancelled) can't be answered; that is not the test's business.
  await page.route('**/__mail/sync/**', (route) => answer(route).catch(() => {}));
}

/** The flag, a test mailbox, and Ana signed in. With `on`, this computer already has sync on and ready. */
async function setup(page: Page, box = newBox(), { on = false, flag = true, live = false, backup = false, wrapped }: { on?: boolean; flag?: boolean; live?: boolean; backup?: boolean; wrapped?: string | null } = {}) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const cloud = new FakeCloud();
  const user = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  cloud.signIn(page.context(), user);
  await mailbox(page, box);
  await page.addInitScript(
    ([flag, on, id, live, backup, wrapped]) => {
      const w = window as unknown as Record<string, unknown>;
      if (flag) w.__syncBeta = true;
      w.__syncUrl = location.origin + '/__mail';
      if (!live) w.__syncNoLive = true;
      const KEY = 'thoughtdesk.devmock.sync';
      if (on && !localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, JSON.stringify({ enabled: true, account: id, ready: true, cursor: 0, wrappedKey: wrapped, unreadable: 0, backup }));
        localStorage.setItem(KEY + '.open', JSON.stringify([id]));
      }
    },
    [flag, on, user.id, live, backup, wrapped === undefined ? box.wrappedKey : wrapped] as const,
  );
  return { box, user, cloud };
}

/** Opens the app and closes the one-time pop-up about the free storage: it covers the window while it shows. */
async function start(page: Page) {
  await open(page);
  const seen = await page.evaluate(async () => {
    const { prefs } = await import('/src/lib/prefs.svelte.ts');
    return Object.keys(prefs.syncWelcomed).length > 0;
  });
  // It arrives a moment after the app does, so it is waited for.
  if (!seen) await page.getByRole('button', { name: 'Got It' }).click();
}

async function openAccount(page: Page) {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
}

/** Waits until the engine says sync is ready (editors bind to documents from then on). */
async function whenReady(page: Page) {
  await page.evaluate(async () => {
    const { syncState } = await import('/src/lib/sync/state.svelte.ts');
    while (!syncState.ready) await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const mock = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __syncMock: { calls: string[]; args: Record<string, unknown>[]; commits: Record<string, unknown>[] } }).__syncMock;
    return { calls: m.calls, args: m.args, commits: m.commits };
  });

const settings = (page: Page) => page.locator('.modal');

test.describe('turning sync on and off', () => {
  test('off: one line about it and Turn On Sync; with the flag off, nothing', async ({ page }) => {
    await setup(page);
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Keep your notes on all your computers, encrypted so only you can read them.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync Now' })).toHaveCount(0);
  });

  test('the flag off hides it all and loads nothing', async ({ page }) => {
    await setup(page, newBox(), { flag: false });
    await open(page);
    await openAccount(page);
    await expect(page.getByRole('button', { name: 'Edit Profile…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toHaveCount(0);
    const asked = await page.evaluate(() => (window as unknown as { __syncMock: { calls: string[] } }).__syncMock.calls);
    expect(asked).toEqual([]);
  });

  test('the first computer: the key is shown once, must be saved, then it sets up', async ({ page }) => {
    const { box } = await setup(page);
    await start(page);
    await page.evaluate(() => {
      const w = window as unknown as { __ready: number };
      w.__ready = 0;
      window.addEventListener('td:sync-ready', () => w.__ready++);
    });
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();

    const key = page.getByLabel('Recovery key', { exact: true });
    await expect(key).toHaveText(KEY);
    await expect(page.getByText("If you lose this key and all your computers, the synced copy can't be opened. Your notes on your computers are fine.")).toBeVisible();
    // Nothing has reached the mailbox yet.
    expect(box.wrappedKey).toBeNull();
    const go = page.getByRole('button', { name: 'Continue' });
    await expect(go).toBeDisabled();
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Recovery key copied')).toBeVisible();
    await expect(go, 'copying is not enough').toBeDisabled();
    await page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await expect(go).toBeEnabled();
    await go.click();

    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    expect(box.wrappedKey).toBe(WRAPPED);
    const { calls, args } = await mock(page);
    expect(calls).toContain('sync_vault_create');
    expect(args.find((a) => a.cmd === 'sync_turn_on')).toMatchObject({ joining: false });
    expect(calls.indexOf('sync_mark_ready')).toBeGreaterThan(calls.indexOf('sync_turn_on'));
    expect(await page.evaluate(() => (window as unknown as { __ready: number }).__ready)).toBe(1);
    await expect(page.getByRole('button', { name: 'Sync Now' })).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('cancelling before saving the key leaves nothing behind', async ({ page }) => {
    const { box } = await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByLabel('Recovery key', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    expect(box.wrappedKey).toBeNull();
    const { calls } = await mock(page);
    expect(calls).toContain('sync_vault_forget');
    expect(calls).not.toContain('sync_turn_on');
  });

  test('another computer: a wrong recovery key says so, the right one joins', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, seq: 12 }));
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByText('Sync is already set up for this account. Enter the recovery key you saved then.')).toBeVisible();
    const field = page.getByRole('textbox', { name: 'Recovery key' });
    const go = page.getByRole('button', { name: 'Continue' });
    await expect(go).toBeDisabled();

    await field.fill('WRONG-WRONG');
    await go.click();
    await expect(page.getByRole('alert')).toHaveText("That recovery key doesn't open your synced notes. Check it and try again.");
    expect((await mock(page)).calls).not.toContain('sync_turn_on');

    // Typed the way people do: lower case, spaces.
    await field.fill('abcde fghjk mnpqr stvwx yz012 34567');
    await go.click();
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    const { args } = await mock(page);
    expect(args.find((a) => a.cmd === 'sync_turn_on')).toMatchObject({ joining: true });
    expect(args.find((a) => a.cmd === 'sync_vault_create')).toBeUndefined();
  });

  test('turning on and the app stays usable while it sets up', async ({ page, errors }) => {
    // The mailbox is away: setting up waits, it doesn't fail, and nothing pops up.
    const { box } = await setup(page, newBox({ dropAfterKey: true }));
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Setting up sync. You can keep working.')).toBeVisible();
    await expect(page.getByText('Waiting for a connection…')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(box.offline).toBe(true);
    // The browser logs a failed request itself; that is all that may be in the log.
    expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
    errors.length = 0;
  });

  test('turn off asks first, and keeps the notes and the synced copy', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    await settings(page).getByRole('button', { name: 'Turn Off Sync' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Turn Off Sync?');
    await expect(dialog).toContainText('This computer stops syncing. Your notes stay here, and the synced copy stays too.');
    await expect(dialog).toContainText('Turning sync on again asks for your recovery key.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sync Now' })).toBeVisible();
    expect((await mock(page)).calls).not.toContain('sync_turn_off');

    await settings(page).getByRole('button', { name: 'Turn Off Sync' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Turn Off Sync' }).click();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    expect((await mock(page)).calls).toContain('sync_turn_off');
    expect(box.deleted, 'the synced copy stays').toBe(false);
    expect(box.wrappedKey).toBe(WRAPPED);
    // The key goes from this computer too: only the recovery key brings it back.
    const { calls } = await mock(page);
    expect(calls.indexOf('sync_vault_forget')).toBeGreaterThan(calls.indexOf('sync_turn_off'));
  });

  test('delete synced copy is a dangerous question, then removes it and stops syncing', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    await settings(page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete the Synced Copy?');
    await expect(dialog).toContainText("it can't be undone");
    await expect(dialog).toContainText('The notes on your computers stay.');
    await expect(dialog).toContainText('nothing on the server can be got back');
    await expect(dialog).toContainText('Your other computers stop syncing.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(box.deleted).toBe(false);

    await settings(page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    expect(box.deleted).toBe(true);
    const { calls } = await mock(page);
    expect(calls.indexOf('sync_vault_forget')).toBeGreaterThan(-1);
    expect(calls.indexOf('sync_turn_off')).toBeGreaterThan(calls.indexOf('sync_vault_forget'));
    // Notes on this computer are still there.
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.sidebar').getByText('Getting started')).toBeVisible();
  });
});

test.describe('what it says about itself', () => {
  const lines: [string, string][] = [
    ['idle', 'Up to date'],
    ['syncing', 'Syncing…'],
    ['offline', 'Offline, will catch up'],
    ['paused-clock', "Your computer's clock is off"],
    ['needs-update', 'Update Thought Desk to keep syncing'],
    ['full', 'Sync storage is full'],
    ['error', 'Sync hit a problem and will try again'],
    ['signed-out', 'Sign in again to keep syncing'],
    ['copy-gone', 'The synced copy was deleted. Your notes here are safe. Turn sync off and on again to start a new one.'],
  ];

  test('every state in plain words, with the last synced time and Sync Now', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^Last synced /)).toBeVisible();
    for (const [status, words] of lines) {
      await page.evaluate(async (status) => {
        const { syncState } = await import('/src/lib/sync/state.svelte.ts');
        syncState.status = status as never;
      }, status);
      await expect(page.getByText(words, { exact: true }), status).toBeVisible();
    }
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('Sync Now runs a cycle', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    const before = (await mock(page)).calls.filter((c) => c === 'sync_text_todo').length;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect.poll(async () => (await mock(page)).calls.filter((c) => c === 'sync_text_todo').length).toBeGreaterThan(before);
    expect(box.deleted).toBe(false);
  });

  test('a clock far from the server pauses syncing', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, skewMs: 20 * 60_000 }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText("Your computer's clock is off", { exact: true })).toBeVisible({ timeout: 15_000 });
    // Nothing was pulled or sent while it was.
    expect((await mock(page)).calls).not.toContain('sync_text_todo');
  });

  test('a newer app’s mailbox asks for an update', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, format: 2 }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Update Thought Desk to keep syncing', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('offline is a status, never a toast', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, offline: true }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Offline, will catch up', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.toast')).toHaveCount(0);
    // The browser logs a failed request itself; that is all that may be in the log.
    expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
    errors.length = 0;
    expect(box.offline).toBe(true);
  });

  test('a record goes up with its base, a conflict starts another round, and a full account stops uploads', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, pushStatus: [409, 413] }), { on: true });
    await start(page);
    await page.evaluate(() => {
      (window as unknown as { __syncMock: { records: unknown[] } }).__syncMock.records.push({ entity: 'tag', id: 'exam', key: 'k_exam', kind: 'r', base: 0, data: 'AAAA' });
    });
    await openAccount(page);
    await page.getByRole('button', { name: 'Sync Now' }).click();
    // 409: the round is run again. 413: the account is full.
    await expect(page.getByText('Sync storage is full', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(box.pushes.length).toBeGreaterThanOrEqual(2);
    expect(box.pushes[0].items[0]).toMatchObject({ key: 'k_exam', kind: 'r', base: 0 });
    // Nothing of this is a toast; the browser's own notes about 409 and 413 are all the log has.
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
    errors.length = 0;
    // Uploads stopped: the full account is asked about, not pushed to, in the next round.
    const pushes = box.pushes.length;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await page.waitForTimeout(800);
    expect(box.pushes.length).toBe(pushes);
  });
});

test.describe('the editor on a synced page', () => {
  const editor = (page: Page) => page.locator('.scroller .ProseMirror');

  async function openSynced(page: Page) {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await whenReady(page);
    await page.click('.sidebar >> text=Getting started');
    await expect(editor(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __editor?: { extensionManager: { extensions: { name: string }[] } } }).__editor?.extensionManager.extensions.some((e) => e.name === 'collaboration'))).toBe(true);
  }

  const pageId = (page: Page) =>
    page.evaluate(async () => (await import('/src/lib/store.svelte.ts')).store.currentId as string);

  const stored = (page: Page, id: string) =>
    page.evaluate((id) => (window as any).__TAURI_INTERNALS__.invoke('get_page', { id }) as Promise<{ content: string; updatedAt: number }>, id);

  test('it still edits and saves, and the typing is written down for the other computers', async ({ page }) => {
    await openSynced(page);
    const id = await pageId(page);
    await editor(page).click();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type('typed on a synced page');
    await expect.poll(async () => (await stored(page, id)).content, { timeout: 5000 }).toContain('typed on a synced page');
    await expect.poll(async () => (await mock(page)).commits.length, { timeout: 5000 }).toBeGreaterThan(0);
    const { commits } = await mock(page);
    // The first write for a page nobody had synced is the seed, and it carries what was typed.
    expect(commits.some((c) => c.first === true && typeof c.update === 'string')).toBe(true);
    expect(commits.every((c) => c.base === null || c.content !== undefined)).toBe(true);
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('a change from another computer appears without touching what is typed, and is not saved from here', async ({ page }) => {
    await openSynced(page);
    const id = await pageId(page);
    await editor(page).click();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type('mine one');
    await expect.poll(async () => (await stored(page, id)).content).toContain('mine one');
    const before = await stored(page, id);

    // What the engine does with an update from the mailbox: applied with the REMOTE origin.
    await page.evaluate(async (id) => {
      const T = await import('/src/lib/sync/text.ts');
      const D = await import('/src/lib/sync/docs.ts');
      const { syncSchema } = await import('/src/lib/sync/schema.ts');
      const open = D.get(id)!;
      const other = new T.Y.Doc();
      T.Y.applyUpdate(other, T.Y.encodeStateAsUpdate(open), T.LOAD);
      const sv = T.Y.encodeStateVector(other);
      const json = T.read(other).json;
      json.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'From elsewhere' }] });
      T.diffInto(other, json, syncSchema());
      T.Y.applyUpdate(open, T.Y.encodeStateAsUpdate(other, sv), T.REMOTE);
    }, id);

    await expect(editor(page)).toContainText('From elsewhere');
    await expect(editor(page)).toContainText('mine one');
    // Not dirty: no save, so the page's body and time stay as they were.
    await page.waitForTimeout(1200);
    const after = await stored(page, id);
    expect(after.content).toBe(before.content);
    expect(after.updatedAt).toBe(before.updatedAt);

    // Typing goes on where it was, and does save.
    await page.waitForTimeout(700);
    await page.keyboard.type(' mine two');
    await expect(editor(page)).toContainText('mine one mine two');
    await expect.poll(async () => (await stored(page, id)).content).toContain('mine two');
    expect((await stored(page, id)).content).toContain('From elsewhere');

    // Undo takes back what was typed here, and never the change that came from elsewhere.
    await page.waitForTimeout(700);
    await page.keyboard.press(`${MOD}+z`);
    await expect(editor(page)).not.toContainText('mine two');
    await expect(editor(page)).toContainText('From elsewhere');
    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.press(`${MOD}+z`);
    await expect(editor(page)).toContainText('From elsewhere');
    await expect(editor(page)).not.toContainText('mine one');
  });

  test('the engine merges what the mailbox brought into the open page, and writes the body without a new time', async ({ page }) => {
    await openSynced(page);
    const id = await pageId(page);
    await editor(page).click();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type('mine one');
    await expect.poll(async () => (await stored(page, id)).content).toContain('mine one');
    const before = await stored(page, id);

    await page.evaluate(async (id) => {
      const T = await import('/src/lib/sync/text.ts');
      const D = await import('/src/lib/sync/docs.ts');
      const { toB64 } = await import('/src/lib/sync/bytes.ts');
      const { syncSchema } = await import('/src/lib/sync/schema.ts');
      const other = new T.Y.Doc();
      T.Y.applyUpdate(other, T.Y.encodeStateAsUpdate(D.get(id)!), T.LOAD);
      const sv = T.Y.encodeStateVector(other);
      const json = T.read(other).json;
      json.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'Sent by the mailbox' }] });
      T.diffInto(other, json, syncSchema());
      (window as any).__syncMock.incoming[id] = [{ seq: 7, kind: 'y', data: toB64(T.Y.encodeStateAsUpdate(other, sv)) }];
      const { loadEngine } = await import('/src/lib/sync/entry.svelte.ts');
      (await loadEngine()).engine.syncNow();
    }, id);

    await expect(editor(page)).toContainText('Sent by the mailbox');
    await expect(editor(page)).toContainText('mine one');
    await expect.poll(async () => (await stored(page, id)).content).toContain('Sent by the mailbox');
    const commit = (await mock(page)).commits.find((c) => c.consumed === 7);
    expect(commit).toMatchObject({ pageId: id, consumed: 7 });
    expect(String(commit!.content)).toContain('Sent by the mailbox');
    // The body is brought up to the document; no time is bumped, and the editor did not save.
    expect((await stored(page, id)).updatedAt).toBe(before.updatedAt);
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('a picture shows for this platform whichever form the document holds, and keeps its width', async ({ page }) => {
    // The picture is made up, so it is answered here and the page never goes looking for a server:
    // on Linux that is refused at once, and the refusal is an error in the page.
    const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.route('**/abc123.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: dot }));
    await openSynced(page);
    const id = await pageId(page);
    const result = await page.evaluate(async (id) => {
      const D = await import('/src/lib/sync/docs.ts');
      const { fileUrl } = await import('/src/lib/api.ts');
      const ed = (window as any).__editor;
      void D;
      ed.chain().focus('end').insertContent({ type: 'image', attrs: { src: 'tdfile://localhost/abc123.png' } }).run();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const img = () => ed.view.dom.querySelector('img[src*="abc123"]') as HTMLImageElement | null;
      const shown = img()?.getAttribute('src');
      // Resize: the node's width and height are committed as attributes.
      let at = -1;
      ed.state.doc.descendants((n: any, pos: number) => {
        if (n.type.name === 'image') at = pos;
      });
      ed.chain().setNodeSelection(at).updateAttributes('image', { width: 200, height: 100 }).run();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const node = ed.state.doc.nodeAt(at);
      return { shown, want: fileUrl('abc123.png'), saved: node.attrs.src, width: node.attrs.width, inDom: img()?.style.width ?? '' };
    }, id);
    expect(result.shown).toBe(result.want);
    expect(result.saved, 'what is saved is what the document holds').toBe('tdfile://localhost/abc123.png');
    expect(result.width).toBe(200);
    await expect.poll(async () => (await stored(page, id)).content, { timeout: 5000 }).toContain('"width":200');
    expect((await stored(page, id)).content).toContain('tdfile://localhost/abc123.png');
  });

  test('with sync off the editor is the plain one', async ({ page }) => {
    await setup(page);
    await start(page);
    await page.click('.sidebar >> text=Getting started');
    await expect(editor(page)).toBeVisible();
    const names = await page.evaluate(() => (window as any).__editor.extensionManager.extensions.map((e: { name: string }) => e.name) as string[]);
    expect(names).not.toContain('collaboration');
    expect(names).toContain('undoRedo');
  });
});

// ============================================================ the mailbox's answers, and stopping

const LONG = { timeout: 20_000 };

/** The engine's own "Sync Now". */
const syncNowEngine = (page: Page) => page.evaluate(async () => (await (await import('/src/lib/sync/entry.svelte.ts')).loadEngine()).engine.syncNow());
/** The engine asked for a cycle by something other than a person (a timer, a focus): nothing happens while it is stopped. */
const requestEngine = (page: Page) => page.evaluate(async () => (await (await import('/src/lib/sync/entry.svelte.ts')).loadEngine()).engine.request(0));
/** A record waiting to be sent, ahead of the pages' own. */
const queue = (page: Page, id = 'exam') =>
  page.evaluate((id) => {
    (window as unknown as { __syncMock: { records: unknown[] } }).__syncMock.records.push({ entity: 'tag', id, key: `k_${id}`, kind: 'r', base: 0, data: 'AAAA' });
  }, id);
/** Runs one cycle and waits for it to be over (`lastSynced` moves). */
const cycle = (page: Page) =>
  page.evaluate(async () => {
    const { loadEngine } = await import('/src/lib/sync/entry.svelte.ts');
    const { syncState } = await import('/src/lib/sync/state.svelte.ts');
    const before = syncState.lastSynced;
    const started = Date.now();
    (await loadEngine()).engine.syncNow();
    while (syncState.lastSynced === before) {
      if (Date.now() - started > 20_000) throw new Error(`the cycle did not finish (status: ${syncState.status})`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
const pushedKeys = (box: Box) => box.pushes.flatMap((p) => p.items.map((i) => i.key));
/** The browser logs each 4xx/5xx it fetches; those notes are all the log may hold. */
const onlyNetworkNotes = (errors: string[]) => {
  expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
  errors.length = 0;
};
/** The first cycle is over and the pane says so. */
const settled = (page: Page) =>
  expect
    .poll(() => page.evaluate(async () => { const { syncState } = await import('/src/lib/sync/state.svelte.ts'); return syncState.lastSynced !== null && syncState.status === 'idle'; }), LONG)
    .toBe(true);
const statusOf = (page: Page) => page.evaluate(async () => (await import('/src/lib/sync/state.svelte.ts')).syncState.status as string);
const invokeOn = <T>(page: Page, cmd: string, args: object = {}) => page.evaluate(([cmd, args]) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>, [cmd, args] as const);
const storedPage = (page: Page, id: string) => invokeOn<{ title: string; content: string }>(page, 'get_page', { id });
const gettingStarted = (page: Page) => page.evaluate(async () => (await import('/src/lib/store.svelte.ts')).store.pages.find((p) => p.title === 'Getting started')!.id as string);

test.describe('the vault proof', () => {
  test('the key is stored with its proof, every change carries it, and it is asked for once', async ({ page }) => {
    const { box } = await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 });
    expect(box.keyBody?.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await queue(page);
    await cycle(page);
    await cycle(page);
    expect(pushedKeys(box)).toContain('k_exam');
    expect(box.proofs.length).toBeGreaterThan(0);
    expect(new Set(box.proofs), 'one proof, the one stored with the key').toEqual(new Set([box.keyBody!.proof]));
    expect((await mock(page)).calls.filter((c) => c === 'sync_vault_proof')).toHaveLength(1);
  });

  test("a proof the copy refuses (403) means this computer's copy is another one: syncing stops, edits stay, and Sync Now resumes", async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, proof: 'x'.repeat(43) }), { on: true });
    await start(page);
    await queue(page);
    await openAccount(page);
    await syncNowEngine(page);
    await expect(page.getByText('The synced copy was deleted', { exact: false })).toBeVisible(LONG);
    expect(await statusOf(page)).toBe('copy-gone');
    await expect(settings(page).getByRole('button', { name: 'Delete Synced Copy' })).toHaveCount(0);
    await expect(settings(page).getByRole('button', { name: 'Turn Off Sync' })).toBeVisible();
    // Nothing retries by itself.
    const asked = box.requests;
    await requestEngine(page);
    await page.waitForTimeout(700);
    expect(box.requests).toBe(asked);
    expect(box.pushes).toHaveLength(0);
    // Whatever changed meanwhile is still waiting to go.
    box.proof = null;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    expect(pushedKeys(box)).toContain('k_exam');
    onlyNetworkNotes(errors);
  });

  test('"no vault" (409) means the copy is gone: copy-gone, and nothing more is pushed', async ({ page, errors }) => {
    // The mailbox has no key at all (the copy was deleted); this computer was never told which one it belongs to.
    const { box } = await setup(page, newBox({ wrappedKey: null }), { on: true });
    await start(page);
    await queue(page);
    await openAccount(page);
    await syncNowEngine(page);
    await expect.poll(() => statusOf(page), LONG).toBe('copy-gone');
    const asked = box.requests;
    await requestEngine(page);
    await page.waitForTimeout(700);
    expect(box.requests, 'nothing is asked while stopped').toBe(asked);
    expect(box.pushes).toHaveLength(0);
    onlyNetworkNotes(errors);
  });
});

test.describe('refused pushes', () => {
  test('a refusal that names a seq already seen is rebased and pushed again, without a pull', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 5, pushStatus: [409], conflictSeq: 3 }), { on: true });
    await start(page);
    // The first cycle has pulled up to 5.
    await settled(page);
    await queue(page);
    const before = (await mock(page)).calls.length;
    await cycle(page);
    const { calls, args } = await mock(page);
    const after = calls.slice(before);
    const at = after.indexOf('sync_records_rebase');
    expect(at, 'rebased').toBeGreaterThan(-1);
    expect(after[at - 1]).toBe('sync_seal_records');
    expect(after[at + 1]).toBe('sync_seal_records');
    expect(after.slice(at)).not.toContain('sync_ingest');
    expect(args.find((a) => a.cmd === 'sync_records_rebase')).toMatchObject({ items: [{ entity: 'tag', id: 'exam', seq: 3 }] });
    expect(box.pushes).toHaveLength(2);
    expect(pushedKeys(box).filter((k) => k === 'k_exam')).toHaveLength(2);
    onlyNetworkNotes(errors);
  });

  test('a refusal at a seq not seen yet is pulled, not rebased', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 5, pushStatus: [409], conflictSeq: 9 }), { on: true });
    await start(page);
    await settled(page);
    await queue(page);
    await cycle(page);
    await cycle(page);
    const { calls } = await mock(page);
    expect(calls).not.toContain('sync_records_rebase');
    expect(box.pushes.length).toBeGreaterThanOrEqual(2);
    onlyNetworkNotes(errors);
  });

  test('refusals that never end back off after five and say so; Sync Now ends it', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, pushStatus: Array(40).fill(409) }), { on: true });
    await start(page);
    await queue(page);
    await openAccount(page);
    await syncNowEngine(page);
    await expect(page.getByText('Sync keeps meeting changes from another computer and will try again', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(box.pushes).toHaveLength(6);
    await page.waitForTimeout(1200);
    expect(box.pushes, 'it waits').toHaveLength(6);
    box.pushStatus.length = 0;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    onlyNetworkNotes(errors);
  });

  test('a refused sign-in is its own status; nothing retries until Sync Now, and edits go up afterwards', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    box.unauthorized = true;
    await queue(page);
    await syncNowEngine(page);
    await expect(page.getByText('Sign in again to keep syncing', { exact: true })).toBeVisible(LONG);
    const asked = box.requests;
    await requestEngine(page);
    await page.waitForTimeout(700);
    expect(box.requests).toBe(asked);
    box.unauthorized = false;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    expect(pushedKeys(box)).toContain('k_exam');
    onlyNetworkNotes(errors);
  });
});

test.describe('recovering without losing what was edited here', () => {
  test('needs-update: it waits, and the record queued meanwhile goes up once the mailbox is readable', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, format: 2 }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Update Thought Desk to keep syncing', { exact: true })).toBeVisible(LONG);
    await queue(page);
    const asked = box.requests;
    await requestEngine(page);
    await page.waitForTimeout(700);
    expect(box.requests, 'not retried').toBe(asked);
    expect(box.pushes).toHaveLength(0);
    box.format = 1;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    expect(pushedKeys(box)).toContain('k_exam');
  });

  test('copy-gone: Delete is not offered, the notes here are untouched, and when the copy is back it syncs again', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: 'wrapped.SOMEONEELSE' }), { on: true, wrapped: WRAPPED });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('The synced copy was deleted', { exact: false })).toBeVisible(LONG);
    await expect(settings(page).getByRole('button', { name: 'Delete Synced Copy' })).toHaveCount(0);
    await queue(page);
    const id = await gettingStarted(page);
    await invokeOn(page, 'update_page', { id, patch: { title: 'Edited while the copy was gone' } });
    await requestEngine(page);
    await page.waitForTimeout(700);
    expect(box.pushes, 'nothing goes up with the wrong key').toHaveLength(0);
    box.wrappedKey = WRAPPED;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    expect(pushedKeys(box)).toContain('k_exam');
    await expect(settings(page).getByRole('button', { name: 'Delete Synced Copy' })).toBeVisible();
    expect((await storedPage(page, id)).title).toBe('Edited while the copy was gone');
  });

  test('paused-clock: nothing is sent while the clock is off, and the queued record goes up once it is right', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, skewMs: 20 * 60_000 }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText("Your computer's clock is off", { exact: true })).toBeVisible(LONG);
    await queue(page);
    await syncNowEngine(page);
    await page.waitForTimeout(700);
    expect(box.pushes).toHaveLength(0);
    box.skewMs = 0;
    await page.getByRole('button', { name: 'Sync Now' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    expect(pushedKeys(box)).toContain('k_exam');
  });
});

test.describe('delete', () => {
  test('from a computer whose copy was replaced it is refused, and the copy there survives', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: 'wrapped.THEIRS' }), { on: true, wrapped: WRAPPED });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('The synced copy was deleted', { exact: false })).toBeVisible(LONG);
    const result = await page.evaluate(async () => {
      const { engine } = await import('/src/lib/sync/engine.svelte.ts');
      try {
        await engine.deleteSyncedCopy();
        return 'deleted';
      } catch (e) {
        return (e as Error).constructor.name;
      }
    });
    expect(result).toBe('CopyGone');
    expect(box.deleted).toBe(false);
    expect(box.wrappedKey).toBe('wrapped.THEIRS');
    expect(box.proofs, 'no delete was even sent').toEqual([]);
  });

  test('the copy replaced a moment before the click: the question is asked, then refused, with a sentence', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    box.wrappedKey = 'wrapped.THEIRS';
    await settings(page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect(page.getByRole('alert')).toHaveText("This computer's synced copy was already deleted or replaced, so nothing was deleted.");
    expect(box.deleted).toBe(false);
    expect(box.wrappedKey).toBe('wrapped.THEIRS');
  });

  test('while a push is in flight: it is cancelled, and nothing reaches the mailbox after the delete', async ({ page }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, hold }), { on: true });
    const cancelled: string[] = [];
    page.on('requestfailed', (r) => /\/sync\/push$/.test(r.url()) && cancelled.push(r.failure()?.errorText ?? ''));
    await start(page);
    await queue(page);
    await syncNowEngine(page);
    await expect.poll(() => box.arrived.includes('push'), LONG).toBe(true);
    await openAccount(page);
    await settings(page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect.poll(() => box.deleted, LONG).toBe(true);
    release();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible(LONG);
    await page.waitForTimeout(1200);
    expect(box.late, 'nothing asked after the delete').toEqual([]);
    expect(box.pushes, 'the held push never landed').toHaveLength(0);
    expect(cancelled).toHaveLength(1);
  });

  test('while a file chunk is being uploaded: the rest is never sent', async ({ page }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, hold }), { on: true });
    await start(page);
    await page.evaluate(() => {
      (window as unknown as { __syncMock: { files: { upload: unknown[] } } }).__syncMock.files.upload.push({ id: 'f1', stored: 'abc.png', chunks: 3 });
    });
    await syncNowEngine(page);
    await expect.poll(() => box.arrived.includes('PUT blob'), LONG).toBe(true);
    await openAccount(page);
    await settings(page).getByRole('button', { name: 'Delete Synced Copy' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Synced Copy' }).click();
    await expect.poll(() => box.deleted, LONG).toBe(true);
    release();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible(LONG);
    await page.waitForTimeout(1200);
    expect(box.late).toEqual([]);
    expect(box.arrived.filter((a) => a === 'PUT blob'), 'one chunk was on its way, the other two never started').toHaveLength(1);
    expect(box.blobs).toEqual([]);
    expect((await mock(page)).calls, 'the file was not marked done').not.toContain('sync_file_done');
  });
});

test.describe('files', () => {
  test('an upload that resumes finds chunk 0 already there (409): it is looked at, believed, and the rest goes up', async ({ page, errors }) => {
    const first = '0'.repeat(32);
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    box.existing.add(first);
    await start(page);
    await settled(page);
    await page.evaluate(() => {
      (window as unknown as { __syncMock: { files: { upload: unknown[] } } }).__syncMock.files.upload.push({ id: 'f1', stored: 'abc.png', chunks: 3 });
    });
    await syncNowEngine(page);
    await expect.poll(async () => (await mock(page)).calls.includes('sync_file_done'), LONG).toBe(true);
    expect(box.blobGets, 'the chunk that was there is checked').toEqual([first]);
    expect(box.blobs, 'the other two went up').toEqual(['1'.padStart(32, '0'), '2'.padStart(32, '0')]);
    onlyNetworkNotes(errors);
  });

  test('a name that is taken but not there (an upload still being counted) does not mark the file done', async ({ page, errors }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    box.existing.add('0'.repeat(32));
    box.missing = true;
    await start(page);
    await settled(page);
    await page.evaluate(() => {
      (window as unknown as { __syncMock: { files: { upload: unknown[] } } }).__syncMock.files.upload.push({ id: 'f1', stored: 'abc.png', chunks: 2 });
    });
    await syncNowEngine(page);
    await expect.poll(() => box.blobGets.length, LONG).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect((await mock(page)).calls).not.toContain('sync_file_done');
    expect(box.blobs).toEqual([]);
    onlyNetworkNotes(errors);
  });
});

test.describe('turning on again, and what the pane keeps', () => {
  test('it audits once before the first cycle', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await expect.poll(async () => (await mock(page)).calls.includes('sync_text_todo'), LONG).toBe(true);
    const { calls } = await mock(page);
    expect(calls.filter((c) => c === 'sync_audit')).toHaveLength(1);
    expect(calls.indexOf('sync_audit')).toBeLessThan(calls.indexOf('sync_text_todo'));
  });

  test('turn off forgets the key; turning on again is the join path with the recovery key, then an audit', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, seq: 3 }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    await settings(page).getByRole('button', { name: 'Turn Off Sync' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Turn Off Sync' }).click();
    await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
    const mark = (await mock(page)).calls.length;
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByText('Sync is already set up for this account. Enter the recovery key you saved then.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Recovery key' }).fill(KEY);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    const { calls, args } = await mock(page);
    const after = calls.slice(mark);
    expect(args.slice(mark).find((a) => a.cmd === 'sync_turn_on')).toMatchObject({ joining: true });
    expect(after).not.toContain('sync_vault_create');
    expect(after.indexOf('sync_audit')).toBeGreaterThan(after.indexOf('sync_turn_on'));
    expect(after.indexOf('sync_audit')).toBeLessThan(after.indexOf('sync_text_todo'));
  });

  test('items that could not be read, and updates and records passed over, are one quiet line', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    await expect(page.getByText(/couldn't be read on this computer/)).toHaveCount(0);
    await page.evaluate(() => ((window as any).__syncMock.status.unreadable = 1));
    await cycle(page);
    await expect(page.getByText("1 item couldn't be read on this computer", { exact: true })).toBeVisible();
    await page.evaluate(() => ((window as any).__syncMock.applySkipped = 2));
    await cycle(page);
    await page.evaluate(() => ((window as any).__syncMock.applySkipped = 0));
    await expect(page.getByText("3 items couldn't be read on this computer", { exact: true })).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('the backup from before sync is announced and can be deleted after a question', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true, backup: true });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    const line = page.getByText('A copy of your notes from before sync was turned on is kept on this computer.');
    await expect(line).toBeVisible();
    await settings(page).getByRole('button', { name: 'Delete Backup' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect((await mock(page)).calls).not.toContain('sync_backup_delete');
    await settings(page).getByRole('button', { name: 'Delete Backup' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Backup' }).click();
    await expect(line).toHaveCount(0);
    expect((await mock(page)).calls).toContain('sync_backup_delete');
  });

  test('turning on for the first time leaves a backup, and says so', async ({ page }) => {
    await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    await expect(page.getByText('A copy of your notes from before sync was turned on is kept on this computer.')).toBeVisible();
  });
});

test.describe('recovery key handling', () => {
  test('a wrong key typed is cleared from the box after the error', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, seq: 12 }));
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    const field = page.getByRole('textbox', { name: 'Recovery key' });
    await field.fill('WRONG-WRONG');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(field).toHaveValue('');
  });

  test('cancelling clears the typed key', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED, seq: 12 }));
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('textbox', { name: 'Recovery key' }).fill(KEY);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByRole('textbox', { name: 'Recovery key' })).toHaveValue('');
    await expect(page.locator('body')).not.toContainText(KEY);
  });

  test('closing Settings while the key is shown forgets the key that was made', async ({ page }) => {
    const { box } = await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByLabel('Recovery key', { exact: true })).toBeVisible();
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await expect(settings(page)).toHaveCount(0);
    await expect.poll(async () => (await mock(page)).calls.includes('sync_vault_forget')).toBe(true);
    expect(box.wrappedKey).toBeNull();
    expect((await mock(page)).calls).not.toContain('sync_turn_on');
    await expect(page.locator('body')).not.toContainText(KEY);
  });

  test('Copy says the clipboard is cleared; cancelling clears it at once if it still holds the key, and leaves other text alone', async ({ page }) => {
    await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await expect(page.getByText('The clipboard is cleared 30 seconds after you copy.')).toBeVisible();
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Recovery key copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(KEY);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('');

    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('button', { name: 'Copy' }).click();
    await page.evaluate(() => navigator.clipboard.writeText('something else'));
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('something else');
  });

  test('after 30 seconds the clipboard is cleared if it still holds the key', async ({ page }) => {
    await setup(page);
    await start(page);
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.clock.install();
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByText('Recovery key copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(KEY);
    await page.clock.fastForward(31_000);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('');
  });

  test('turning on fails after the key was stored: trying again is not "someone else set it up"', async ({ page, errors }) => {
    const { box } = await setup(page);
    await start(page);
    await page.evaluate(() => ((window as any).__syncMock.fail.sync_turn_on = 'disk full'));
    await openAccount(page);
    await page.getByRole('button', { name: 'Turn On Sync' }).click();
    await page.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toHaveText("Sync couldn't start. Try again in a moment.");
    expect(box.wrappedKey).toBe(WRAPPED);
    // The key made here is still the one the mailbox holds, so the second go is the same copy.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    const { calls } = await mock(page);
    expect(calls.filter((c) => c === 'sync_vault_forget')).toHaveLength(0);
    expect(calls).toContain('sync_turn_on');
    // The second try's 409 is the browser's own note.
    onlyNetworkNotes(errors);
  });
});

test.describe('what the mailbox sends is checked', () => {
  test("a seq above the mailbox's own count is refused: nothing is ingested", async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 2 }), { on: true });
    box.pull = () => ({ items: [{ seq: 99, key: 'k', kind: 'r', data: 'AAAA' }], seq: 99, more: false });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Sync hit a problem and will try again', { exact: true })).toBeVisible(LONG);
    expect((await mock(page)).calls).not.toContain('sync_ingest');
  });

  test('items out of order are refused', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 9 }), { on: true });
    box.pull = () => ({
      items: [
        { seq: 5, key: 'a', kind: 'r', data: 'AAAA' },
        { seq: 4, key: 'b', kind: 'r', data: 'AAAA' },
      ],
      seq: 9,
      more: false,
    });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Sync hit a problem and will try again', { exact: true })).toBeVisible(LONG);
    expect((await mock(page)).calls).not.toContain('sync_ingest');
  });

  test('a blob name that is not 32 hex digits is never fetched', async ({ page }) => {
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 3 }), { on: true });
    box.pull = () => ({ items: [{ seq: 3, key: 'k', kind: 'r', blob: '../account' }], seq: 3, more: false });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Sync hit a problem and will try again', { exact: true })).toBeVisible(LONG);
    expect(box.blobGets).toEqual([]);
    expect((await mock(page)).calls).not.toContain('sync_ingest');
  });

  test('a pull batch holds only so many blob bytes: the rest comes next round', async ({ page }) => {
    test.setTimeout(90_000);
    const names = ['a', 'b', 'c'].map((c) => c.repeat(32));
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED, seq: 3 }), { on: true });
    box.pull = (after) => ({ items: names.map((blob, i) => ({ seq: i + 1, key: `k${i}`, kind: 'y', blob })).filter((x) => x.seq > after), seq: 3, more: false });
    await start(page);
    // Three 9 MiB blobs: two make 18 MiB, over the 16 MiB a round may hold, so the third waits.
    await expect.poll(async () => (await mock(page)).args.filter((a) => a.cmd === 'sync_ingest').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const sizes = (await mock(page)).args.filter((a) => a.cmd === 'sync_ingest').map((a) => (a.items as unknown[]).length);
    expect(sizes.slice(0, 2)).toEqual([2, 1]);
    expect(box.blobGets).toEqual(names);
  });

  test('a burst of live messages makes a cycle at most every two seconds', async ({ page }) => {
    test.setTimeout(60_000);
    const { box } = await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true, live: true });
    await page.routeWebSocket('**/__mail/sync/live', (ws) => {
      let n = 0;
      const timer = setInterval(() => ws.send(JSON.stringify({ seq: 100 + n++ })), 250);
      ws.onClose(() => clearInterval(timer));
    });
    await start(page);
    await openAccount(page);
    await expect(page.getByText('Up to date')).toBeVisible(LONG);
    const before = box.infoCalls;
    await page.waitForTimeout(6500);
    // 26 messages in 6.5 s; one cycle per 2 s from them, so a handful.
    expect(box.infoCalls - before).toBeLessThanOrEqual(5);
    expect(box.infoCalls - before).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================ page text under stress

test.describe('page text under stress', () => {
  const editor = (page: Page) => page.locator('.scroller .ProseMirror');
  const stored = (page: Page, id: string) => invokeOn<{ content: string; updatedAt: number }>(page, 'get_page', { id });

  /** An update, as another computer would send it, that adds a paragraph to the page's current document. */
  async function remoteUpdate(page: Page, id: string, words: string): Promise<string> {
    return page.evaluate(
      async ([id, words]) => {
        const T = await import('/src/lib/sync/text.ts');
        const D = await import('/src/lib/sync/docs.ts');
        const { toB64 } = await import('/src/lib/sync/bytes.ts');
        const { syncSchema } = await import('/src/lib/sync/schema.ts');
        const mine = T.Y.encodeStateAsUpdate(D.get(id)!);
        const other = new T.Y.Doc();
        T.Y.applyUpdate(other, mine, T.LOAD);
        const sv = T.Y.encodeStateVector(other);
        const json = T.read(other).json;
        json.content!.push({ type: 'paragraph', content: [{ type: 'text', text: words }] });
        T.diffInto(other, json, syncSchema());
        return toB64(T.Y.encodeStateAsUpdate(other, sv));
      },
      [id, words] as const,
    );
  }

  async function openSynced(page: Page) {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await whenReady(page);
    await page.click('.sidebar >> text=Getting started');
    await expect(editor(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__editor?.extensionManager.extensions.some((e: { name: string }) => e.name === 'collaboration'))).toBe(true);
    return gettingStarted(page);
  }

  test('a corrupt update is set aside after three tries; the good one around it goes in and the page goes on', async ({ page }) => {
    const id = await openSynced(page);
    await editor(page).click();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type('mine one');
    await expect.poll(async () => (await stored(page, id)).content).toContain('mine one');
    const warnings: string[] = [];
    page.on('console', (m) => m.type() === 'warning' && /set aside/.test(m.text()) && warnings.push(m.text()));

    const good = await remoteUpdate(page, id, 'Beyond the bad one');
    await page.evaluate(
      ([id, good]) => {
        (window as any).__syncMock.incoming[id] = [
          { seq: 7, kind: 'y', data: '______8' }, // not a Yjs update
          { seq: 8, kind: 'y', data: good },
        ];
      },
      [id, good] as const,
    );
    await cycle(page);
    // The good update went in at once; the bad one is tried again, so nothing past it is consumed yet.
    await expect(editor(page)).toContainText('Beyond the bad one');
    expect((await mock(page)).commits.filter((c) => c.consumed !== undefined)).toHaveLength(0);
    await cycle(page);
    expect((await mock(page)).commits.filter((c) => c.consumed !== undefined)).toHaveLength(0);
    await cycle(page);
    // Third time: set aside, and the page moves on past both.
    await expect.poll(async () => (await mock(page)).commits.find((c) => c.consumed === 8) !== undefined).toBe(true);
    expect(await page.evaluate((id) => (window as any).__syncMock.incoming[id]?.length ?? 0, id)).toBe(0);
    expect(warnings).toHaveLength(1);
    await cycle(page);
    expect(warnings, 'said once').toHaveLength(1);

    // Typing goes on, and the line in Settings counts what was set aside.
    await editor(page).click();
    await page.keyboard.press(`${MOD}+End`);
    await page.keyboard.type(' and more');
    await expect.poll(async () => (await stored(page, id)).content).toContain('and more');
    await page.keyboard.press(`${MOD}+Comma`);
    await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
    await expect(page.getByText("1 item couldn't be read on this computer", { exact: true })).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('opening a page while its incoming text is merged loses none of it', async ({ page }) => {
    await setup(page, newBox({ wrappedKey: WRAPPED }), { on: true });
    await start(page);
    await whenReady(page);
    const id = await gettingStarted(page);
    // The page has a state here (as after it was opened once), and is closed.
    await page.evaluate(async (id) => {
      const D = await import('/src/lib/sync/docs.ts');
      const doc = await D.open(id);
      await D.release(id, doc);
    }, id);
    await expect.poll(async () => (await mock(page)).commits.length).toBeGreaterThan(0);
    const state = await page.evaluate(async (id) => (await (window as any).__TAURI_INTERNALS__.invoke('sync_text_read', { pageId: id })).state as string, id);
    expect(state).not.toBe('');

    // Remote text for the closed page, built on that state.
    const update = await page.evaluate(
      async ([state, words]) => {
        const T = await import('/src/lib/sync/text.ts');
        const { fromB64, toB64 } = await import('/src/lib/sync/bytes.ts');
        const { syncSchema } = await import('/src/lib/sync/schema.ts');
        const other = new T.Y.Doc();
        T.Y.applyUpdate(other, fromB64(state), T.LOAD);
        const sv = T.Y.encodeStateVector(other);
        const json = T.read(other).json;
        json.content!.push({ type: 'paragraph', content: [{ type: 'text', text: words }] });
        T.diffInto(other, json, syncSchema());
        return toB64(T.Y.encodeStateAsUpdate(other, sv));
      },
      [state, 'Said on another computer'] as const,
    );

    // The open's read of the page is slow: the engine's merge meets it in the middle.
    const raced = await page.evaluate(
      async ([id, update]) => {
        const w = window as any;
        w.__syncMock.incoming[id] = [{ seq: 9, kind: 'y', data: update }];
        const internals = w.__TAURI_INTERNALS__;
        const real = internals.invoke;
        let held = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        internals.invoke = async (cmd: string, args: unknown, options: unknown) => {
          const answer = await real(cmd, args, options);
          if (cmd === 'sync_text_read' && !held) {
            held = true;
            await gate;
          }
          return answer;
        };
        const D = await import('/src/lib/sync/docs.ts');
        const { loadEngine } = await import('/src/lib/sync/entry.svelte.ts');
        const { syncState } = await import('/src/lib/sync/state.svelte.ts');
        const opened = D.open(id);
        (await loadEngine()).engine.syncNow();
        // The cycle gets to the page while the open is still holding its (older) read.
        await new Promise((resolve) => setTimeout(resolve, 900));
        release();
        const doc = await opened;
        // The merge goes on after the open, into the open document.
        const started = Date.now();
        const T = await import('/src/lib/sync/text.ts');
        while (!T.read(doc).text.includes('Said on another computer') && Date.now() - started < 8000) await new Promise((resolve) => setTimeout(resolve, 50));
        while (syncState.status === 'syncing' && Date.now() - started < 12000) await new Promise((resolve) => setTimeout(resolve, 50));
        internals.invoke = real;
        const text = T.read(doc).text;
        await D.release(id, doc);
        return text;
      },
      [id, update] as const,
    );
    expect(raced).toContain('Said on another computer');
    await expect.poll(async () => (await stored(page, id)).content, { timeout: 8000 }).toContain('Said on another computer');
  });
});
