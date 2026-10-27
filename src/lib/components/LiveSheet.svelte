<script lang="ts">
  import Modal from './Modal.svelte';
  import { cowork, type Session } from '../cowork.svelte';
  import { t, type MessageKey } from '../i18n';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';

  let { pageId }: { pageId: string } = $props();

  const page = $derived(store.byId.get(pageId));
  const row = $derived(cowork.liveFor(pageId));
  const session = $derived(cowork.sessions[pageId]);
  const close = () => (ui.liveSheet = null);

  /** How the connection is going, in a sentence. */
  const STATUS = {
    live: 'social.live.status.live',
    offline: 'social.live.status.offline',
    paused: 'social.live.status.paused',
    connecting: 'social.live.status.connecting',
  } as const satisfies Record<Session['status'], MessageKey>;

  async function end() {
    // Read before closing: the panel's values go with it.
    const current = row;
    if (!current) return close();
    const room = current.id;
    const ok = await ui.confirm({
      title: t('social.live.endTitle'),
      message: cowork.aboutOther(current, 'social.live.endMessage', 'social.live.endMessageFriend'),
      confirmLabel: t('social.live.end'),
    });
    if (!ok) return;
    close();
    await cowork.end(room).catch((e) => ui.error(e));
  }
</script>

<Modal onclose={close} width={420} label={t('social.live.label')} closeButton>
  <div class="live">
    <h2>{row ? cowork.aboutOther(row, 'social.live.writingWith', 'social.live.writingWithFriend') : t('social.live.label')}</h2>
    <p class="lead">{t('social.live.lead', { title: page?.title || t('common.untitled') })}</p>

    <h3>{t('social.live.hereNow')}</h3>
    {#if session}
      <ul class="people" aria-label={t('social.live.hereNow')}>
        {#each session.people as p (p.id)}
          <li><span class="dot" style:background={p.color}></span>{p.me ? t('social.live.you', { name: p.name }) : p.name}</li>
        {/each}
      </ul>
      <p class="state" class:offline={session.status === 'offline'}>
        {t(STATUS[session.status])}
      </p>
    {/if}

    <div class="actions">
      <button class="btn danger-text" onclick={end}>{t('social.live.end')}</button>
      <button class="btn primary" onclick={close}>{t('common.actions.done')}</button>
    </div>
  </div>
</Modal>

<style>
  .live {
    padding: 24px;
  }
  h2 {
    margin: 0 0 8px;
    /* Clear of the close button. */
    padding-right: 28px;
    font-size: 18px;
    font-weight: var(--fw-600);
  }
  h3 {
    margin: 18px 0 6px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .lead {
    margin: 0;
    color: var(--text-2);
    line-height: 1.5;
  }
  .people {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .state {
    margin: 10px 0 0;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .state.offline {
    color: var(--c-orange);
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
</style>
