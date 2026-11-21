// A note reopens where it was last scrolled to, not at the top.
import { test, expect, open } from './fixtures';

test('a long note reopens where it was left, after another note and after a restart', async ({ page }) => {
  await open(page);
  const scroller = page.locator('.panes > .scroller');
  const top = () => scroller.evaluate((el) => Math.round(el.scrollTop));

  await page.click('.sidebar [aria-label="Pages"] >> text=Study plan');
  // A plain line: the middle of the note may hold something a click opens or ticks.
  await page.locator('.prose p').last().click();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 90; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('the far end');

  // Read somewhere in the middle, the way a person gets there.
  await scroller.hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(top).toBeGreaterThan(200);
  await page.waitForTimeout(200);
  const left = await top();

  await test.step('a note opened for the first time starts at the top', async () => {
    await page.click('.sidebar [aria-label="Pages"] >> text=Getting started');
    await expect(page.locator('h1.title')).toHaveText('Getting started');
    await expect.poll(top).toBe(0);
  });

  await test.step('going back to the long note returns to the place', async () => {
    await page.click('.sidebar [aria-label="Pages"] >> text=Study plan');
    await expect(page.locator('h1.title')).toHaveText('Study plan');
    await expect.poll(top).toBe(left);
    // And it stays there once the note has finished drawing.
    await page.waitForTimeout(500);
    expect(await top()).toBe(left);
  });

  await test.step('so does closing the app and opening it again', async () => {
    await page.reload();
    await page.locator('.sidebar').waitFor();
    await expect(page.locator('h1.title')).toHaveText('Study plan');
    await expect.poll(top).toBe(left);
  });

  await test.step('scrolling back to the top is remembered too', async () => {
    await scroller.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(top).toBe(0);
    await page.click('.sidebar [aria-label="Pages"] >> text=Getting started');
    await expect(page.locator('h1.title')).toHaveText('Getting started');
    await page.click('.sidebar [aria-label="Pages"] >> text=Study plan');
    await expect(page.locator('h1.title')).toHaveText('Study plan');
    await page.waitForTimeout(400);
    expect(await top()).toBe(0);
  });

  await test.step('the side of split view keeps its place in a note as well', async () => {
    const side = page.locator('.side .pane-scroller');
    const sideTop = () => side.evaluate((el) => Math.round(el.scrollTop));
    const name = page.locator('.side .pane-head');
    await page.click('.sidebar [aria-label="Pages"] >> text=Getting started');
    await expect(page.locator('h1.title')).toHaveText('Getting started');
    await page.click('.sidebar [aria-label="Pages"] >> text=Study plan', { modifiers: ['Alt'] });
    await expect(name).toContainText('Study plan');
    await side.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(sideTop).toBeGreaterThan(200);
    await page.waitForTimeout(200);
    const leftAt = await sideTop();

    await page.click('.sidebar [aria-label="Pages"] >> text=Projects', { modifiers: ['Alt'] });
    await expect(name).toContainText('Projects');
    await page.click('.sidebar [aria-label="Pages"] >> text=Study plan', { modifiers: ['Alt'] });
    await expect(name).toContainText('Study plan');
    await expect.poll(sideTop).toBe(leftAt);
  });
});
