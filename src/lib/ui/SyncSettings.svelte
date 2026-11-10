<script lang="ts">
  import { onDestroy } from 'svelte';
  import { account } from '../account.svelte';
  import { api } from '../api';
  import { loadEngine } from '../sync/entry.svelte';
  import { syncState } from '../sync/state.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  /**
   * Settings → Account, under the storage meter: turning sync on and off, and
   * how it is doing. Everything it does goes through the engine, loaded on
   * demand (sync/engine.svelte.ts).
   */
  type Step = 'idle' | 'create' | 'join';
  let step = $state<Step>('idle');
  let busy = $state(false);
  let error = $state('');
  let made = $state<{ recoveryKey: string; wrappedKey: string } | null>(null);
  let joining = $state<{ wrappedKey: string; seq: number; empty: boolean } | null>(null);
  let saved = $state(false);
  let typed = $state('');

  const id = $derived(account.user?.id ?? null);

  const line = $derived.by(() => {
    switch (syncState.status) {
      case 'syncing':
        return t('settings.sync.status.syncing');
      case 'offline':
        return t('settings.sync.status.offline');
      case 'paused-clock':
        return t('settings.sync.status.clock');
      case 'needs-update':
        return t('settings.sync.status.update');
      case 'copy-gone':
        return t('settings.sync.status.gone');
      case 'full':
        return t('settings.sync.status.full');
      case 'signed-out':
        return t('settings.sync.status.signedOut');
      case 'error':
        return syncState.reason === 'conflicts' ? t('settings.sync.status.conflicts') : t('settings.sync.status.error');
      default:
        return t('settings.sync.status.idle');
    }
  });

  const progress = $derived.by(() => {
    switch (syncState.progress) {
      case 'pulling':
        return t('settings.sync.setup.pulling');
      case 'text':
        return t('settings.sync.setup.text');
      case 'pushing':
        return t('settings.sync.setup.pushing');
      case 'offline':
        return t('settings.sync.setup.offline');
      default:
        return t('settings.sync.setup.starting');
    }
  });

  const when = $derived(syncState.lastSynced ? t('settings.sync.lastSynced', { time: fmt.dateTime(syncState.lastSynced) }) : t('settings.sync.never'));

  /** An error as a sentence for this pane (never a toast). */
  async function message(e: unknown): Promise<string> {
    const { describe } = await loadEngine();
    switch (describe(e)) {
      case 'offline':
        return t('settings.sync.errors.offline');
      case 'clock':
        return t('settings.sync.errors.clock');
      case 'update':
        return t('settings.sync.errors.update');
      case 'taken':
        return t('settings.sync.errors.taken');
      case 'wrong':
        return t('settings.sync.join.wrong');
      case 'gone':
        return t('settings.sync.errors.gone');
      case 'signedout':
        return t('settings.sync.errors.signedOut');
      default:
        return t('settings.sync.errors.generic');
    }
  }

  async function run(work: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await work();
    } catch (e) {
      console.warn('Sync settings:', e);
      // A recovery key that was typed doesn't stay in the box after a failure.
      typed = '';
      error = await message(e);
    } finally {
      busy = false;
    }
  }

  const turnOn = () =>
    run(async () => {
      if (!id) return;
      const { engine } = await loadEngine();
      const r = await engine.prepare(id);
      saved = false;
      typed = '';
      if (r.mode === 'create') {
        made = r;
        step = 'create';
      } else {
        joining = r;
        step = 'join';
      }
    });

  /** Lets go of every recovery key this pane holds: the one shown, the one typed, and the one on the clipboard. */
  async function clearKeys() {
    // A key made here but never used goes again.
    if (step === 'create' && made && id) await api.syncVaultForget(id).catch(() => {});
    made = joining = null;
    typed = '';
    saved = false;
    await wipeClipboard();
  }

  async function cancel() {
    await clearKeys();
    step = 'idle';
    error = '';
  }

  // Closing Settings in the middle of turning on is a cancel too.
  onDestroy(() => {
    void clearKeys();
  });

  const create = () =>
    run(async () => {
      if (!id || !made) return;
      const { engine, describe } = await loadEngine();
      try {
        await engine.create(id, made.wrappedKey);
      } catch (e) {
        // Someone got there first: the same screen as joining, with a word about it.
        if (describe(e) === 'taken') {
          const r = await engine.prepare(id);
          made = null;
          if (r.mode === 'join') {
            joining = r;
            step = 'join';
          }
        }
        throw e;
      }
      made = null;
      step = 'idle';
    });

  /** The synced copy is empty and its key isn't one this person has: a new one in its place. */
  const startOver = () =>
    run(async () => {
      if (!id) return;
      const { engine } = await loadEngine();
      const r = await engine.startOver(id);
      typed = '';
      joining = null;
      if (r.mode === 'create') {
        made = r;
        step = 'create';
      }
    });

  const join = () =>
    run(async () => {
      if (!id || !joining) return;
      const { engine } = await loadEngine();
      await engine.join(id, joining.wrappedKey, typed, joining.seq);
      joining = null;
      typed = '';
      step = 'idle';
    });

  const unlock = () =>
    run(async () => {
      if (!id) return;
      const { engine } = await loadEngine();
      await engine.unlock(id, typed);
      typed = '';
    });

  /** What was copied, and the timer that takes it off the clipboard again. */
  let copied: string | null = null;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;
  const CLIPBOARD_MS = 30_000;

  /** Clears the clipboard if it still holds the recovery key (what else is there is left alone). */
  async function wipeClipboard() {
    clearTimeout(clipTimer);
    const key = copied;
    copied = null;
    if (!key) return;
    try {
      if ((await navigator.clipboard.readText()) === key) await navigator.clipboard.writeText('');
    } catch (e) {
      console.warn('Sync settings: could not clear the clipboard', e);
    }
  }

  async function copyKey() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.recoveryKey);
      copied = made.recoveryKey;
      clearTimeout(clipTimer);
      clipTimer = setTimeout(() => void wipeClipboard(), CLIPBOARD_MS);
      ui.toast(t('settings.sync.create.copied'));
    } catch (e) {
      console.warn('Sync settings: could not copy', e);
    }
  }

  async function syncNow() {
    (await loadEngine()).engine.syncNow();
  }

  async function turnOff() {
    const ok = await ui.confirm({
      title: t('settings.sync.turnOffConfirm.title'),
      message: t('settings.sync.turnOffConfirm.message'),
      confirmLabel: t('settings.sync.turnOffConfirm.confirm'),
    });
    if (ok) await run(async () => void (await (await loadEngine()).engine.turnOff()));
  }

  async function deleteCopy() {
    const ok = await ui.confirm({
      title: t('settings.sync.deleteConfirm.title'),
      message: t('settings.sync.deleteConfirm.message'),
      confirmLabel: t('settings.sync.deleteConfirm.confirm'),
      danger: true,
    });
    if (ok) await run(async () => void (await (await loadEngine()).engine.deleteSyncedCopy()));
  }

  async function deleteBackup() {
    const ok = await ui.confirm({
      title: t('settings.sync.backup.deleteConfirm.title'),
      message: t('settings.sync.backup.deleteConfirm.message'),
      confirmLabel: t('settings.sync.backup.deleteConfirm.confirm'),
      danger: true,
    });
    if (ok) await run(async () => void (await (await loadEngine()).engine.deleteBackup()));
  }

  const onEnter = (go: () => unknown) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' && typed.trim() && !busy) {
      e.preventDefault();
      void go();
    }
  };
