// Home, capture, tags, backlinks, the slash menu and moving between views.
import { test, expect, open } from './fixtures';

test('Home, capture, tags and backlinks', async ({ page }) => {
  const wait = (ms = 300) => page.waitForTimeout(ms);
  await open(page);

  await test.step('starts on Home with to-dos rolled up from Study plan', async () => {
    await expect(page.locator('h1.view-title')).toHaveText(/Good|Working/);
    await expect(page.locator('.todo-text', { hasText: 'Redo practice exam' })).toBeVisible();
  });

  await test.step('checking a to-do on Home checks it in its page', async () => {
    const row = page.locator('.todo', { hasText: 'Redo practice exam' });
    await row.locator('.box').click();
    await expect(row).toHaveClass(/done/);
    await page.click('.sidebar >> text=Study plan');
    await expect(page.locator('.prose li[data-checked="true"]', { hasText: 'Redo practice exam' })).toBeVisible();
  });

  await test.step('capturing a to-do creates Inbox', async () => {
    await page.keyboard.press('Control+1');
    await page.fill('.capture-card textarea', 'Email the TA about lab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.sidebar .row', { hasText: 'Inbox' })).toBeVisible();
    await expect(page.locator('.todo-text', { hasText: 'Email the TA about lab' })).toBeVisible();
  });

  await test.step('Ctrl+Shift+Space captures a note under Inbox', async () => {
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('.modal', { hasText: 'Quick Capture' })).toBeVisible();
    await page.click('.modal [role=radio] >> text=Note');
    await page.keyboard.type('Thesis idea');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Compare two cell models');
    await page.click('.modal-foot >> text=Save');
    await expect(page.locator('.modal', { hasText: 'Quick Capture' })).toHaveCount(0);
    await page.click('.sidebar .row >> text=Inbox');
    await expect(page.locator('.sidebar .row', { hasText: 'Thesis idea' })).toBeVisible();
  });

  await test.step('capturing an assignment with a date', async () => {
    await page.keyboard.press('Control+1');
    await page.click('.capture-card [role=radio] >> text=Assignment');
    await page.fill('.capture-card input[type=date]', '2026-10-20');
    await page.fill('.capture-card textarea', 'Reading response');
    await page.keyboard.press('Enter');
    await wait(300);
    await page.keyboard.press('Control+2');
    await expect(page.locator('.a-row', { hasText: 'Reading response' })).toBeVisible();
  });

  await test.step('tagging a page and opening the tag view', async () => {
    await page.click('.sidebar >> text=Getting started');
    await page.hover('h1.title');
    await page.click('.head-tools >> text=Add tag');
    await page.keyboard.type('Biology 101');
    await page.keyboard.press('Enter');
    await wait();
    await page.keyboard.press('Escape');
    await expect(page.locator('.page-tags', { hasText: '#biology-101' })).toBeVisible();
    await page.click('.sidebar .tag-list >> text=#biology-101');
    await expect(page.locator('h1.view-title', { hasText: 'biology-101' })).toBeVisible();
    await expect(page.locator('.link-row', { hasText: 'Getting started' })).toBeVisible();
  });

  await test.step('tagging an assignment; #search finds it', async () => {
    await page.keyboard.press('Control+2');
    await page.click('.a-row >> text=Problem set 3');
    await page.click('.modal .add >> text=Add tag');
    await page.keyboard.type('exam');
    await wait(200);
    await page.keyboard.press('Enter');
    await wait();
    await page.keyboard.press('Escape');
    await wait(200);
    await page.keyboard.press('Escape');
    await wait();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('#ex');
    await expect(page.locator('.hit', { hasText: '#exam' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.a-row', { hasText: 'Problem set 3' })).toBeVisible();
  });

  await test.step('backlinks on a page', async () => {
    await page.click('.sidebar >> text=Getting started');
    await expect(page.locator('.backlinks', { hasText: 'Study plan' })).toBeVisible();
  });

  await test.step('backlinks on an assignment sheet', async () => {
    await page.click('.sidebar >> text=Design review');
    await wait(600);
    await page.evaluate(() => (window as any).__editor.chain().focus('end').run());
    await page.keyboard.type('@lab r');
    await wait(400);
    await page.keyboard.press('Enter');
    await wait(600);
    await page.keyboard.press('Control+2');
    await page.click('.a-row >> text=Lab report: osmosis');
    await expect(page.locator('.modal .backlinks', { hasText: 'Design review' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('back and forward across the tag view and Home', async () => {
    await page.keyboard.press('Control+1');
    await page.click('.sidebar .tag-list >> text=#exam');
    await wait();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('h1.view-title')).toHaveText(/Good|Working/);
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('h1.view-title', { hasText: 'exam' })).toBeVisible();
  });
});

test('every list item shows its bullet or number, not only the one being typed in', async ({ page }) => {
  await open(page, '?fresh');
  await page.keyboard.press('Control+n');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- apples\nbananas\n\n1. first\nsecond\n\nThe caret is down here.');
  // Items out of the caret's way skip drawing until needed, which clips anything
  // drawn outside their own box: the marker must sit inside it (#29).
  const markers = await page.evaluate(() =>
    [...document.querySelectorAll('.prose > ul:not([data-type]) > li, .prose > ol > li')].map((li) => ({
      left: parseFloat(getComputedStyle(li, '::before').left),
      drawn: getComputedStyle(li, '::before').content !== 'none',
    })),
  );
  expect(markers).toHaveLength(4);
  for (const m of markers) {
    expect(m.drawn).toBe(true);
    expect(m.left).toBeGreaterThanOrEqual(0);
  }
  await expect(page.locator('.prose > ol > li').first()).toHaveCSS('list-style-type', 'none');
});

test('keys typed straight after Enter land in order', async ({ page }) => {
  await open(page, '?fresh');
  await page.keyboard.press('Control+n');
  await expect(page.locator('h1.title')).toBeFocused();
  await page.keyboard.type('Quick typing');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ProseMirror')).toBeFocused();
  // Enter and the keys after it in one go, before the new line is drawn
  // (a busy machine): each key still goes after the one before.
  const enterThenType = () =>
    page.evaluate(() => {
      const ed = (window as any).__editor;
      ed.commands.enter();
      for (const ch of 'abc') document.execCommand('insertText', false, ch);
    });
  const last = () => page.evaluate(() => (window as any).__editor.state.doc.lastChild.textContent);

  await page.keyboard.type('First line');
  await enterThenType();
  await expect.poll(last).toBe('abc');

  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await enterThenType();
  await expect(page.locator('.prose ul > li').nth(1)).toHaveText('abc');
});

test('new page, slash menu, events and history', async ({ page }) => {
  const wait = (ms = 300) => page.waitForTimeout(ms);
  await open(page);

  await test.step('Ctrl+N makes a page; typing names it', async () => {
    await page.keyboard.press('Control+n');
    await wait(500);
    await page.keyboard.type('Weekly plan');
    await expect(page.locator('.sidebar .row', { hasText: 'Weekly plan' })).toBeVisible();
  });

  await test.step('the slash menu lists the Planner group', async () => {
    await page.keyboard.press('Enter');
    await wait(200);
    await page.keyboard.type('/');
    await expect(page.locator('.suggest .group', { hasText: 'Planner' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('/event creates an event and links it', async () => {
    await page.keyboard.press('Backspace');
    await page.keyboard.type('/event');
    await wait();
    await page.keyboard.press('Enter');
    await wait(400);
    await page.keyboard.type('Team sync');
    await page.keyboard.press('Enter');
    await expect(page.locator('.prose .chip.event', { hasText: 'Team sync' })).toBeVisible();
  });

  await test.step('favorites', async () => {
    await page.click('[data-tip="Add to Favorites"]');
    await expect(page.locator('.sidebar section', { hasText: 'Favorites' })).toBeVisible();
  });

  await test.step('back and forward across views', async () => {
    await page.keyboard.press('Control+4');
    await wait();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('h1.title')).toHaveText('Weekly plan');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('h1.view-title', { hasText: 'Files' })).toBeVisible();
  });

  await test.step('the event shows on today in the calendar', async () => {
    await page.keyboard.press('Control+3');
    await expect(page.locator('.panel', { hasText: 'Team sync' })).toBeVisible();
  });
});
