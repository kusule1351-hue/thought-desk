/**
 * Where each note was last scrolled to, so it opens there again instead of at
 * the top. Kept on this device like the other interface preferences: where
 * you were reading on one computer says nothing about another.
 */

const KEY = 'thoughtdesk.scroll.v1';
/** The most recently read notes are kept; older places are forgotten. */
const LIMIT = 500;
const SAVE_AFTER = 600;
/** How long a reopened note gets to grow tall enough to scroll back to its place. */
const SETTLE_FOR = 1500;

function load(): Map<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(saved)) return new Map();
    return new Map(saved.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && e[1] > 0));
  } catch {
    return new Map();
  }
}

/** Oldest first, so the first entry is the one to forget. */
const places = load();
let timer: ReturnType<typeof setTimeout> | undefined;

function saveNow() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  try {
    localStorage.setItem(KEY, JSON.stringify([...places]));
  } catch {
    // Storage full or switched off: the places last for this run only.
  }
}

function remember(id: string, top: number) {
  const at = Math.round(top);
  if ((places.get(id) ?? 0) === at) return;
  places.delete(id);
  if (at > 0) places.set(id, at);
  if (places.size > LIMIT) places.delete(places.keys().next().value!);
  timer ??= setTimeout(saveNow, SAVE_AFTER);
}

window.addEventListener('td:flush', saveNow);
window.addEventListener('pagehide', saveNow);

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/**
 * Looks after one scrolling pane. Call `scrolled` on its scroll events,
 * `show(id)` once a note is on screen and `leave` when it goes.
 */
export function scrollMemory(pane: () => HTMLElement | undefined) {
  /** The note whose place scrolling updates; none while one is loading or settling. */
  let following: string | null = null;
  let turn = 0;

  return {
    scrolled() {
      const el = pane();
      // A pane with nothing to scroll sits at the top whatever was read (the
      // note is being swapped out or redrawn): that isn't a place to keep.
      if (following && el && el.scrollHeight > el.clientHeight) remember(following, el.scrollTop);
    },

    leave() {
      following = null;
      turn++;
    },

    async show(id: string) {
      following = null;
      const mine = ++turn;
      const el = pane();
      if (!el) return;
      const top = places.get(id) ?? 0;
      el.scrollTop = top;
      if (top > 0) {
        // The note is drawn over the next frames, pictures and shared notes
        // later still: keep going back to the place until the note is tall
        // enough to reach it, unless its reader starts moving it themselves.
        let touched = false;
        const touch = () => (touched = true);
        const signs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
        for (const sign of signs) el.addEventListener(sign, touch, { passive: true, capture: true });
        const until = performance.now() + SETTLE_FOR;
        while (turn === mine && !touched && Math.abs(el.scrollTop - top) > 1 && performance.now() < until) {
          await frame();
          if (turn === mine && !touched) el.scrollTop = top;
        }
        for (const sign of signs) el.removeEventListener(sign, touch, { capture: true });
      }
      if (turn === mine) following = id;
    },
  };
}
