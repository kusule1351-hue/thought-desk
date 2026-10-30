<script lang="ts">
  import { split } from '../split.svelte';
  import PageIcon from './PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import WindowControls from './WindowControls.svelte';
  import { isMac } from '../platform';
  import { changeLook } from '../look-transition';
  import { drag, dragLater, endDrag, pageDragImage } from './TreeItem.svelte';
  import { prefs, type Theme } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { relativeWhen } from '../time';
  import { pageMenuItems } from '../page-actions';
  import { planner } from '../planner.svelte';
  import { cards } from '../cards.svelte';
  import { library } from '../library.svelte';
  import { shortcuts } from '../shortcuts.svelte';
  import { databases } from '../databases.svelte';
  import { cowork } from '../cowork.svelte';
  import { tabs } from '../tabs.svelte';
  import TabStrip from './TabStrip.svelte';
  import { t, type MessageKey } from '../i18n';
  import { fmt } from '../i18n/format';

  let { words = 0, scrolled = false }: { words?: number; scrolled?: boolean } = $props();

  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const page = $derived(store.view === 'page' ? store.current : null);
  /** The open page's live session, while it's on. */
  const live = $derived(page && cowork.isLive(page.id) ? cowork.sessions[page.id] : undefined);
  const liveRow = $derived(page && live ? cowork.liveFor(page.id) : undefined);
  /** Whether the other person is here now. */
  const together = $derived(!!live && live.people.some((p) => !p.me));
  const deck = $derived(page ? cards.deck(page.id) : undefined);
  const VIEW_CRUMBS: Record<string, { label: string; icon: string }> = {
    home: { label: t('common.views.home'), icon: 'home' },
    assignments: { label: t('common.views.assignments'), icon: 'assignment' },
    calendar: { label: t('common.views.calendar'), icon: 'calendar' },
    files: { label: t('common.views.files'), icon: 'files' },
    cards: { label: t('common.views.flashcards'), icon: 'cards' },
    friends: { label: t('common.views.friends'), icon: 'users' },
    galaxy: { label: t('common.views.galaxy'), icon: 'galaxy' },
  };
  const viewCrumb = $derived(
    store.view === 'tag'
      ? { label: `#${store.tag ?? ''}`, icon: 'tag' }
      : store.view === 'course'
        ? { label: planner.courseById.get(store.courseId ?? '')?.name || t('common.course'), icon: 'book' }
        : VIEW_CRUMBS[store.view],
  );
  const crumbs = $derived.by(() => {
    if (!page) return [];
    const all = [...store.ancestors(page.id), page];
    // Long paths collapse to: first › … › parent › page.
    if (all.length > 4) return [all[0], null, ...all.slice(-2)];
    return all;
  });

  // A page nobody has typed in yet reads "Created", not "Edited".
  const status = $derived.by(() => {
    if (!page) return '';
    if (page.kind === 'database') return t('shell.rowCount', { count: databases.rowCount(page.id) });
    const untouched = page.updatedAt - page.createdAt < 1500;
    const when = relativeWhen(untouched ? page.createdAt : page.updatedAt, now);
    if (when.kind === 'now') return t(untouched ? 'shell.titleBar.created.now' : 'shell.titleBar.edited.now');
    if (when.kind === 'relative') return t(untouched ? 'shell.titleBar.created.relative' : 'shell.titleBar.edited.relative', { when: when.text });
    return t(untouched ? 'shell.titleBar.created.date' : 'shell.titleBar.edited.date', { date: when.text });
  });

  // The live chip: how the session is going, and with whom. A sentence for each state, since other languages word them differently.
  const LIVE_WITH = { here: 'shell.titleBar.live.with', paused: 'shell.titleBar.live.withPaused', away: 'shell.titleBar.live.withAway' } as const satisfies Record<string, MessageKey>;
  /** No session row yet: "a friend". */
  const LIVE_WITH_FRIEND = { here: 'shell.titleBar.live.withFriend', paused: 'shell.titleBar.live.withFriendPaused', away: 'shell.titleBar.live.withFriendAway' } as const satisfies Record<string, MessageKey>;
  /** A row, but the other person is no longer a friend: "Your friend" (cowork.aboutOther). */
  const LIVE_WITH_YOUR_FRIEND = { here: 'shell.titleBar.live.withYourFriend', paused: 'shell.titleBar.live.withYourFriendPaused', away: 'shell.titleBar.live.withYourFriendAway' } as const satisfies Record<string, MessageKey>;
  const liveText = $derived.by(() => {
    if (!live) return '';
    if (live.status === 'offline') return t('shell.titleBar.live.offline');
    if (live.status === 'connecting') return t('shell.titleBar.live.connecting');
    const state = live.status === 'paused' ? 'paused' : together ? 'here' : 'away';
    return liveRow ? cowork.aboutOther(liveRow, LIVE_WITH[state], LIVE_WITH_YOUR_FRIEND[state]) : t(LIVE_WITH_FRIEND[state]);
  });

  // App-wide buttons: appearance, Trash and Settings.
  const themeIcon = $derived(prefs.theme === 'system' ? 'monitor' : prefs.theme === 'dark' ? 'moon' : 'sun');
  const THEME_TIPS = { system: 'shell.titleBar.appearance.system', dark: 'shell.titleBar.appearance.dark', light: 'shell.titleBar.appearance.light' } as const satisfies Record<Theme, MessageKey>;
  const themeTip = $derived(t(THEME_TIPS[prefs.theme] ?? THEME_TIPS.light));
  function cycleTheme() {
    changeLook(() => (prefs.theme = prefs.theme === 'system' ? 'light' : prefs.theme === 'light' ? 'dark' : 'system'));
  }
  const trashCount = $derived(
    store.trash.length +
      planner.assignments.filter((a) => a.deletedAt).length +
      planner.events.filter((e) => e.deletedAt).length +
      library.files.filter((f) => f.deletedAt).length,
  );

  // Drag a page from the sidebar onto Trash to delete it (with Undo, as
  // from its menu). While a page is dragged, the button shows it's a target.
  let trashHover = $state(false);
  function onTrashDragOver(e: DragEvent) {
    if (!drag.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    trashHover = true;
  }
  function onTrashDrop(e: DragEvent) {
    const id = drag.id;
    trashHover = false;
    if (!id) return;
    e.preventDefault();
    drag.id = null;
    void store.trashPage(id);
  }

  let moreOpen = $state(false);
  function openMore(e: MouseEvent) {
    if (!page) return;
    moreOpen = true;
    ui.openMenuAt(e.currentTarget as Element, pageMenuItems(page.id, { words }), {
      alignRight: true,
      onClose: () => (moreOpen = false),
    });
  }
</script>

<header class="titlebar" class:scrolled class:tabbed={tabs.list.length > 1} class:bare={!prefs.sidebarOpen} data-tauri-drag-region>
  <div class="nav">
    {#if !prefs.sidebarOpen}
      <button class="icon-btn" onclick={() => (prefs.sidebarOpen = true)} data-tip={t('shell.titleBar.showSidebar')} data-tip-key={shortcuts.label('sidebar')}>
        <Icon name="sidebar-left" />
      </button>
    {/if}
    <button class="icon-btn" disabled={!store.canGoBack} onclick={() => store.back()} data-tip={t('shell.titleBar.back')} data-tip-key={shortcuts.label('back')}>
      <Icon name="arrow-left" />
    </button>
    <button class="icon-btn" disabled={!store.canGoForward} onclick={() => store.forward()} data-tip={t('shell.titleBar.forward')} data-tip-key={shortcuts.label('forward')}>
      <Icon name="arrow-right" />
    </button>
  </div>

  {#if tabs.list.length > 1}
    <TabStrip />
  {:else}
  <nav class="crumbs" data-tauri-drag-region aria-label={t('shell.titleBar.breadcrumb')}>
    {#if viewCrumb}
      <span class="crumb current view-crumb" data-tauri-drag-region>
        <span class="view-icon"><Icon name={viewCrumb.icon} size={15} /></span>
        <span class="crumb-title" data-tauri-drag-region>{viewCrumb.label}</span>
      </span>
    {/if}
    {#each crumbs as c, i (c?.id ?? `gap-${i}`)}
      {#if i > 0}<span class="sep" data-tauri-drag-region><Icon name="chevron-right" size={12} stroke={2} /></span>{/if}
      {#if c === null}
        <span class="gap" data-tauri-drag-region>…</span>
      {:else}
        <button
          class="crumb"
          class:current={i === crumbs.length - 1}
          onclick={() => store.open(c.id)}
          draggable={i === crumbs.length - 1}
          ondragstart={(e) => {
            const id = c.id;
            e.dataTransfer?.setData('text/plain', c.title || t('common.untitled'));
            pageDragImage(e, c.title, c.icon);
            dragLater(id, 'main');
          }}
          ondragend={endDrag}
        >
          {#if c.icon}<span class="emoji"><PageIcon icon={c.icon} /></span>{:else if c.kind === 'database'}<Icon name="database" size={13} />{/if}
          <span class="crumb-title">{c.title || (c.kind === 'database' ? t('common.untitledDatabase') : t('common.untitled'))}</span>
        </button>
      {/if}
    {/each}
  </nav>
    <button class="icon-btn new-tab" onclick={() => tabs.newTab()} aria-label={t('shell.newTab')} data-tip={t('shell.newTab')} data-tip-key={shortcuts.label('newTab')}>
      <Icon name="plus" size={15} />
    </button>
    <div class="spacer" data-tauri-drag-region></div>
  {/if}

  {#if page}
    <div class="actions">
      {#if live}
        <button class="live-chip" class:offline={live.status === 'offline'} class:alone={(live.status === 'live' && !together) || live.status === 'paused'} onclick={() => (ui.liveSheet = page.id)} data-tip={t('shell.titleBar.live.tip')}>
          <span class="live-dot"></span>
          {liveText}
        </button>
      {/if}
      <span class="status" data-tauri-drag-region>
        {store.saving ? t('shell.titleBar.saving') : status}
      </span>
      {#if deck}
        <button class="btn small study" onclick={() => cards.study([deck.pageId], page.title || t('common.untitled'))} data-tip={t('shell.titleBar.studyTip', { count: deck.count })}>
          <Icon name="cards" size={14} stroke={2} /> {t('shell.titleBar.study', { count: deck.due + deck.fresh })}
        </button>
      {/if}
      <button
        class="icon-btn"
        class:on={!!page.favorite}
        onclick={() => store.toggleFavorite(page.id)}
        data-tip={page.favorite ? t('shell.titleBar.removeFavorite') : t('shell.titleBar.addFavorite')}
      >
        <Icon name="star" size={15} stroke={page.favorite ? 1.6 : 1.9} filled={!!page.favorite} />
      </button>
      <button class="icon-btn" class:open={moreOpen} onclick={openMore} data-tip={t('common.actions.more')}>
        <Icon name="more" />
      </button>
    </div>
    <span class="divider"></span>
  {/if}
  <div class="app-tools">
    <button class="icon-btn" class:on={split.open} onclick={() => split.toggle()} data-tip={split.open ? t('shell.closeSplitView') : t('shell.splitView')} data-tip-key={shortcuts.label('split')} aria-label={t('shell.splitView')} aria-pressed={split.open}>
      <Icon name="split" size={15} />
    </button>
    <button class="icon-btn" onclick={cycleTheme} data-tip={themeTip} data-tip-key={shortcuts.label('theme')} aria-label={themeTip}>
      <Icon name={themeIcon} size={15} />
    </button>
    <button
      class="icon-btn trash"
      class:open={ui.trashOpen}
      class:armed={!!drag.id}
      class:target={trashHover}
      onclick={() => (ui.trashOpen = true)}
      ondragover={onTrashDragOver}
      ondragleave={() => (trashHover = false)}
      ondrop={onTrashDrop}
      data-tip={t('shell.titleBar.trashTip', { count: trashCount })}
      aria-label={t('common.views.trash')}
    >
      <Icon name="trash" />
      {#if trashCount}<span class="badge">{trashCount > 99 ? t('shell.titleBar.badgeOverflow', { max: 99 }) : fmt.number(trashCount)}</span>{/if}
    </button>
    <button class="icon-btn" class:open={ui.settingsOpen} onclick={() => (ui.settingsOpen = true)} data-tip={t('common.views.settings')} aria-label={t('common.views.settings')}>
      <Icon name="settings" />
    </button>
  </div>
  <span class="divider"></span>
  {#if !isMac}<WindowControls />{/if}
</header>

<style>
  /* With the sidebar hidden, the title bar holds the corner macOS draws its window buttons in. */
  .titlebar.bare {
    padding-left: var(--traffic-lights);
  }
  .titlebar {
    position: relative;
    height: var(--titlebar-h);
    display: flex;
    align-items: center;
    flex: none;
    user-select: none;
    background: var(--bg);
    z-index: 2;
  }
  /* A hairline appears once content scrolls underneath, like a macOS toolbar. */
  .titlebar::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: var(--separator);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
    pointer-events: none;
  }
  .titlebar.scrolled::after {
    opacity: 1;
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px 0 8px;
    flex: none;
  }
  .crumbs {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 0 1 auto;
    gap: 1px;
    overflow: hidden;
  }
  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    max-width: 220px;
    min-width: 0;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body-ui);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .crumb:hover {
    background: var(--fill);
    color: var(--text);
  }
  .crumb.current {
    color: var(--text);
    font-weight: var(--fw-550);
  }
  .view-crumb:hover {
    background: none;
  }
  .view-icon {
    display: grid;
    color: var(--tint);
  }
  .crumb-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .emoji {
    font-size: 14px;
    line-height: 1;
  }
  .sep {
    color: var(--text-4);
    display: grid;
    place-items: center;
    width: 12px;
  }
  .gap {
    color: var(--text-3);
    padding: 0 4px;
  }
  .spacer {
    flex: 1;
    align-self: stretch;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 8px;
  }
  .status {
    margin-right: 8px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  /* With tabs, their names matter more than "Edited just now". */
  @media (max-width: 1200px) {
    .tabbed .status {
      display: none;
    }
  }
  .live-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    margin-right: 8px;
    padding: 0 9px;
    border-radius: 12px;
    background: var(--fill);
    font-size: var(--fs-footnote);
    color: var(--text-2);
    white-space: nowrap;
  }
  .live-chip:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c-green);
  }
  .live-chip.alone .live-dot {
    background: var(--text-3);
  }
  .live-chip.offline .live-dot {
    background: var(--c-orange);
  }
  .study {
    gap: 6px;
    margin-right: 4px;
  }
  .icon-btn.on {
    color: var(--text);
  }
  .icon-btn.open {
    background: var(--fill-2);
    color: var(--text);
  }
  .app-tools {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    margin-right: 4px;
  }
  /* The Trash count sits on the can's shoulder, like a Dock badge. */
  .trash {
    position: relative;
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  /* A page is being dragged: Trash is a place to drop it. */
  .trash.armed {
    background: var(--fill);
    color: var(--text);
  }
  .trash.target {
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
    transform: scale(1.12);
  }
  .badge {
    position: absolute;
    top: -1px;
    right: -3px;
    min-width: 14px;
    height: 14px;
    padding: 0 4px;
    border-radius: 7px;
    background: var(--text-3);
    color: var(--bg);
    font-size: 9.5px;
    font-weight: var(--fw-600);
    line-height: 14px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 0 0 1.5px var(--bg);
    pointer-events: none;
  }
  .divider {
    flex: none;
    width: 1px;
    height: 16px;
    background: var(--separator-strong);
    margin: 0 4px 0 0;
  }
  @media (max-width: 880px) {
    .status {
      display: none;
    }
  }
</style>
