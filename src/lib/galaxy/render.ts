/**
 * Draws the Galaxy view on a canvas: a black-and-white night sky, a spiral
 * galaxy in it, and every page as a star in its arms, coloured
 * like real stars by how much it holds: short notes burn red, long ones blue.
 * Links are faint threads between stars; hovering a star lights up its own.
 * The galaxy's form (arms, bar, tilt) is the workspace's own (layout.ts formFor).
 *
 * The galaxy holds still (motion that isn't asked for makes people dizzy): it
 * fades in, and moves only when it's dragged, zoomed or flown to a page, so
 * it draws only then or when something changes. Everything soft (the core,
 * the haze of the arms, the dust lanes) and the thousands of specks of
 * stardust are painted once into an image, so a frame is that image, the
 * links and the stars. Zoomed in, the specks near you are drawn one by one.
 */
import { armPoint, SPACING, type GalaxyLayout } from './layout';

export interface GalaxyEvents {
  /** The star under the pointer changed or moved (-1: none), in CSS pixels. */
  hover: (star: number, x: number, y: number) => void;
  /** A star was clicked. */
  pick: (star: number, e: MouseEvent) => void;
}

/** A part of the canvas covered by the view's own controls, where no label goes. */
export interface Covered {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The galaxy fades in over this long when the view opens. */
const INTRO_MS = 700;
const FLY_MS = 900;
/** Below this many CSS pixels of movement a press is a click, not a drag. */
const DRAG_SLOP = 4;
/** Stars smaller than this (radius, CSS pixels) are drawn as plain dots, batched: thousands of sprites are slow. */
const SPRITE_FROM = 2.6;
/** Brightness steps the dots are batched in. */
const LEVELS = 10;
/** Zoomed in this far (against the whole galaxy), the dust is drawn speck by speck; further out it's part of the galaxy's image. */
const LIVE_DUST = 1.7;
/** Brightness of the dust's three steps. */
const DUST_LEVELS = [0.14, 0.3, 0.5];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const expoOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const cubicInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const white = (a: number) => `rgba(255,255,255,${a})`;

type RGB = [number, number, number];
/** Star colours from short notes to long ones, as real stars run from cool red to hot blue. */
const STAR_COLORS: RGB[] = [
  [255, 84, 72],
  [255, 124, 70],
  [255, 164, 74],
  [255, 200, 92],
  [255, 228, 140],
  [240, 240, 255],
  [176, 202, 255],
  [118, 162, 255],
];
/** Fewer words than this is as red as a note gets, more than LONG as blue. */
const SHORT = 10;
const LONG = 1500;

/** The colour step (an index into STAR_COLORS) for a page of `words` words. */
export function heatOf(words: number): number {
  const t = (Math.log10(words + 1) - Math.log10(SHORT)) / (Math.log10(LONG) - Math.log10(SHORT));
  return Math.round(clamp(t, 0, 1) * (STAR_COLORS.length - 1));
}

/** Small, fast and repeatable, so the dust falls the same way every visit. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** A star: a crisp point, white-hot in the middle, in a small halo of its colour. */
function starSprite([r, gr, b]: RGB) {
  const tint = (a: number) => `rgba(${r},${gr},${b},${a})`;
  const size = 64;
  const c = canvas(size, size);
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, white(1));
  grad.addColorStop(0.14, white(0.95));
  grad.addColorStop(0.24, tint(0.9));
  grad.addColorStop(0.34, tint(0.45));
  grad.addColorStop(0.52, tint(0.1));
  grad.addColorStop(0.75, tint(0.025));
  grad.addColorStop(1, tint(0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export class GalaxyRenderer {
  #el: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #events: GalaxyEvents;
  #title: (star: number) => string;

  #w = 0;
  #h = 0;
  #dpr = 1;

  #layout: GalaxyLayout | null = null;
  #stars = STAR_COLORS.map(starSprite);
  #dotStyles = STAR_COLORS.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  /** Each star's colour step. */
  #heat: Uint8Array = new Uint8Array(0);
  #disc: HTMLCanvasElement | null = null;
  #discExtent = 1;
  #field: HTMLCanvasElement | null = null;
  /** Stardust: x, y and size per speck, sorted by brightness. */
  #dust = new Float32Array(0);
  /** Where each brightness starts in #dust, in specks; the last entry is the count. */
  #dustStarts: number[] = [];
  #sky: CanvasGradient | null = null;
  #font = '';
  #covered: Covered[] = [];
  /** Per star: screen x/y this frame, and on-screen radius. */
  #sx = new Float32Array(0);
  #sy = new Float32Array(0);
  #sr = new Float32Array(0);
  /** This frame's dots, grouped by colour and brightness step. */
  #dotLevel = new Uint8Array(0);
  #dotOrder = new Uint32Array(0);
  /** Stars, brightest first, for labels. */
  #order = new Uint32Array(0);
  #neighbours: number[][] = [];
  /** Label widths by text, so a renamed page is measured afresh. */
  #widths = new Map<string, number>();

  /** The camera: the sky point at the centre of the view, and pixels per galaxy unit. */
  #cam = { x: 0, y: 0, zoom: 1 };
  #fitZoom = 1;
  /** A galaxy point (in its own plane, before the tilt) the camera is flying to and then keeps centred, and the star it's on, if any. */
  #follow: { x: number; y: number; zoom: number; from: { x: number; y: number; zoom: number }; start: number; star?: number } | null = null;
  /** How far the focus lights: its neighbours (1), or theirs too (2). */
  #depth = 1;
  #touched = false;

  #reduced = reducedMotion();
  #motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  #born = 0;
  #raf = 0;
  #dirty = true;

  #pointer: { x: number; y: number } | null = null;
  #drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  #pinch = new Map<number, { x: number; y: number }>();
  #hover = -1;
  /** The star a focus (Show in Galaxy, the star list, search) is on, and what's lit with it. */
  #focus = -1;
  #lit: Uint8Array | null = null;
  #matches: Uint8Array | null = null;

  constructor(el: HTMLCanvasElement, events: GalaxyEvents, title: (star: number) => string) {
    this.#el = el;
    this.#ctx = el.getContext('2d', { alpha: false })!;
    this.#events = events;
    this.#title = title;
    this.#born = performance.now();
    el.addEventListener('pointerdown', this.#down);
    el.addEventListener('pointermove', this.#move);
    el.addEventListener('pointerup', this.#up);
    el.addEventListener('pointercancel', this.#cancel);
    el.addEventListener('pointerleave', this.#leave);
    el.addEventListener('wheel', this.#wheel, { passive: false });
    el.addEventListener('dblclick', this.#dblclick);
    this.#motionQuery.addEventListener('change', this.#motionChange);
    this.#watchDensity();
    this.#wake();
  }

  destroy() {
    cancelAnimationFrame(this.#raf);
    const el = this.#el;
    el.removeEventListener('pointerdown', this.#down);
    el.removeEventListener('pointermove', this.#move);
    el.removeEventListener('pointerup', this.#up);
    el.removeEventListener('pointercancel', this.#cancel);
    el.removeEventListener('pointerleave', this.#leave);
    el.removeEventListener('wheel', this.#wheel);
    el.removeEventListener('dblclick', this.#dblclick);
    this.#motionQuery.removeEventListener('change', this.#motionChange);
    this.#densityQuery?.removeEventListener('change', this.#densityChange);
    // Zero-sized canvases give their GPU memory back now, not whenever they're collected.
    for (const c of [this.#el, this.#disc, this.#field, ...this.#stars]) if (c) c.width = c.height = 0;
    this.#disc = this.#field = null;
  }

  #densityQuery: MediaQueryList | null = null;
  #watchDensity() {
    this.#densityQuery?.removeEventListener('change', this.#densityChange);
    this.#densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.#densityQuery.addEventListener('change', this.#densityChange);
  }
  #densityChange = () => {
    this.#watchDensity();
    const [w, h] = [this.#w, this.#h];
    this.#w = 0;
    this.resize(w, h, this.#covered);
  };

  /** The canvas's size in CSS pixels, and the parts of it the view's controls cover. */
  resize(w: number, h: number, covered: Covered[] = []) {
    this.#covered = covered;
    this.#invalidate();
    // The GPU budget is small (tauri.conf.json), so very large windows draw at a lower density.
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(9e6 / Math.max(1, w * h)));
    if (w === this.#w && h === this.#h && dpr === this.#dpr) return;
    const wasFit = !this.#touched;
    this.#w = w;
    this.#h = h;
    this.#dpr = dpr;
    this.#el.width = Math.round(w * dpr);
    this.#el.height = Math.round(h * dpr);
    this.#field = null;
    this.#sky = null;
    this.#font = getComputedStyle(this.#el).fontFamily;
    this.#refit();
    if (wasFit) {
      this.#follow = null;
      this.#cam = { x: 0, y: 0, zoom: this.#fitZoom };
    }
  }

  /** New pages, links or lengths: rebuilds the sky. `heat` is each star's colour step (heatOf). */
  setLayout(layout: GalaxyLayout, heat: Uint8Array) {
    const first = !this.#layout;
    this.#layout = layout;
    this.#heat = heat;
    const n = layout.mag.length;
    this.#sx = new Float32Array(n);
    this.#sy = new Float32Array(n);
    this.#sr = new Float32Array(n);
    this.#dotLevel = new Uint8Array(n);
    this.#dotOrder = new Uint32Array(n);
    this.#order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => layout.mag[b] - layout.mag[a] || a - b);
    this.#neighbours = Array.from({ length: n }, () => []);
    for (let p = 0; p < layout.links.length; p += 2) {
      this.#neighbours[layout.links[p]].push(layout.links[p + 1]);
      this.#neighbours[layout.links[p + 1]].push(layout.links[p]);
    }
    this.#widths.clear();
    if (this.#hover !== -1) {
      this.#hover = -1;
      this.#el.style.cursor = '';
      this.#events.hover(-1, 0, 0);
    }
    if (this.#focus >= n) this.#focus = -1;
    this.#lit = null;
    if (this.#focus !== -1) this.#light(this.#focus, this.#depth);
    // A flight to a point (the old fit) means nothing in the new sky;
    // one on a star is re-aimed when the view focuses it again.
    if (this.#follow && this.#follow.star === undefined) this.#follow = null;
    this.#scatterDust();
    this.#paintDisc();
    this.#refit();
    if (first || !this.#touched) this.#cam = { x: 0, y: 0, zoom: this.#fitZoom };
    // The galaxy forms when its stars arrive, not when the canvas did.
    if (first) this.#born = performance.now();
    this.#invalidate();
  }

  /** Pages grew or shrank but nothing moved: new colour steps only. */
  recolor(heat: Uint8Array) {
    this.#heat = heat;
    this.#invalidate();
  }

  /** Titles changed: measure labels again. */
  retitle() {
    this.#widths.clear();
    this.#invalidate();
  }

  /**
   * Centres the view on a star and lights it with its neighbours (and theirs,
   * with `depth` 2), dimming the rest. -1 lets go. Without `fly` it only
   * lights them, leaving the camera be.
   */
  focus(star: number, { depth = 1, fly = true }: { depth?: number; fly?: boolean } = {}) {
    const layout = this.#layout;
    if (!layout || star < 0 || star >= layout.mag.length) {
      this.#focus = -1;
      this.#lit = null;
      this.#invalidate();
      return;
    }
    this.#focus = star;
    this.#depth = depth;
    this.#light(star, depth);
    if (fly) {
      this.#touched = true;
      this.#flyTo(layout.pos[star * 2], layout.pos[star * 2 + 1], Math.max(this.#cam.zoom, this.#fitZoom * 3.2), star);
    } else if (this.#follow?.star !== undefined) {
      // The sky was laid out again: keep following the same page where it is now.
      this.#flyTo(layout.pos[star * 2], layout.pos[star * 2 + 1], this.#follow.zoom, star);
    }
  }

  /** Stars that match a search, brightened and labelled; null clears it. */
  highlight(stars: Uint8Array | null) {
    this.#matches = stars;
    this.#invalidate();
  }

  /** Back to the whole galaxy. */
  fit() {
    this.#touched = false;
    this.#flyTo(0, 0, this.#fitZoom);
  }

  zoomBy(factor: number) {
    this.#touched = true;
    const z = clamp(this.#aimedZoom() * factor, ...this.#zoomRange());
    const at = this.#follow ? { x: this.#follow.x, y: this.#follow.y } : this.#fromSky(this.#cam.x, this.#cam.y);
    this.#flyTo(at.x, at.y, z, this.#follow?.star);
  }

  /** The zoom a flight under way is heading for, so quick clicks add up. */
  #aimedZoom() {
    return this.#follow && performance.now() - this.#follow.start < FLY_MS ? this.#follow.zoom : this.#cam.zoom;
  }

  #light(star: number, depth: number) {
    const lit = new Uint8Array(this.#neighbours.length);
    lit[star] = 3;
    let ring = [star];
    for (let d = 1; d <= depth; d++) {
      const next: number[] = [];
      for (const s of ring)
        for (const o of this.#neighbours[s])
          if (!lit[o]) {
            lit[o] = 3 - d;
            next.push(o);
          }
      ring = next;
    }
    this.#lit = lit;
    this.#invalidate();
  }

  #zoomRange(): [number, number] {
    return [this.#fitZoom * 0.45, Math.max(this.#fitZoom * 14, 5)];
  }

  #refit() {
    const radius = this.#layout?.radius ?? 400;
    this.#fitZoom = Math.max(1e-3, (Math.min(this.#w, this.#h) * 0.47) / radius);
  }

  #flyTo(x: number, y: number, zoom: number, star?: number) {
    this.#follow = { x, y, zoom, from: { ...this.#cam }, start: performance.now(), star };
    this.#invalidate();
  }

  /**
   * Galaxy point → sky point: the galaxy tilted and laid the way this one
   * faces. As [a, b, c, d]: x' = a·x + b·y, y' = c·x + d·y.
   */
  #matrix() {
    const form = this.#layout?.form;
    const tilt = form?.tilt ?? 1;
    const facing = form?.facing ?? 0;
    const cf = Math.cos(facing);
    const sf = Math.sin(facing);
    // R(facing) · S(1, tilt)
    return [cf, -sf * tilt, sf, cf * tilt];
  }

  #toSky(x: number, y: number) {
    const [a, b, c, d] = this.#matrix();
    return { x: a * x + b * y, y: c * x + d * y };
  }

  #fromSky(x: number, y: number) {
    const [a, b, c, d] = this.#matrix();
    const det = a * d - b * c || 1;
    return { x: (d * x - b * y) / det, y: (-c * x + a * y) / det };
  }

  /** The core, the haze of the arms and clusters, and the dust lanes, painted once. */
  #paintDisc() {
    const layout = this.#layout!;
    const { spiral } = layout;
    const extent = layout.radius * 1.25;
    // About a pixel per galaxy unit: sharp at the usual zoom, and kind to the GPU's small budget.
    const size = Math.min(1536, Math.max(1024, Math.round(extent * 2 * 0.9)));
    const k = size / (2 * extent);
    const c = canvas(size, size);
    // Opaque black, added onto the sky: a haze this faint kept with transparency
    // has only a few steps of brightness left, which show as bands when zoomed.
    const g = c.getContext('2d', { alpha: false })!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.translate(size / 2, size / 2);
    g.scale(k, k);
    const blob = (x: number, y: number, r: number, stops: [number, number][], ink = white) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      for (const [at, alpha] of stops) grad.addColorStop(at, ink(alpha));
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // A puff that fades like a bell curve. Straight-line fades have a kink, and
    // hundreds of puffs strung along an arm line their kinks up into ridges.
    const bell = Array.from({ length: 11 }, (_, i) => {
      const t = i / 10;
      return [t, (Math.exp(-5 * t * t) - Math.exp(-5)) / (1 - Math.exp(-5))] as const;
    });
    const soft = (x: number, y: number, r: number, peak: number, ink = white) =>
      blob(
        x,
        y,
        r,
        bell.map(([t, v]) => [t, peak * v]),
        ink,
      );
    const rand = random(layout.mag.length * 31 + 7);

    g.globalCompositeOperation = 'lighter';
    // A faint halo around the whole disc.
    soft(0, 0, spiral.rOut * 1.2, 0.035);
    // The arms: a thin haze of stars too faint to see one by one.
    for (let arm = 0; arm < spiral.arms; arm++) {
      for (let u = 0; u <= 1; u += 0.006) {
        const p = armPoint(spiral, arm, u);
        const fade = 1 - u * 0.75;
        soft(p.x, p.y, p.width * 1.1, 0.026 * fade);
      }
    }
    // The bulge, the bar (when this galaxy has one) and the core.
    const { form } = layout;
    g.save();
    g.rotate(spiral.twist);
    if (form.bar) {
      g.scale(3.4, 0.5);
      soft(0, 0, spiral.rIn * 0.34, 0.17 * form.bar);
    } else {
      g.scale(1.8, 0.6);
      soft(0, 0, spiral.rIn * 1.1, 0.06);
    }
    g.restore();
    soft(0, 0, spiral.rIn * 2 * form.core, 0.1);
    blob(0, 0, spiral.rIn * 0.8 * form.core, [
      [0, 0.5],
      [0.18, 0.2],
      [0.5, 0.05],
      [1, 0],
    ]);

    // A little more haze where a cluster's stars gather.
    const members: number[][] = layout.clusters.map(() => []);
    for (let i = 0; i < layout.cluster.length; i++) members[layout.cluster[i]].push(i);
    layout.clusters.forEach((cluster, ci) => {
      if (cluster.root === -1) return;
      const list = members[ci];
      const clouds = Math.min(12, 2 + Math.ceil(Math.sqrt(list.length)));
      for (let j = 0; j < clouds; j++) {
        const i = list[Math.floor((j / clouds) * list.length)];
        const r = SPACING * (1.8 + rand() * 2) * Math.min(2.2, 0.8 + Math.sqrt(list.length) / 9);
        soft(layout.pos[i * 2] + (rand() - 0.5) * SPACING * 2, layout.pos[i * 2 + 1] + (rand() - 0.5) * SPACING * 2, r, 0.035);
      }
    });

    // Dust lanes darken the inner edge of each arm.
    g.globalCompositeOperation = 'source-over';
    const black = (a: number) => `rgba(0,0,0,${a})`;
    for (let arm = 0; arm < spiral.arms; arm++) {
      for (let u = 0.04; u <= 0.92; u += 0.004) {
        const p = armPoint(spiral, arm, u);
        const r = Math.hypot(p.x, p.y);
        const inward = p.width * (0.3 + (rand() - 0.5) * 0.12);
        const x = p.x - (p.x / r) * inward;
        const y = p.y - (p.y / r) * inward;
        soft(x, y, p.width * (0.18 + rand() * 0.12), 0.2 * form.lanes * (1 - u * 0.7), black);
      }
    }

    // The browser dithers gradients in a fine regular pattern, which zooming in
    // would magnify into stripes; a slight blur melts it into the haze.
    const smooth = canvas(size, size);
    const sg = smooth.getContext('2d', { alpha: false })!;
    sg.filter = 'blur(2px)';
    sg.drawImage(c, 0, 0);
    // Give the first copy's memory back now rather than whenever it's collected.
    c.width = c.height = 0;

    // The stardust, painted in after the blur so it stays sharp.
    sg.filter = 'none';
    sg.globalCompositeOperation = 'lighter';
    sg.translate(size / 2, size / 2);
    sg.scale(k, k);
    const dust = this.#dust;
    for (let l = 0; l < DUST_LEVELS.length; l++) {
      sg.fillStyle = white(DUST_LEVELS[l]);
      for (let i = this.#dustStarts[l]; i < this.#dustStarts[l + 1]; i++) {
        // At least a pixel of the image, so the faintest still show.
        const d = Math.max(1.2, dust[i * 3 + 2] * 1.5) / k;
        sg.fillRect(dust[i * 3] - d / 2, dust[i * 3 + 1] - d / 2, d, d);
      }
    }
    this.#disc = smooth;
    this.#discExtent = extent;
  }

  /** Specks of light along the arms and in the core: the galaxy's own stars, not pages. */
  #scatterDust() {
    const layout = this.#layout!;
    const { spiral } = layout;
    const count = Math.round(clamp(7000 + layout.mag.length * 0.5, 7000, 12000));
    const rand = random(count * 13 + 1);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    const specks: { x: number; y: number; size: number; level: number }[] = [];
    for (let i = 0; i < count; i++) {
      let x: number, y: number;
      const kind = rand();
      if (kind < 0.22) {
        const { form } = layout;
        if (form.bar && rand() < 0.4) {
          // Along the bar, which joins the arms' starts.
          const along = (rand() * 2 - 1) * spiral.rIn * 0.95;
          const across = gauss() * spiral.rIn * 0.09;
          x = along * Math.cos(spiral.twist) - across * Math.sin(spiral.twist);
          y = along * Math.sin(spiral.twist) + across * Math.cos(spiral.twist);
        } else {
          // The bulge.
          const r = Math.abs(gauss()) * spiral.rIn * 0.42 * form.core;
          const a = rand() * Math.PI * 2;
          x = r * Math.cos(a) * 1.25;
          y = r * Math.sin(a) * 0.85;
        }
      } else if (kind < 0.86) {
        // Along an arm, thinning toward its end.
        const p = armPoint(spiral, Math.floor(rand() * spiral.arms), Math.pow(rand(), 1.35));
        const r = Math.hypot(p.x, p.y);
        const off = gauss() * p.width * 0.24;
        const along = gauss() * p.width * 0.2;
        x = p.x + (p.x / r) * off - (p.y / r) * along;
        y = p.y + (p.y / r) * off + (p.x / r) * along;
      } else {
        // The thin disc between the arms.
        const r = spiral.rIn * 0.6 + Math.sqrt(rand()) * spiral.rOut;
        const a = rand() * Math.PI * 2;
        x = r * Math.cos(a);
        y = r * Math.sin(a);
      }
      const bright = rand();
      specks.push({ x, y, size: 0.45 + bright * bright * 0.9, level: bright < 0.55 ? 0 : bright < 0.88 ? 1 : 2 });
    }
    specks.sort((a, b) => a.level - b.level);
    this.#dust = new Float32Array(count * 3);
    this.#dustStarts = [0, 0, 0, count];
    specks.forEach((d, i) => {
      this.#dust.set([d.x, d.y, d.size], i * 3);
      if (i > 0 && specks[i - 1].level !== d.level) for (let l = specks[i - 1].level + 1; l <= d.level; l++) this.#dustStarts[l] = i;
    });
    // A brightness no speck got starts where the next one does.
    const last = specks.at(-1)?.level ?? -1;
    for (let l = last + 1; l < 3; l++) this.#dustStarts[l] = count;
  }

  /** The far stars behind everything, as a tile that drifts a little when the view pans. */
  #paintField() {
    const size = 512;
    const c = canvas(size * this.#dpr, size * this.#dpr);
    const g = c.getContext('2d')!;
    g.scale(this.#dpr, this.#dpr);
    const rand = random(99);
    for (let i = 0; i < 200; i++) {
      const b = rand();
      g.fillStyle = white(0.12 + b * 0.55);
      g.beginPath();
      g.arc(rand() * size, rand() * size, (0.4 + b * b * 1.1) / 2, 0, Math.PI * 2);
      g.fill();
    }
    this.#field = c;
  }

  /** Something changed: draw it on the next frame, waking the loop if it's asleep. */
  #invalidate() {
    this.#dirty = true;
    this.#wake();
  }

  #wake() {
    if (!this.#raf) this.#raf = requestAnimationFrame(this.#loop);
  }

  #motionChange = () => {
    this.#reduced = reducedMotion();
    this.#invalidate();
  };

  #loop = (now: number) => {
    this.#raf = 0;
    if (!this.#w || !this.#h) return;
    // A frame past the end, so the fade and the flight land exactly.
    const fading = !this.#reduced && now - this.#born < INTRO_MS + 50;
    const flying = this.#follow !== null && now - this.#follow.start < FLY_MS + 50;
    if (!this.#dirty && !fading && !flying) return;
    if (fading || flying) this.#raf = requestAnimationFrame(this.#loop);
    this.#step(now);
    this.#draw(this.#reduced ? 1 : clamp((now - this.#born) / INTRO_MS, 0, 1));
    this.#dirty = false;
  };

  /** The camera's flight toward (and then along with) what it follows. */
  #step(now: number) {
    const f = this.#follow;
    if (!f) return;
    const target = this.#toSky(f.x, f.y);
    const t = this.#reduced ? 1 : clamp((now - f.start) / FLY_MS, 0, 1);
    const e = cubicInOut(t);
    this.#cam.x = f.from.x + (target.x - f.from.x) * e;
    this.#cam.y = f.from.y + (target.y - f.from.y) * e;
    this.#cam.zoom = Math.exp(Math.log(f.from.zoom) + (Math.log(f.zoom) - Math.log(f.from.zoom)) * e);
    // Once there it stays centred until the view is moved by hand.
  }

  #draw(intro: number) {
    const layout = this.#layout;
    const g = this.#ctx;
    const w = this.#w;
    const h = this.#h;
    const dpr = this.#dpr;
    const introE = expoOut(intro);
    const zoom = this.#cam.zoom;
    const [ma, mb, mc, md] = this.#matrix();
    const cx = w / 2 - this.#cam.x * zoom;
    const cy = h / 2 - this.#cam.y * zoom;
    const rel = this.#cam.zoom / this.#fitZoom;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    if (!this.#sky) {
      this.#sky = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      this.#sky.addColorStop(0, '#0a0a0a');
      this.#sky.addColorStop(1, '#000000');
    }
    g.fillStyle = this.#sky;
    g.fillRect(0, 0, w, h);

    // Far stars, drifting slower than the galaxy when it pans.
    if (!this.#field) this.#paintField();
    const tile = 512;
    const ox = (((-this.#cam.x * zoom * 0.04) % tile) + tile) % tile;
    const oy = (((-this.#cam.y * zoom * 0.04) % tile) + tile) % tile;
    for (let x = ox - tile; x < w; x += tile) for (let y = oy - tile; y < h; y += tile) g.drawImage(this.#field!, x, y, tile, tile);

    if (!layout || !this.#disc) return;

    // The disc; its haze thins as you zoom in among the stars.
    g.save();
    g.globalAlpha = introE * clamp(1.15 - 0.45 * Math.log2(Math.max(1, rel)), 0.2, 1);
    g.globalCompositeOperation = 'lighter';
    g.translate(cx, cy);
    g.transform(ma, mc, mb, md, 0, 0);
    // Shrinking the big image needs the careful filter, or its haze shows moiré.
    g.imageSmoothingQuality = 'high';
    const e = this.#discExtent * zoom;
    g.drawImage(this.#disc, -e, -e, e * 2, e * 2);
    g.restore();

    // Zoomed in, the stardust near you speck by speck (dimmest first); the image's own is too soft by then.
    const live = clamp((rel - LIVE_DUST) / 0.6, 0, 1);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = introE * live;
    const dust = this.#dust;
    const grain = clamp(Math.pow(rel, 0.3), 0.8, 2.2);
    for (let l = 0; l < (live ? DUST_LEVELS.length : 0); l++) {
      g.fillStyle = white(DUST_LEVELS[l]);
      for (let i = this.#dustStarts[l]; i < this.#dustStarts[l + 1]; i++) {
        const x = dust[i * 3];
        const y = dust[i * 3 + 1];
        const px = cx + (ma * x + mb * y) * zoom;
        const py = cy + (mc * x + md * y) * zoom;
        if (px < -2 || py < -2 || px > w + 2 || py > h + 2) continue;
        const s = dust[i * 3 + 2] * grain;
        g.fillRect(px - s / 2, py - s / 2, s, s);
      }
    }

    // Where every star is this frame.
    const n = layout.mag.length;
    const pos = layout.pos;
    const sx = this.#sx;
    const sy = this.#sy;
    const sr = this.#sr;
    const starScale = clamp(Math.pow(rel, 0.55), 0.85, 7);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      sx[i] = cx + (ma * x + mb * y) * zoom;
      sy[i] = cy + (mc * x + md * y) * zoom;
      // Links make a star bright; a long page makes it a little bigger, like a blue giant.
      sr[i] = (1.2 + 2.4 * layout.mag[i] + 0.12 * (this.#heat[i] ?? 0)) * starScale;
    }
    this.#pickUnderPointer();

    const lit = this.#lit;
    const matches = this.#matches;
    const hover = this.#hover;
    const dimming = lit !== null || matches !== null;
    // Thousands of pages in view would fill the sky with light: the faint ones dim
    // with the crowd (less as you zoom in), the bright ones keep shining.
    const crowd = clamp(Math.sqrt(450 / Math.max(1, n / (rel * rel))), 0.32, 1);

    // Links: faint threads, and the lit ones brighter.
    const links = layout.links;
    g.globalAlpha = 1;
    g.lineWidth = 0.75;
    g.strokeStyle = white((dimming ? 0.03 : 0.07) * (0.35 + 0.65 * crowd) * introE);
    // A link with both ends off the same side of the view can't cross it.
    const away = (a: number, b: number) => (sx[a] < 0 && sx[b] < 0) || (sx[a] > w && sx[b] > w) || (sy[a] < 0 && sy[b] < 0) || (sy[a] > h && sy[b] > h);
    g.beginPath();
    for (let p = 0; p < links.length; p += 2) {
      const a = links[p];
      const b = links[p + 1];
      if (away(a, b)) continue;
      g.moveTo(sx[a], sy[a]);
      g.lineTo(sx[b], sy[b]);
    }
    g.stroke();
    const lightLinks = (center: number, alpha: number, width: number) => {
      g.lineWidth = width;
      for (const o of this.#neighbours[center]) {
        if (away(center, o)) continue;
        const grad = g.createLinearGradient(sx[center], sy[center], sx[o], sy[o]);
        grad.addColorStop(0, white(alpha));
        grad.addColorStop(1, white(alpha * 0.45));
        g.strokeStyle = grad;
        g.beginPath();
        g.moveTo(sx[center], sy[center]);
        g.lineTo(sx[o], sy[o]);
        g.stroke();
      }
    };
    if (lit) {
      // Second-ring links faintly, as one stroke (a hub's neighbours can have thousands), then the focused star's own brightly.
      if (this.#depth >= 2) {
        g.lineWidth = 0.7;
        g.strokeStyle = white(0.1);
        g.beginPath();
        for (const s of this.#neighbours[this.#focus])
          for (const o of this.#neighbours[s]) {
            if (o === this.#focus || away(s, o)) continue;
            g.moveTo(sx[s], sy[s]);
            g.lineTo(sx[o], sy[o]);
          }
        g.stroke();
      }
      lightLinks(this.#focus, 0.5, 1);
    }
    if (hover !== -1) lightLinks(hover, 0.55, 1);

    // Stars: big ones as soft sprites, the many small ones as dots batched by brightness.
    const level = this.#dotLevel;
    const heat = this.#heat;
    const colors = STAR_COLORS.length;
    // Batches: colour × brightness step (0 is "not a dot").
    const counts = new Uint32Array((LEVELS + 1) * colors);
    for (let i = 0; i < n; i++) {
      const r = sr[i];
      const x = sx[i];
      const y = sy[i];
      const d = r * 3.6;
      level[i] = 0;
      if (x < -d || y < -d || x > w + d || y > h + d) continue;
      let a = (0.62 + 0.38 * layout.mag[i]) * (crowd + (1 - crowd) * layout.mag[i] * layout.mag[i]);
      if (dimming && !(lit && lit[i]) && !(matches && matches[i]) && i !== hover) a *= 0.25;
      // Inner stars come out first as the view opens.
      if (intro < 1) a *= clamp(introE * 1.5 - (Math.hypot(pos[i * 2], pos[i * 2 + 1]) / layout.radius) * 0.5, 0, 1);
      if (a <= 0.01) continue;
      if (r >= SPRITE_FROM) {
        g.globalAlpha = Math.min(1, a);
        g.drawImage(this.#stars[heat[i] ?? 0], x - d / 2, y - d / 2, d, d);
      } else {
        level[i] = Math.max(1, Math.min(LEVELS, Math.round(a * LEVELS)));
        counts[(heat[i] ?? 0) * (LEVELS + 1) + level[i]]++;
      }
    }
    const batches = counts.length;
    const starts = new Uint32Array(batches + 1);
    for (let k = 0; k < batches; k++) starts[k + 1] = starts[k] + counts[k];
    const fill = starts.slice();
    for (let i = 0; i < n; i++) if (level[i]) this.#dotOrder[fill[(heat[i] ?? 0) * (LEVELS + 1) + level[i]]++] = i;
    // A dot's width matches a sprite's white centre; on sharp screens a square would show, so they're round.
    const round = dpr >= 1.5;
    for (let batch = 0; batch < batches; batch++) {
      const l = batch % (LEVELS + 1);
      if (!l || starts[batch] === starts[batch + 1]) continue;
      g.fillStyle = this.#dotStyles[Math.floor(batch / (LEVELS + 1))];
      g.globalAlpha = l / LEVELS;
      g.beginPath();
      for (let k = starts[batch]; k < starts[batch + 1]; k++) {
        const i = this.#dotOrder[k];
        const half = Math.max(0.7, sr[i] * (0.4 + 0.2 * crowd));
        if (round) {
          g.moveTo(sx[i] + half, sy[i]);
          g.arc(sx[i], sy[i], half, 0, Math.PI * 2);
        } else g.rect(sx[i] - half, sy[i] - half, half * 2, half * 2);
      }
      g.fill();
    }
    // Rings around the star in focus and the one under the pointer.
    g.globalCompositeOperation = 'source-over';
    const ring = (i: number, alpha: number) => {
      g.globalAlpha = alpha;
      g.strokeStyle = white(0.7);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(sx[i], sy[i], sr[i] * 2.2 + 5, 0, Math.PI * 2);
      g.stroke();
    };
    if (this.#focus !== -1) ring(this.#focus, 0.7);
    if (hover !== -1 && hover !== this.#focus) ring(hover, 0.4);

    this.#labels(rel, introE);
  }

  /** Names beside the brightest stars that fit, more as you zoom in; none under the view's controls. */
  #labels(rel: number, introE: number) {
    const layout = this.#layout!;
    const g = this.#ctx;
    const w = this.#w;
    const h = this.#h;
    const lit = this.#lit;
    const matches = this.#matches;
    const cut = 0.78 - 0.32 * Math.log2(Math.max(1, rel));
    g.font = `500 12px ${this.#font}`;
    g.textBaseline = 'middle';
    const taken: number[] = [];
    for (const c of this.#covered) taken.push(c.x, c.y, c.width, c.height);
    const reserved = taken.length;
    const free = (x: number, y: number, wd: number, upTo = taken.length) => {
      for (let k = 0; k < upTo; k += 4) {
        if (x < taken[k] + taken[k + 2] && x + wd > taken[k] && y < taken[k + 1] + taken[k + 3] && y + 16 > taken[k + 1]) return false;
      }
      return true;
    };
    const place = (i: number, alpha: number, strong: boolean) => {
      const x = this.#sx[i] + this.#sr[i] * 1.6 + 6;
      const y = this.#sy[i] - 8;
      if (x > w || y > h || y < -16) return false;
      const full = this.#title(i);
      const chars = Array.from(full);
      const text = chars.length > 40 ? chars.slice(0, 39).join('') + '…' : full;
      let wd = this.#widths.get(text);
      if (wd === undefined) {
        wd = Math.min(220, g.measureText(text).width);
        this.#widths.set(text, wd);
      }
      // The star under the pointer or in focus only keeps clear of the controls.
      if (!free(x, y, wd, strong ? reserved : taken.length)) return false;
      taken.push(x - 2, y, wd + 4, 16);
      g.globalAlpha = alpha * introE;
      g.fillStyle = strong ? white(0.95) : 'rgba(225,225,228,0.7)';
      g.shadowColor = 'rgba(0,0,0,0.9)';
      g.shadowBlur = 4;
      g.fillText(text, x, y + 8, 220);
      g.shadowBlur = 0;
      return true;
    };
    // The star in focus goes first. The one under the pointer has its name in the view's card.
    if (this.#focus !== -1 && this.#focus !== this.#hover) place(this.#focus, 1, true);
    let shown = (taken.length - reserved) / 4;
    const max = Math.round(clamp((w * h) / 22000, 10, 48));
    for (let k = 0; k < this.#order.length && shown < max; k++) {
      const i = this.#order[k];
      if (i === this.#hover || i === this.#focus) continue;
      const wanted = (lit && lit[i] > 0) || (matches && matches[i]);
      if (!wanted && (layout.mag[i] < cut || lit || matches)) continue;
      if (this.#sx[i] < 0 || this.#sx[i] > w || this.#sy[i] < 0 || this.#sy[i] > h) continue;
      if (place(i, wanted ? 0.95 : 0.85, false)) shown++;
    }
  }

  /** The star nearest the pointer, if it's close enough to mean it. */
  #pickUnderPointer() {
    const p = this.#pointer;
    let best = -1;
    if (p && !this.#drag && this.#layout) {
      let bestD = Infinity;
      for (let i = 0; i < this.#sx.length; i++) {
        const dx = this.#sx[i] - p.x;
        const dy = this.#sy[i] - p.y;
        const d = dx * dx + dy * dy;
        const reach = Math.max(9, this.#sr[i] * 2.4);
        if (d < reach * reach && d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best === this.#hover && best === -1) return;
    if (best !== this.#hover) {
      this.#hover = best;
      this.#el.style.cursor = best === -1 ? '' : 'pointer';
    }
    this.#events.hover(best, best === -1 ? 0 : this.#sx[best], best === -1 ? 0 : this.#sy[best]);
  }

  #local(e: PointerEvent | MouseEvent) {
    const r = this.#el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #handMoved() {
    this.#touched = true;
    this.#follow = null;
    this.#invalidate();
  }

  #down = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = this.#local(e);
    this.#pinch.set(e.pointerId, p);
    if (this.#pinch.size === 1) this.#drag = { id: e.pointerId, x: p.x, y: p.y, moved: false };
    else this.#drag = null;
    this.#el.setPointerCapture(e.pointerId);
  };

  #move = (e: PointerEvent) => {
    const p = this.#local(e);
    this.#pointer = p;
    this.#invalidate();
    const before = this.#pinch.get(e.pointerId);
    if (before && this.#pinch.size === 2) {
      // Two fingers: zoom around their middle.
      const [a, b] = [...this.#pinch.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      this.#pinch.set(e.pointerId, p);
      const [c, d] = [...this.#pinch.values()];
      const d1 = Math.hypot(c.x - d.x, c.y - d.y);
      if (d0 > 0) this.#zoomAround((c.x + d.x) / 2, (c.y + d.y) / 2, d1 / d0);
      return;
    }
    const drag = this.#drag;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      this.#el.style.cursor = 'grabbing';
    }
    this.#cam.x -= dx / this.#cam.zoom;
    this.#cam.y -= dy / this.#cam.zoom;
    drag.x = p.x;
    drag.y = p.y;
    this.#handMoved();
  };

  #up = (e: PointerEvent) => {
    const drag = this.#drag;
    this.#pinch.delete(e.pointerId);
    if (drag && drag.id === e.pointerId) {
      this.#drag = null;
      this.#el.style.cursor = '';
      if (!drag.moved) {
        this.#pointer = this.#local(e);
        this.#pickUnderPointer();
        if (this.#hover !== -1) this.#events.pick(this.#hover, e);
      }
    }
    this.#invalidate();
  };

  #cancel = (e: PointerEvent) => {
    this.#pinch.delete(e.pointerId);
    this.#drag = null;
    this.#el.style.cursor = '';
  };

  #leave = () => {
    if (this.#drag) return;
    this.#pointer = null;
    this.#invalidate();
  };

  #wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.#local(e);
    // Pinch on a trackpad arrives as a wheel with Ctrl; it wants to feel quicker.
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.012 : 0.0016;
    this.#zoomAround(p.x, p.y, Math.exp(-e.deltaY * lines * k));
  };

  #dblclick = (e: MouseEvent) => {
    if (this.#hover !== -1) return;
    const p = this.#local(e);
    const at = this.#fromSky(this.#cam.x + (p.x - this.#w / 2) / this.#cam.zoom, this.#cam.y + (p.y - this.#h / 2) / this.#cam.zoom);
    this.#touched = true;
    this.#flyTo(at.x, at.y, clamp(this.#aimedZoom() * 2.4, ...this.#zoomRange()));
  };

  #zoomAround(x: number, y: number, factor: number) {
    const [lo, hi] = this.#zoomRange();
    const zoom = clamp(this.#cam.zoom * factor, lo, hi);
    // Keep the sky point under (x, y) where it is.
    const skyX = this.#cam.x + (x - this.#w / 2) / this.#cam.zoom;
    const skyY = this.#cam.y + (y - this.#h / 2) / this.#cam.zoom;
    this.#cam.zoom = zoom;
    this.#cam.x = skyX - (x - this.#w / 2) / zoom;
    this.#cam.y = skyY - (y - this.#h / 2) / zoom;
    this.#handMoved();
  }
}
