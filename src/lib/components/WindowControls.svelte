<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onMount } from 'svelte';
  import { t } from '../i18n';

  const win = getCurrentWindow();
  // Windows ships hinted caption glyphs that stay crisp at every display
  // scale (100%, 125%, 150%…); elsewhere we draw our own.
  const nativeGlyphs = navigator.userAgent.includes('Windows');
  let maximized = $state(false);

  onMount(() => {
    let unlisten: (() => void) | undefined;
    const sync = async () => (maximized = await win.isMaximized());
    void sync();
    void win.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  });
</script>

<div class="controls" class:native={nativeGlyphs}>
  <button class="ctl" onclick={() => win.minimize()} aria-label={t('shell.window.minimize')} data-tip={t('shell.window.minimize')}>
    {#if nativeGlyphs}<span class="glyph">&#xE921;</span>{:else}
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" /></svg>
    {/if}
  </button>
  <button class="ctl" onclick={() => win.toggleMaximize()} aria-label={maximized ? t('shell.window.restore') : t('shell.window.maximize')} data-tip={maximized ? t('shell.window.restoreDown') : t('shell.window.maximize')}>
    {#if nativeGlyphs}<span class="glyph">{maximized ? '' : ''}</span>{:else if maximized}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
        <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
        <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
      </svg>
    {:else}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" /></svg>
    {/if}
  </button>
  <button class="ctl close" onclick={() => win.close()} aria-label={t('common.actions.close')} data-tip={t('common.actions.close')}>
    {#if nativeGlyphs}<span class="glyph">&#xE8BB;</span>{:else}
      <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.05"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
    {/if}
  </button>
</div>

<style>
  .controls {
    display: flex;
    align-self: stretch;
  }
  .ctl {
    width: 46px;
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--text);
    border-radius: 0;
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .glyph {
    font-family: 'Segoe Fluent Icons', 'Segoe MDL2 Assets';
    font-size: 10px;
    line-height: 1;
    /* The glyphs are designed on whole pixels; don't let smoothing shift them. */
    font-optical-sizing: none;
  }
  .ctl svg {
    shape-rendering: crispEdges;
  }
  .ctl:hover {
    background: var(--fill);
  }
  .ctl:active {
    background: var(--fill-2);
    color: var(--text-2);
  }
  /* Windows 11's close red, in either theme. */
  .close:hover {
    background: #c42b1c;
    color: #fff;
  }
  .close:active {
    background: #c42b1c;
    color: rgba(255, 255, 255, 0.85);
    opacity: 0.9;
  }
  .close svg {
    shape-rendering: geometricPrecision;
  }
</style>
