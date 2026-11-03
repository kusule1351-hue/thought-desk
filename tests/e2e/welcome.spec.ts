// The welcome screen on a new install: name, look, a short tour, and its animations.
import { test, expect, open } from './fixtures';
import type { Page } from '@playwright/test';

const root = (page: Page, key: string) => page.evaluate((key) => document.documentElement.dataset[key], key);

/** The welcome step with this heading (the one leaving can linger while it slides out). */
const step = (page: Page, text: string | RegExp) => page.locator('.welcome h1', { hasText: text });

test('a new install walks through the welcome and lands on Home', async ({ page }) => {
  const next = page.locator('.welcome .nav .btn.primary');
  await page.goto('/?fresh&welcome');

  await test.step('it shows with the name field focused, offering Skip', async () => {
    await expect(page.locator('.welcome')).toHaveCount(1);
    await expect(page.locator('.welcome input')).toBeFocused();
    await expect(next).toContainText('Skip');
  });

  await test.step('a name turns Skip into Continue; Enter goes on', async () => {
    await page.keyboard.type('Alex Morgan');
    await expect(next).toContainText('Continue');
    await page.keyboard.press('Enter');
    await expect(step(page, 'Make it yours')).toBeVisible();
  });

  await test.step('app shortcuts wait until it is done', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await expect(page.locator('.palette input, [placeholder^="Search pages"]')).toHaveCount(0);
  });

  await test.step('theme, font and accent apply as you pick them', async () => {
    await page.click('.choice:has-text("Dark")');
    await expect.poll(() => root(page, 'theme')).toBe('dark');
    await page.click('.choice:has-text("Serif")');
    await expect.poll(() => root(page, 'font')).toBe('serif');
    await page.locator('.accent button').nth(6).click();
    await expect.poll(() => root(page, 'accent')).not.toBe('graphite');
    expect(await root(page, 'accent')).toBeTruthy();
  });

  await test.step('the tour, Back, and a done step that uses the first name', async () => {
    await next.click();
    await expect(step(page, 'Three things')).toBeVisible();
    await page.click('.welcome .nav .btn.ghost');
    await expect(step(page, 'Make it yours')).toBeVisible();
    await next.click();
    await expect(step(page, 'Three things')).toBeVisible();
    await next.click();
    await expect(step(page, "You're all set, Alex.")).toBeVisible();
  });

  await test.step('finishing opens Home, greeting by name, with the setup card', async () => {
    await page.keyboard.press('Enter');
    await expect(page.locator('.welcome')).toHaveCount(0);
    await expect(page.locator('.view-title').first()).toHaveText(/, Alex\??$/);
    await expect(page.locator('.setup')).toHaveCount(1);
  });

  await test.step('Settings changes the name and replays the welcome', async () => {
    await page.keyboard.press('Control+,');
    await expect(page.locator('.name-field')).toHaveValue('Alex Morgan');
    await page.locator('.name-field').fill('Sam');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Show Again' }).click();
    await expect(page.locator('.welcome')).toHaveCount(1);
    await expect(page.locator('.welcome input')).toHaveValue('Sam');
  });
});

test.describe('dark scheme', () => {
  test.use({ colorScheme: 'dark' });

  test('Enter alone carries you through', async ({ page }) => {
    await page.goto('/?fresh&welcome');
    await expect(page.locator('.welcome input')).toBeFocused();
    await page.keyboard.type('Priya');
    await page.keyboard.press('Enter');
    await expect(step(page, 'Make it yours')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(step(page, 'Three things')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(step(page, "You're all set, Priya.")).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.welcome')).toHaveCount(0);
    await expect(page.locator('.view-title').first()).toHaveText(/, Priya\??$/);
  });
});

test('someone who used the app before never sees it', async ({ page }) => {
  // The preview decides `welcomed` from the address, so read saved
  // preferences the way the app does, with a fresh copy of the prefs module.
  await open(page);
  const welcomedFrom = (saved: object | null) =>
    page.evaluate(async (saved) => {
      // The copy loaded last saves itself a moment after loading: let it, so
      // it can't overwrite what this check sets up.
      await new Promise((r) => setTimeout(r, 400));
      if (saved) localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify(saved));
      else localStorage.removeItem('thoughtdesk.prefs.v1');
      // A timestamp query (the one Vite itself uses for reloads) gives a new copy.
      const t = Date.now() - Math.floor(Math.random() * 1e6);
      const { prefs } = await import(`/src/lib/prefs.svelte.ts?t=${t}` as string);
      return prefs.welcomed as boolean;
    }, saved);
  // Preferences saved before the welcome existed have no `welcomed` field.
  expect(await welcomedFrom({ theme: 'light' })).toBe(true);
  expect(await welcomedFrom(null)).toBe(false);
  expect(await welcomedFrom({ theme: 'light', welcomed: false })).toBe(false);
});

test.describe('animations', () => {
  test.use({ viewport: { width: 1100, height: 720 } });

  test('the theme reveal finishes and cleans up, even with quick clicks', async ({ page }) => {
    await page.goto('/?fresh&welcome');
    await expect(page.locator('.welcome input')).toBeFocused();
    await page.keyboard.type('Alex');
    await page.keyboard.press('Enter');
    await expect(step(page, 'Make it yours')).toBeVisible();

    await test.step('the engine has view transitions', async () => {
      expect(await page.evaluate(() => typeof (document as any).startViewTransition)).toBe('function');
    });

    await test.step('a dark reveal lands and leaves nothing behind', async () => {
      await page.click('.choice:has-text("Dark")');
      await expect.poll(() => root(page, 'theme')).toBe('dark');
      await expect.poll(() => root(page, 'lookChange')).toBeUndefined();
    });

    await test.step('clicks during a transition both apply', async () => {
      await page.click('.choice:has-text("Light")');
      await page.waitForTimeout(80);
      await page.click('.choice:has-text("Serif")');
      await expect.poll(() => Promise.all([root(page, 'theme'), root(page, 'font')])).toEqual(['light', 'serif']);
      await expect.poll(() => root(page, 'lookChange')).toBeUndefined();
    });

    await test.step('the welcome leaves after its exit animation', async () => {
      const next = page.locator('.welcome .nav .btn.primary');
      await next.click();
      await expect(step(page, 'Three things')).toBeVisible();
      await next.click();
      await expect(step(page, "You're all set")).toBeVisible();
      await next.click();
      await expect(page.locator('.welcome')).toHaveCount(0);
    });

    await test.step('Ctrl+Shift+L switches the theme with a reveal', async () => {
      await page.keyboard.press('Control+Shift+L');
      await expect.poll(() => root(page, 'theme')).not.toBe('light');
      await expect.poll(() => root(page, 'lookChange')).toBeUndefined();
    });
  });

  test.describe('with reduced motion', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('the done step shows at once, without animations', async ({ page }) => {
      await page.goto('/?fresh&welcome');
      await expect(page.locator('.welcome input')).toBeFocused();
      for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
      await expect(step(page, "You're all set")).toBeVisible();
      await expect(page.locator('.welcome')).toHaveClass(/still/);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tick')!).strokeDashoffset)).toMatch(/^0(px)?$/);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.disc')!).animationName)).toBe('none');
    });
  });
});
