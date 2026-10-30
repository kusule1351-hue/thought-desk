/**
 * Where each page sits in the Galaxy view. Every page is a star. A top-level
 * page and everything inside it make one cluster, and the clusters are strung
 * along the galaxy's spiral arms, the biggest nearest the core. Links pull
 * linked pages together, within a cluster and across arms.
 *
 * Pure and deterministic: the same pages and links always give the same sky,
 * so it doesn't reshuffle between visits, and each star's scatter depends only
 * on its own page. Given where the stars were (prev), a small change settles
 * from there instead. Big workspaces run it in a worker (layout.worker.ts).
 */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';

export interface GalaxyPage {
  id: string;
  /** The page it's inside, or null for a top-level page. */
  parent: string | null;
}

export interface GalaxyInput {
  /** In sidebar order: siblings next to each other in the sky. */
  pages: GalaxyPage[];
  /** [from, to] page ids; either way round, duplicates and unknown ids are fine. */
  links: [string, string][];
  /** The workspace's own number, which picks its galaxy's form (formFor). */
  seed: number;
  /**
   * Where the stars were last time, so a small change (a new link, a page
   * more or less) settles the sky from there instead of laying it out anew.
   */
  prev?: { ids: string[]; pos: Float32Array };
}

/**
 * What makes one person's galaxy theirs, drawn once from their workspace's
 * seed: how many arms and how tightly they wind, which way, whether a bar
 * crosses the core, and the angle it's seen from.
 */
export interface Form {
  arms: number;
  /** tan(pitch angle): small winds tightly, large opens out. */
  pitch: number;
  /** Which way the arms wind (1 or -1). */
  spin: number;
  /** A bar through the core, joining the arms' starts: how bold it is (0: none). */
  bar: number;
  /** How wide the arms spread, against the usual. */
  width: number;
  /** Seen at an angle: the disc's height against its width (1: face on). */
  tilt: number;
  /** Which way the tilted disc lies, in radians. */
  facing: number;
  /** The core's size, against the usual. */
  core: number;
  /** How dark the dust lanes are, against the usual. */
  lanes: number;
  /** Where the arms start around the core, in radians. */
  twist: number;
}

/** The spiral the arms follow, shared with the renderer's dust and haze. */
export interface Spiral {
  arms: number;
  /** Arms start this far from the core... */
  rIn: number;
  /** ...and end this far out. */
  rOut: number;
  /** tan(pitch angle): how tightly the arms wind. */
  b: number;
  /** Which way they wind (1 or -1). */
  spin: number;
  /** Arm width, against the usual. */
  width: number;
  /** Where the first arm starts around the core, in radians. */
  twist: number;
}

export interface GalaxyCluster {
  /** Index of the top-level page, or -1 for loose pages with no family or links. */
  root: number;
  size: number;
  /** Middle of its stars, in galaxy units. */
  x: number;
  y: number;
}

export interface GalaxyLayout {
  /** x, y per page (in input order), in galaxy units around the core. */
  pos: Float32Array;
  /** Index into `clusters` per page. */
  cluster: Uint16Array;
  /** Distinct pages each page is linked with, either direction. */
  degree: Uint32Array;
  /** Pages directly inside each page. */
  children: Uint32Array;
  /** 0–1: how bright each star is, from its links and its children. */
  mag: Float32Array;
  /** Distinct links as pairs of page indexes. */
  links: Uint32Array;
  clusters: GalaxyCluster[];
  spiral: Spiral;
  form: Form;
  /** Everything fits inside this radius. */
  radius: number;
}

/** Space between neighbouring stars, in galaxy units. */
export const SPACING = 20;

/** A point on arm `arm` at `u` (0 inner end, 1 outer end), and the arm's width there. */
export function armPoint(s: Spiral, arm: number, u: number): { x: number; y: number; width: number; angle: number } {
  // Arc length along a logarithmic spiral grows with r, so r linear in u
  // spaces things evenly along the arm.
  const r = s.rIn + (s.rOut - s.rIn) * u;
  const angle = s.spin * (Math.log(r / s.rIn) / s.b) + (arm / s.arms) * Math.PI * 2 + s.twist;
  return { x: r * Math.cos(angle), y: r * Math.sin(angle), width: s.rIn * (0.55 + 0.9 * (r / s.rOut)) * s.width, angle };
}

/** A workspace's galaxy form, the same every time for the same seed. */
export function formFor(seed: number): Form {
  const rand = random(seed ^ 0x9e3779b9);
  const roll = rand();
  const arms = roll < 0.5 ? 2 : roll < 0.8 ? 3 : 4;
  return {
    arms,
    // Four arms wound tightly would run into each other.
    pitch: arms === 4 ? 0.27 + rand() * 0.11 : 0.17 + rand() * 0.21,
    spin: rand() < 0.5 ? 1 : -1,
    bar: arms === 2 && rand() < 0.55 ? 0.9 + rand() * 0.6 : 0,
    width: 0.78 + rand() * 0.5,
    // Most face us; some lie back as far as a 50° tilt.
    tilt: 1 - Math.pow(rand(), 1.6) * 0.36,
    facing: rand() * Math.PI,
    core: 0.7 + rand() * 0.7,
    lanes: 0.4 + rand() * 0.9,
    twist: rand() * Math.PI * 2,
  };
}

