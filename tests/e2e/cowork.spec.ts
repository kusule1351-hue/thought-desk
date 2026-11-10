// Live sessions: two friends (two browser profiles sharing the fake cloud)
// write a page together through the relay (server/, in test mode on port
// 8788, started by playwright.config.ts).
import type { Browser, Page } from '@playwright/test';
import { test, expect, open, MOD } from './fixtures';
import { FakeCloud } from './fake-cloud';

test.use({ viewport: { width: 1280, height: 820 } });

/** Sync goes through the relay, so give it a moment. */
const LIVE = { timeout: 10_000 };

/** Ana (this page) and Ben (a second profile), friends, both signed in.
 *  `idleMs` shortens how long a quiet session waits before letting go of the relay;
 *  `sameColor` makes both start with the same cursor colour (it comes from the
 *  Yjs client id, a random number, modulo the number of colours). */
async function twoFriends(ana: Page, browser: Browser, { idleMs, sameColor }: { idleMs?: number; sameColor?: boolean } = {}) {
  const cloud = new FakeCloud();
  const anaUser = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  const benUser = cloud.addUser({ email: 'ben@example.com', name: 'Ben Ito', username: 'ben' });
  cloud.befriend(anaUser, benUser);
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  context.on('page', (p) => p.on('pageerror', (e) => console.error(`[Ben] ${e.stack}`)));
  if (idleMs)
    for (const c of [ana.context(), context]) await c.addInitScript((ms) => ((window as unknown as { __coworkIdleMs: number }).__coworkIdleMs = ms), idleMs);
  if (sameColor)
    for (const c of [ana.context(), context])
      await c.addInitScript(() => {
        const real = crypto.getRandomValues.bind(crypto);
        crypto.getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
          real(a);
          if (a instanceof Uint32Array && a.length === 1) a[0] = (a[0] & ~7) | 3;
          return a;
        };
      });
  await cloud.attach(ana.context());
  cloud.signIn(ana.context(), anaUser);
  await open(ana);
  await cloud.attach(context);
  cloud.signIn(context, benUser);
  const ben = await context.newPage();
  await open(ben);
  return { cloud, ben };
}

const editor = (page: Page) => page.locator('.scroller .ProseMirror');
const title = (page: Page) => page.locator('.scroller h1.title');
const liveTab = (page: Page) => page.locator('.titlebar [role=tab][aria-selected=true] .tab-live');
const friendsPage = (page: Page) => page.locator('.friends-view');

/** Opens the Cowork page from the sidebar. */
async function openFriends(page: Page) {
  await page.locator('.sidebar .views').getByRole('button', { name: 'Cowork' }).click();
  await expect(friendsPage(page)).toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}

async function inviteBen(ana: Page) {
  await ana.locator('.sidebar').getByText('Study plan', { exact: true }).click();
  await expect(editor(ana)).toContainText('Before the midterm');
  await ana.locator('.titlebar [data-tip="More"]').click();
  await ana.getByRole('menuitem', { name: 'Invite a Friend…' }).click();
  await ana.getByRole('button', { name: 'Invite Ben Ito' }).click();
  await expect(ana.locator('.toast', { hasText: 'Invited Ben Ito to “Study plan”' })).toBeVisible();
}

