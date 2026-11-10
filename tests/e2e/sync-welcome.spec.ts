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

const note = (page: Page) => page.getByRole('region', { name: 'You get 1 GB of free sync storage' });

async function openAccountPane(page: Page) {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
}

test('with the flag off, nothing about sync shows or is remembered', async ({ page }) => {
  await signedIn(page);
  await open(page);
  await page.waitForTimeout(500);
  await expect(page.getByText('free sync storage')).toHaveCount(0);
  await openAccountPane(page);
  await expect(page.getByRole('button', { name: 'Edit Profile…' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Sync storage' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('thoughtdesk.prefs.v1') ?? '{}').syncWelcomed)).toEqual({});
});

test('signed out, there is no note', async ({ page }) => {
  await beta(page);
  await new FakeCloud().attach(page.context());
  await open(page);
  await page.waitForTimeout(500);
  await expect(note(page)).toHaveCount(0);
});

test('the welcome note shows once per account, and stays gone after a reload', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await open(page);
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('Keep your notes on all your computers, encrypted so only you can read them.');
  await note(page).getByRole('button', { name: 'Got It' }).click();
  await expect(note(page)).toHaveCount(0);
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(500);
  await expect(note(page)).toHaveCount(0);
});

test('another account sees the note again', async ({ page }) => {
  await beta(page);
  const { cloud } = await signedIn(page);
  await open(page);
  await note(page).getByRole('button', { name: 'Got It' }).click();

  cloud.signIn(page.context(), cloud.addUser({ email: 'ben@example.com', name: 'Ben', username: 'ben' }));
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await expect(note(page)).toBeVisible();
});

test('the note waits for the sign-in sheet to close', async ({ page }) => {
  await beta(page);
  const cloud = new FakeCloud();
  cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  await open(page);
  await openAccountPane(page);
  const signIn = page.getByRole('button', { name: 'Sign In…' });
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();

  await page.waitForTimeout(500);
  await expect(note(page), 'not on top of a sheet').toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(note(page)).toBeVisible();
});

test('the note does not show over the welcome screen', async ({ page }) => {
  await beta(page);
  await signedIn(page);
  await page.goto('/?fresh&welcome');
  await expect(page.locator('.welcome')).toHaveCount(1);
  await page.waitForTimeout(500);
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
