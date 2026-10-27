/**
 * Choosing the folder notes are kept in (Settings → Storage): copy them to
 * a folder of your own (OneDrive, a USB drive…), open notes a folder already
 * has, or go back to Thought Desk's own folder. Each restarts the app.
 */

import { open } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from './api';
import { databases } from './databases.svelte';
import { t } from './i18n';
import { fmt } from './i18n/format';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import { ui } from './ui.svelte';

/** The folder older notes are put aside in when notes move back. The Rust
 *  side makes it ("Replaced <date>", location.rs), always in English. */
const REPLACED_FOLDER = 'Replaced';

/** Saves everything waiting, then has the Rust side switch folders, then restarts. */
async function switchFolder(change: () => Promise<void>) {
  const toast = ui.toast(t('app.dataFolder.moving'), undefined, 120_000);
  try {
    window.dispatchEvent(new Event('td:flush'));
    await Promise.all([store.flush(), planner.flush(), databases.flush()]);
    await change();
    await relaunch();
  } catch (e) {
    ui.dismissToast(toast);
    ui.error(e);
  }
}

export async function chooseDataFolder() {
  let dir: string | string[] | null;
  try {
    dir = await open({ directory: true, title: t('app.dataFolder.chooseTitle') });
  } catch (e) {
    ui.error(e);
    return;
  }
  if (typeof dir !== 'string') return;
  try {
    const { hasNotes, modified } = await api.dataFolderCheck(dir);
    if (hasNotes) {
      // The date and time as toLocaleString() writes them, in the interface's locale.
      const date = modified ? fmt.dateTime(modified, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }) : '';
      const ok = await ui.confirm({
        title: t('app.dataFolder.openExisting.title'),
        message: date ? t('app.dataFolder.openExisting.messageChanged', { folder: dir, date }) : t('app.dataFolder.openExisting.message', { folder: dir }),
        confirmLabel: t('app.dataFolder.openExisting.confirm'),
      });
      if (ok) await switchFolder(() => api.dataFolderMove(dir, true));
    } else {
      const ok = await ui.confirm({
        title: t('app.dataFolder.move.title'),
        message: t('app.dataFolder.move.message', { folder: dir }),
        confirmLabel: t('app.dataFolder.move.confirm'),
      });
      if (ok) await switchFolder(() => api.dataFolderMove(dir, false));
    }
  } catch (e) {
    ui.error(e);
  }
}

/** Back to Thought Desk's own folder. `missing`: the chosen one wasn't
 *  there, so the notes open now are in Thought Desk's folder already. */
export async function useDefaultDataFolder(missing = false) {
  const ok = await ui.confirm(missing ? {
    title: t('app.dataFolder.keepDefault.title'),
    message: t('app.dataFolder.keepDefault.message'),
    confirmLabel: t('app.dataFolder.keepDefault.confirm'),
  } : {
    title: t('app.dataFolder.moveBack.title'),
    message: t('app.dataFolder.moveBack.message', { replaced: REPLACED_FOLDER }),
    confirmLabel: t('app.dataFolder.moveBack.confirm'),
  });
  if (ok) await switchFolder(() => api.dataFolderReset());
}

/** At start-up: a chosen folder that wasn't there (a drive not plugged in). */
export async function warnIfFolderMissing() {
  const info = await api.dataInfo().catch(() => null);
  if (!info?.missingDir) return;
  ui.toast(
    t('app.dataFolder.missing', { folder: info.missingDir }),
    { label: t('app.dataFolder.restart'), run: () => void relaunch() },
    30_000,
  );
}
