// The backups of the notes database, in Settings → Storage: when the last one
// was made, the folder, going back to one, and what's said when one couldn't
// be made. The Rust side makes them (backups.rs has its own tests); here the
// stand-in answers what it would.
import type { Page } from '@playwright/test';
import { test, expect, open, MOD } from './fixtures';

/** What the stand-in answers for the backups: a test's own, laid over one with nothing in it. */
async function withBackups(page: Page, status: Record<string, unknown>) {
  await page.addInitScript((s) => {
    (window as any).__backups = { dir: 'C:\\Thought Desk\\Backups', backups: [], problem: null, restored: null, restoreError: null, ...s };
  }, status);
}

async function openStorage(page: Page) {
  const storage = page.getByRole('tab', { name: 'Storage' });
  // The shortcut is lost if the app isn't up yet: press until Settings is open (never while it is).
  await expect(async () => {
    if (!(await storage.isVisible())) await page.keyboard.press(`${MOD}+Comma`);
    await expect(storage).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await storage.click();
}

const calls = (page: Page) => page.evaluate(() => (window as any).__backupCalls ?? []);
/** The Backups row: its name, when the last was made, and its buttons. */
const backupsRow = (page: Page) => page.locator('.group-row', { has: page.getByRole('button', { name: 'Restore…' }) });

test('Storage shows the last backup, opens the folder, and restores one after asking', async ({ page }) => {
  await open(page);
  await openStorage(page);
  const row = backupsRow(page);
  // One backup from 24 October, 09:30 UTC (the day depends on the time zone).
  await expect(row).toContainText('Backups');
  await expect(row).toContainText(/Last backup Oct 2[345], \d/);
  await expect(page.getByText("Files you've added aren't in the backups.")).toBeVisible();
  await expect(page.getByText('This folder is in')).toHaveCount(0);

  await row.getByRole('button', { name: 'Open Folder' }).click();
  await expect.poll(() => calls(page)).toEqual([{ cmd: 'backup_reveal' }]);

  // The backups are listed only once asked for.
  const restore = page.getByRole('button', { name: /^Restore the backup from Oct 2[345]/ });
  await expect(restore).toHaveCount(0);
  await row.getByRole('button', { name: 'Restore…' }).click();
  await expect(restore).toHaveCount(1);
  await expect(page.locator('.group-row.backup')).toContainText('264.0 KB');

  await test.step('cancelling restores nothing', async () => {
    await restore.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Restore this backup?');
    await expect(dialog).toContainText('put aside in a “Replaced” folder in your notes folder, not deleted');
    await expect(dialog).not.toContainText('Sync is on');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    expect(await calls(page)).toEqual([{ cmd: 'backup_reveal' }]);
  });

  await test.step('confirming asks the Rust side for that backup', async () => {
    await restore.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore Backup' }).click();
    await expect.poll(() => calls(page)).toEqual([{ cmd: 'backup_reveal' }, { cmd: 'backup_restore', name: 'thoughtdesk 2026-10-24 0930.db' }]);
  });
});

test('with no backup yet there is nothing to restore', async ({ page }) => {
  await withBackups(page, {});
  await open(page);
  await openStorage(page);
  const row = backupsRow(page);
  await expect(row).toContainText('No backup yet. The first is made a minute after Thought Desk starts.');
  await expect(row.getByRole('button', { name: 'Restore…' })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Open Folder' })).toBeEnabled();
});

test('a database that failed its check is pointed out, and the backups it has are kept in view', async ({ page }) => {
  const day = Date.UTC(2026, 9, 20, 12);
  await withBackups(page, {
    problem: 'damaged',
    backups: [
      { name: 'thoughtdesk 2026-10-20 1200.db', at: day, bytes: 5 << 20 },
      { name: 'thoughtdesk 2026-10-19 1200.db', at: day - 86_400_000, bytes: 4 << 20 },
    ],
  });
  await open(page);
  const toast = page.locator('.toast', { hasText: "Your notes database didn't pass its check" });
  await expect(toast).toBeVisible();
  // The notice leads to the backups.
  await toast.getByRole('button', { name: 'Show Backups' }).click();
  await expect(page.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true');
  const row = backupsRow(page);
  await expect(row).toContainText(/Last backup Oct 20, \d/);
  await expect(row).toContainText("The database didn't pass its check, so no new backup was made. The ones you have are kept.");
  await row.getByRole('button', { name: 'Restore…' }).click();
  await expect(page.locator('.group-row.backup')).toHaveCount(2);
  // Newest first.
  await expect(page.locator('.group-row.backup').first()).toContainText('Oct 20');
});

test('a backup that could not be written is said in Storage, without a notice', async ({ page }) => {
  await withBackups(page, { problem: 'failed' });
  await open(page);
  await openStorage(page);
  await expect(backupsRow(page)).toContainText("The last backup couldn't be made. Thought Desk tries again every hour.");
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('after a restore the app says where the earlier notes are, or that nothing changed', async ({ page }) => {
  await withBackups(page, { restored: 'Replaced 2026-10-24 1030' });
  await open(page);
  await expect(page.locator('.toast', { hasText: 'The backup was restored. The notes you had before are in the “Replaced 2026-10-24 1030” folder' })).toBeVisible();

  await withBackups(page, { restoreError: "That backup isn't there any more" });
  await page.reload();
  await expect(page.locator('.toast', { hasText: "The backup couldn't be restored, so your notes are as they were. That backup isn't there any more" })).toBeVisible();
});

test('a notes folder inside a cloud drive is pointed out in Storage', async ({ page }) => {
  await page.addInitScript(() => ((window as any).__dataDir = 'C:\\Users\\ana\\Dropbox\\Notes'));
  await open(page);
  await openStorage(page);
  await expect(page.getByText('This folder is in Dropbox')).toBeVisible();
  await expect(page.getByText("That's fine on one computer. Never open these notes on two computers at once, or the database can be damaged. Backups are kept separately, on this computer.")).toBeVisible();
});
