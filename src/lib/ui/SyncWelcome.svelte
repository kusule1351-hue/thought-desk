<script lang="ts">
  import { account } from '../account.svelte';
  import { prefs } from '../prefs.svelte';
  import { syncAvailable } from '../sync/flag';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';

  /**
   * A small note, once per account, the first time someone is signed in: the
   * free sync storage. It never interrupts: it waits for the welcome screen
   * and for any open sheet to close.
   */
  const id = $derived(account.user?.id ?? null);
  const show = $derived(syncAvailable() && prefs.welcomed && !!id && !prefs.syncWelcomed[id] && !ui.anyModalOpen);

  function dismiss() {
    if (id) prefs.syncWelcomed = { ...prefs.syncWelcomed, [id]: true };
  }

  function setUp() {
    dismiss();
    ui.settingsSection = 'account';
    ui.settingsOpen = true;
  }
</script>

{#if show}
  <section class="note" aria-labelledby="sync-welcome-title">
    <h2 id="sync-welcome-title">{t('settings.sync.welcome.title')}</h2>
    <p>{t('settings.sync.welcome.body')}</p>
    <div class="actions">
      <button class="btn small raised" onclick={setUp}>{t('settings.sync.welcome.setUp')}</button>
      <button class="btn small primary" onclick={dismiss}>{t('settings.sync.welcome.gotIt')}</button>
    </div>
  </section>
{/if}

<style>
  .note {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 100;
    width: min(320px, calc(100vw - 32px));
    padding: 14px 16px;
    border-radius: var(--r-xl);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-pop);
  }
  h2 {
    margin: 0 0 4px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    color: var(--text);
  }
  p {
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--text-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  @media (max-width: 480px) {
    .note {
      right: 16px;
      bottom: 16px;
    }
  }
</style>
