<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { account } from '../account.svelte';
  import { prefs } from '../prefs.svelte';
  import { syncAvailable } from '../sync/flag';
  import { ui } from '../ui.svelte';
  import { fadeOut } from '../motion';
  import { t } from '../i18n';

  /**
   * The free sync storage, said once per install as the app opens, to
   * everyone, signed in or not: a small card in the middle of the window with
   * a present on it. It never interrupts: it waits for the welcome screen and
   * for any open sheet to close, and for the sign-in state, so its button
   * says the right thing from the start.
   */
  const id = $derived(account.user?.id ?? null);
  const seen = $derived(Object.keys(prefs.syncWelcomed).length > 0);
  /** The window is shown a moment after the app starts; the card arrives once it's there to be seen. */
  let settled = $state(false);
  onMount(() => {
    const timer = setTimeout(() => (settled = true), 350);
    return () => clearTimeout(timer);
  });
  const show = $derived(syncAvailable() && prefs.welcomed && account.ready && settled && !seen && !ui.anyModalOpen);

  function dismiss() {
    prefs.syncWelcomed = { ...prefs.syncWelcomed, [id ?? 'guest']: true };
  }

  function openSettings() {
    ui.settingsSection = 'account';
    ui.settingsOpen = true;
  }

  /** Signed out, the way to it starts with signing in; Settings → Account follows when that sheet closes. */
  let afterSignIn = $state(false);
  function setUp() {
    dismiss();
    if (id) return openSettings();
    afterSignIn = true;
    ui.accountSheet = true;
  }
  $effect(() => {
    if (!afterSignIn || ui.accountSheet) return;
    afterSignIn = false;
    if (id) openSettings();
  });

  // A dialog of two buttons. Focus goes to the card, not a button: it arrives unasked, and a key
  // someone was already pressing (Enter, Space) must not choose for them. Tab stays inside,
  // Escape closes, and focus goes back to where it was.
  let card = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!card) return;
    const before = document.activeElement as HTMLElement | null;
    void tick().then(() => card?.focus({ preventScroll: true }));
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key !== 'Tab' || !card) return;
    const buttons = [...card.querySelectorAll<HTMLElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onmousedown={(e) => e.target === e.currentTarget && dismiss()} out:fadeOut={{ duration: 160 }}>
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="sync-welcome-title" tabindex="-1" bind:this={card} {onkeydown}>
      <!-- A white box with a black ribbon; the lid lifts once and a few sparks fly. -->
      <div class="stage" aria-hidden="true">
        <svg class="gift" viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <g class="sparks">
            <path class="spark" d="M32 7V2" />
            <path class="spark" d="m17 12-3.5-3.5" />
            <path class="spark" d="m47 12 3.5-3.5" />
            <path class="spark" d="M8 21H3.5" />
            <path class="spark" d="M56 21h4.5" />
          </g>
          <rect class="box" x="13" y="31" width="38" height="24" rx="3" />
          <rect class="band" x="28.5" y="31" width="7" height="24" stroke="none" />
          <g class="lid">
            <path d="M32 22c-2.6-6.4-11.5-7.6-11.5-2.6 0 3.6 6.3 3.4 11.5 2.6Z" />
            <path d="M32 22c2.6-6.4 11.5-7.6 11.5-2.6 0 3.6-6.3 3.4-11.5 2.6Z" />
            <rect class="box" x="9.5" y="22" width="45" height="9" rx="2.5" />
            <rect class="band" x="28.5" y="22" width="7" height="9" stroke="none" />
          </g>
        </svg>
      </div>
      <h2 id="sync-welcome-title">{t('settings.sync.welcome.title')}</h2>
      <p>{t('settings.sync.welcome.body')}</p>
      <div class="actions">
        <button class="btn primary" onclick={setUp}>{id ? t('settings.sync.welcome.setUp') : t('settings.sync.welcome.signIn')}</button>
        <button class="btn quiet" onclick={dismiss}>{t('settings.sync.welcome.gotIt')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--scrim);
    animation: scrim-in 240ms var(--ease) both;
  }
  @keyframes scrim-in {
    from {
      background-color: transparent;
    }
  }
  .card {
    width: min(360px, 100%);
    padding: 28px 24px 16px;
    border-radius: var(--r-xl);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-modal);
    text-align: center;
    outline: none;
    /* Arrives a touch past its size and settles: the "boom". */
    animation: card-in 460ms cubic-bezier(0.2, 1.25, 0.35, 1) both;
  }
  @keyframes card-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.9);
    }
    45% {
      opacity: 1;
    }
  }

  .stage {
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    margin: 0 auto 18px;
    border-radius: 50%;
    background: var(--fill);
    color: var(--text);
  }
  .gift {
    overflow: visible;
    animation: gift-in 620ms cubic-bezier(0.2, 1.5, 0.4, 1) 140ms both;
  }
  @keyframes gift-in {
    from {
      opacity: 0;
      transform: scale(0.55) rotate(-10deg);
    }
    40% {
      opacity: 1;
    }
  }
  .box {
    fill: var(--bg-elevated);
  }
  .band {
    fill: currentColor;
  }
  .lid {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: lid 760ms var(--ease-out) 620ms both;
  }
  @keyframes lid {
    35% {
      transform: translateY(-7px) rotate(-7deg);
    }
    70% {
      transform: translateY(1px) rotate(1deg);
    }
  }
  /* Each spark is drawn outwards and then let go. */
  .spark {
    stroke-dasharray: 6;
    stroke-dashoffset: 6;
    opacity: 0;
    animation: spark 620ms var(--ease-out) 760ms both;
  }
  @keyframes spark {
    25% {
      stroke-dashoffset: 0;
      opacity: 1;
    }
    60% {
      stroke-dashoffset: 0;
      opacity: 1;
    }
    to {
      stroke-dashoffset: -6;
      opacity: 0;
    }
  }

  h2 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: var(--fw-650);
    line-height: 1.25;
    letter-spacing: -0.015em;
    color: var(--text);
    text-wrap: balance;
  }
  p {
    margin: 0 auto;
    max-width: 30ch;
    font-size: var(--fs-body-ui);
    line-height: 1.45;
    color: var(--text-2);
    text-wrap: balance;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 22px;
  }
  .actions .btn {
    width: 100%;
    height: 38px;
  }
  .quiet {
    background: none;
    color: var(--text-2);
  }
  .quiet:hover {
    background: var(--fill);
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .card,
    .gift,
    .lid,
    .spark {
      animation: none;
    }
  }
</style>
