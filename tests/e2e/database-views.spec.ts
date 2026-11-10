// Databases: the seeded example, its views, copies, inline and linked
// databases in a page, and covers taken from a row's page.
import { test, expect, open } from './fixtures';

test('the example database opens in each of its views', async ({ page }) => {
  await open(page);
  await page.click('.sidebar >> text=Reading list');
  for (const view of ['Shelf', 'By status', 'Table']) {
    await test.step(`the ${view} view`, async () => {
      await page.click(`.tab:has-text("${view}")`);
      await expect(page.locator('.tab.active, .tab[aria-selected=true]', { hasText: view })).toBeVisible();
    });
  }
  await expect(page.locator('.td[data-r="0"][data-c="0"]')).toContainText('The Left Hand of Darkness');
});

// A database's rows are read when it's first shown, not at start-up.
test('a row opened from search, before its database, shows its properties', async ({ page }) => {
  await open(page);
  await test.step('the sidebar counts rows without the database being opened', async () => {
    await expect(page.locator('.db-row:has-text("Reading list") .count')).toHaveText(/^[1-9]/);
  });
  await test.step('search opens the row, and its values come with it', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Left Hand of Darkness');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await expect(page.locator('h1.title')).toHaveText('The Left Hand of Darkness');
    await expect(page.locator('.props[aria-label=Properties]')).toBeVisible();
    await expect(page.locator('.props .db-link')).toContainText('Reading list');
  });
  await test.step('and its database then opens with every row', async () => {
    await page.click('.props .db-link');
    await page.click('.tab:has-text("Table")');
    await expect(page.locator('.td[data-r="0"][data-c="0"]')).toContainText('The Left Hand of Darkness');
  });
});

test('duplicating a database copies its rows and views', async ({ page }) => {
  await open(page);
  const rows = page.locator('.db-row');
  const before = await rows.count();

  await test.step('Duplicate from the sidebar menu', async () => {
    await page.locator('.db-row:has-text("Reading list")').hover();
    await page.locator('.db-row:has-text("Reading list") .row-more').click();
    await page.click('.menu .item:has-text("Duplicate")');
    await expect(rows).toHaveCount(before + 1);
    await expect(page.locator('h1.title')).toHaveText('Reading list (copy)');
    await expect(page.locator('.db-row:has-text("Reading list (copy)") .count')).toHaveText(/^[1-9]/);
  });

  await test.step('the copy has every view', async () => {
    for (const view of ['Shelf', 'By status', 'Table']) {
      await page.click(`.tab:has-text("${view}")`);
      await page.waitForTimeout(150);
    }
  });

  await test.step('a row of the copy opens as a page', async () => {
    const cell = page.locator('.td[data-r="0"][data-c="0"]');
    await cell.hover();
    await cell.locator('.open').click({ force: true });
    await expect(page.locator('h1.title')).toHaveText('The Left Hand of Darkness');
  });
});

