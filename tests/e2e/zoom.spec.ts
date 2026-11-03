// Zoom: Ctrl + scroll, Ctrl + = / - / 0 and Settings make the whole app
// bigger or smaller, and the level is remembered. (In the browser the app
// zooms with CSS; the desktop app asks the webview to zoom.)
import { test, expect, open } from './fixtures';
import type { Page } from '@playwright/test';

const zoom = (page: Page) => page.evaluate(() => Number(document.documentElement.style.zoom || 1));
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('thoughtdesk.prefs.v1') || '{}').zoom ?? 1);

test('zooming with the wheel, the keyboard and Settings', async ({ page }) => {
  await open(page);
  const center = { x: 700, y: 400 };

  await test.step('Ctrl + scroll up zooms in a step, and says so', async () => {
    await page.mouse.move(center.x, center.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(() => zoom(page)).toBe(1.1);
    await expect(page.locator('.toast', { hasText: 'Zoom 110%' })).toBeVisible();
  });

  await test.step('scrolling without Ctrl still scrolls, it never zooms', async () => {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    expect(await zoom(page)).toBe(1.1);
  });

  await test.step('Ctrl + = and Ctrl + - step through the levels', async () => {
    await page.keyboard.press('Control+Equal');
    await expect.poll(() => zoom(page)).toBe(1.25);
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Control+Minus');
    await expect.poll(() => zoom(page)).toBe(0.9);
  });

  await test.step('Ctrl + 0 goes back to 100%', async () => {
    await page.keyboard.press('Control+Digit0');
    await expect.poll(() => zoom(page)).toBe(1);
  });

  await test.step('Settings shows the level and changes it', async () => {
    await page.keyboard.press('Control+Comma');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    const stepper = page.locator('.stepper[aria-label=Zoom]');
    await expect(stepper.locator('.level')).toHaveText('100%');
    await stepper.locator('button[aria-label="Zoom in"]').click();
    await stepper.locator('button[aria-label="Zoom in"]').click();
    await expect(stepper.locator('.level')).toHaveText('125%');
    await expect.poll(() => saved(page)).toBe(1.25);
    await page.keyboard.press('Escape');
  });

  await test.step('the level is there again after a restart', async () => {
    await page.reload();
    await page.locator('.sidebar').waitFor();
    await expect.poll(() => zoom(page)).toBe(1.25);
  });

  await test.step('it stops at the smallest and largest levels', async () => {
    for (let i = 0; i < 12; i++) await page.keyboard.press('Control+Equal');
    await expect.poll(() => zoom(page)).toBe(2);
    for (let i = 0; i < 14; i++) await page.keyboard.press('Control+Minus');
    await expect.poll(() => zoom(page)).toBe(0.67);
    await page.keyboard.press('Control+Digit0');
  });
});

// Text size: only the writing on pages, not the rest of the app.
const pageText = (page: Page) => page.locator('.prose').first().evaluate((el) => getComputedStyle(el).fontSize);
const titleSize = (page: Page) => page.locator('h1.title').evaluate((el) => getComputedStyle(el).fontSize);
const sidebarSize = (page: Page) => page.locator('.sidebar .row .title').first().evaluate((el) => getComputedStyle(el).fontSize);

test('text size changes the writing on pages, and is remembered', async ({ page }) => {
  await open(page);
  await page.click('.sidebar >> text=Getting started');
  await expect(page.locator('h1.title')).toHaveText('Getting started');
  await expect.poll(() => pageText(page)).toBe('16px');
  const sidebar = await sidebarSize(page);

  await test.step('Larger makes page text and the title bigger, not the sidebar', async () => {
    await page.keyboard.press('Control+Comma');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.locator('[role=radiogroup][aria-label="Text size"] button', { hasText: 'Larger' }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => pageText(page)).toBe('20px');
    await expect.poll(() => titleSize(page)).toBe('52px');
    expect(await sidebarSize(page)).toBe(sidebar);
  });

  await test.step('headings and code follow the page text', async () => {
    const sizes = await page.locator('.prose').first().evaluate((el) => {
      const h = el.querySelector('h2');
      const c = el.querySelector('code');
      return { h2: h && getComputedStyle(h).fontSize, code: c && getComputedStyle(c).fontSize };
    });
    if (sizes.h2) expect(sizes.h2).toBe('27.5px');
    if (sizes.code) expect(sizes.code).toBe('17px');
  });

  await test.step('it is there again after a restart', async () => {
    await page.reload();
    await page.locator('.sidebar').waitFor();
    await expect(page.locator('h1.title')).toHaveText('Getting started');
    await expect.poll(() => pageText(page)).toBe('20px');
  });
});

test('"Small text" from before becomes the Small size', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('migrated-check')) {
      localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify({ smallText: true, welcomed: true, lastView: 'page' }));
      localStorage.setItem('migrated-check', '1');
    }
  });
  await open(page);
  await page.click('.sidebar >> text=Getting started');
  await expect(page.locator('h1.title')).toHaveText('Getting started');
  await expect.poll(() => pageText(page)).toBe('15px');
  await page.keyboard.press('Control+Comma');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await expect(page.locator('[role=radiogroup][aria-label="Text size"] button[aria-checked=true]')).toHaveText('Small');
});

test('a setting changed just before a reload is kept', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+Comma');
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.locator('[role=radiogroup][aria-label="Text size"] button', { hasText: 'Larger' }).click();
  // Straight away, inside the wait before settings are written.
  await page.reload();
  await page.locator('.sidebar').waitFor();
  expect(await page.evaluate(() => document.documentElement.dataset.textSize)).toBe('xlarge');
});
