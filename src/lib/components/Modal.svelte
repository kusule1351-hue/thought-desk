<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { fadeOut, sheet, sheetOut } from '../motion';
  import { t } from '../i18n';

  let {
    onclose,
    width = 600,
    top = '10vh',
    label,
    glass = false,
    closeButton = false,
    children,
  }: {
    onclose: () => void;
    width?: number;
    top?: string;
    label: string;
    glass?: boolean;
    /** A close button in the corner, for sheets without a header of their own. */
    closeButton?: boolean;
    children: Snippet;
  } = $props();

  // A sheet stays on screen while it fades out; by then the keys and clicks
  // belong to whatever is opening next.
  let leaving = $state(false);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !leaving) {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="backdrop"
  class:light={glass}
  class:leaving
  onoutrostart={() => (leaving = true)}
  onmousedown={(e) => e.target === e.currentTarget && onclose()}
  out:fadeOut|global={{ duration: 200 }}
>
  <div
    class="modal"
    class:glass
    style:width="{width}px"
    style:margin-top={top}
    role="dialog"
    aria-modal="true"
    aria-label={label}
    in:sheet|global={{ duration: 340 }}
    out:sheetOut|global={{ duration: 180 }}
  >
    {@render children()}
    {#if closeButton}<button class="icon-btn close" onclick={onclose} aria-label={t('common.actions.close')} data-tip={t('common.actions.close')}><Icon name="x" /></button>{/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    background: var(--scrim);
    /* Fade the colour, not opacity: an opacity group would stop the frosted
       panel from blurring the page behind it. */
    animation: scrim-in 200ms var(--ease) both;
  }
  @keyframes scrim-in {
    from {
      background-color: transparent;
    }
  }
  .modal {
    position: relative;
    max-width: calc(100vw - 32px);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-elevated);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-modal);
    transform-origin: 50% 30%;
  }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
  }
  /* Spotlight-style: frosted panel over a lighter scrim. */
  .backdrop.leaving {
    pointer-events: none;
  }
  .backdrop.light {
    background: color-mix(in srgb, var(--scrim) 55%, transparent);
  }
  .modal.glass {
    background: var(--material-strong);
    -webkit-backdrop-filter: blur(40px) saturate(0.2);
    backdrop-filter: blur(40px) saturate(0.2);
  }
</style>
