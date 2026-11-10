// Motion: views, sheets and the sidebar animate, and sit still for people who ask for reduced motion.
import { test, expect, open } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Does `action`, then records `read` on every frame for `ms`: what an
 * animation passes through, without racing it from the test side.
 */
async function frames<T>(page: Page, read: () => T, action: () => Promise<void>, ms = 450): Promise<T[]> {
  await page.evaluate(
    ({ read, ms }) => {
      const fn = new Function(`return (${read})()`) as () => unknown;
      const seen: unknown[] = [];
      (window as any).__frames = seen;
      const end = performance.now() + ms;
      const tick = () => {
        seen.push(fn());
        if (performance.now() < end) requestAnimationFrame(tick);
        else (window as any).__framesDone = true;
      };
      (window as any).__framesDone = false;
      requestAnimationFrame(tick);
    },
    { read: read.toString(), ms },
  );
  await action();
  await page.waitForFunction(() => (window as any).__framesDone);
  return page.evaluate(() => (window as any).__frames);
}

/** The names of the animations running on the current view. */
const routeAnimations = () =>
  (document.querySelector('.scroller > *')?.getAnimations() ?? []).map((a) => (a as CSSAnimation).animationName ?? '').join(',');

const sidebarWidth = () => document.querySelector('.sidebar-slot')?.getBoundingClientRect().width ?? 0;

/** How much each page icon in the tree is scaled (1 at rest). */
const iconScales = () =>
  [...document.querySelectorAll('[role=tree][aria-label=Pages] .glyph .swap')].map((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 1 : new DOMMatrix(t).a;
  });

/** A new page called `title`, and its row in the tree. */
async function newPage(page: Page, title: string) {
  await page.keyboard.press('Control+n');
  await expect(page.locator('h1.title')).toBeFocused();
  await page.keyboard.type(title);
  const row = page.locator('[role=tree][aria-label=Pages] .row', { hasText: title });
  await expect(row).toBeVisible();
  return row;
}

test('views slide in the direction you move', async ({ page }) => {
  await open(page);
  const played = async (key: string) => (await frames(page, routeAnimations, () => page.keyboard.press(key))).filter(Boolean);

  await test.step('going to a view slides it in, and it comes to rest', async () => {
    const seen = await played('Control+2');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => /route-in$/.test(n))).toBe(true);
    await expect.poll(() => page.evaluate(routeAnimations)).toBe('');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scroller > *')!).transform)).toBe('none');
  });

  await test.step('back and forward slide their own ways', async () => {
    expect((await played('Alt+ArrowLeft')).some((n) => /route-back$/.test(n))).toBe(true);
    expect((await played('Alt+ArrowRight')).some((n) => /route-forward$/.test(n))).toBe(true);
  });

  await test.step('opening a page slides it in', async () => {
    const seen = await frames(page, routeAnimations, () => page.click('.sidebar .row >> text=Design review'));
    expect(seen.some((n) => /route-in$/.test(n))).toBe(true);
  });
});

test('sheets animate open and closed', async ({ page }) => {
  await open(page);
  const modalAnimations = () => document.querySelector('.modal')?.getAnimations().length ?? -1;
  const opening = await frames(page, modalAnimations, () => page.keyboard.press('Control+Comma'));
  expect(opening.some((n) => n > 0)).toBe(true);
  await expect.poll(() => page.evaluate(modalAnimations)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('the sidebar slides closed and open, and still resizes', async ({ page }) => {
  await open(page);
  const full = await page.evaluate(sidebarWidth);
  expect(full).toBeGreaterThan(150);
  const between = (widths: number[]) => widths.filter((w) => w > 1 && w < full - 1);

  await test.step('it narrows on its way out', async () => {
    const widths = await frames(page, sidebarWidth, () => page.keyboard.press('Control+Backslash'));
    expect(between(widths).length).toBeGreaterThan(0);
    await expect(page.locator('.sidebar-slot')).toHaveCount(0);
  });

  await test.step('it widens on its way back, and comes to rest', async () => {
    const widths = await frames(page, sidebarWidth, () => page.keyboard.press('Control+Backslash'));
    expect(between(widths).length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(sidebarWidth)).toBe(full);
    await expect.poll(() => page.locator('.sidebar-slot').getAttribute('style')).toBeFalsy();
  });

  await test.step('dragging its edge resizes it', async () => {
    const edge = (await page.locator('.resizer').boundingBox())!;
    await page.mouse.move(edge.x + 2, edge.y + 300);
    await page.mouse.down();
    await page.mouse.move(edge.x + 62, edge.y + 300, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(sidebarWidth)).toBeGreaterThan(full + 40);
  });
});

test('a page icon turns into a branch and back softly, without overshooting', async ({ page }) => {
  await open(page);
  const trip = await newPage(page, 'Trip');
  const icon = () => trip.locator('.glyph [data-icon]').evaluateAll((els) => els.map((el) => el.getAttribute('data-icon')));

  await test.step('its first sub-page: the branch grows in as the page icon shrinks away', async () => {
    await trip.hover();
    const scales = (await frames(page, iconScales, () => trip.locator('button[data-tip="Add a page inside"]').click())).flat();
    expect(scales.some((s) => s < 0.95)).toBe(true);
    expect(scales.every((s) => s <= 1)).toBe(true);
    await expect.poll(icon).toEqual(['page-tree']);
  });

  await test.step('its last one gone: the page icon comes back the same way', async () => {
    await page.locator('[role=tree][aria-label=Pages] .row', { hasText: 'Untitled' }).click({ button: 'right' });
    const scales = (await frames(page, iconScales, () => page.getByRole('menuitem', { name: 'Move to Trash' }).click())).flat();
    expect(scales.some((s) => s < 0.95)).toBe(true);
    expect(scales.every((s) => s <= 1)).toBe(true);
    await expect.poll(icon).toEqual(['page']);
  });
});

// The resize handle reaches 4px past the sidebar's edge; the page must not cover that half.
test('the whole resize handle can be grabbed', async ({ page }) => {
  await open(page);
  const edge = (await page.locator('.resizer').boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains('resizer'), [edge.x + edge.width - 2, edge.y + 300]);
  expect(hit).toBe(true);
});

test.describe('with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('views, sheets and the sidebar change at once', async ({ page }) => {
    await open(page);
    const views = await frames(page, routeAnimations, () => page.keyboard.press('Control+2'));
    expect(views.filter(Boolean)).toEqual([]);

    const sheets = await frames(page, () => document.querySelector('.modal')?.getAnimations().length ?? 0, () => page.keyboard.press('Control+Comma'));
    await expect(page.locator('.modal')).toBeVisible();
    expect(sheets.every((n) => n === 0)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);

    const full = await page.evaluate(sidebarWidth);
    const widths = await frames(page, sidebarWidth, () => page.keyboard.press('Control+Backslash'));
    expect(widths.every((w) => w === 0 || w === full)).toBe(true);
    await expect(page.locator('.sidebar-slot')).toHaveCount(0);
  });

  test('a page icon turns into a branch at once', async ({ page }) => {
    await open(page);
    const trip = await newPage(page, 'Trip');
    const scales = (await frames(page, iconScales, () => trip.locator('button[data-tip="Add a page inside"]').click())).flat();
    expect(scales.every((s) => s === 1)).toBe(true);
    await expect(trip.locator('.glyph [data-icon]')).toHaveAttribute('data-icon', 'page-tree');
  });
});
