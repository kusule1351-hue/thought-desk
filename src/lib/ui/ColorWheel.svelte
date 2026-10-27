<script lang="ts">
  /**
   * A hue wheel: the angle picks the hue, the distance from the centre picks
   * how colourful it is (gray in the middle). Drag, click, or use the arrow
   * keys (left/right turn the hue, up/down change the strength).
   */
  import { t } from '../i18n';

  let {
    hue,
    amount,
    onchange,
    label,
    size = 168,
    kind = 'accent',
    knob,
  }: {
    hue: number;
    /** 0 (centre) to 1 (rim). */
    amount: number;
    onchange: (hue: number, amount: number) => void;
    label: string;
    size?: number;
    /** Pastel ring for themes, vivid for accents. */
    kind?: 'theme' | 'accent';
    /** CSS colour of the knob (the colour picked). */
    knob: string;
  } = $props();

  let el: HTMLDivElement;
  let dragging = $state(false);

  // A stop every 30° keeps the hue sweep even (OKLCH, like the colours made).
  const ring = $derived.by(() => {
    const [l, c] = kind === 'theme' ? [0.9, 0.07] : [0.7, 0.17];
    const stops = Array.from({ length: 13 }, (_, i) => `oklch(${l} ${c} ${i * 30})`).join(', ');
    return `radial-gradient(closest-side, oklch(${l} 0 0), oklch(${l} 0 0 / 0) 100%), conic-gradient(from 0deg, ${stops})`;
  });

  const knobX = $derived(50 + 50 * amount * Math.sin((hue * Math.PI) / 180));
  const knobY = $derived(50 - 50 * amount * Math.cos((hue * Math.PI) / 180));

  function pick(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let h = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (h < 0) h += 360;
    const a = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    // Near the centre the hue is meaningless; keep the old one.
    onchange(a < 0.02 ? hue : Math.round(h * 10) / 10, Math.round(a * 1000) / 1000);
  }

  function down(e: PointerEvent) {
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    dragging = true;
    pick(e);
  }

  function move(e: PointerEvent) {
    if (dragging) pick(e);
  }

  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 15 : 3;
    const a = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') onchange((hue - step + 360) % 360, amount);
    else if (e.key === 'ArrowRight') onchange((hue + step) % 360, amount);
    else if (e.key === 'ArrowUp') onchange(hue, Math.min(1, amount + a));
    else if (e.key === 'ArrowDown') onchange(hue, Math.max(0, amount - a));
    else return;
    e.preventDefault();
  }
</script>

<div
  class="wheel round"
  class:dragging
  bind:this={el}
  style:width="{size}px"
  style:height="{size}px"
  style:background={ring}
  role="slider"
  tabindex="0"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={360}
  aria-valuenow={Math.round(hue)}
  aria-valuetext={t('library.controls.hueStrength', { hue: Math.round(hue), strength: Math.round(amount * 100) })}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={() => (dragging = false)}
  onpointercancel={() => (dragging = false)}
  onkeydown={key}
>
  <span class="knob round" style:left="{knobX}%" style:top="{knobY}%" style:--k={knob}></span>
</div>

<style>
  .wheel {
    position: relative;
    flex: none;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px var(--hairline);
    cursor: crosshair;
    touch-action: none;
    outline: none;
  }
  .wheel:focus-visible {
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      0 0 0 3px var(--focus);
  }
  .knob {
    position: absolute;
    width: 20px;
    height: 20px;
    margin: -10px 0 0 -10px;
    border-radius: 50%;
    background: var(--k);
    box-shadow:
      0 0 0 3px #fff,
      0 0 0 4px rgba(0, 0, 0, 0.18),
      0 2px 6px rgba(0, 0, 0, 0.25);
    pointer-events: none;
    transition: transform var(--dur-fast) var(--ease);
  }
  .dragging .knob {
    transform: scale(1.15);
  }
</style>
