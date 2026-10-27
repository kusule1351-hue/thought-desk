/**
 * Zoom: the whole app bigger or smaller, from Ctrl + scroll (or a touchpad
 * pinch), Ctrl + = / Ctrl + - / Ctrl + 0, or Settings. The webview zooms
 * itself, so text stays sharp and everything keeps its proportions. The
 * level is remembered (prefs.zoom).
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { t } from './i18n';
import { fmt } from './i18n/format';
import { prefs } from './prefs.svelte';
import { ui } from './ui.svelte';

/** The levels zooming steps through, as in a browser. */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

// Decided before the browser stand-in for the Rust side is set up (main.ts),
// which zooms with CSS instead.
const NATIVE = '__TAURI_INTERNALS__' in window;

/** A zoom level as a percentage, the locale's way ("110%", "110 %"). */
export const zoomLabel = (z: number) => fmt.number(z, { style: 'percent' });

/** The next level up (1) or down (-1) from `z`. */
function step(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
}

let notice = 0;
/** Sets the zoom and says what it is now, replacing the last such notice. */
export function setZoom(z: number) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
  if (next === prefs.zoom) return;
  prefs.zoom = next;
  if (notice) ui.dismissToast(notice);
  notice = ui.toast(t('app.zoom.level', { level: zoomLabel(next) }), next === 1 ? undefined : { label: t('app.zoom.reset'), run: () => setZoom(1) }, 1600);
}

export const zoomIn = () => setZoom(step(prefs.zoom, 1));
export const zoomOut = () => setZoom(step(prefs.zoom, -1));
export const zoomReset = () => setZoom(1);

// A mouse wheel notch is about 100; a pinch sends many small steps, which
// add up to one level at a time.
const PER_STEP = 60;
let pending = 0;
let last = 0;
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    // A part-step left over from a while ago doesn't count towards this one.
    if (e.timeStamp - last > 400) pending = 0;
    last = e.timeStamp;
    pending += e.deltaY;
    while (Math.abs(pending) >= PER_STEP) {
      if (pending < 0) zoomIn();
      else zoomOut();
      pending -= Math.sign(pending) * PER_STEP;
    }
  },
  { passive: false },
);

$effect.root(() => {
  $effect(() => {
    const z = prefs.zoom;
    if (NATIVE) void getCurrentWebview().setZoom(z).catch(() => {});
    else document.documentElement.style.zoom = z === 1 ? '' : String(z);
  });
});