test('invite, join, write together in a new tab, end: both keep the page', async ({ page: ana, browser }) => {
  test.setTimeout(120_000);
  const { cloud, ben } = await twoFriends(ana, browser, { sameColor: true });
  const sockets: string[] = [];
  ana.on('websocket', (ws) => sockets.push(ws.url()));

  await test.step('Ana invites Ben to a page; Ben sees it and joins', async () => {
    await inviteBen(ana);
    await expect(ben.locator('.toast', { hasText: 'Ana Lima invites you to write together' })).toBeVisible(LIVE);
    await openFriends(ben);
    await expect(friendsPage(ben)).toContainText('“Study plan”');
    await ben.getByRole('button', { name: 'Join Ana Lima' }).click();
  });

  await test.step('a live tab opens for both, with the page', async () => {
    for (const page of [ana, ben]) {
      await expect(liveTab(page)).toHaveCount(1, LIVE);
      await expect(editor(page)).toContainText('Before the midterm', LIVE);
      await expect(title(page)).toHaveText('Study plan', LIVE);
      await expect(page.locator('.live-chip')).toContainText(page === ana ? 'Live with Ben Ito' : 'Live with Ana Lima', LIVE);
    }
    await expect(ana.locator('.toast', { hasText: 'Ben Ito joined “Study plan”' })).toBeVisible();
    // The sign-in goes as a subprotocol: never in the address, where logs keep it.
    const relay = sockets.filter((u) => u.includes('/parties/page/'));
    expect(relay.length).toBeGreaterThan(0);
    for (const u of relay) expect(u).not.toMatch(/token|test\./);
  });

  await test.step('each sees the other typing, with their name on the cursor', async () => {
    await typeAtEnd(ana, ' Ana was here.');
    await expect(editor(ben)).toContainText('Ana was here.', LIVE);
    await typeAtEnd(ben, ' Ben too.');
    await expect(editor(ana)).toContainText('Ben too.', LIVE);
    await expect(ana.locator('.collaboration-carets__label', { hasText: 'Ben Ito' })).toBeVisible(LIVE);
    await expect(ben.locator('.collaboration-carets__label', { hasText: 'Ana Lima' })).toBeVisible(LIVE);
    // Both started with the same colour; the one who came later took another.
    const colorOf = (page: Page, name: string) => page.locator('.collaboration-carets__label', { hasText: name }).evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect.poll(async () => (await colorOf(ana, 'Ben Ito')) !== (await colorOf(ben, 'Ana Lima')), LIVE).toBe(true);
    // A name shows while its person types, then fades off the words above.
    await typeAtEnd(ben, ' Still here.');
    const benOnAna = ana.locator('.collaboration-carets__caret', { hasText: 'Ben Ito' });
    await expect(benOnAna).toHaveClass(/awake/, LIVE);
    await expect(benOnAna).not.toHaveClass(/awake/, { timeout: 6000 });
    // What he types glows on Ana's side in his colour, then fades away.
    await typeAtEnd(ben, ' Glowing words.');
    const glow = ana.locator('.scroller .remote-glow');
    await expect.poll(() => glow.allTextContents().then((t) => t.join('')), LIVE).toContain('Glowing');
    expect((await glow.allTextContents()).join(''), 'only the new words').not.toContain('Still here');
    const inHisColor = await ana.evaluate(() => {
      const glowing = document.querySelector<HTMLElement>('.scroller .remote-glow')!;
      const caret = [...document.querySelectorAll<HTMLElement>('.collaboration-carets__caret')].find((el) => el.textContent?.includes('Ben Ito'))!;
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = glowing.style.getPropertyValue('--glow');
      const glowColor = getComputedStyle(probe).color;
      probe.remove();
      return glowColor === getComputedStyle(caret).borderLeftColor;
    });
    expect(inHisColor, "in Ben's colour").toBe(true);
    await expect(glow).toHaveCount(0, { timeout: 6000 });
  });

  await test.step("Ana's / menu holds still while Ben types above it", async () => {
    await typeAtEnd(ana, ' /');
    const picked = ana.locator('.suggest .row[aria-selected=true]');
    await expect(picked).toHaveCount(1);
    for (let i = 0; i < 3; i++) await ana.keyboard.press('ArrowDown');
    const choice = await picked.locator('.title').textContent();
    // Ben writes at the start of the page, which moves Ana's "/" along.
    await editor(ben).click();
    await ben.keyboard.press(`${MOD}+Home`);
    await ben.keyboard.type('Ben above. ');
    await expect(editor(ana)).toContainText('Ben above.', LIVE);
    await ana.waitForTimeout(500);
    await expect(picked.locator('.title')).toHaveText(choice!);
    await ana.keyboard.press('Escape');
    await ana.keyboard.press('Backspace');
  });

  await test.step('a new title reaches the other side', async () => {
    await title(ana).click();
    await ana.keyboard.press(`${MOD}+a`);
    await ana.keyboard.type('Midterm plan');
    await expect(title(ben)).toHaveText('Midterm plan', LIVE);
  });

  await test.step('Ben goes offline, both keep typing, and nothing is lost', async () => {
    await ben.context().setOffline(true);
    await expect(ben.locator('.live-chip')).toContainText('Offline', LIVE);
    await typeAtEnd(ben, ' Typed offline.');
    await typeAtEnd(ana, ' Typed meanwhile.');
    await ben.context().setOffline(false);
    for (const page of [ana, ben]) {
      await expect(editor(page)).toContainText('Typed offline.', LIVE);
      await expect(editor(page)).toContainText('Typed meanwhile.', LIVE);
    }
  });

  await test.step('switching tabs keeps Ben in the session', async () => {
    await ben.locator('.titlebar [data-tip="New tab"]').click();
    await typeAtEnd(ana, ' While Ben looked away.');
    await ben.locator('.titlebar [role=tab]', { has: ben.locator('.tab-live') }).click();
    await expect(editor(ben)).toContainText('While Ben looked away.', LIVE);
  });

  await test.step('Ben ends it: both keep the page, written as it was', async () => {
    await ben.locator('.live-chip').click();
    await ben.getByRole('button', { name: 'End Session' }).click();
    await ben.getByRole('button', { name: 'End Session' }).last().click();
    await expect(ana.locator('.toast', { hasText: 'The session with Ben Ito ended. You both keep the page.' })).toBeVisible(LIVE);
    for (const page of [ana, ben]) {
      await expect(page.locator('.tab-live')).toHaveCount(0, LIVE);
      await expect(page.locator('.live-chip')).toHaveCount(0);
      await expect(editor(page)).toContainText('While Ben looked away.');
      await expect(page.locator('.sidebar')).toContainText('Midterm plan');
    }
    expect(cloud.sessions.map((s) => s.status)).toEqual(['ended']);
    // Now each page is private again.
    await typeAtEnd(ana, ' Only mine now.');
    await ben.waitForTimeout(1500);
    await expect(editor(ben)).not.toContainText('Only mine now.');
  });

  await test.step("Ben's copy is an ordinary page, kept after a restart", async () => {
    await ben.waitForTimeout(800);
    await ben.reload();
    await ben.locator('.sidebar').getByText('Midterm plan', { exact: true }).click();
    await expect(editor(ben)).toContainText('Ben too.');
    await expect(ben.locator('.live-chip')).toHaveCount(0);
  });

  await ben.context().close();
});

