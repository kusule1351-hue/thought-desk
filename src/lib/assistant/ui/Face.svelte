<!--
  The assistant's face: Socrates, as simple line art. A bald head, heavy
  brows, a snub nose and a great curly beard, in one colour, the way the app's
  icons are drawn, so he sits among them in either theme. He is only a head:
  large, with the lines of his forehead and the curls in his beard; small,
  drawn afresh and simpler; at icon sizes, a head with two eyes.

  His face shows what the assistant is doing, quietly: his eyes and brows
  change, his head tips, and now and then something appears (glasses to read
  with, sunglasses when he is pleased with himself). A change of mood moves
  the eyes and brows on a short spring. Nothing fades and nothing sways.

  Still when motion is reduced.
-->
<script lang="ts" module>
  import type { Mood } from '../mood.svelte';

  /** His expression, as numbers. Every mood is one of these; a change of mood springs from one to the other. */
  interface Features {
    /**
     * Each eye (l, r) is a stroked line: its centre, half its length, its thickness, and how far its middle arches
     * (up: pleased; down: asleep). A line with no length is a dot. `ring` opens a white inside it, with a pupil that
     * looks about (`px`, `py`, radius `pr`).
     */
    lx: number; ly: number; lw: number; lt: number; larc: number; lring: number; lpx: number; lpy: number; lpr: number;
    rx: number; ry: number; rw: number; rt: number; rarc: number; rring: number; rpx: number; rpy: number; rpr: number;
    /** Degrees each eye's two strokes turn apart: 0 is one line, 45 is a cross. */
    spread: number;
    /** The shine in each eye. */
    shine: number;
    /** Brows: how much of one there is (0 none, 1 whole), its height, and how far the inner end is raised (negative: a scowl). */
    lbo: number; lby: number; lbt: number;
    rbo: number; rby: number; rbt: number;
    /** The mouth, a line in his beard: centre, half width, how far the middle sags (negative: a frown), how far the right corner lifts, its thickness (thick and short: an "o"), how wavy. */
    mx: number; my: number; mw: number; bend: number; skew: number; mt: number; wave: number;
    /** Things that come and go, each from nothing (0) to whole (1): sunglasses, reading glasses, a tongue, a tear, a blush. */
    shades: number; glasses: number; tongue: number; tear: number; blush: number;
    /** How far his head tips (degrees). */
    lean: number;
  }

  /** A dot's length: not quite nothing, so the round ends still draw. */
  const DOT = 0.01;

  const REST: Features = {
    lx: 38, ly: 44, lw: DOT, lt: 6.6, larc: 0, lring: 0, lpx: 0, lpy: 0, lpr: 0,
    rx: 62, ry: 44, rw: DOT, rt: 6.6, rarc: 0, rring: 0, rpx: 0, rpy: 0, rpr: 0,
    spread: 0,
    shine: 0,
    lbo: 1, lby: 34.6, lbt: 0.7,
    rbo: 1, rby: 34.6, rbt: 0.7,
    mx: 50, my: 69.5, mw: 6.5, bend: 5, skew: 0, mt: 3.2, wave: 0,
    shades: 0, glasses: 0, tongue: 0, tear: 0, blush: 0,
    lean: 0,
  };
  const face = (over: Partial<Features>): Features => ({ ...REST, ...over });
  /** Both eyes the same: half length, thickness, and (for a wide-open eye) a pupil and where it looks. */
  const eyes = (w: number, t: number, ring = 0, pr = 0, px = 0, py = 0) => ({ lw: w, lt: t, lring: ring, lpr: pr, lpx: px, lpy: py, rw: w, rt: t, rring: ring, rpr: pr, rpx: px, rpy: py });
  /** Both eyes shut into a curve. */
  const shut = (arc: number) => ({ lw: 6.5, lt: 3.2, larc: arc, rw: 6.5, rt: 3.2, rarc: arc });
  const brows = (y: number, tilt: number) => ({ lbo: 1, lby: y, lbt: tilt, rbo: 1, rby: y, rbt: tilt });
  /** A small round mouth. */
  const oh = { mw: DOT, mt: 7.4, bend: 0, my: 71 };
  const flat = { bend: 0, mw: 5, my: 70.5 };

  const FACES: Record<Mood, Features> = {
    idle: REST,
    asleep: face({ ...shut(-8), ...brows(36.5, 1.4), ...oh, mt: 6 }),
    bored: face({ ...eyes(4.4, 4.4), ly: 45, ry: 45, ...brows(37.4, 0), ...flat, lean: -4 }),
    listening: face({ ...eyes(DOT, 15.2, 1, 3.4, 1, 1), ly: 41.5, ry: 41.5, ...brows(29.6, 0.8), ...oh, lean: -5 }),
    curious: face({ ly: 45, lby: 37, lbt: -0.6, rw: DOT, rt: 14.4, rring: 1, rpr: 3.2, rpx: 1, ry: 41.5, rby: 29, rbt: 1.5, mw: 4.5, bend: -3, my: 72, lean: -5 }),
    thinking: face({ ...eyes(DOT, 15.2, 1, 3.2, 2.5, -3), ly: 41.5, ry: 41.5, ...brows(30, 0.6), lby: 31.4, mw: 4.5, bend: -2, skew: 1.5, my: 71 }),
    scheming: face({ ...eyes(1, 6.8), ly: 46, ry: 46, ...brows(38, -3), mw: 8.5, bend: 6, skew: 3, my: 69 }),
    reading: face({ ...eyes(DOT, 6.4), ly: 42.5, ry: 42.5, ...brows(29.2, 0.4), glasses: 1, ...flat }),
    writing: face({ lw: 6.5, lt: 3.2, larc: 8, lby: 35.6, rby: 32.6, tongue: 1 }),
    asking: face({ ...eyes(DOT, 14), ly: 43, ry: 43, shine: 1, ...brows(31.4, 3), mw: 3.5, bend: -3, my: 72.5, lean: -4 }),
    proud: face({ shades: 1, ...brows(31.6, -0.6), mw: 7.5, bend: 6, skew: 3.5 }),
    flattered: face({ ...shut(8), ...brows(32.6, 1.2), blush: 1 }),
    sad: face({ ly: 46, ry: 46, ...brows(36.6, 2.8), tear: 1, mw: 7, bend: -6, my: 75 }),
    oops: face({ ...eyes(DOT, 16, 1, 3, 0, 0), ly: 41.5, ry: 41.5, ...brows(28.6, 1), ...oh }),
    dizzy: face({ ...eyes(7, 3.2), spread: 45, ...brows(32.4, 1.6), mw: 10, bend: 0, wave: 1, my: 72 }),
    broke: face({ ...eyes(4.4, 3.2), ly: 45, ry: 45, ...brows(36.8, 2.2), ...flat, my: 73 }),
    nope: face({ ...eyes(3.2, 9.6, 1, 3, 4.5, 0.4), ...brows(36, -0.4), ...flat }),
  };

  // His head, in a square of 100. The top of it is an outline; his hair and beard are one dark shape with scalloped
  // edges that runs from temple to temple under his chin, and his face is the gap it leaves.
  const SKULL = 'M23,35 C22,20 33,10 50,10 C67,10 78,20 77,35';
  const HAIR =
    'M77,33 C82,31 87,36 83.5,43 C89,43.5 91,51 84.8,55.5 C91,57 91.5,66 84.2,68.5 C89,72 86,80 78,80.5 C79,86 72,91 66,89.5 C65,94 59,95.5 57,92 C56,97 44,97 43,92 C41,95.5 35,94 34,89.5 C28,91 21,86 22,80.5 C14,80 11,72 15.8,68.5 C8.5,66 9,57 15.2,55.5 C9,51 11,43.5 16.5,43 C13,36 18,31 23,33 L23.6,48 C24.5,57 32,61 38,61 C42,61 46,63.5 50,63.5 C54,63.5 58,61 62,61 C68,61 75.5,57 76.4,48 Z';
  /**
   * Small, he is drawn afresh and not shrunk: a round bald head with a larger face, and a beard in a few big
   * curls that hangs from his cheeks and is little wider than his head. Shrunk, the hair at his temples closes
   * round his face like a hood, and the small curls turn to noise.
   */
  const SKULL_SMALL = 'M21.5,53 C20.2,50 19.5,45 19.5,40 C19.5,23.15 33.15,9.5 50,9.5 C66.85,9.5 80.5,23.15 80.5,40 C80.5,45 79.8,50 78.5,53';
  const BEARD_SMALL =
    'M79,50 C85.5,50 89.5,61 84,68 C88,75 79,88 67,89 C63,97 37,97 33,89 C21,88 12,75 16,68 C10.5,61 14.5,50 21,50 C22.5,58 31,63 39,63 C43.5,63 46.5,59.5 50,59.5 C53.5,59.5 56.5,63 61,63 C69,63 77.5,58 79,50 Z';
  const NOSE = 'M46.8,44.5 C46.4,49.5 43.6,52.5 44.2,55.6 C44.9,59 55.1,59 55.8,55.6 C56.1,54 55.2,52.8 54,52';
  /** Large only: the lines of his forehead, and the curls in his beard (drawn in the colour behind him). */
  const BROW_LINES = 'M41,24.5 Q50,22.4 59,24.5 M43.6,29.6 Q50,28 56.4,29.6';
  const CURLS =
    'M25.5,71 c2.6,-2.8 6.8,-1.2 5.8,2.6 M65,74 c2.6,-2.8 6.8,-1.2 5.8,2.6 M36.5,82 c2.6,-2.8 6.8,-1.2 5.8,2.6 M55,84.5 c2.6,-2.8 6.8,-1.2 5.8,2.6 M14.6,61.6 c2,-2.4 5.4,-1 4.6,2.2 M79.6,50 c2,-2.4 5.4,-1 4.6,2.2 M72,62.5 c2.4,-2.6 6.2,-1 5.2,2.4';

  /** A four-pointed star. */
  const STAR = 'M0,-5 L1.3,-1.3 5,0 1.3,1.3 0,5 -1.3,1.3 -5,0 -1.3,-1.3 Z';

  /** His eyes and brows are drawn to numbers made for a larger face (see REST); this sets them on his, large and small. */
  const FEATURES_SCALE = 0.875;
  const FEATURES_AT = `translate(50 43) scale(${FEATURES_SCALE}) translate(-50 -44)`;
  const FEATURES_SCALE_SMALL = 0.96;
  const FEATURES_AT_SMALL = `translate(50 40.5) scale(${FEATURES_SCALE_SMALL}) translate(-50 -44)`;
  const MOUTH_SCALE = 0.8;
  const MOUTH_AT = `translate(50 70.5) scale(${MOUTH_SCALE}) translate(-50 -69.5)`;
  const MOUTH_AT_SMALL = `translate(50 74.5) scale(${MOUTH_SCALE}) translate(-50 -69.5)`;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { Spring } from 'svelte/motion';

  let {
    mood = 'idle',
    size = 32,
    label,
    still = false,
  }: {
    mood?: Mood;
    /** Pixels, square. */
    size?: number;
    /** Said to a screen reader; without it the face is decoration. */
    label?: string;
    /** Holds still (a face beside an old message: only the latest one is alive). */
    still?: boolean;
  } = $props();

  const calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const moving = $derived(!still && !calm);
  /** Large enough for the lines of his forehead and the curls in his beard. */
  const large = $derived(size >= 64);
  /**
   * Small, he is an icon among icons: a head with two eyes; a little larger he has brows and a mouth. From 30 pixels,
   * the size he is beside his replies, he is his whole self: his nose, the hair at his temples and the wide beard.
   */
  const tiny = $derived(size < 22);
  const small = $derived(size < 30);

  // His lines keep one weight on the screen whatever his size, as an icon's do.
  /** The weight of a line, in pixels. */
  const px = $derived(size < 22 ? 1.5 : size < 30 ? 1.6 : Math.min(3.2, 1.5 + size / 100));
  /** The same, in the square's own units; and in those his eyes and brows are drawn to. */
  const hw = $derived((px * 100) / size);
  const fw = $derived(hw / (small ? FEATURES_SCALE_SMALL : FEATURES_SCALE));

  // One face, sprung to wherever the mood puts it: it settles quickly, with a little overshoot.
  const sprung = new Spring(untrack(() => ({ ...FACES[mood] })), { stiffness: 0.16, damping: 0.52 });
  $effect(() => {
    void sprung.set(FACES[mood], moving ? undefined : { instant: true });
  });
  const f = $derived(sprung.current);

  /** A spring passes its mark before it settles: a size is never less than nothing. */
  const pos = (v: number) => Math.max(0, v);
  const n = (v: number) => v.toFixed(2);

  /** An eye is never slighter than the lines round it: a dot is drawn a little heavier than they are, a shut eye about as heavy. */
  const eyeWeight = (t: number, len: number) => Math.max(pos(t), (1.35 - 0.5 * Math.min(1, Math.max(0, (len - 0.5) / 3))) * fw);
  /** The white inside a wide-open eye: what its rim leaves. Small, the rim leaves none, and the eye is a large dot. */
  const eyeWhite = (t: number, ring: number) => pos(t - 2 * Math.max(2.4, 0.9 * fw)) * pos(ring);

  /** One stroke of an eye: a line through its centre, turned `turn` degrees, its middle lifted by `arc`. */
  function stroke(x: number, y: number, len: number, arc: number, turn: number): string {
    const a = (turn * Math.PI) / 180;
    const dx = Math.max(DOT, len) * Math.cos(a);
    const dy = Math.max(DOT, len) * Math.sin(a);
    return `M${n(x - dx)},${n(y - dy)} Q${n(x)},${n(y - arc)} ${n(x + dx)},${n(y + dy)}`;
  }

  /** The mouth: a curve that sags or lifts, one corner higher for a smirk, and wavy when everything is spinning. */
  const mouth = $derived.by(() => {
    const half = Math.max(DOT, f.mw);
    let d = '';
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const x = f.mx - half + 2 * half * t;
      const y = f.my + 2 * t * (1 - t) * f.bend - f.skew * t + f.wave * 2.6 * Math.sin(4 * Math.PI * t);
      d += `${i ? 'L' : 'M'}${n(x)},${n(y)}`;
    }
    return d;
  });
