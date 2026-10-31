// Making the app your own: which items the sidebar shows, coloured text,
// and the folder notes are kept in.
import { test, expect, open, MOD } from './fixtures';

const sidebar = (page: import('@playwright/test').Page) => page.locator('.sidebar');

test('sidebar items can be hidden from Settings or by right-click, and stay hidden', async ({ page }) => {
  await open(page);
  await expect(sidebar(page).locator('nav.views')).toContainText('Flashcards');
  await expect(sidebar(page)).toContainText('Databases');

  await test.step('a switch in Settings hides Flashcards', async () => {
    await page.keyboard.press(`${MOD}+Comma`);
    await page.getByRole('switch', { name: 'Show Flashcards in the sidebar' }).click();
    await page.keyboard.press('Escape');
    await expect(sidebar(page).locator('nav.views')).not.toContainText('Flashcards');
    await expect(sidebar(page).locator('nav.views')).toContainText('Calendar');
  });

  await test.step('right-click hides a section, and Undo brings it back', async () => {
    await sidebar(page).locator('.section-title', { hasText: 'Databases' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide from Sidebar' }).click();
    await expect(sidebar(page).locator('.section-title', { hasText: 'Databases' })).toHaveCount(0);
    await page.locator('.toast', { hasText: 'Databases is hidden' }).getByRole('button', { name: 'Undo' }).click();
    await expect(sidebar(page).locator('.section-title', { hasText: 'Databases' })).toHaveCount(1);
    // A closed menu fades out for a moment; the next right-click waits for it, or there'd be two.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await sidebar(page).locator('.section-title', { hasText: 'Tags' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide from Sidebar' }).click();
    await expect(sidebar(page).locator('.section-title', { hasText: 'Tags' })).toHaveCount(0);
  });

  await test.step('hidden items are still a shortcut away, and stay hidden after a restart', async () => {
    await page.keyboard.press(`${MOD}+5`);
    await expect(page.locator('h1', { hasText: 'Flashcards' }).first()).toBeVisible();
    await page.reload();
    await sidebar(page).waitFor();
    await expect(sidebar(page).locator('nav.views')).not.toContainText('Flashcards');
    await expect(sidebar(page).locator('.section-title', { hasText: 'Tags' })).toHaveCount(0);
    await expect(sidebar(page).locator('.section-title', { hasText: 'Pages' })).toHaveCount(1);
  });
});

test('courses can be dragged into another order, or moved with their menu, and keep it', async ({ page }) => {
  await open(page);
  const courses = sidebar(page).locator('[role=listitem] .label');
  const row = (name: string) => sidebar(page).locator('[role=listitem]', { hasText: name });
  await expect(courses).toHaveText(['Biology', 'History', 'Computer Science']);

  // Onto the top half of a row: it goes above it.
  await row('Computer Science').locator('.nav-main').dragTo(row('Biology'), { targetPosition: { x: 40, y: 4 } });
  await expect(courses).toHaveText(['Computer Science', 'Biology', 'History']);

  await row('Biology').locator('.nav-main').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move Down' }).click();
  await expect(courses).toHaveText(['Computer Science', 'History', 'Biology']);
  // The first can't go higher. (The last menu fades out first, or there'd be two.)
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row('Computer Science').locator('.nav-main').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Move Up' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.reload();
  await sidebar(page).waitFor();
  await expect(courses).toHaveText(['Computer Science', 'History', 'Biology']);
});

test('text can be coloured and highlighted in colour, and keeps it', async ({ page }) => {
  await open(page);
  await sidebar(page).locator('text=Getting started').click();
  const words = page.locator('.scroller .ProseMirror p').first();
  await words.dblclick();
  const bubble = page.locator('.bubble');

  await bubble.getByRole('button', { name: 'Color' }).click();
  await bubble.getByRole('button', { name: 'Red text' }).click();
  await expect(words.locator('[data-text-color="red"]')).toHaveCount(1);

  await bubble.getByRole('button', { name: 'Color' }).click();
  await bubble.getByRole('button', { name: 'Blue highlight' }).click();
  await expect(words.locator('mark[data-color="blue"]')).toHaveCount(1);

  // Readable in both themes: darker than the label colour on light pages, lighter on dark.
  const colours = await words.locator('[data-text-color="red"]').evaluate((el) => {
    const root = document.documentElement;
    const read = () => getComputedStyle(el).color;
    root.dataset.theme = 'light';
    const light = read();
    root.dataset.theme = 'dark';
    const dark = read();
    return { light, dark };
  });
  expect(colours.light).not.toBe(colours.dark);

  await bubble.getByRole('button', { name: 'Color' }).click();
  await bubble.getByRole('button', { name: 'Default text color' }).click();
  await expect(words.locator('[data-text-color]')).toHaveCount(0);
  await expect(words.locator('mark[data-color="blue"]'), 'the highlight stays').toHaveCount(1);

  // Saved with the page.
  await page.waitForTimeout(800);
  await page.reload();
  await sidebar(page).locator('text=Getting started').click();
  await expect(page.locator('.scroller .ProseMirror p').first().locator('mark[data-color="blue"]')).toHaveCount(1);
});

test('notes can move to a folder you pick, open notes a folder has, or go back', async ({ page }) => {
  await open(page);
  const openStorage = async () => {
    await page.keyboard.press(`${MOD}+Comma`);
    await page.getByRole('button', { name: 'Change…' }).scrollIntoViewIfNeeded();
  };
  const moves = () => page.evaluate(() => (window as any).__folderMoves ?? []);

  await test.step('an empty folder: the notes are copied there', async () => {
    await page.evaluate(() => ((window as any).__pickFolder = 'D:\\OneDrive\\Notes'));
    await openStorage();
    await page.getByRole('button', { name: 'Change…' }).click();
    await expect(page.getByText('Keep your notes in this folder?')).toBeVisible();
    await page.getByRole('button', { name: 'Move Notes' }).click();
    await expect.poll(moves).toEqual([{ cmd: 'data_folder_move', dir: 'D:\\OneDrive\\Notes', openExisting: false }]);
  });

  await test.step('a folder with notes: open those, never overwrite them', async () => {
    await page.reload();
    await page.evaluate(() => {
      (window as any).__pickFolder = 'E:\\Notes';
      (window as any).__folderHasNotes = true;
    });
    await openStorage();
    await page.getByRole('button', { name: 'Change…' }).click();
    await expect(page.getByText('Open the notes in that folder?')).toBeVisible();
    await page.getByRole('button', { name: 'Open Those Notes' }).click();
    await expect.poll(moves).toEqual([{ cmd: 'data_folder_move', dir: 'E:\\Notes', openExisting: true }]);
  });

  await test.step('cancelling the folder picker changes nothing', async () => {
    await page.reload();
    await page.evaluate(() => ((window as any).__pickFolder = null));
    await openStorage();
    await page.getByRole('button', { name: 'Change…' }).click();
    await page.waitForTimeout(300);
    expect(await moves()).toEqual([]);
  });

  await test.step('a chosen folder offers going back to the default', async () => {
    await page.reload();
    await page.evaluate(() => ((window as any).__dataDir = 'D:\\OneDrive\\Notes'));
    await openStorage();
    await page.getByRole('button', { name: 'Use Default' }).click();
    await page.getByRole('button', { name: 'Move Notes Back' }).click();
    await expect.poll(moves).toEqual([{ cmd: 'data_folder_reset' }]);
  });
});

test('a chosen folder that is missing at start-up is pointed out', async ({ page }) => {
  await page.addInitScript(() => ((window as any).__missingDir = 'F:\\Notes'));
  await open(page);
  await expect(page.locator('.toast', { hasText: "Your notes folder (F:\\Notes) isn't there" })).toBeVisible();
  await page.keyboard.press(`${MOD}+Comma`);
  await expect(page.getByText('Chosen folder not found')).toBeVisible();
});
