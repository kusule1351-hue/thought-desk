// Sync's first touches, behind a hidden flag: the one-time welcome note about
// the free storage, and the storage meter in Settings → Account.
import type { Page } from '@playwright/test';
import { test, expect, open, MOD } from './fixtures';
import { FakeCloud } from './fake-cloud';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Turns the flag on, and sets what the usage stub answers, before the app starts. */
async function beta(page: Page, usage?: unknown) {
  await page.addInitScript((usage) => {
    (window as unknown as { __syncBeta: boolean }).__syncBeta = true;
    if (usage !== undefined) (window as unknown as { __syncUsage: unknown }).__syncUsage = usage;
  }, usage);
}

/** A cloud with Ana signed in on this browser profile. */
async function signedIn(page: Page) {
  const cloud = new FakeCloud();
  const user = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  cloud.signIn(page.context(), user);
  return { cloud, user };
}

const note = (page: Page) => page.getByRole('dialog', { name: 'You get 1 GB of free sync storage' });
/** Long enough for the pop-up to have come, had it been going to. */
const SETTLED = 1200;

async function openAccountPane(page: Page) {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
}

test('with the flag off, nothing about sync shows or is remembered', async ({ page }) => {
  await signedIn(page);
  await open(page);
  await page.waitForTimeout(SETTLED);
  await expect(page.getByText('free sync storage')).toHaveCount(0);
  await openAccountPane(page);
  await expect(page.getByRole('button', { name: 'Edit Profile…' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Sync storage' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('thoughtdesk.prefs.v1') ?? '{}').syncWelcomed)).toEqual({});
});

test('signed out, the note shows as the app opens: its button leads to signing in, then to Settings → Account', async ({ page }) => {
  await beta(page);
  const cloud = new FakeCloud();
  cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  await open(page);
  await expect(note(page)).toBeVisible();
  await expect(note(page).getByRole('button', { name: 'Set Up Sync' })).toHaveCount(0);
  await note(page).getByRole('button', { name: 'Sign In to Set Up' }).click();
  await expect(note(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Signed in from the note: on to where sync is turned on, and the note doesn't come back.
  await expect(page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Turn On Sync' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLED);
  await expect(note(page)).toHaveCount(0);
});

test('signed out and not interested: "Got It" closes it for good, and signing in later does not bring it back', async ({ page }) => {
  await beta(page);
  const cloud = new FakeCloud();
  const user = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  await open(page);
  await note(page).getByRole('button', { name: 'Got It' }).click();
  await expect(note(page)).toHaveCount(0);

  cloud.signIn(page.context(), user);
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(SETTLED);
  await expect(note(page)).toHaveCount(0);
});

test('the note shows once, in the middle of the window, and stays gone after a reload', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await open(page);
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('Keep your notes on all your computers, encrypted so only you can read them.');
  // Once it has settled, it sits in the middle, both ways.
  await page.waitForTimeout(700);
  const box = (await note(page).boundingBox())!;
  const view = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(2);
  // Focus is on the card, not a button: a key already on its way down chooses nothing.
  await expect(note(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(note(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(note(page).getByRole('button', { name: 'Set Up Sync' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(note(page).getByRole('button', { name: 'Got It' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(note(page).getByRole('button', { name: 'Set Up Sync' })).toBeFocused();

  await note(page).getByRole('button', { name: 'Got It' }).click();
  await expect(note(page)).toHaveCount(0);
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(SETTLED);
  await expect(note(page)).toHaveCount(0);
});

test('Escape and a click beside it close it for good too', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await open(page);
  await expect(note(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(note(page)).toHaveCount(0);
  expect(await page.evaluate(async () => Object.keys((await import('/src/lib/prefs.svelte.ts')).prefs.syncWelcomed).length)).toBe(1);

  await page.evaluate(async () => {
    (await import('/src/lib/prefs.svelte.ts')).prefs.syncWelcomed = {};
  });
  await expect(note(page)).toBeVisible();
  await page.mouse.click(20, 400);
  await expect(note(page)).toHaveCount(0);
});

test('once per computer: another account does not see it again', async ({ page }) => {
  await beta(page);
  const { cloud } = await signedIn(page);
  await open(page);
  await note(page).getByRole('button', { name: 'Got It' }).click();

  cloud.signIn(page.context(), cloud.addUser({ email: 'ben@example.com', name: 'Ben', username: 'ben' }));
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(SETTLED);
  await expect(note(page)).toHaveCount(0);
});

test('the note steps aside for a sheet opened over it, and comes back when that closes', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await open(page);
  await expect(note(page)).toBeVisible();
  await page.keyboard.press(`${MOD}+Comma`);
  await expect(page.getByRole('tablist', { name: 'Settings' })).toBeVisible();
  await expect(note(page), 'not on top of a sheet').toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(note(page)).toBeVisible();
});

test('the note does not show over the welcome screen', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await page.goto('/?fresh&welcome');
  await expect(page.locator('.welcome')).toHaveCount(1);
  await page.waitForTimeout(SETTLED);
  await expect(note(page)).toHaveCount(0);
});

test('"Set Up Sync" opens Settings on Account', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await open(page);
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').nth(1).click();
  await page.keyboard.press('Escape');
  await note(page).getByRole('button', { name: 'Set Up Sync' }).click();
  await expect(note(page)).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Edit Profile…' })).toBeVisible();
});

test('the note fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await beta(page);
  await signedIn(page);
  await open(page);
  const box = await note(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(note(page).getByRole('button', { name: 'Got It' })).toBeVisible();
});

test.describe('the storage meter', () => {
  const bar = (page: Page) => page.getByRole('progressbar', { name: 'Sync storage' });

  async function meter(page: Page, usage: unknown) {
    await beta(page, usage);
    await signedIn(page);
    await open(page);
    await note(page).getByRole('button', { name: 'Got It' }).click();
    await openAccountPane(page);
  }

  test('normal', async ({ page }) => {
    await meter(page, { used: 120 * MB, limit: GB });
    await expect(page.getByText('120 MB of 1 GB used')).toBeVisible();
    await expect(bar(page)).toHaveAttribute('aria-valuemin', '0');
    await expect(bar(page)).toHaveAttribute('aria-valuemax', String(GB));
    await expect(bar(page)).toHaveAttribute('aria-valuenow', String(120 * MB));
    await expect(bar(page)).toHaveAttribute('aria-valuetext', '120 MB of 1 GB used');
  });

  test('over 90% says how much is left', async ({ page }) => {
    await meter(page, { used: 950 * MB, limit: GB });
    await expect(page.getByText('950 MB of 1 GB used · 74 MB left')).toBeVisible();
    await expect(bar(page)).toHaveAttribute('aria-valuenow', String(950 * MB));
  });

  test('full says changes stay on this computer', async ({ page }) => {
    await meter(page, { used: GB, limit: GB });
    await expect(page.getByText('Sync storage is full. New changes stay on this computer until you free up space.')).toBeVisible();
    await expect(bar(page)).toHaveAttribute('aria-valuenow', String(GB));
  });

  test('loading is a muted line', async ({ page }) => {
    await meter(page, 'loading');
    await expect(page.getByText('Checking sync storage…')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
  });

  test('failing is a muted line, not a toast', async ({ page }) => {
    await meter(page, 'error');
    await expect(page.getByText("Couldn't check sync storage right now.")).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await meter(page, { used: 120 * MB, limit: GB });
    await expect(page.getByText('120 MB of 1 GB used')).toBeVisible();
  });
});
