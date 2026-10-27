<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import { account } from '../account.svelte';
  import { cowork } from '../cowork.svelte';
  import { friends, nameOf } from '../friends.svelte';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import { choosePage, writeWithMenu } from '../live-actions';
  import { ui, type MenuItem } from '../ui.svelte';
  import type { Friend, LiveSession } from '../cloud';

  const ready = $derived(account.signedIn && !account.needsUsername);
  const here = $derived(friends.accepted.filter((f) => f.online).length);
  const waiting = $derived(friends.incoming.length + cowork.incoming.length);

  const summary = $derived.by(() => {
    if (!account.signedIn) return t('social.friends.summary.signedOut');
    if (!ready) return t('social.friends.summary.needsUsername');
    const count = friends.accepted.length;
    const username = account.profile?.username ?? '';
    if (!count) return t('social.friends.summary.noFriends', { username });
    return here ? t('social.friends.summary.withFriendsHere', { count, here, username }) : t('social.friends.summary.withFriends', { count, username });
  });

  async function addFriend() {
    const answer = await ui.prompt({
      title: t('social.friends.add.title'),
      message: t('social.friends.add.message'),
      placeholder: t('social.friends.add.placeholder'),
      confirmLabel: t('social.friends.add.send'),
      icon: 'user',
    });
    if (!answer) return;
    const name = answer.value.trim().replace(/^@/, '').toLowerCase();
    try {
      const done = await friends.add(name);
      ui.toast(done === 'accepted' ? t('social.friends.nowFriends', { name: `@${name}` }) : t('social.friends.add.sent', { name: `@${name}` }));
    } catch (e) {
      // Usually a typo or someone who isn't there: say so, it's not a fault.
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }

  function accept(f: Friend) {
    friends.accept(f.profile.id).then(
      () => ui.toast(t('social.friends.nowFriends', { name: nameOf(f) })),
      (e) => ui.error(e),
    );
  }

  /** Declines their request, or cancels yours. */
  function drop(f: Friend) {
    friends.remove(f.profile.id).catch((e) => ui.error(e));
  }

  const join = (row: LiveSession) => cowork.join(row).catch((e) => ui.error(e));
  const decline = (row: LiveSession) => cowork.decline(row).catch((e) => ui.error(e));
  const withdraw = (row: LiveSession) => cowork.withdraw(row).catch((e) => ui.error(e));

  function menu(e: MouseEvent, f: Friend) {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      {
        label: t('social.friends.remove'),
        icon: 'trash',
        danger: true,
        action: async () => {
          const ok = await ui.confirm({
            title: t('social.friends.removeTitle', { name: nameOf(f) }),
            message: t('social.friends.removeMessage'),
            confirmLabel: t('common.actions.remove'),
            danger: true,
          });
          if (!ok) return;
          // Writing together ends with the friendship.
          for (const row of cowork.rows) if (row.status === 'active' && cowork.other(row)?.profile.id === f.profile.id) await cowork.end(row.id);
          drop(f);
        },
      },
    ];
    if (e.type === 'contextmenu') ui.openMenu({ x: e.clientX, y: e.clientY, items });
    else ui.openMenuAt(e.currentTarget as Element, items, { alignRight: true });
  }
</script>