/** The spiral for `n` pages in a galaxy of this form: roomy enough for them along its arms. */
export function spiralFor(n: number, form: Form): Spiral {
  const { arms, pitch: b, width } = form;
  // An arm from rIn to 4.5·rIn is √(1+b²)/b · 3.5·rIn long and on average
  // ~0.95·rIn·width wide; each star wants ~1.6·SPACING² of sky.
  const area = (Math.sqrt(1 + b * b) / b) * 3.5 * 0.95 * width;
  const rIn = SPACING * Math.max(4, Math.sqrt((1.6 * n) / (area * arms)));
  return { arms, rIn, rOut: rIn * 4.5, b, spin: form.spin, width, twist: form.twist };
}

interface Node extends SimulationNodeDatum {
  tx: number;
  ty: number;
  field: boolean;
}

interface Edge {
  source: number;
  target: number;
  kind: 'family' | 'link' | 'bridge';
}

/** Mulberry32: small, fast, and the same numbers every time. */
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

/** FNV-1a, so each star's scatter depends on nothing but its page and the workspace. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function layoutGalaxy({ pages, links, seed, prev }: GalaxyInput): GalaxyLayout {
  const n = pages.length;
  const index = new Map<string, number>();
  pages.forEach((p, i) => index.set(p.id, i));

  const parent = new Int32Array(n).fill(-1);
  const children = new Uint32Array(n);
  const kids: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const p = pages[i].parent === null ? undefined : index.get(pages[i].parent!);
    if (p !== undefined && p !== i) {
      parent[i] = p;
      children[p]++;
      kids[p].push(i);
    }
  }

  // Links, once each, as index pairs.
  const seen = new Set<number>();
  const pairs: number[] = [];
  const degree = new Uint32Array(n);
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (const [from, to] of links) {
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = Math.min(a, b) * n + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(a, b);
    degree[a]++;
    degree[b]++;
    neighbours[a].push(b);
    neighbours[b].push(a);
  }

  // Each page's top-level page. A broken chain (a cycle) stops where it repeats.
  const root = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const path: number[] = [];
    let at = i;
    const visiting = new Set<number>();
    while (root[at] === -1 && parent[at] !== -1 && !visiting.has(at)) {
      visiting.add(at);
      path.push(at);
      at = parent[at];
    }
    const top = root[at] !== -1 ? root[at] : at;
    root[at] = top;
    for (const p of path) root[p] = top;
  }

  // A lone top-level page joins the cluster it links into most; with no
  // family and no links it's a field star, scattered along the arms.
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[root[i]]++;
  const home = Int32Array.from(root);
  for (let i = 0; i < n; i++) {
    if (root[i] !== i || size[i] > 1) continue;
    const votes = new Map<number, number>();
    for (const o of neighbours[i]) if (size[root[o]] > 1) votes.set(root[o], (votes.get(root[o]) ?? 0) + 1);
    let best = -1;
    let most = 0;
    for (const [r, v] of votes) if (v > most || (v === most && r < best)) [best, most] = [r, v];
    home[i] = best; // -1: field
  }

  // Clusters, biggest first (sidebar order breaks ties).
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const list = members.get(home[i]);
    if (list) list.push(i);
    else members.set(home[i], [i]);
  }
  const roots = [...members.keys()].filter((r) => r !== -1).sort((a, b) => members.get(b)!.length - members.get(a)!.length || a - b);
  const clusters: GalaxyCluster[] = roots.map((r) => ({ root: r, size: members.get(r)!.length, x: 0, y: 0 }));
  const field = members.get(-1) ?? [];
  if (field.length) clusters.push({ root: -1, size: field.length, x: 0, y: 0 });
  const clusterOf = new Uint16Array(n);
  clusters.forEach((c, k) => {
    for (const i of c.root === -1 ? field : members.get(c.root)!) clusterOf[i] = k;
  });

  // Each cluster gets a stretch of an arm: arms are filled evenly, biggest
  // clusters first, so the big ones sit nearest the core.
  const form = formFor(seed);
  const spiral = spiralFor(n, form);
  // Each star draws its scatter from its own stream, so one page more doesn't reshuffle the rest.
  const streamOf = (i: number) => random(hash(pages[i].id) ^ seed);
  const gaussOf = (rand: () => number) => () => {
    const u = rand() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const load = new Float64Array(spiral.arms);
  const placed: { k: number; arm: number; start: number }[] = [];
  for (let k = 0; k < roots.length; k++) {
    let arm = 0;
    for (let a = 1; a < spiral.arms; a++) if (load[a] < load[arm]) arm = a;
    placed.push({ k, arm, start: load[arm] });
    // A small gap after each cluster keeps the knots apart along the arm.
    load[arm] += clusters[k].size + 2 + Math.sqrt(clusters[k].size);
  }

  const nodes: Node[] = new Array(n);
  const target = (arm: number, u: number, spread: number, gauss: () => number) => {
    const p = armPoint(spiral, arm, Math.min(1, Math.max(0, u)));
    // Across the arm: along the radius, roughly, which reads as the arm's width.
    const off = gauss() * p.width * spread;
    const r = Math.hypot(p.x, p.y);
    return { x: p.x + (p.x / r) * off, y: p.y + (p.y / r) * off };
  };
  for (const { k, arm, start } of placed) {
    const c = clusters[k];
    // Family order (a page, then what's inside it), so subtrees stay together.
    const order: number[] = [];
    const stack = [c.root];
    while (stack.length) {
      const i = stack.pop()!;
      order.push(i);
      for (let j = kids[i].length - 1; j >= 0; j--) if (home[kids[i][j]] === c.root) stack.push(kids[i][j]);
    }
    const inFamily = new Set(order);
    // Lone pages that joined by links, after the family.
    for (const i of members.get(c.root)!) if (!inFamily.has(i)) order.push(i);
    order.forEach((i, j) => {
      const u = (start + j + 0.5) / load[arm];
      const gauss = gaussOf(streamOf(i));
      const t = target(arm, u, 0.18, gauss);
      nodes[i] = { index: i, x: t.x + gauss() * 2, y: t.y + gauss() * 2, tx: t.x, ty: t.y, field: false };
    });
  }
  for (const i of field) {
    const rand = streamOf(i);
    const t = target(Math.floor(rand() * spiral.arms), Math.sqrt(rand()), 0.45, gaussOf(rand));
    nodes[i] = { index: i, x: t.x, y: t.y, tx: t.x, ty: t.y, field: true };
  }

  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) if (parent[i] !== -1 && home[i] === home[parent[i]]) edges.push({ source: i, target: parent[i], kind: 'family' });
  for (let p = 0; p < pairs.length; p += 2) {
    const a = pairs[p];
    const b = pairs[p + 1];
    edges.push({ source: a, target: b, kind: clusterOf[a] === clusterOf[b] ? 'link' : 'bridge' });
  }

  // Stars that were already in the sky start where they were. A few pages more
  // or less barely move the arms, so the sky only needs to settle; when many
  // came or went, the old places don't fit the new arms and it starts afresh.
  let settle = false;
  if (prev && Math.abs(prev.ids.length - n) <= Math.max(3, n * 0.1)) {
    const at = new Map(prev.ids.map((id, i) => [id, i]));
    for (let i = 0; i < n; i++) {
      const j = at.get(pages[i].id);
      if (j === undefined) continue;
      nodes[i].x = prev.pos[j * 2];
      nodes[i].y = prev.pos[j * 2 + 1];
      settle = true;
    }
  }

  if (n > 1) {
    // The work grows with the stars, so big skies take fewer, coarser steps.
    const full = Math.round(Math.min(300, Math.max(60, 300 * Math.sqrt(400 / Math.max(400, n)))));
    const ticks = settle ? Math.ceil(full / 3) : full;
    const big = n > 3000;
    const link = forceLink<Node, Edge>(edges).distance((e) => (e.kind === 'family' ? SPACING * 1.1 : SPACING * 1.6));
    // d3's default strength (1 / the busier end's link count) keeps hubs from
    // collapsing; bridges between clusters pull gently so the arms keep their shape.
    const base = link.strength();
    link.strength((e, i, all) => (base as (e: Edge, i: number, all: Edge[]) => number)(e, i, all) * (e.kind === 'bridge' ? 0.12 : e.kind === 'family' ? 0.6 : 0.9));
    forceSimulation<Node>(nodes)
      .randomSource(random(42))
      .force('link', link)
      .force('charge', forceManyBody<Node>().strength(-SPACING * 1.4).distanceMax(SPACING * (big ? 5 : 8)).theta(big ? 1.2 : 0.95))
      .force('x', forceX<Node>((d) => d.tx).strength((d) => (d.field ? 0.05 : 0.14)))
      .force('y', forceY<Node>((d) => d.ty).strength((d) => (d.field ? 0.05 : 0.14)))
      .alpha(settle ? 0.3 : 1)
      .alphaDecay(1 - Math.pow(0.001 / (settle ? 0.3 : 1), 1 / ticks))
      .stop()
      .tick(ticks);
  }

  const pos = new Float32Array(n * 2);
  let radius = spiral.rOut + spiral.rIn;
  for (let i = 0; i < n; i++) {
    const { x = 0, y = 0 } = nodes[i];
    pos[i * 2] = x;
    pos[i * 2 + 1] = y;
    radius = Math.max(radius, Math.hypot(x, y) + SPACING);
    const c = clusters[clusterOf[i]];
    c.x += x / c.size;
    c.y += y / c.size;
  }

  // Brightness: links count most, children a little; the brightest page is 1.
  const mag = new Float32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, Math.log2(1 + degree[i] + 0.4 * children[i]));
  for (let i = 0; i < n; i++) mag[i] = top ? Math.sqrt(Math.log2(1 + degree[i] + 0.4 * children[i]) / top) : 0;

  return { pos, cluster: clusterOf, degree, children, mag, links: Uint32Array.from(pairs), clusters, spiral, form, radius };
}
