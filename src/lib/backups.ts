/**
 * The backups of the notes database (Settings → Storage). The Rust side
 * makes them by itself, about once a day (backups.rs); here are restoring
 * one, which restarts the app, and the notices about them at start-up.
 */

import { relaunch } from '@tauri-apps/plugin-process';
import { api } from './api';
import { databases } from './databases.svelte';
import { t } from './i18n';
import { fmt } from './i18n/format';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import type { Backup } from './types';
import { ui } from './ui.svelte';

/** The folder the notes open now are put aside in. The Rust side makes it
 *  ("Replaced <date>", backups.rs), always in English. */
const REPLACED_FOLDER = 'Replaced';

/** When a backup was made, as the Storage rows and dialogs write it. */
export const backupDate = (backup: Backup) => fmt.dateTime(backup.at);

/** Asks, then has the backup take the notes' place: the Rust side does it
 *  at the restart, before the database is opened. */
export async function restoreBackup(backup: Backup) {
  const params = { date: backupDate(backup), replaced: REPLACED_FOLDER };
  // A copy that syncs brings back what the synced copy already has.
  const syncing = !!(await api.syncStatus().catch(() => null))?.enabled;
  const ok = await ui.confirm({
    title: t('settings.storage.restoreConfirm.title'),
    message: syncing ? t('settings.storage.restoreConfirm.messageSync', params) : t('settings.storage.restoreConfirm.message', params),
    confirmLabel: t('settings.storage.restoreConfirm.confirm'),
  });
  if (!ok) return;
  const toast = ui.toast(t('app.backups.restoring'), undefined, 120_000);
  try {
    // Everything waiting is saved first, so the notes set aside are whole.
    window.dispatchEvent(new Event('td:flush'));
    await Promise.all([store.flush(), planner.flush(), databases.flush()]);
    await api.backupRestore(backup.name);
    await relaunch();
  } catch (e) {
    ui.dismissToast(toast);
    ui.error(e);
  }
}

/** The database failed its check, so no backup was made: say so, with the way to the backups. */
export function warnDamaged() {
  ui.toast(
    t('app.backups.damaged'),
    {
      label: t('app.backups.show'),
      run: () => {
        ui.settingsSection = 'storage';
        ui.settingsOpen = true;
      },
    },
    30_000,
  );
}

/** At start-up: what a restore came to, and a database that failed its check last time. */
export async function backupNotices() {
  const status = await api.backupStatus().catch(() => null);
  if (!status) return;
  if (status.restoreError) ui.toast(t('app.backups.restoreFailed', { reason: status.restoreError }), undefined, 30_000);
  else if (status.restored) ui.toast(t('app.backups.restored', { folder: status.restored }), undefined, 30_000);
  if (status.problem === 'damaged') warnDamaged();
}