<div class="view friends-view">
  <header class="view-head">
    <div>
      <h1 class="view-title">{t('common.views.friends')}</h1>
      <p class="view-sub">{summary}</p>
    </div>
    {#if ready}
      <div class="view-actions">
        <button class="btn primary" onclick={addFriend}><Icon name="plus" size={15} stroke={2.2} /> {t('social.friends.add.button')}</button>
      </div>
    {/if}
  </header>

  {#if !account.ready}
    <!-- Reading the sign-in state. -->
  {:else if !account.signedIn}
    <EmptyState icon="users" title={t('social.friends.signedOutTitle')} text={t('social.friends.signedOutText')}>
      <button class="btn primary" onclick={() => (ui.accountSheet = true)}>{t('social.friends.signIn')}</button>
    </EmptyState>
  {:else if account.needsUsername}
    <EmptyState icon="users" title={t('social.pickUsername')} text={t('social.friends.needsUsernameText')}>
      <button class="btn primary" onclick={() => (ui.accountSheet = true)}>{t('social.friends.pickUsername')}</button>
    </EmptyState>
  {:else}
    {#if waiting}
      <h2 class="group-title">{t('social.friends.waitingForYou')}</h2>
      <div class="group" role="list" aria-label={t('social.friends.waitingForYou')}>
        {#each cowork.incoming as row (row.id)}
          {@const who = cowork.other(row)}
          {@const name = cowork.otherName(row)}
          <div class="group-row person" role="listitem">
            <Avatar {name} url={who?.profile.avatarUrl} seed={who?.profile.id ?? row.id} size={32} />
            <span class="who">
              <span class="name">{name}</span>
              <span class="meta">{row.kind === 'invite' ? t('social.friends.invitesYou', { title: row.title || t('common.untitled') }) : t('social.friends.wantsToWrite')}</span>
            </span>
            {#if row.kind === 'invite'}
              <button class="btn small primary" onclick={() => join(row)} aria-label={cowork.aboutOther(row, 'social.friends.joinNamed', 'social.friends.joinFriend')}>{t('social.session.join')}</button>
            {:else}
              <button class="btn small primary" onclick={(e) => choosePage(row, e.currentTarget as Element)} aria-label={cowork.aboutOther(row, 'social.friends.choosePageFor', 'social.friends.choosePageForFriend')}>{t('social.friends.choosePage')}</button>
            {/if}
            <button class="btn small raised" onclick={() => decline(row)} aria-label={cowork.aboutOther(row, 'social.friends.declineSessionNamed', 'social.friends.declineSessionFriend')}>{t('social.friends.declineSession')}</button>
          </div>
        {/each}
        <!-- Someone not yet a friend shows initials, never a picture: loading
             one would tell its server you're here. -->
        {#each friends.incoming as f (f.profile.id)}
          <div class="group-row person" role="listitem">
            <Avatar name={nameOf(f)} seed={f.profile.id} size={32} />
            <span class="who">
              <span class="name">{nameOf(f)}</span>
              <span class="meta">{t('social.friends.wantsToBeFriends', { name: `@${f.profile.username ?? ''}` })}</span>
            </span>
            <button class="btn small primary" onclick={() => accept(f)} aria-label={t('social.friends.acceptNamed', { name: nameOf(f) })}>{t('social.friends.accept')}</button>
            <button class="btn small raised" onclick={() => drop(f)} aria-label={t('social.friends.declineRequestNamed', { name: nameOf(f) })}>{t('social.friends.declineRequest')}</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if friends.accepted.length}
      <h2 class="group-title">{t('social.friends.friends')}</h2>
      <div class="group" role="list" aria-label={t('social.friends.friends')}>
        {#each friends.accepted as f (f.profile.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="group-row person" role="listitem" oncontextmenu={(e) => menu(e, f)}>
            <span class="avatar">
              <Avatar name={nameOf(f)} url={f.profile.avatarUrl} seed={f.profile.id} size={32} />
              {#if f.online}<span class="online" aria-label={t('social.online')}></span>{/if}
            </span>
            <span class="who">
              <span class="name">{nameOf(f)}</span>
              <span class="meta"
                >{#if f.online}<Rich key="social.friends.handleHere" params={{ username: f.profile.username ?? '' }}>
                    {#snippet here(text: string)}<span class="here">{text}</span>{/snippet}
                  </Rich>{:else}@{f.profile.username}{/if}</span
              >
            </span>
            <button class="btn small raised" onclick={(e) => writeWithMenu(f, e.currentTarget as Element)} aria-label={t('social.friends.writeWith', { name: nameOf(f) })}>
              <Icon name="page" size={14} /> {t('social.friends.writeTogether')}
            </button>
            <button class="icon-btn" onclick={(e) => menu(e, f)} aria-label={t('social.friends.moreFor', { name: nameOf(f) })} data-tip={t('common.actions.more')}><Icon name="more" size={15} /></button>
          </div>
        {/each}
      </div>
    {/if}

    {#if friends.outgoing.length || cowork.outgoing.length}
      <h2 class="group-title">{t('social.friends.waitingForThem')}</h2>
      <div class="group" role="list" aria-label={t('social.friends.waitingForThem')}>
        {#each cowork.outgoing as row (row.id)}
          {@const who = cowork.other(row)}
          {@const name = cowork.otherName(row)}
          <div class="group-row person" role="listitem">
            <Avatar {name} url={who?.profile.avatarUrl} seed={who?.profile.id ?? row.id} size={32} />
            <span class="who">
              <span class="name">{name}</span>
              <span class="meta">{row.kind === 'invite' ? t('social.friends.invitedTo', { title: row.title || t('common.untitled') }) : t('social.friends.askedToWrite')}</span>
            </span>
            <button class="btn small raised" onclick={() => withdraw(row)} aria-label={cowork.aboutOther(row, 'social.friends.withdrawNamed', 'social.friends.withdrawFriend')}>{t('social.friends.withdraw')}</button>
          </div>
        {/each}
        {#each friends.outgoing as f (f.profile.id)}
          <div class="group-row person" role="listitem">
            <Avatar name={nameOf(f)} seed={f.profile.id} size={32} />
            <span class="who">
              <span class="name">{nameOf(f)}</span>
              <span class="meta">{t('social.friends.askedWaiting', { username: f.profile.username ?? '' })}</span>
            </span>
            <button class="btn small raised" onclick={() => drop(f)} aria-label={t('social.friends.cancelRequestNamed', { name: nameOf(f) })}>{t('social.friends.cancelRequest')}</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if friends.loaded && !friends.list.length && !cowork.incoming.length}
      <EmptyState icon="users" title={t('social.friends.emptyTitle')} text={t('social.friends.emptyText')}>
        <button class="btn primary" onclick={addFriend}><Icon name="plus" size={15} stroke={2.2} /> {t('social.friends.add.button')}</button>
      </EmptyState>
    {/if}
  {/if}
</div>

<style>
  .person {
    justify-content: flex-start;
    gap: 12px;
    padding: 8px 12px 8px 16px;
  }
  .avatar {
    position: relative;
    flex: none;
    display: inline-flex;
  }
  .online {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--c-green);
    box-shadow: 0 0 0 2px var(--bg-grouped);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-size: var(--fs-body-ui);
    line-height: 20px;
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: var(--fs-footnote);
    line-height: 16px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .here {
    color: var(--c-green);
    font-weight: var(--fw-500);
  }
</style>