test('a quiet session lets go of the relay; writing or coming back wakes both sides', async ({ page: ana, browser }) => {
  test.setTimeout(120_000);
  const { ben } = await twoFriends(ana, browser, { idleMs: 3000 });
  const chip = (page: Page) => page.locator('.live-chip');
  await inviteBen(ana);
  await openFriends(ben);
  await ben.getByRole('button', { name: 'Join Ana Lima' }).click();
  await expect(chip(ana)).toContainText('Live with Ben Ito', LIVE);
  await expect(chip(ben)).toContainText('Live with Ana Lima', LIVE);

  await test.step('nobody writes or is at the page: both let go', async () => {
    for (const page of [ana, ben]) await expect(chip(page)).toContainText('· paused', LIVE);
    await chip(ben).click();
    await expect(ben.getByText('Paused: nobody has written here for a while.')).toBeVisible();
    await ben.getByRole('button', { name: 'Done' }).click();
  });

  await test.step("Ana writes: Ben's app wakes up and gets it, without Ben doing anything", async () => {
    await typeAtEnd(ana, ' Back at it.');
    await expect(editor(ben)).toContainText('Back at it.', LIVE);
    await expect(chip(ana)).toHaveText('Live with Ben Ito', LIVE);
    await expect(chip(ben)).toHaveText('Live with Ana Lima', LIVE);
  });

  await test.step('quiet again, then Ben comes back to the page: both catch up', async () => {
    for (const page of [ana, ben]) await expect(chip(page)).toContainText('· paused', LIVE);
    await editor(ben).hover();
    await expect(chip(ben)).toHaveText('Live with Ana Lima', LIVE);
    await expect(chip(ana)).toHaveText('Live with Ben Ito', LIVE);
    await typeAtEnd(ben, ' Ben is back.');
    await expect(editor(ana)).toContainText('Ben is back.', LIVE);
  });

  await ben.context().close();
});

test('in a page written together, a picture from the web waits for a click', async ({ page: ana, browser }) => {
  test.setTimeout(120_000);
  const { ben } = await twoFriends(ana, browser);
  const fetched: string[] = [];
  await ben.route('https://pictures.example/**', (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>' });
  });
  await inviteBen(ana);
  await openFriends(ben);
  await ben.getByRole('button', { name: 'Join Ana Lima' }).click();
  await expect(editor(ben)).toContainText('Before the midterm', LIVE);

  await ana.evaluate(() =>
    (window as unknown as { __editor: { chain(): any } }).__editor
      .chain()
      .focus('end')
      .insertContent({ type: 'image', attrs: { src: 'https://pictures.example/cat.svg' } })
      .run(),
  );
  const waiting = ben.locator('.remote-image');
  await expect(waiting).toContainText('Picture from pictures.example', LIVE);
  expect(fetched, 'nothing loads before the click').toEqual([]);
  await waiting.getByRole('button', { name: 'Show' }).click();
  await expect(waiting.locator('img')).toBeVisible();
  expect(fetched).toEqual(['https://pictures.example/cat.svg']);

  await ben.context().close();
});

