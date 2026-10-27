<script lang="ts">
  import { untrack } from 'svelte';
  import Avatar from './Avatar.svelte';
  import Modal from './Modal.svelte';
  import { account } from '../account.svelte';
  import { USERNAME, suggestUsername, type Provider } from '../cloud/types';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import { ui } from '../ui.svelte';

  /** The sign-in services' names, which stay as they are in every language. */
  const PROVIDER_NAMES: Record<Provider, string> = { google: 'Google', github: 'GitHub' };

  const close = () => {
    if (account.waiting) account.cancelSignIn();
    ui.accountSheet = false;
  };

  let busy = $state(false);
  let error = $state('');

  /** Runs an action, showing its error here. */
  async function run(action: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await action();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // "cancelled": a Google or GitHub sign-in stopped here, which says nothing.
      if (message !== 'cancelled') error = message;
    } finally {
      busy = false;
    }
  }

  // ---- signing in
  let email = $state('');
  let code = $state('');
  /** Where the code went (then the code field shows). */
  let sentTo = $state<string | null>(null);
  const emailOk = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));

  const withProvider = (p: Provider) => run(() => account.signInWith(p));
  const sendCode = () =>
    run(async () => {
      await account.sendCode(email);
      sentTo = email.trim();
      code = '';
    });
  const verify = () => run(() => account.verifyCode(sentTo!, code));

  // ---- profile
  let username = $state('');
  let displayName = $state('');
  /** The last availability answer, for the name it was about. */
  let checked = $state<{ name: string; free: boolean } | null>(null);

  // Fill the fields when the profile arrives (and again after saving).
  $effect(() => {
    const p = account.profile;
    if (!p) return;
    untrack(() => {
      displayName = p.displayName;
      username = p.username ?? suggestUsername(p.displayName || (account.user?.email ?? '').split('@')[0]);
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const name = username;
    clearTimeout(timer);
    if (!USERNAME.test(name) || name === account.profile?.username) {
      checked = null;
      return;
    }
    timer = setTimeout(async () => {
      const free = await account.usernameFree(name).catch(() => true);
      if (username === name) checked = { name, free };
    }, 300);
  });

  const usernameState = $derived.by((): { text: string; ok: boolean | null } => {
    if (!username) return { text: t('social.account.usernameHint'), ok: null };
    if (!USERNAME.test(username)) return { text: t('social.account.usernameRule'), ok: false };
    if (username === account.profile?.username) return { text: t('social.account.usernameHint'), ok: null };
    if (checked?.name !== username) return { text: t('social.account.checking'), ok: null };
    return checked.free ? { text: t('social.account.available', { username }), ok: true } : { text: t('social.account.taken', { username }), ok: false };
  });
  const usernameReady = $derived(username === account.profile?.username || usernameState.ok === true);
  const changed = $derived(username !== (account.profile?.username ?? '') || displayName.trim() !== (account.profile?.displayName ?? ''));

  const save = () =>
    run(async () => {
      const first = !account.profile?.username;
      await account.saveProfile({ username, displayName: displayName.trim() });
      ui.toast(first ? t('social.account.youAre', { username }) : t('social.account.profileSaved'));
    });

  const signOut = () => run(() => account.signOut());

  function typeUsername(e: Event & { currentTarget: HTMLInputElement }) {
    username = e.currentTarget.value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 20);
    e.currentTarget.value = username;
  }
</script>

<Modal onclose={close} width={420} label={t('social.account.label')} closeButton>
  <div class="account">
    {#if !account.user}
      <h2>{t('social.account.signInTitle')}</h2>
      <p class="lead">{t('social.account.lead')}</p>

      {#if account.waiting}
        <div class="waiting">
          <p>{t('social.account.waitingFor', { provider: PROVIDER_NAMES[account.waiting] })}</p>
          <button class="btn" onclick={() => account.cancelSignIn()}>{t('social.account.cancelSignIn')}</button>
        </div>
      {:else}
        <div class="providers">
          <button class="btn raised provider" disabled={busy} onclick={() => withProvider('google')}>
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3.01c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.1A12 12 0 0 0 12 24Z" />
              <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28v-3.1H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.38l3.99-3.1Z" />
              <path fill="#EA4335" d="M12 4.76c1.76 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l3.99 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
            </svg>
            {t('social.account.continueWith', { provider: PROVIDER_NAMES.google })}
          </button>
          <button class="btn raised provider" disabled={busy} onclick={() => withProvider('github')}>
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
              />
            </svg>
            {t('social.account.continueWith', { provider: PROVIDER_NAMES.github })}
          </button>
        </div>

        <div class="or"><span>{t('social.account.orEmail')}</span></div>

        {#if !sentTo}
          <form
            class="email"
            onsubmit={(e) => {
              e.preventDefault();
              if (emailOk && !busy) void sendCode();
            }}
          >
            <input class="field" type="email" placeholder={t('social.account.emailPlaceholder')} autocomplete="email" aria-label={t('social.account.email')} bind:value={email} />
            <button class="btn primary" type="submit" disabled={!emailOk || busy}>{t('social.account.sendCode')}</button>
          </form>
        {:else}
          <form
            class="email"
            onsubmit={(e) => {
              e.preventDefault();
              if (code.replace(/\s/g, '').length === 6 && !busy) void verify();
            }}
          >
            <p class="sent"><Rich key="social.account.codeSent" params={{ email: sentTo }} /></p>
            <input class="field code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" aria-label={t('social.account.code')} maxlength="7" bind:value={code} />
            <button class="btn primary" type="submit" disabled={code.replace(/\s/g, '').length !== 6 || busy}>{t('social.account.signIn')}</button>
            <div class="again">
              <button type="button" class="link" disabled={busy} onclick={() => void sendCode()}>{t('social.account.sendAgain')}</button> ·
              <button type="button" class="link" onclick={() => (sentTo = null)}>{t('social.account.otherEmail')}</button>
            </div>
          </form>
        {/if}
      {/if}
    {:else if account.profile}
      <div class="me">
        <Avatar name={displayName || username || account.name} url={account.profile.avatarUrl} seed={account.profile.id} size={48} />
        <div>
          <div class="me-name">{account.profile.displayName || account.name}</div>
          <div class="me-sub">{account.profile.username ? `@${account.profile.username}` : ''}{account.user.email ? ` · ${account.user.email}` : ''}</div>
        </div>
      </div>

      {#if account.needsUsername}
        <h2>{t('social.pickUsername')}</h2>
        <p class="lead">{t('social.account.pickUsernameLead')}</p>
      {/if}

      <label class="row">
        <span>{t('social.account.username')}</span>
        <span class="at-field field" class:bad={usernameState.ok === false}>
          <span class="at">@</span>
          <input value={username} oninput={typeUsername} spellcheck="false" autocomplete="off" aria-label={t('social.account.username')} />
        </span>
      </label>
      <p class="hint" class:ok={usernameState.ok === true} class:bad={usernameState.ok === false}>{usernameState.text}</p>

      <label class="row">
        <span>{t('social.account.name')}</span>
        <input class="field" bind:value={displayName} maxlength="50" aria-label={t('social.account.name')} />
      </label>

      <div class="actions">
        {#if !account.needsUsername}<button class="btn danger-text" disabled={busy} onclick={signOut}>{t('social.account.signOut')}</button>{/if}
        <button class="btn primary" disabled={busy || !usernameReady || !username || !changed} onclick={save}>{account.needsUsername ? t('social.account.continue') : t('common.actions.save')}</button>
      </div>
    {:else}
      <p class="lead">{t('social.account.loadingProfile')}</p>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>

<style>
  .account {
    padding: 24px;
  }
  h2 {
    margin: 0 0 8px;
    /* Clear of the close button. */
    padding-right: 28px;
    font-size: 18px;
    font-weight: var(--fw-600);
  }
  .me + h2 {
    margin-top: 18px;
  }
  .lead {
    margin: 0 0 18px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .providers {
    display: grid;
    gap: 8px;
  }
  .provider {
    justify-content: center;
    gap: 10px;
    height: 38px;
  }
  .or {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 18px 0 14px;
    color: var(--text-3);
    font-size: var(--fs-caption);
  }
  .or::before,
  .or::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }
  .email {
    display: grid;
    gap: 8px;
  }
  .email .btn {
    justify-content: center;
    height: 36px;
  }
  .code {
    font-size: 20px;
    letter-spacing: 0.3em;
    text-align: center;
  }
  .sent {
    margin: 0;
    color: var(--text-2);
  }
  .again {
    text-align: center;
    color: var(--text-3);
    font-size: var(--fs-caption);
  }
  .link {
    color: var(--accent-text, var(--text-2));
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .waiting {
    display: grid;
    gap: 12px;
    justify-items: center;
    padding: 18px 0 6px;
    text-align: center;
    color: var(--text-2);
  }
  .waiting p {
    margin: 0;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }
  .me-name {
    font-size: 16px;
    font-weight: var(--fw-600);
  }
  .me-sub {
    margin-top: 2px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .row {
    display: grid;
    grid-template-columns: 84px 1fr;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    color: var(--text-2);
  }
  .at-field {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .at-field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font: inherit;
    color: var(--text);
    outline: none;
  }
  .at {
    color: var(--text-3);
  }
  .at-field.bad {
    border-color: var(--c-red);
  }
  .hint {
    margin: 4px 0 0 94px;
    min-height: 1.3em;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .hint.ok {
    color: var(--c-green);
  }
  .hint.bad {
    color: var(--c-red);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 22px;
  }
  .actions .danger-text {
    margin-right: auto;
    color: var(--c-red);
  }
  .error {
    margin: 14px 0 0;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--c-red) 12%, transparent);
    color: var(--text);
    font-size: var(--fs-caption);
    line-height: 1.4;
  }
</style>
