// The interface's language: Settings switches it (the window restarts in
// it), and back to the system's. Run against the development build, which
// has the pseudo-language: English with accents in ⟦ ⟧ (lib/i18n/pseudo.ts).
import { test, expect, open, MOD } from './fixtures';

type Page = import('@playwright/test').Page;
const languageButton = (page: Page) => page.locator('button.language');
/** Picks a language from Settings' menu; the window restarts in it. */
async function chooseLanguage(page: Page, name: RegExp) {
  await languageButton(page).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('menuitem', { name }).click()]);
}

test('a language chosen in Settings applies after the window restarts, and System goes back', async ({ page }) => {
  await open(page);

  await test.step('the pseudo-language replaces the interface text', async () => {
    await page.keyboard.press(`${MOD}+Comma`);
    await expect(languageButton(page)).toHaveText('System (English)');
    await chooseLanguage(page, /Pseudo \(development\)/);
    await page.locator('.sidebar').waitFor();
    await page.keyboard.press(`${MOD}+Comma`);
    await expect(languageButton(page)).toContainText('Pseudo (development)');
    await expect(page.locator('.modal-body')).toContainText('⟦Ŀȧƞɠŭȧɠḗ');
    await page.keyboard.press('Escape');
    // The rest of the interface, not only Settings: the sidebar's views, the window's language.
    await expect(page.locator('.sidebar nav.views')).toContainText('⟦Ħǿḿḗ');
    await expect(page.locator('.sidebar nav.views')).not.toContainText('Assignments');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  await test.step('names the app wrote into notes are still recognised in another language', async () => {
    // The Inbox page is created in English by a capture, then found again (not duplicated) in the pseudo-language.
    await page.keyboard.press('Control+Shift+Space');
    await page.keyboard.type('a note in another language');
    await page.keyboard.press('Enter');
    await expect(page.locator('.sidebar .tree-item, .sidebar [role=treeitem]').filter({ hasText: /Inbox|Ĩƞƀǿẋ|Īƞƀǿẋ/ })).toHaveCount(1);
  });

  await test.step('System brings English back', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press(`${MOD}+Comma`);
    await chooseLanguage(page, /^⟦.*English/);
    await page.locator('.sidebar').waitFor();
    await page.keyboard.press(`${MOD}+Comma`);
    await expect(languageButton(page)).toHaveText('System (English)');
    await expect(page.locator('.modal-body')).toContainText('Language');
    await expect(page.locator('.modal-body')).not.toContainText('⟦');
  });
});