</script>

<svg class="assistant-face {mood}" class:moving width={size} height={size} viewBox="0 0 100 100" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}>
  <g class="head" transform="rotate({n(f.lean)} 50 84)">
    <path class="ink" stroke-width={n(hw)} d={small ? SKULL_SMALL : SKULL} />
    <path class="hair" stroke-width={n(small ? hw * 0.2 : hw)} d={small ? BEARD_SMALL : HAIR} />
    {#if large}
      <path class="ink" stroke-width={n(hw * 0.7)} d={BROW_LINES} />
      <path class="cut" stroke-width={n(hw * 0.7)} d={CURLS} />
    {/if}
    {#if !small}
      <path class="ink" stroke-width={n(hw * 0.9)} d={NOSE} />
    {/if}

    <g class="features" transform={small ? FEATURES_AT_SMALL : FEATURES_AT}>
      <g class="eyes">
        <!-- Each eye is two strokes that lie on one another, and turn apart into a cross when he is dizzy. -->
        <path class="eye" stroke-width={n(f.lring > 0.5 ? pos(f.lt) : eyeWeight(f.lt, f.lw))} d="{stroke(f.lx, f.ly, f.lw, f.larc, f.spread)} {stroke(f.lx, f.ly, f.lw, f.larc, -f.spread)}" />
        <path class="eye" stroke-width={n(f.rring > 0.5 ? pos(f.rt) : eyeWeight(f.rt, f.rw))} d="{stroke(f.rx, f.ry, f.rw, f.rarc, f.spread)} {stroke(f.rx, f.ry, f.rw, f.rarc, -f.spread)}" />
        <!-- A wide-open eye: a white opens inside the stroke, with a pupil in it. -->
        <path class="eye white" stroke-width={n(eyeWhite(f.lt, f.lring))} d={stroke(f.lx, f.ly, f.lw, f.larc, 0)} />
        <path class="eye white" stroke-width={n(eyeWhite(f.rt, f.rring))} d={stroke(f.rx, f.ry, f.rw, f.rarc, 0)} />
        <g class="pupils">
          <circle cx={n(f.lx + f.lpx)} cy={n(f.ly + f.lpy)} r={n(pos(f.lpr))} />
          <circle cx={n(f.rx + f.rpx)} cy={n(f.ry + f.rpy)} r={n(pos(f.rpr))} />
        </g>
        <g class="white">
          <circle cx={n(f.lx - 2)} cy={n(f.ly - 2.5)} r={n(pos(f.shine) * 2.5)} /><circle cx={n(f.rx - 2)} cy={n(f.ry - 2.5)} r={n(pos(f.shine) * 2.5)} />
        </g>
      </g>

      <!-- His brows: heavy, and at an icon's size left out. -->
      {#if !tiny}
        <path class="ink" stroke-width={n(pos(f.lbo) * 1.15 * fw)} d="M{n(f.lx - 7.5 * pos(f.lbo))},{n(f.lby + f.lbt * f.lbo)} L{n(f.lx + 7.5 * pos(f.lbo))},{n(f.lby - f.lbt * f.lbo)}" />
        <path class="ink" stroke-width={n(pos(f.rbo) * 1.15 * fw)} d="M{n(f.rx - 7.5 * pos(f.rbo))},{n(f.rby - f.rbt * f.rbo)} L{n(f.rx + 7.5 * pos(f.rbo))},{n(f.rby + f.rbt * f.rbo)}" />
      {/if}

      {#if f.glasses > 0.02}
        <g class="glasses">
          <circle class="ink" cx={n(f.lx - 1)} cy={n(f.ly)} r={n(pos(f.glasses) * 9.6)} stroke-width={n(pos(f.glasses) * Math.max(2.6, 0.85 * fw))} />
          <circle class="ink" cx={n(f.rx + 1)} cy={n(f.ry)} r={n(pos(f.glasses) * 9.6)} stroke-width={n(pos(f.glasses) * Math.max(2.6, 0.85 * fw))} />
          <path class="ink" stroke-width={n(pos(f.glasses) * Math.max(2.4, 0.8 * fw))} d="M{n(50 - 2.4 * f.glasses)},{n(f.ly - 1)} h{n(4.8 * pos(f.glasses))}" />
        </g>
      {/if}
      <!-- The shades drop from above and land on his nose. -->
      {#if f.shades > 0.01}
        <g transform="translate(0 {n((1 - f.shades) * -52 - 3)})">
          <path d="M22,40 h56 v4 q0,10 -11,10 h-3 q-10,0 -11,-9 h-6 q-1,9 -11,9 h-3 q-11,0 -11,-10 Z" />
          {#if !tiny}<path class="cut" stroke-width="2" d="M30,44 l5,5 M58,44 l5,5" />{/if}
        </g>
      {/if}
      {#if f.tear > 0.02}
        <g transform="translate(71.5 50) scale({n(pos(f.tear) * Math.max(1, fw / 4.4))})"><path d="M0,0 q4.2,6 0,9.6 q-4.2,-3.6 0,-9.6 Z" /></g>
      {/if}
      {#if f.blush > 0.02 && !tiny}
        <path class="ink" stroke-width={n(pos(f.blush) * Math.max(2.2, 0.7 * fw))} d="M22,{n(51 + 2 * f.blush)} l3,{n(-4 * f.blush)} M27,{n(52 + 2 * f.blush)} l3,{n(-4 * f.blush)} M70,{n(52 + 2 * f.blush)} l3,{n(-4 * f.blush)} M75,{n(51 + 2 * f.blush)} l3,{n(-4 * f.blush)}" />
      {/if}
    </g>

    <!-- His mouth is a line in his beard. -->
    {#if !tiny}
      <g transform={small ? MOUTH_AT_SMALL : MOUTH_AT}>
        <path class="cut" stroke-width={n(Math.max(pos(f.mt), (0.8 * hw) / MOUTH_SCALE))} d={mouth} />
        {#if f.tongue > 0.02}
          <path class="tongue" transform="translate({n(f.mx + 3)} {n(f.my + 1.6)}) scale({n(pos(f.tongue))})" d="M-3.6,0 v3 a3.6,3.6 0 0 0 7.2,0 v-3 Z" />
        {/if}
      </g>
    {/if}
  </g>

  <!-- What floats beside him; an icon has no room for it. -->
  {#if tiny}
    <!-- nothing -->
  {:else if mood === 'asleep'}
    <g class="float zzz"><text x="80" y="24" font-size="14">z</text><text x="91" y="12" font-size="10">z</text></g>
  {:else if mood === 'thinking' || mood === 'oops'}
    <g class="float"><path d="M91,6 c2.6,4.4 4,6.6 4,8.8 a4,4 0 0 1 -8,0 c0,-2.2 1.4,-4.4 4,-8.8 Z" /></g>
  {:else if mood === 'curious'}
    <g class="float"><text x="86" y="20" font-size="19">?</text></g>
  {:else if mood === 'dizzy'}
    <!-- Stars over his head. -->
    <g class="float"><path d={STAR} transform="translate(83 17) scale(1.25)" /><path d={STAR} transform="translate(93 6) scale(0.8)" /><path d={STAR} transform="translate(95 23) scale(0.6)" /></g>
  {/if}
</svg>

<style>
  .assistant-face {
    flex: none;
    display: block;
    overflow: visible;
    /* What is behind him, for the lines cut into his beard and the whites of his eyes. */
    --ground: var(--face-ground, var(--bg));
    fill: currentColor;
  }
  .ink,
  .eye,
  .cut {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* His hair and beard carry the weight of a line round them, so their edge is as heavy as the top of his head. */
  .hair {
    stroke: currentColor;
    stroke-linejoin: round;
  }
  .cut,
  .eye.white {
    stroke: var(--ground);
  }
  .white,
  .tongue {
    fill: var(--ground);
  }
  .float text {
    font-family: inherit;
    font-weight: 700;
  }

  /* He is mostly still. What appears pops in (nothing fades), he blinks, and while he works his eyes move. */
  .moving .float {
    transform-box: fill-box;
    transform-origin: center;
    animation: pop-in 320ms cubic-bezier(0.3, 1.5, 0.5, 1) backwards;
  }
  @keyframes pop-in {
    from {
      transform: scale(0);
    }
  }
  .moving.idle .eyes,
  .moving.listening .eyes {
    transform-box: fill-box;
    transform-origin: center;
    animation: blink 6s infinite;
  }
  @keyframes blink {
    0%,
    95%,
    100% {
      transform: scaleY(1);
    }
    97.5% {
      transform: scaleY(0.1);
    }
  }
  .moving.thinking .pupils {
    animation: roll 3.4s ease-in-out infinite;
  }
  @keyframes roll {
    0%,
    100% {
      transform: translateX(0);
    }
    50% {
      transform: translateX(-5px);
    }
  }
  .moving.scheming .eyes {
    animation: shifty 3.6s ease-in-out infinite;
  }
  @keyframes shifty {
    0%,
    15%,
    100% {
      transform: translateX(0);
    }
    35%,
    45% {
      transform: translateX(-3px);
    }
    65%,
    80% {
      transform: translateX(3px);
    }
  }
  .moving.reading .eyes {
    animation: scan 2.2s ease-in-out infinite;
  }
  @keyframes scan {
    0%,
    100% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(-3px);
    }
    75% {
      transform: translateX(3px);
    }
  }
  .moving.asleep .zzz text {
    transform-box: fill-box;
    transform-origin: center;
    animation: doze 4s ease-in-out infinite;
  }
  .moving.asleep .zzz text + text {
    animation-delay: -2s;
  }
  @keyframes doze {
    0%,
    100% {
      transform: translateY(0) scale(1);
    }
    50% {
      transform: translateY(-2px) scale(1.12);
    }
  }
</style>
