<script lang="ts" module>
  /** Open popovers, innermost last: Esc closes only the top one. */
  const stack: symbol[] = [];
</script>

<script lang="ts">
  /**
   * A floating panel anchored to an element (or a rectangle): below it, or
   * above when there's no room, kept on screen. Closes on Esc or a click
   * outside. Popovers opened from inside one nest in it, so clicking in the
   * inner one doesn't close the outer. Render the inner one beside the outer,
   * not inside it: the outer's glass (backdrop-filter) would place it from
   * the outer's corner and clip it.
   */
  import { onMount, tick, type Snippet } from 'svelte';
  import { fadeOut, pop } from '../motion';
  import { ui } from '../ui.svelte';

  let {
    anchor,
    onclose,
    width,
    align = 'start',
    side = 'below',
    label,
    pad = true,
    children,
  }: {
    anchor: Element | DOMRect;
    onclose: () => void;
    width?: number;
    align?: 'start' | 'end';
    /** "right": beside the anchor (submenus). */
    side?: 'below' | 'right';
    label?: string;
    /** Inner padding (off for editors that fill the panel). */
    pad?: boolean;
    children: Snippet;
  } = $props();

  const me = Symbol('popover');
  let el: HTMLDivElement;
  let pos = $state({ left: -9999, top: -9999, origin: 'top left' });

  function place() {
    if (!el) return;
    const a = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    // Its laid-out size: the bounding box is still scaled down while it pops in.
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    let origin: string;
    if (side === 'right') {
      left = a.right + 4;
      if (left + r.width > vw - 8) left = a.left - r.width - 4;
      top = Math.min(a.top - 4, vh - r.height - 8);
      origin = 'top left';
    } else {
      left = align === 'end' ? a.right - r.width : a.left;
      top = a.bottom + 4;
      origin = `top ${align === 'end' ? 'right' : 'left'}`;
      if (top + r.height > vh - 8) {
        const above = a.top - r.height - 4;
        if (above >= 8) {
          top = above;
          origin = `bottom ${align === 'end' ? 'right' : 'left'}`;
        } else top = Math.max(8, vh - r.height - 8);
      }
    }
    left = Math.max(8, Math.min(left, vw - r.width - 8));
    pos = { left, top: Math.max(8, top), origin };
  }

  onMount(() => {
    stack.push(me);
    void tick().then(place);
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || el.contains(t)) return;
      // Menus, pickers and other popovers opened from this one.
      if (t.closest('.popover, .menu')) return;
      onclose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || stack.at(-1) !== me || ui.menu) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onclose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => {
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      ro.disconnect();
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
    };
  });
</script>

<div
  class="db-pop popover"
  class:pad
  bind:this={el}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  style:width={width ? `${width}px` : undefined}
  style:transform-origin={pos.origin}
  role="dialog"
  aria-label={label}
  in:pop
  out:fadeOut
>
  {@render children()}
</div>

<style>
  .db-pop {
    position: fixed;
    z-index: 85;
    max-width: calc(100vw - 16px);
    max-height: min(560px, calc(100vh - 16px));
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: var(--fs-body-ui);
    color: var(--text);
  }
  /* 12px corners − 4px padding = 8px rows, like menus. */
  .db-pop.pad {
    padding: 4px;
  }
</style>
