/**
 * Updates from GitHub releases. The installed app looks for a newer version
 * a little after it starts and every few hours while it's open; when there
 * is one, a notice offers to install it. Installing saves everything first,
 * then the installer replaces the app and it starts again. Each update is
 * signed (tauri.conf.json: plugins.updater.pubkey), so only real releases
 * are installed.
 */

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { databases } from './databases.svelte';
import { t } from './i18n';
import { planner } from './planner.svelte';
import { store } from './store.svelte';
import { ui } from './ui.svelte';

// Decided before the browser stand-in for the Rust side is set up (main.ts):
// only the installed app can update itself.
const NATIVE = '__TAURI_INTERNALS__' in window && import.meta.env.PROD;

const FIRST_CHECK = 15_000;
const EVERY = 6 * 60 * 60_000;

class Updates {
  /** A newer version, once one is found. */
  available = $state<Update | null>(null);
  checking = $state(false);
  /** 0–1 while downloading, or null. */
  progress = $state<number | null>(null);

  /** Looks for a newer version; `quiet` says nothing unless there is one. */
  async check(quiet = true) {
    if (!NATIVE) {
      if (!quiet) ui.toast(t('app.updates.browserOnly'));
      return;
    }
    if (this.checking || this.progress !== null) return;
    this.checking = true;
    try {
      const found = await check();
      if (found) {
        this.available = found;
        ui.toast(t('app.updates.ready', { version: found.version }), { label: t('app.updates.install'), run: () => void this.install() }, 20_000);
      } else if (!quiet) {
        ui.toast(t('app.updates.upToDate'));
      }
    } catch (e) {
      // Offline, or GitHub unreachable: try again next time.
      if (!quiet) ui.error(e);
    } finally {
      this.checking = false;
    }
  }

  /** Saves everything, installs the update, and starts the new version. */
  async install() {
    const update = this.available;
    if (!update || this.progress !== null) return;
    try {
      window.dispatchEvent(new Event('td:flush'));
      await Promise.all([store.flush(), planner.flush(), databases.flush()]);
      let total = 0;
      let done = 0;
      this.progress = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          this.progress = total ? done / total : null;
        }
      });
      await relaunch();
    } catch (e) {
      this.progress = null;
      ui.error(e);
    }
  }
}

export const updates = new Updates();

if (NATIVE) {
  setTimeout(() => void updates.check(), FIRST_CHECK);
  setInterval(() => void updates.check(), EVERY);
}
