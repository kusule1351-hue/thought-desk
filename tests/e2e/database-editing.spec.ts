// Databases: making one from a template and editing it as a board and a
// table — pickers, numbers and sums, formulas, pasting from a spreadsheet,
// keyboard editing, changing a property's type, and undo.
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const cell = (page: Page, r: number, c: number) => page.locator(`.td[data-r="${r}"][data-c="${c}"]`);
const colOf = async (page: Page, name: string) =>
  (await page.locator('.head .th').allTextContents()).findIndex((t) => t.trim().startsWith(name));

/** Makes a database from one of the templates in the new-database sheet. */
async function newDatabase(page: Page, template: string, name?: string) {
  await page.click('.section-head:has-text("Databases") .section-add', { force: true });
  await page.click(`.tile:has-text("${template}")`);
  await page.waitForTimeout(500);
  if (name) await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
}

/** Pastes tab-separated text into the table, as a copy from a spreadsheet would. */
async function pasteIntoGrid(page: Page, text: string) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector('.grid')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);
}

test('a new task database: rows, status, dates and priority', async ({ page }) => {
  await open(page);
  await newDatabase(page, 'Tasks', 'Homework');
  await expect(page.locator('h1.title')).toHaveText('Homework');

  await test.step('rows are added from the table', async () => {
    await page.click('.tab:has-text("All tasks")');
    await page.click('button.new');
    await page.waitForTimeout(300);
    await page.keyboard.type('Essay on Middlemarch');
    await page.keyboard.press('Enter');
    await page.click('button.new');
    await page.waitForTimeout(300);
    await page.keyboard.type('Lab report');
    await page.keyboard.press('Tab');
    await expect(page.locator('.td[data-c="0"]', { hasText: 'Essay on Middlemarch' })).toBeVisible();
    await expect(page.locator('.td[data-c="0"]', { hasText: 'Lab report' })).toBeVisible();
    const titles = await page.locator('.td[data-c="0"]').allInnerTexts();
    expect(titles.at(-1), 'New adds rows at the bottom').toContain('Lab report');
  });

  await test.step('the status picker sets a status', async () => {
    await cell(page, 0, 1).click();
    await page.click('.db-pop .opt:has-text("In progress")');
    await expect(cell(page, 0, 1)).toContainText('In progress');
  });

  await test.step('the date picker reads "tomorrow 3pm"', async () => {
    await cell(page, 0, 2).click();
    await page.waitForTimeout(200);
    await page.keyboard.type('tomorrow 3pm');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await expect(cell(page, 0, 2)).toContainText(/3(:00)?\s?PM/i);
  });

  await test.step('typing in a select picker searches; Enter picks', async () => {
    await cell(page, 1, 3).click();
    await page.waitForTimeout(200);
    await page.keyboard.type('hig');
    await page.keyboard.press('Enter');
    await expect(cell(page, 1, 3)).toContainText('High');
  });

  await test.step('a new choice has a … menu that renames and deletes it', async () => {
    await cell(page, 0, 3).click();
    await page.waitForTimeout(200);
    await page.keyboard.type('Someday');
    await page.keyboard.press('Enter');
    await expect(cell(page, 0, 3)).toContainText('Someday');
    await cell(page, 0, 3).click();
    await page.click('.db-pop .opt-row:has-text("Someday") .more');
    // It used to open inside the picker, out of sight (issue #33).
    const edit = page.getByRole('dialog', { name: 'Edit choice' });
    await expect(edit).toBeInViewport();
    await edit.getByRole('textbox', { name: 'Name' }).fill('Later');
    await expect(cell(page, 0, 3)).toContainText('Later');
    await edit.locator('.danger').click();
    await page.click('button[type=submit]:has-text("Delete")');
    await expect(cell(page, 0, 3)).not.toContainText('Later');
  });

  await test.step('a view can put new rows at the top instead', async () => {
    await page.click('.tools .icon-btn[aria-label="View settings"]');
    await page.getByRole('radiogroup', { name: 'New rows' }).getByRole('radio', { name: 'Top' }).click();
    await page.keyboard.press('Escape');
    await page.click('button.new');
    await page.waitForTimeout(300);
    await page.keyboard.type('Reading notes');
    await page.keyboard.press('Enter');
    const titles = await page.locator('.td[data-c="0"]').allInnerTexts();
    expect(titles[0]).toContain('Reading notes');
  });
});

