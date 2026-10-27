import { t } from './i18n';

/** Whether this is the desktop app, not the interface alone in a browser
 *  (development and the interface tests, see dev-mock.ts). Asked at call
 *  time: the browser stand-in installs itself after modules load. */
export function isDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window && !(window as { __TD_MOCK__?: boolean }).__TD_MOCK__;
}

/** A Mac: Cmd is the shortcut key, and macOS draws the window's own buttons
 *  (tauri.macos.conf.json). While developing, ?mac in the address pretends. */
export const isMac = /Mac/i.test(navigator.platform) || (import.meta.env.DEV && new URLSearchParams(location.search).has('mac'));

/** The shortcut key and Alt, as this system names them (and, off a Mac, as
 *  keyboards in the interface's language print them: Strg in German). */
export const MOD = isMac ? '⌘' : t('app.keys.ctrl');
export const ALT = isMac ? '⌥' : t('app.keys.alt');
