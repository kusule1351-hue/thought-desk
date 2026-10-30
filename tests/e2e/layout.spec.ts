// Views lay themselves out for the width of their pane, not the window: in
// split view or a narrow window, nothing spills out sideways.
import { test, expect, open } from './fixtures';
import type { Page } from '@playwright/test';

const VIEWS: [string, (page: Page) => Promise<unknown>][] = [
  ['Home', (p) => p.click('.sidebar >> text=Home')],
  ['Assignments', (p) => p.click('.sidebar >> text=Assignments')],
  ['the month calendar', (p) => p.click('.sidebar >> text=Calendar')],
  [
    'the week calendar',
    async (p) => {
      await p.click('.sidebar >> text=Calendar');
      await p.click('.scroller button:has-text("Week")');
    },
  ],
  ['Files', (p) => p.click('.sidebar >> text=Files')],
  ['Flashcards', (p) => p.click('.sidebar >> text=Flashcards')],
  ['Galaxy', (p) => p.click('.sidebar >> text=Galaxy')],
  ['a course', (p) => p.click('.sidebar >> text=Biology')],
  ['a tag', (p) => p.click('.sidebar >> text=#exam')],
  ['a database', (p) => p.click('.sidebar .db-row >> text=Reading list')],
];

const CASES = [
  // Half of a wide window: Home and courses drop to one column.
  { name: 'beside a split view', width: 1360, prefs: { splitOpen: true, splitRatio: 0.5 }, below: 'data-below-720', homeColumns: 1 },
  // A smaller window: still room for two columns on Home.
  { name: 'in a narrow window', width: 1000, prefs: {}, below: 'data-below-820', homeColumns: 2 },
];

/** How many columns a grid lays out. */
const columns = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

for (const { name, width, prefs, below, homeColumns } of CASES) {
  test(`views fit their pane ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.addInitScript((pr) => {
      if (sessionStorage.getItem('seeded')) return;
      localStorage.setItem('thoughtdesk.prefs.v1', JSON.stringify({ welcomed: true, ...pr }));
      sessionStorage.setItem('seeded', '1');
    }, prefs);
    await open(page);
    const scroller = page.locator('.panes > .scroller');

    await test.step('the main pane knows it is narrow', async () => {
      await expect(scroller).toHaveAttribute(below, '');
    });

    for (const [view, go] of VIEWS) {
      await test.step(`${view} fits its pane`, async () => {
        await go(page);
        await page.waitForTimeout(500);
        await page.mouse.move(5, 810);
        await expect
          .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${view} overflows` })
          .toBeLessThanOrEqual(1);
        if (view === 'Home') expect(await columns(page, '.scroller .columns'), 'Home columns').toBe(homeColumns);
        if (view === 'a course') expect(await columns(page, '.scroller .columns'), 'course columns').toBe(homeColumns);
        if (view === 'the month calendar') {
          // The day panel moves under the month instead of squeezing it.
          const grid = (await page.locator('.scroller .grid-wrap').boundingBox())!;
          const panel = (await page.locator('.scroller .panel').boundingBox())!;
          expect(panel.y, 'day panel sits under the month').toBeGreaterThanOrEqual(grid.y + grid.height - 1);
        }
      });
    }
  });
}
