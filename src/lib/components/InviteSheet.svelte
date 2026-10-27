<script lang="ts">
  import Avatar from './Avatar.svelte';
  import Modal from './Modal.svelte';
  import { account } from '../account.svelte';
  import { cowork } from '../cowork.svelte';
  import { friends, nameOf } from '../friends.svelte';
  import { t } from '../i18n';
  import { inviteFriend } from '../live-actions';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';

  let { pageId }: { pageId: string } = $props();

  const page = $derived(store.byId.get(pageId));
  const close = () => (ui.inviteSheet = null);
  /** Someone's already invited to this page (waiting for them). */
  const waiting = $derived(cowork.outgoing.find((r) => prefs.coworkPages[r.id] === pageId));
</script>

<Modal onclose={close} width={420} label={t('social.invite.label')} closeButton>
  <div class="invite">
    <h2>{t('social.invite.title', { title: page?.title || t('common.untitled') })}</h2>
    <p class="lead">{t('social.invite.lead')}</p>

    {#if !account.signedIn || account.needsUsername}
      <button
        class="btn primary wide"
        onclick={() => {
          close();
          ui.accountSheet = true;
        }}>{account.signedIn ? t('social.invite.pickUsernameFirst') : t('social.invite.signInFirst')}</button
      >
    {:else if waiting}
      <p class="note">{cowork.aboutOther(waiting, 'social.invite.waitingFor', 'social.invite.waitingForFriend')}</p>
      <button class="btn" onclick={() => void cowork.withdraw(waiting).catch((e) => ui.error(e))}>{t('social.invite.withdraw')}</button>
    {:else if !friends.accepted.length}
      <p class="note">{t('social.invite.addFirst')}</p>
    {:else}
      <ul class="people" aria-label={t('social.invite.friends')}>
        {#each friends.accepted as f (f.profile.id)}
          <li>
            <span class="who">
              <span class="avatar-wrap">
                <Avatar name={nameOf(f)} url={f.profile.avatarUrl} seed={f.profile.id} size={28} />
                {#if f.online}<span class="online" aria-label={t('social.online')}></span>{/if}
              </span>
              <span>
                <span class="name">{nameOf(f)}</span>
                <span class="sub">{f.online ? t('social.invite.handleHere', { username: f.profile.username ?? '' }) : `@${f.profile.username ?? ''}`}</span>
              </span>
            </span>
            <button
              class="btn small raised"
              aria-label={t('social.invite.inviteNamed', { name: nameOf(f) })}
              onclick={() => {
                inviteFriend(f, pageId);
                close();
              }}>{t('social.invite.invite')}</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Modal>

<style>
  .invite {
    padding: 24px;
  }
  h2 {
    margin: 0 0 8px;
    /* Clear of the close button. */
    padding-right: 28px;
    font-size: 18px;
    font-weight: var(--fw-600);
  }
  .lead {
    margin: 0 0 16px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .note {
    margin: 0 0 12px;
    color: var(--text-2);
  }
  .wide {
    width: 100%;
    justify-content: center;
  }
  .people {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
    max-height: 50vh;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 4px;
    border-radius: var(--r-sm);
  }
  li:hover {
    background: var(--fill);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .avatar-wrap {
    position: relative;
    display: inline-flex;
  }
  .online {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c-green);
    box-shadow: 0 0 0 2px var(--bg);
  }
  .name {
    display: block;
    font-weight: var(--fw-550);
  }
  .sub {
    display: block;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
</style>