test('board, numbers, sums, formulas, pasting and undo', async ({ page }) => {
  await open(page);
  await newDatabase(page, 'Tasks', 'Homework');

  await test.step('cards are added to board columns', async () => {
    await page.click('.column:has-text("Not started") .add');
    await page.waitForTimeout(300);
    await page.keyboard.type('Read chapter 4');
    await page.keyboard.press('Enter');
    await page.click('.column:has-text("In progress") .add');
    await page.waitForTimeout(300);
    await page.keyboard.type('Problem set 2');
    await page.keyboard.press('Enter');
    await expect(page.locator('.column:has-text("In progress") .slot', { hasText: 'Problem set 2' })).toBeVisible();
  });

  await test.step('dragging a card to Done moves it', async () => {
    await page.locator('.slot:has-text("Read chapter 4")').dragTo(page.locator('.column:has-text("Done")'));
    await expect(page.locator('.column:has-text("Done") .slot')).toHaveCount(1);
  });

  let points = -1;
  await test.step('a Number property and its sum', async () => {
    await page.click('.tab:has-text("All tasks")');
    await page.click('.th.add');
    await page.click('.db-pop .pop-item:has-text("Number")');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Points');
    await page.keyboard.press('Enter');
    await expect(page.locator('.head .th', { hasText: 'Points' })).toBeVisible();
    points = await colOf(page, 'Points');
    await cell(page, 0, points).click();
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.type('30');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.locator('.calc-cell').nth(points).click();
    await page.click('.menu .item:has-text("Sum")');
    await expect(page.locator('.calc-cell').nth(points)).toContainText('42');
  });

  await test.step('a formula over it', async () => {
    await page.click('.th.add');
    await page.click('.db-pop .pop-item:has-text("Formula")');
    await page.waitForTimeout(400);
    await page.keyboard.type('{Poi');
    await page.waitForTimeout(150);
    await page.keyboard.press('Tab');
    await page.keyboard.type(' * 2');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    const formula = await colOf(page, 'Formula');
    expect(formula).toBeGreaterThan(points);
    const values = (await page.locator(`.td[data-c="${formula}"]`).allInnerTexts()).map((v) => v.trim());
    expect(values).toEqual(expect.arrayContaining(['24', '60']));
  });

  await test.step('pasting rows from a spreadsheet, then undoing it', async () => {
    const rows = page.locator('.tr');
    const before = await rows.count();
    await cell(page, 1, 0).click();
    const tsv = 'Write lab report\tNot started\t2026-10-20\tHigh\n"Quiz, chapter 5"\tDone\tOct 22\tLow';
    await pasteIntoGrid(page, tsv);
    await expect(rows).toHaveCount(before + 1);
    await expect(page.locator('.td[data-c="0"]', { hasText: 'Quiz, chapter 5' })).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(rows).toHaveCount(before);
  });

  await test.step('a row opens as a page and Back returns', async () => {
    await page.locator('.tr').first().hover();
    await page.locator('.tr').first().locator('.open').click();
    await expect(page.locator('h1.title')).not.toHaveText('Homework');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('h1.title')).toHaveText('Homework');
  });

  await test.step('the calendar and chart views', async () => {
    await page.click('.tab:has-text("Calendar")');
    await page.click('.add-view');
    await page.click('.menu .item:has-text("Chart")');
    await page.waitForTimeout(400);
    await page.click('.nav-main:has-text("Calendar")');
    await expect(page.locator('h1.view-title')).toBeVisible();
  });
});