test('inline and linked databases in a page; search finds rows by value', async ({ page }) => {
  await open(page);
  await page.click('[role=tree][aria-label=Pages] .row >> text=Projects');
  await page.click('.ProseMirror');

  await test.step('/database inserts a new database in the page', async () => {
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/database');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.click('.tile:has-text("Tasks")');
    await expect(page.locator('.database-block .dbv')).toHaveCount(1);
  });

  await test.step('rows can be added to it in place', async () => {
    await page.click('.database-block .tab:has-text("All tasks")');
    await page.click('.database-block .new');
    await page.waitForTimeout(300);
    await page.keyboard.type('Inline row works');
    await page.keyboard.press('Enter');
    await expect(page.locator('.database-block')).toContainText('Inline row works');
  });

  await test.step('/linked shows an existing database', async () => {
    await page.click('.ProseMirror p >> nth=0');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/linked');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.click('.menu .item:has-text("Reading list")');
    await expect(page.locator('.database-block .dbv')).toHaveCount(2);
  });

  await test.step('search finds a row by one of its values', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Le Guin');
    await expect(page.locator('text=Database Rows')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test("a gallery card takes its cover from the first picture in the row's page", async ({ page }) => {
  // A tiny PNG standing in for a picture copied from the web.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.route('**/cover-test.png', (route) => route.fulfill({ contentType: 'image/png', body: png }));
  await open(page);
  await page.click('.sidebar >> text=Reading list');
  await page.click('.tab:has-text("Shelf")');
  const covers = page.locator('.gallery .cover img');
  const before = await covers.count();

  await page.click('.tab:has-text("Table")');
  const cell = page.locator('.td[data-r="1"][data-c="0"]');
  await cell.hover();
  await cell.locator('.open').click({ force: true });
  await page.click('.ProseMirror');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', `<img src="${location.origin}/cover-test.png">`);
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.ProseMirror img')).toHaveCount(1);
  await page.waitForTimeout(800);

  await page.click('.db-row:has-text("Reading list") .nav-main');
  await page.click('.tab:has-text("Shelf")');
  await expect(covers).toHaveCount(before + 1);
});

// After a while in the background the app lets go of rows it isn't showing.
test('rows let go in the background come back when the database is shown', async ({ page }) => {
  await open(page);
  await page.click('.sidebar >> text=Reading list');
  await page.click('.tab:has-text("Table")');
  await expect(page.locator('.td[data-r="0"][data-c="0"]')).toContainText('The Left Hand of Darkness');
  await page.click('.sidebar >> text=Getting started');
  await expect(page.locator('h1.title')).toHaveText('Getting started');

  await test.step('rows of a database off screen are let go', async () => {
    const left = await page.evaluate(async () => {
      const dbs = (window as unknown as { databases: { release(): Promise<void>; rows: Record<string, unknown> } }).databases;
      await dbs.release();
      return Object.keys(dbs.rows).length;
    });
    expect(left).toBe(0);
    await expect(page.locator('.db-row:has-text("Reading list") .count')).toHaveText(/^[1-9]/);
  });

  await test.step('and come back when it opens again', async () => {
    await page.click('.sidebar >> text=Reading list');
    await page.click('.tab:has-text("Table")');
    await expect(page.locator('.td[data-r="0"][data-c="0"]')).toContainText('The Left Hand of Darkness');
  });
});

// Menus of a database inside a page float over the page, whole.
test('a database in a page opens its menus in full', async ({ page }) => {
  await open(page);
  await page.click('[role=tree][aria-label=Pages] .row >> text=Projects');
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/database');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.click('.tile:has-text("Tasks")');
  await expect(page.locator('.database-block .dbv')).toHaveCount(1);

  await page.click('.database-block .tab:has-text("All tasks")');
  await page.locator('.database-block button[aria-label="Add a property"]').click();
  const menu = page.locator('.popover[aria-label="Add a property"]');
  await expect(menu).toBeVisible();
  // Every type in the list can be reached: scrolled into view, it's the
  // thing under the pointer (not cut off by the page block around it).
  for (const type of ['Text', 'Relation', 'Last edited']) {
    const item = menu.getByRole('button', { name: type, exact: true });
    await item.scrollIntoViewIfNeeded();
    const b = (await item.boundingBox())!;
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.popover')?.getAttribute('aria-label') ?? null, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    expect(hit, `${type} is visible`).toBe('Add a property');
  }
  // And the menu sits inside the window.
  const m = (await menu.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.y + m.height).toBeLessThanOrEqual(vh);
});

// A new editor's selection is at the very start of the page; when that is a
// database, the block was drawn selected (a wash over the whole table) every
// time the page was opened, until someone clicked somewhere.
test('a page that begins with a database opens with nothing selected', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+n');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/database');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.click('.tile:has-text("Tasks")');
  const block = page.locator('.ProseMirror > .database-block');
  await expect(block.locator('.dbv')).toHaveCount(1);
  // The database is the page's first block, with a line of text under it.
  await expect(page.locator('.ProseMirror > *').first()).toHaveClass(/database-block/);
  await page.waitForTimeout(600);

  // Closing the app and opening it again comes back to this page.
  await page.reload();
  await expect(block.locator('.dbv')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.locator('.ProseMirror-selectednode')).toHaveCount(0);
  // The selection rests in the line of text under it instead.
  expect(await page.evaluate(() => (window as unknown as { __editor: { state: { selection: { toJSON(): { type: string } } } } }).__editor.state.selection.toJSON().type)).toBe('text');

  // Selected on purpose, it has its outline and no wash (the table's header and rules would show through it).
  await page.evaluate(() => (window as unknown as { __editor: { commands: { setNodeSelection(pos: number): boolean } } }).__editor.commands.setNodeSelection(0));
  await expect(block).toHaveClass(/ProseMirror-selectednode/);
  const look = await block.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, shadow: cs.boxShadow, outline: cs.outlineStyle };
  });
  expect(look).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none', outline: 'solid' });
});
