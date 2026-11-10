/** Svelte transitions shared by popovers, menus and dialogs. */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Exponential ease-out: fast start, long gentle settle. */
const expoOut = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Scales and fades in from slightly smaller, like a macOS popover. */
export function pop(_node: Element, { duration = 220, scale = 0.96, y = -4 } = {}) {
  return {
    duration: reduced() ? 0 : duration,
    easing: expoOut,
    css: (t: number, u: number) =>
      `opacity: ${Math.min(1, t * 1.6)}; transform: translateY(${u * y}px) scale(${1 - u * (1 - scale)});`,
  };
}

/** Quick fade for exits; leaving should never feel slower than arriving. */
export function fadeOut(_node: Element, { duration = 120 } = {}) {
  return {
    duration: reduced() ? 0 : duration,
    css: (t: number) => `opacity: ${t};`,
  };
}

/** For modal sheets: a little more scale, and the backdrop fades with it. */
export function sheet(_node: Element, { duration = 300 } = {}) {
  return pop(_node, { duration, scale: 0.94, y: 8 });
}

const cubicOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Closing a sheet or dialog: it sinks a little and shrinks as it fades,
 * gently at first and then away (cubic-out on a reversed clock).
 */
export function sheetOut(_node: Element, { duration = 180 } = {}) {
  return {
    duration: reduced() ? 0 : duration,
    easing: cubicOut,
    css: (t: number, u: number) => `opacity: ${t}; transform: translateY(${u * 6}px) scale(${1 - u * 0.04});`,
  };
}

/**
 * The sidebar sliding in or out: its slot widens or narrows (so the page
 * beside it glides over), while the panel itself moves with the edge
 * instead of squashing, and fades a touch at the far end.
 */
export function sidebarSlide(node: HTMLElement, { duration = 260 } = {}) {
  const width = node.offsetWidth;
  return {
    duration: reduced() ? 0 : duration,
    easing: cubicOut,
    css: (t: number, u: number) =>
      `overflow: hidden; width: ${(t * width).toFixed(2)}px; --slide: ${(-u * width * 0.35).toFixed(2)}px; --slide-fade: ${(0.4 + 0.6 * t).toFixed(3)};`,
  };
}

export function fade(_node: Element, { duration = 200 } = {}) {
  return {
    duration: reduced() ? 0 : duration,
    css: (t: number) => `opacity: ${t};`,
  };
}

/**
 * One small icon giving way to another in the same spot (a page's icon as
 * it gains or loses sub-pages): the old one shrinks away as the new grows in.
 */
export function swap(_node: Element, { duration = 200, scale = 0.6 } = {}) {
  return {
    duration: reduced() ? 0 : duration,
    easing: cubicOut,
    css: (t: number, u: number) => `opacity: ${t}; transform: scale(${1 - u * (1 - scale)});`,
  };
}
