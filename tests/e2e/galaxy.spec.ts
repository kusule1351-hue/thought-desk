// The Galaxy view: every page a star, every link a line, once it's turned on.
// The canvas is checked through what's around it (the counts, the list of
// stars screen readers get, the hover card), and a click on a star the view centred.
import { test, expect, open, type Page } from './fixtures';

const galaxy = (page: Page) => page.locator('.galaxy');
/** The list of stars is for screen readers and the keyboard: reached by focus, not seen. */
const star = (page: Page, title: string) => galaxy(page).locator('nav.stars button', { hasText: new RegExp(`^${title},`) });

/** It asks before it's turned on; this turns it on. */
const turnOn = (page: Page) => page.getByRole('button', { name: 'Turn on Galaxy' }).click();

async function openGalaxy(page: Page) {
  await page.locator('.sidebar nav.views').getByText('Galaxy').click();
  await turnOn(page);
  await expect(galaxy(page).locator('h1')).toHaveText('Galaxy');
  await expect(galaxy(page).locator('canvas')).toBeVisible();
}

test('every page is a star, links are counted, and a star from the list opens its page', async ({ page }) => {
  await open(page);
  await openGalaxy(page);
  // Study plan mentions Getting started: the example workspace's one link.
  await expect(galaxy(page).locator('.sub')).toHaveText(/^\d+ stars · 1 link$/);
  await expect(star(page, 'Study plan')).toHaveText('Study plan, linked with 1 page');
  await expect(star(page, 'Roadmap')).toHaveText('Roadmap, not linked yet');
  // Database rows aren't stars of their own: their database is.
  await expect(star(page, 'Reading list')).toHaveCount(1);
  await expect(star(page, 'Sapiens')).toHaveCount(0);

  await star(page, 'Study plan').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('h1.title')).toHaveText('Study plan');
});

test('the Galaxy is off until it’s turned on, and can be hidden instead', async ({ page }) => {
  await open(page);
  const views = page.locator('.sidebar nav.views');
  await views.getByText('Galaxy').click();
  // Nothing of it runs yet: it says what it is and what it costs.
  await expect(page.getByText('See your notes as a galaxy')).toBeVisible();
  await expect(page.getByText(/uses more memory than the rest of Thought Desk/)).toBeVisible();
  await expect(galaxy(page)).toHaveCount(0);

  // Not wanted: gone from the sidebar (with Undo), back on Home.
  await page.getByRole('button', { name: 'Hide from sidebar' }).click();
  await expect(views).not.toContainText('Galaxy');
  await expect(page.locator('.toast', { hasText: 'Galaxy is hidden' })).toBeVisible();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(views).toContainText('Galaxy');

  // Turned on, it stays on.
  await views.getByText('Galaxy').click();
  await turnOn(page);
  await expect(galaxy(page).locator('canvas')).toBeVisible();
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.locator('.sidebar nav.views').getByText('Galaxy').click();
  await expect(galaxy(page).locator('canvas')).toBeVisible();
});

test('searching lights up matching stars, and says when nothing matches', async ({ page }) => {
  await open(page);
  await openGalaxy(page);
  const find = galaxy(page).getByPlaceholder('Find a page');
  await find.fill('road');
  await find.press('Enter');
  await expect(find).toHaveValue('road');
  await expect(galaxy(page).locator('nav.stars button')).toHaveText(['Roadmap, not linked yet']);
  await find.fill('nebula');
  await expect(galaxy(page).locator('.no-match')).toHaveText('No page called “nebula”');
  await find.fill('');
  await expect(galaxy(page).locator('.no-match')).toHaveCount(0);
});

test.describe('with reduced motion', () => {
  // A still galaxy, so a star the view centres on stays put under the pointer.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('Show in Galaxy centres on the page; its star shows a card and opens on click', async ({ page }) => {
    await open(page);
    await page.locator('.sidebar').getByText('Study plan', { exact: true }).click();
    await page.locator('.titlebar [data-tip="More"]').click();
    await page.getByRole('menuitem', { name: 'Show in Galaxy' }).click();
    await turnOn(page);

    await expect(galaxy(page).locator('.chip')).toContainText('Around “Study plan”');
    // A narrower window keeps the view on the page (it used to zoom back out to everything).
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(300);
    const box = (await galaxy(page).locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await expect(galaxy(page).locator('.card')).toContainText('Study plan');
    await expect(galaxy(page).locator('.card')).toContainText('linked with 1 page');
    await page.mouse.click(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await expect(page.locator('h1.title')).toHaveText('Study plan');

    // Back in the Galaxy from the sidebar, it shows everything again.
    await page.locator('.sidebar nav.views').getByText('Galaxy').click();
    await expect(galaxy(page).locator('.chip')).toHaveCount(0);
  });

  test('the list of stars is one Tab stop that the arrow keys walk along', async ({ page }) => {
    await open(page);
    await openGalaxy(page);
    const stars = galaxy(page).locator('nav.stars button');
    await expect(stars.first()).toHaveAttribute('tabindex', '0');
    await expect(stars.nth(1)).toHaveAttribute('tabindex', '-1');
    await stars.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(stars.nth(1)).toBeFocused();
    await expect(stars.nth(1)).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('Home');
    await expect(stars.first()).toBeFocused();
  });

  test('the chip lets go of the page', async ({ page }) => {
    await open(page);
    await page.locator('.sidebar').getByText('Getting started', { exact: true }).click();
    await page.locator('.titlebar [data-tip="More"]').click();
    await page.getByRole('menuitem', { name: 'Show in Galaxy' }).click();
    await turnOn(page);
    await expect(galaxy(page).locator('.chip')).toContainText('Around “Getting started”');
    await galaxy(page).getByRole('button', { name: 'Show every star' }).click();
    await expect(galaxy(page).locator('.chip')).toHaveCount(0);
  });
});
