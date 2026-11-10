// The page tree: a page dropped on another goes inside it, and a page with
// pages under it shows a branch in place of the plain page icon, wherever it shows.
import { test, expect, open } from './fixtures';
import type { Locator, Page } from '@playwright/test';

const row = (page: Page, title: string) => page.locator('[role=tree][aria-label=Pages] .row', { hasText: title }).first();
/** The icons in a row's icon slot (two only while one gives way to the other). */
const icons = (page: Page, title: string) => row(page, title).locator('.glyph [data-icon]').evaluateAll((els) => els.map((el) => el.getAttribute('data-icon')));

/**
 * Drags `source` with the mouse onto the middle of `target` (into it) or its
 * top edge (just before it), the way a person would.
 */
async function dropOn(page: Page, source: Locator, target: Locator, where: 'inside' | 'before' = 'inside') {
  await source.scrollIntoViewIfNeeded();
  const b = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 6, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, where === 'inside' ? t.y + t.height / 2 : t.y + 4, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.up();
}

test('a page with pages under it shows a branch until the last one leaves', async ({ page }) => {
  await open(page);
  for (const title of ['Trip', 'Packing list']) {
    await page.keyboard.press('Control+n');
    await expect(page.locator('h1.title')).toBeFocused();
    await page.keyboard.type(title);
    await expect(row(page, title)).toBeVisible();
  }
  await expect.poll(() => icons(page, 'Trip')).toEqual(['page']);

  await test.step('dropped on the middle of a page, a page goes inside it, and it branches', async () => {
    await dropOn(page, row(page, 'Packing list'), row(page, 'Trip'));
    await expect(row(page, 'Trip')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => icons(page, 'Trip')).toEqual(['page-tree']);
    await expect.poll(() => icons(page, 'Packing list')).toEqual(['page']);
  });

  await test.step('with the pointer still on it, the new icon stays in view until the pointer moves off', async () => {
    const box = (await row(page, 'Trip').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 1);
    await page.waitForTimeout(300);
    expect(await row(page, 'Trip').locator('.glyph').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.mouse.move(box.x + box.width + 300, box.y);
    await row(page, 'Trip').hover();
    await expect(row(page, 'Trip').locator('.chev')).toHaveCSS('opacity', '1');
    await expect(row(page, 'Trip').locator('.glyph')).toHaveCSS('opacity', '0');
  });

  await test.step('its tab and search show the branch too', async () => {
    await row(page, 'Trip').click({ modifiers: ['Control'] });
    await expect(page.locator('.tab', { hasText: 'Trip' }).locator('.tab-icon [data-icon]')).toHaveAttribute('data-icon', 'page-tree');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Trip');
    await expect(page.locator('.hit', { hasText: 'Trip' }).first().locator('.hit-icon [data-icon]')).toHaveAttribute('data-icon', 'page-tree');
    await page.keyboard.press('Escape');
  });

  await test.step('when its last page moves out, it is a plain page again', async () => {
    await dropOn(page, row(page, 'Packing list'), row(page, 'Trip'), 'before');
    await expect.poll(() => icons(page, 'Trip')).toEqual(['page']);
    await expect(row(page, 'Trip')).not.toHaveAttribute('aria-expanded');
    await expect(page.locator('.tab', { hasText: 'Trip' }).locator('.tab-icon [data-icon]')).toHaveAttribute('data-icon', 'page');
  });

  await test.step('a page with an icon of its own keeps it', async () => {
    await dropOn(page, row(page, 'Trip'), row(page, 'Design review'));
    await expect(row(page, 'Design review')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'Design review').locator('.glyph .emoji')).toHaveCount(1);
    await expect(row(page, 'Design review').locator('.glyph [data-icon]')).toHaveCount(0);
  });
});
