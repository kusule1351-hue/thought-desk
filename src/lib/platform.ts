import { t } from './i18n';

/** Whether this is the desktop app, not the interface alone in a browser
 *  (development and the interface tests, see dev-mock.ts). Asked at call
 *  time: the browser stand-in installs itself after modules load. */
export function isDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window && !(import.meta.env.DEV && (window as { __TD_MOCK__?: boolean }).__TD_MOCK__);
}

/** A Mac: Cmd is the shortcut key, and macOS draws the window's own buttons
 *  (tauri.macos.conf.json). While developing, ?mac in the address pretends. */
export const isMac = /Mac/i.test(navigator.platform) || (import.meta.env.DEV && new URLSearchParams(location.search).has('mac'));

/** Whether blocks out of sight may skip layout and painting (app.css: html.skip-offscreen).
 *  Only on Chromium (WebView2 on Windows, and the browser the interface tests run in).
 *  WebKit (Linux, macOS) crashes its web process when a block changes from always drawn
 *  to skipped while blocks are added beside it: WebKitGTK 2.50.4, issue #50. */
export const skipsOffscreen = /Chrom(e|ium)\//.test(navigator.userAgent);

/** The shortcut key and Alt, as this system names them (and, off a Mac, as
 *  keyboards in the interface's language print them: Strg in German). */
export const MOD = isMac ? '⌘' : t('app.keys.ctrl');
export const ALT = isMac ? '⌥' : t('app.keys.alt');
