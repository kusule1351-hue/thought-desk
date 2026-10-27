<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Swatches from '../ui/Swatches.svelte';
  import { fadeOut, sheet, sheetOut } from '../motion';
  import { ui, type ConfirmState } from '../ui.svelte';
  import { t } from '../i18n';

  let { dialog: request }: { dialog: ConfirmState } = $props();
  // Fixed for this dialog's life; closing clears the prop before resolving.
  // svelte-ignore state_referenced_locally
  const dialog = request;
  let confirmBtn: HTMLButtonElement;
  let input = $state<HTMLInputElement>();
  let value = $state(dialog.input?.value ?? '');
  let color = $state(dialog.color ?? '');

  let finished = false;

  function done(ok: boolean) {
    // While fading out it can still be clicked: that mustn't close the next dialog.
    if (finished) return;
    finished = true;
    if (ui.confirmState === dialog) ui.confirmState = null;
    dialog.resolve(ok, value, color);
  }

  onMount(() => {
    if (input) {
      input.focus();
      void tick().then(() => {
        if (!input) return;
        // Renaming a file selects the name but not its extension.
        const dot = dialog.input?.select === 'stem' ? value.lastIndexOf('.') : -1;
        input.setSelectionRange(0, dot > 0 ? dot : value.length);
      });
    } else {
      confirmBtn.focus();
    }
    // Capture phase, so Escape doesn't also close a modal underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onmousedown={(e) => e.target === e.currentTarget && done(false)} out:fadeOut|global={{ duration: 200 }}>
  <div
    class="dialog"
    class:prompt={!!dialog.input}
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-message"
    in:sheet|global={{ duration: 300 }}
    out:sheetOut|global={{ duration: 160 }}
  >
    <div class="badge" class:danger={dialog.danger}>
      <Icon name={dialog.icon ?? (dialog.danger ? 'trash' : 'info')} size={22} />
    </div>
    <h2 id="confirm-title">{dialog.title}</h2>
    {#if dialog.message}<p id="confirm-message">{dialog.message}</p>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (!dialog.input || value.trim()) done(true);
      }}
    >
      {#if dialog.input}
        <input class="field" bind:this={input} bind:value placeholder={dialog.input.placeholder} spellcheck="false" />
      {/if}
      {#if dialog.color !== undefined}
        <div class="colors"><Swatches value={color} onchange={(c) => (color = c)} /></div>
      {/if}
      <div class="actions">
        <button type="button" class="btn" onclick={() => done(false)}>{t('common.actions.cancel')}</button>
        <button type="submit" class="btn primary" bind:this={confirmBtn} disabled={!!dialog.input && !value.trim()}>{dialog.confirmLabel}</button>
      </div>
    </form>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: var(--scrim);
    animation: scrim-in 200ms var(--ease) both;
  }
  @keyframes scrim-in {
    from {
      background-color: transparent;
    }
  }
  /* A centred alert, in the manner of macOS. */
  .dialog {
    width: 300px;
    max-width: calc(100vw - 32px);
    padding: 24px 20px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    background: var(--bg-elevated);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-modal);
  }
  .dialog.prompt {
    width: 340px;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: 14px;
    border-radius: var(--r-lg);
    background: var(--fill);
    color: var(--tint);
  }
  .badge.danger {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }
  h2 {
    margin: 0 0 6px;
    font-size: var(--fs-callout);
    font-weight: var(--fw-650);
    letter-spacing: -0.008em;
  }
  p {
    margin: 0 0 4px;
    font-size: var(--fs-ui);
    line-height: 1.45;
    color: var(--text-2);
    text-wrap: balance;
  }
  form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
    width: 100%;
    margin-top: 16px;
  }
  .field {
    width: 100%;
    text-align: left;
  }
  .colors {
    display: flex;
    justify-content: center;
    padding: 2px 0;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 100%;
  }
  .actions .btn {
    min-width: 0;
  }
</style>