test('a picture from the web in a page that was written together still waits for a click once the session ends', async ({ page: ana, browser }) => {
  test.setTimeout(120_000);
  const { ben } = await twoFriends(ana, browser);
  const fetched: string[] = [];
  await ben.route('https://pictures.example/**', (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>' });
  });
  await inviteBen(ana);
  await openFriends(ben);
  await ben.getByRole('button', { name: 'Join Ana Lima' }).click();
  await expect(editor(ben)).toContainText('Before the midterm', LIVE);
  await ana.evaluate(() =>
    (window as unknown as { __editor: { chain(): any } }).__editor
      .chain()
      .focus('end')
      .insertContent({ type: 'image', attrs: { src: 'https://pictures.example/dog.svg' } })
      .run(),
  );
  await expect(ben.locator('.remote-image')).toContainText('Picture from pictures.example', LIVE);

  await ben.locator('.live-chip').click();
  await ben.getByRole('button', { name: 'End Session' }).click();
  await ben.getByRole('button', { name: 'End Session' }).last().click();
  await expect(ben.locator('.tab-live')).toHaveCount(0, LIVE);
  await expect(ben.locator('.remote-image')).toContainText('Picture from pictures.example');

  // Opened again as an ordinary page (after a restart too), it still waits.
  await ben.waitForTimeout(800);
  await ben.reload();
  await ben.locator('.sidebar').getByText('Study plan', { exact: true }).last().click();
  const waiting = ben.locator('.remote-image');
  await expect(waiting).toContainText('Picture from pictures.example');
  await ben.waitForTimeout(500);
  expect(fetched, 'nothing loads before the click').toEqual([]);
  await waiting.getByRole('button', { name: 'Show' }).click();
  await expect(waiting.locator('img')).toBeVisible();
  expect(fetched).toEqual(['https://pictures.example/dog.svg']);

  await ben.context().close();
});

test('asking to write together: the host picks the page, and closing the tab ends it', async ({ page: ana, browser }) => {
  test.setTimeout(90_000);
  const { cloud, ben } = await twoFriends(ana, browser);

  await openFriends(ben);
  await ben.getByRole('button', { name: 'Write with Ana Lima' }).click();
  await ben.getByRole('menuitem', { name: 'One of Their Pages' }).click();
  await expect(ben.locator('.toast', { hasText: 'Asked Ana Lima to write together' })).toBeVisible();

  const asked = ana.locator('.toast', { hasText: 'Ben Ito wants to write together' });
  await expect(asked).toBeVisible(LIVE);
  await asked.getByRole('button', { name: 'Open Cowork' }).click();
  await ana.getByRole('button', { name: 'Choose a page for Ben Ito' }).click();
  await ana.getByRole('menuitem', { name: 'A New Page' }).click();

  await expect(ben.locator('.toast', { hasText: 'Ana Lima shared “With Ben Ito” with you' })).toBeVisible(LIVE);
  for (const page of [ana, ben]) {
    await expect(liveTab(page)).toHaveCount(1, LIVE);
    await expect(title(page)).toHaveText('With Ben Ito', LIVE);
  }
  await typeAtEnd(ben, 'Hello from Ben');
  await expect(editor(ana)).toContainText('Hello from Ben', LIVE);

  await ana.keyboard.press(`${MOD}+w`);
  await expect(ben.locator('.toast', { hasText: 'The session with Ana Lima ended.' })).toBeVisible(LIVE);
  await expect(ben.locator('.tab-live')).toHaveCount(0);
  expect(cloud.sessions.map((s) => s.status)).toEqual(['ended']);
  await ben.context().close();
});

test('an invite can be declined, or withdrawn', async ({ page: ana, browser }) => {
  const { cloud, ben } = await twoFriends(ana, browser);

  await inviteBen(ana);
  await openFriends(ben);
  await expect(friendsPage(ben)).toContainText('“Study plan”', LIVE);
  await ben.getByRole('button', { name: 'Decline Ana Lima' }).click();
  await expect(ana.locator('.toast', { hasText: 'Ben Ito said no this time.' })).toBeVisible(LIVE);
  await expect(ana.locator('.tab-live')).toHaveCount(0);

  // Again from Ana's Friends page, picking the page from her recent ones.
  await openFriends(ana);
  await expect(friendsPage(ana)).not.toContainText('“Study plan”');
  await ana.getByRole('button', { name: 'Write with Ben Ito' }).click();
  await ana.getByRole('menuitem', { name: 'Study plan' }).click();
  await expect(friendsPage(ana)).toContainText('Invited to write “Study plan”');
  await expect(friendsPage(ben)).toContainText('“Study plan”', LIVE);
  await ana.getByRole('button', { name: 'Withdraw invite to Ben Ito' }).click();
  await expect(friendsPage(ben)).not.toContainText('“Study plan”', LIVE);
  expect(cloud.sessions.map((s) => s.status)).toEqual(['declined', 'cancelled']);
  await ben.context().close();
});