test('keyboard editing, copying, fill down, types and grouping', async ({ page }) => {
  await open(page);
  await page.click('.sidebar >> text=Reading list');
  await page.click('.tab:has-text("Table")');

  await test.step('arrow keys move; typing replaces the cell', async () => {
    await cell(page, 0, 1).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('Y. N. Harari');
    await page.keyboard.press('Enter');
    await expect(cell(page, 1, 1)).toContainText('Y. N. Harari');
  });

  await test.step('copying a block of cells gives tab-separated text', async () => {
    await cell(page, 0, 0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+c');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('The Left Hand of Darkness\tUrsula K. Le Guin\r\nSapiens\tY. N. Harari');
  });

  const st = await colOf(page, 'Status');
  await test.step('Ctrl+D fills down; Delete clears; undo restores', async () => {
    await cell(page, 0, st).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+d');
    await expect(cell(page, 2, st)).toContainText('Finished');
    await page.keyboard.press('Delete');
    await expect(cell(page, 1, st)).toHaveText('');
    await page.keyboard.press('Control+z');
    await expect(cell(page, 1, st)).toContainText('Finished');
  });

  await test.step('a text property turns into a select', async () => {
    await page.click('.th:has-text("Author")');
    await page.click('.db-pop .pop-item:has-text("Type")');
    await page.click('.db-pop .pop-item:has-text("Select")');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await expect(page.locator('.td[data-c="1"] .pill')).toHaveCount(4);
  });

  await test.step('grouping the table and a list view', async () => {
    await page.click('.tools .icon-btn[aria-label="View settings"]');
    await page.locator('.db-pop .pop-row:has-text("Group by") select').selectOption({ label: 'Status' });
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.click('.add-view');
    await page.click('.menu .item:has-text("List")');
    await page.waitForTimeout(300);
  });
});

test('a habit tracker: checkboxes, typed dates, formulas that follow renames', async ({ page }) => {
  await open(page);
  await newDatabase(page, 'Habit tracker');
  await page.click('.tab:has-text("All days")');

  await test.step('rows with typed dates', async () => {
    for (let i = 0; i < 3; i++) {
      await page.click('button.new');
      await page.waitForTimeout(300);
      await page.keyboard.type(`Day ${i + 1}`);
      await page.keyboard.press('Tab');
      await page.keyboard.type(`2026-10-${12 + i}`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    }
    const dates = await page.locator(`.td[data-c="${await colOf(page, 'Date')}"]`).allInnerTexts();
    expect(dates.filter((d) => /Oct 1[234]/.test(d))).toHaveLength(3);
  });

  const sc = await colOf(page, 'Score');
  const scoreCells = page.locator(`.td[data-c="${sc}"]`);
  let scores: string[] = [];
  await test.step('ticking habits scores the day', async () => {
    const ex = await colOf(page, 'Exercise');
    const rd = await colOf(page, 'Read');
    await cell(page, 0, ex).locator('.v-check').click();
    await cell(page, 0, rd).locator('.v-check').click();
    await cell(page, 1, ex).locator('.v-check').click();
    await page.waitForTimeout(300);
    scores = await scoreCells.allInnerTexts();
    expect(scores[0]).not.toBe(scores[2]);
  });

  await test.step('renaming a property the formula uses keeps the formula working', async () => {
    await page.click('.th:has-text("Exercise")');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Workout');
    await page.keyboard.press('Enter');
    await expect(page.locator('.head .th', { hasText: 'Workout' })).toBeVisible();
    await expect.poll(() => scoreCells.allInnerTexts()).toEqual(scores);
  });

  await test.step('deleting a property, then undoing from the toast', async () => {
    await page.click('.th:has-text("Water")');
    await page.click('.db-pop .pop-item:has-text("Delete property")');
    await expect(page.locator('.head .th', { hasText: 'Water' })).toHaveCount(0);
    await page.click('button:has-text("Undo")');
    await expect(page.locator('.head .th', { hasText: 'Water' })).toHaveCount(1);
  });
});

test('a budget pasted from a spreadsheet, and its chart', async ({ page }) => {
  await open(page);
  await newDatabase(page, 'Budget');
  await page.click('button.new');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await pasteIntoGrid(
    page,
    'Groceries\t$54.20\tFood\nRent\t$600\tRent\nBus pass\t$40\tTransport\nTextbook\t$89.99\tBooks & supplies\nCinema\t$14\tFun\nPizza\t$22\tFood',
  );
  await expect(page.locator('.td[data-c="0"]', { hasText: 'Pizza' })).toBeVisible();
  await expect(page.locator('.td', { hasText: '$89.99' })).toBeVisible();
  await page.click('.tab:has-text("By category")');
  await page.waitForTimeout(300);
});