</script>

{#if syncState.status === 'off'}
  {#if step === 'create' && made}
    <div class="group-row stack">
      <div class="row-label">
        {t('settings.sync.create.title')}
        <small>{t('settings.sync.create.hint')}</small>
      </div>
      <div class="key-row">
        <code class="key" aria-label={t('settings.sync.create.keyLabel')}>{made.recoveryKey}</code>
        <button class="btn small raised" onclick={copyKey}>{t('settings.sync.create.copy')}</button>
      </div>
      <small class="quiet">{t('settings.sync.create.copyNote')}</small>
      <label class="check"><input type="checkbox" bind:checked={saved} /> {t('settings.sync.create.saved')}</label>
      <div class="actions">
        <button class="btn small raised" disabled={busy} onclick={cancel}>{t('common.actions.cancel')}</button>
        <button class="btn small primary" disabled={!saved || busy} onclick={create}>{t('settings.sync.create.continue')}</button>
      </div>
    </div>
  {:else if step === 'join' && joining}
    <div class="group-row stack">
      <div class="row-label">
        {t('settings.sync.join.title')}
        <small>{t('settings.sync.join.hint')}</small>
      </div>
      <input
        class="field"
        bind:value={typed}
        placeholder={t('settings.sync.join.placeholder')}
        aria-label={t('settings.sync.join.placeholder')}
        autocomplete="off"
        spellcheck="false"
        onkeydown={onEnter(join)}
      />
      <div class="actions">
        <button class="btn small raised" disabled={busy} onclick={cancel}>{t('common.actions.cancel')}</button>
        <button class="btn small primary" disabled={!typed.trim() || busy} onclick={join}>{t('settings.sync.create.continue')}</button>
      </div>
      {#if joining.empty}
        <div class="row-label">
          <small>{t('settings.sync.join.empty')}</small>
        </div>
        <div class="actions">
          <button class="btn small raised" disabled={busy} onclick={startOver}>{t('settings.sync.join.startOver')}</button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="group-row">
      <div class="row-label">{t('settings.sync.offHint')}</div>
      <button class="btn small raised" disabled={busy || !id} onclick={turnOn}>{t('settings.sync.turnOn')}</button>
    </div>
  {/if}
{:else if syncState.status === 'locked'}
  <div class="group-row stack">
    <div class="row-label">
      {t('settings.sync.unlock.title')}
      <small>{t('settings.sync.unlock.hint')}</small>
    </div>
    <input
      class="field"
      bind:value={typed}
      placeholder={t('settings.sync.join.placeholder')}
      aria-label={t('settings.sync.join.placeholder')}
      autocomplete="off"
      spellcheck="false"
      onkeydown={onEnter(unlock)}
    />
    <div class="actions">
      <button class="btn small primary" disabled={!typed.trim() || busy} onclick={unlock}>{t('settings.sync.unlock.button')}</button>
    </div>
  </div>
{:else if syncState.settingUp}
  <div class="group-row">
    <div class="row-label" role="status">
      <span>{t('settings.sync.setup.title')}</span>
      <small>{progress}</small>
    </div>
  </div>
{:else}
  <div class="group-row">
    <div class="row-label" role="status">
      <span>{line}</span>
      <small>{when}</small>
    </div>
    <button class="btn small raised" disabled={syncState.status === 'syncing'} onclick={syncNow}>{t('settings.sync.syncNow')}</button>
  </div>
  {#if syncState.unreadable > 0}
    <div class="group-row">
      <small class="quiet">{t('settings.sync.unreadable', { count: syncState.unreadable })}</small>
    </div>
  {/if}
  {#if syncState.backup}
    <div class="group-row">
      <div class="row-label">{t('settings.sync.backup.text')}</div>
      <button class="btn small raised" disabled={busy} onclick={deleteBackup}>{t('settings.sync.backup.delete')}</button>
    </div>
  {/if}
  <div class="group-row">
    <button class="btn small raised" disabled={busy} onclick={turnOff}>{t('settings.sync.turnOff')}</button>
    <!-- A computer whose copy was deleted or replaced can't delete it: that would delete the replacement. -->
    {#if syncState.status !== 'copy-gone'}
      <button class="btn small raised danger" disabled={busy} onclick={deleteCopy}>{t('settings.sync.deleteCopy')}</button>
    {/if}
  </div>
{/if}
{#if error}
  <div class="group-row">
    <span class="problem" role="alert">{error}</span>
  </div>
{/if}

<style>
  .key-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  /* The key is shown to be written down: large, and selectable in a window that otherwise isn't. */
  .key {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--raised);
    box-shadow: 0 0 0 0.5px var(--hairline);
    font-family: var(--font-mono);
    font-size: var(--fs-title-3, 17px);
    letter-spacing: 0.04em;
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
    word-break: break-all;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-body-ui);
    color: var(--text);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .danger {
    color: var(--danger);
  }
  .quiet {
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .problem {
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
</style>
