<script lang="ts">
  import Icon from './Icon.svelte';
  import { fadeOut, pop } from '../motion';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as toast (toast.id)}
    <div class="toast round" in:pop|global={{ y: 10, scale: 0.94, duration: 320 }} out:fadeOut|global={{ duration: 160 }}>
      <span class="msg">{toast.message}</span>
      {#if toast.action}
        <button
          class="act round"
          onclick={() => {
            toast.action?.();
            ui.dismissToast(toast.id);
          }}>{toast.actionLabel}</button
        >
      {/if}
      <button class="x round" onclick={() => ui.dismissToast(toast.id)} aria-label={t('shell.toasts.dismiss')}><Icon name="x" size={13} stroke={2.2} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 110;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  /* An inverted HUD pill: dark on light, light on dark. */
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 40px;
    max-width: min(560px, calc(100vw - 32px));
    padding: 0 6px 0 16px;
    border-radius: 20px;
    background: color-mix(in srgb, var(--ink) 92%, transparent);
    -webkit-backdrop-filter: blur(20px) saturate(0.2);
    backdrop-filter: blur(20px) saturate(0.2);
    color: var(--on-ink);
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    box-shadow: 0 10px 30px -8px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.12);
  }
  .msg {
    margin-right: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .act {
    height: 28px;
    padding: 0 12px;
    border-radius: 14px;
    font-weight: var(--fw-650);
    color: var(--on-ink);
    background: color-mix(in srgb, var(--on-ink) 14%, transparent);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .act:hover {
    background: color-mix(in srgb, var(--on-ink) 22%, transparent);
  }
  .x {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 14px;
    color: color-mix(in srgb, var(--on-ink) 60%, transparent);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .x:hover {
    background: color-mix(in srgb, var(--on-ink) 14%, transparent);
    color: var(--on-ink);
  }
</style>
