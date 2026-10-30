<script lang="ts">
  import { paneSize } from './lib/pane-size';
  import SplitDrop from './lib/components/SplitDrop.svelte';
  import Logo from './lib/components/Logo.svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { onMount } from 'svelte';
  import { warnIfFolderMissing } from './lib/data-folder';
  import { t } from './lib/i18n';
  import { tabs } from './lib/tabs.svelte';
  import { api } from './lib/api';
  import { cssToRgb } from './lib/color-math';
  import { sidebarSlide } from './lib/motion';
  import { shortcuts, toAccelerator, type ShortcutId } from './lib/shortcuts.svelte';
  import { prefs } from './lib/prefs.svelte';
  import { store } from './lib/store.svelte';
  import { planner } from './lib/planner.svelte';
  import { library } from './lib/library.svelte';
  import { tags } from './lib/tags.svelte';
  import './lib/reminders.svelte';
  import { listen } from '@tauri-apps/api/event';
  import { ui } from './lib/ui.svelte';
  import type { Page } from './lib/types';
  import Sidebar from './lib/components/Sidebar.svelte';
  import TitleBar from './lib/components/TitleBar.svelte';
  import PageView from './lib/components/PageView.svelte';
  import SearchPalette from './lib/components/SearchPalette.svelte';
  import SettingsModal from './lib/components/SettingsModal.svelte';
  import ShortcutsHelp from './lib/components/ShortcutsHelp.svelte';
  import Welcome from './lib/components/Welcome.svelte';
  import SplitPane from './lib/components/SplitPane.svelte';
  import { split } from './lib/split.svelte';
  import { zoomIn, zoomOut, zoomReset } from './lib/zoom.svelte';
  import { changeLook } from './lib/look-transition';
  import TrashModal from './lib/components/TrashModal.svelte';
  import Menu from './lib/components/Menu.svelte';
  import IconPicker from './lib/components/IconPicker.svelte';
  import ConfirmDialog from './lib/components/ConfirmDialog.svelte';
  import LiveSheet from './lib/components/LiveSheet.svelte';
  import InviteSheet from './lib/components/InviteSheet.svelte';
  import AccountSheet from './lib/components/AccountSheet.svelte';
  import { account } from './lib/account.svelte';
  import { friends } from './lib/friends.svelte';
  import { cowork } from './lib/cowork.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import Icon from './lib/components/Icon.svelte';
  import Tooltip from './lib/components/Tooltip.svelte';
  import FilePicker from './lib/components/FilePicker.svelte';
  import TagPicker from './lib/components/TagPicker.svelte';
  import HomeView from './lib/views/HomeView.svelte';
  import TagView from './lib/views/TagView.svelte';
  import CourseView from './lib/views/CourseView.svelte';
  import CaptureSheet from './lib/sheets/CaptureSheet.svelte';
  import AssignmentsView from './lib/views/AssignmentsView.svelte';
  import CalendarView from './lib/views/CalendarView.svelte';
  import FilesView from './lib/views/FilesView.svelte';
  import AssignmentSheet from './lib/sheets/AssignmentSheet.svelte';
  import EventSheet from './lib/sheets/EventSheet.svelte';
  import FilePreview from './lib/sheets/FilePreview.svelte';
  import ImportSheet from './lib/sheets/ImportSheet.svelte';
  import StudySheet from './lib/sheets/StudySheet.svelte';
  import FlashcardsView from './lib/views/FlashcardsView.svelte';
  import FriendsView from './lib/views/FriendsView.svelte';
  import GalaxyView from './lib/views/GalaxyView.svelte';
  import GalaxyIntro from './lib/views/GalaxyIntro.svelte';
  import { cards } from './lib/cards.svelte';
  import { databases } from './lib/databases.svelte';
  import DatabaseView from './lib/db/DatabaseView.svelte';
  import FormulaEditor from './lib/db/FormulaEditor.svelte';
  import NewDatabaseSheet from './lib/db/NewDatabaseSheet.svelte';

  const win = getCurrentWindow();
  const webviewWin = getCurrentWebviewWindow();

  let page = $state<Page | null>(null);
  let words = $state(0);
  let scroller = $state<HTMLDivElement>();
  let scrolled = $state(false);

  // Match the native window (border, shadow, resize backdrop) to the theme so
  // nothing flashes white while resizing in dark mode.
  $effect(() => {
    const dark = prefs.resolvedTheme === 'dark';
    void prefs.palette;
    void prefs.customTheme.hue;
    void prefs.customTheme.tint;
    void win.setTheme(dark ? 'dark' : 'light').catch(() => {});
    // Read the theme's background once the new attributes are applied (the
    // body's resolved colour, which works for hex and oklch() themes alike).
    requestAnimationFrame(() => {
      const rgb = cssToRgb(getComputedStyle(document.body).backgroundColor) ?? (dark ? [0, 0, 0] : [1, 1, 1]);
      const [r, g, b] = rgb.map((v) => Math.round(v * 255));
      void webviewWin.setBackgroundColor([r, g, b, 255]).catch(() => {});
    });
  });

  // The system-wide Quick Capture shortcut follows its setting and its keys.
  $effect(() => {
    const combo = shortcuts.combos('capture')[0];
    const on = prefs.globalCapture && !!combo;
    api.setCaptureShortcut(on, combo ? toAccelerator(combo) : '').catch((e) => {
      if (!on) return;
      ui.error(e);
      prefs.globalCapture = false;
    });
  });

  /** What each app-wide shortcut does (the calendar's own are in its view). */
  const ACTIONS: Partial<Record<ShortcutId, () => void>> = {
    search: () => (ui.searchOpen = !ui.searchOpen),
    newPage: () => void store.create(null),
    capture: () => {
      if (!ui.capture) ui.capture = { text: '' };
    },
    sidebar: () => (prefs.sidebarOpen = !prefs.sidebarOpen),
    theme: () => changeLook(() => prefs.toggleTheme(), 'keyboard'),
    settings: () => (ui.settingsOpen = true),
    help: () => (ui.shortcutsHelp = !ui.shortcutsHelp),
    split: () => split.toggle(),
    back: () => store.back(),
    forward: () => store.forward(),
    newTab: () => tabs.newTab(),
    closeTab: () => tabs.close(tabs.activeId),
    nextTab: () => tabs.step(1),
    prevTab: () => tabs.step(-1),
    goHome: () => store.go('home'),
    goAssignments: () => store.go('assignments'),
    goCalendar: () => store.go('calendar'),
    goFiles: () => store.go('files'),
    goCards: () => store.go('cards'),
    goFriends: () => store.go('friends'),
    goGalaxy: () => store.go('galaxy'),
    zoomIn,
    zoomOut,
    zoomReset,
  };
  const ACTION_IDS = Object.keys(ACTIONS) as ShortcutId[];

  // Each view starts at the top.
  $effect(() => {
    void store.view;
    void store.courseId;
    void store.tag;
    if (scroller) scroller.scrollTop = 0;
    scrolled = false;
  });

  // Split view: hidden while the window is too narrow for two pages.
  let panesWidth = $state(0);
  let resizing = $state(false);
  /** The side being worked in, marked so it's clear where typing goes. */
  let activePane = $state<'main' | 'side'>('main');
  const showSplit = $derived(split.open && panesWidth >= 720);
  // While a page is dragged over the page area, the layout shows what a drop
  // would do: the page slides aside to open a slot on the right.
  const previewing = $derived(!showSplit && !!split.preview);
  const makeRoom = $derived(!showSplit && split.preview === 'side' ? Math.round((panesWidth - 20) * split.ratio) + 20 : 0);

  function startResize(e: PointerEvent) {
    const divider = e.currentTarget as HTMLElement;
    const box = divider.parentElement!.getBoundingClientRect();
    divider.setPointerCapture(e.pointerId);
    resizing = true;
    const move = (ev: PointerEvent) => (split.ratio = (box.right - ev.clientX) / box.width);
    const up = () => {
      resizing = false;
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  }

  /** The side pane slides in from the right edge. */
  function splitIn(node: HTMLElement) {
    const w = node.getBoundingClientRect().width;
    return { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260, css: (p: number) => `opacity:${p}; margin-right:${-(1 - p) * w * 0.35}px` };
  }
  function splitOut(_node: Element) {
    return { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160, css: (p: number) => `opacity:${p}` };
  }

  /** Saves everything that's waiting to be written. */
  const flushAll = () => Promise.all([store.flush(), planner.flush(), databases.flush()]);

  // A new language (Settings) restarts the window once everything is saved:
  // the whole interface is then drawn in it from the start (lib/i18n).
  onMount(() => {
    const reload = async () => {
      window.dispatchEvent(new Event('td:flush'));
      await flushAll().catch(() => {});
      location.reload();
    };
    window.addEventListener('td:reload', reload);
    return () => window.removeEventListener('td:reload', reload);
  });

  // Only the kind: `store.current` is a new object on every edit (a title
  // keystroke, a save's new timestamp), which mustn't reload the page.
  const currentKind = $derived(store.current?.kind);
  // Sharing a page (or stopping) reloads it: its editor works differently.
  const currentRoom = $derived(store.current?.sharedRoom ?? null);

  // Load the full page (with content) whenever the selection changes.
  $effect(() => {
    const id = store.currentId;
    void currentRoom;
    // A database shows its rows, not a body.
    if (!id || currentKind === 'database') {
      page = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Make sure the page we're leaving (or returning to) is saved first.
        await store.flush();
        const full = await api.getPage(id);
        if (cancelled) return;
        page = full;
        if (scroller) scroller.scrollTop = 0;
        scrolled = false;
      } catch (e) {
        if (!cancelled) ui.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  onMount(() => {
    let unlistenClose: (() => void) | undefined;
    let unlistenCapture: (() => void) | undefined;
    void (async () => {
      try {
        // Pages decide where to start, so the planner and files load alongside.
        await Promise.all([planner.load(), library.load(), tags.load(), databases.load(), store.load()]);
        tabs.init();
        void account.init();
        friends.init();
        cowork.init();
        void cards.load();
        void warnIfFolderMissing();
      } catch (e) {
        ui.error(e);
      }
      // Show the window only once the first frame is painted (no white flash),
      // with a timer as a fallback in case frames are throttled while hidden.
      let shown = false;
      const show = () => {
        if (shown) return;
        shown = true;
        void win.show().then(() => win.setFocus());
      };
      requestAnimationFrame(() => requestAnimationFrame(show));
      setTimeout(show, 500);
      // Minimizing hides and suspends the webview; save everything first.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flushAll();
      });
      // Quick Capture from anywhere (the Rust side shows the window first).
      unlistenCapture = await listen('td-quick-capture', () => {
        if (!ui.capture) ui.capture = { text: '' };
      }).catch(() => undefined);
      unlistenClose = await win.onCloseRequested(async () => {
        window.dispatchEvent(new Event('td:flush'));
        await flushAll();
      });
    })();
    return () => {
      unlistenClose?.();
      unlistenCapture?.();
    };
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    // Zoom works everywhere, the welcome screen too: that's where someone
    // who needs bigger text first does.
    const z = shortcuts.match(e, ['zoomIn', 'zoomOut', 'zoomReset']);
    if (z) {
      e.preventDefault();
      ACTIONS[z]!();
      return;
    }
    // The welcome screen covers everything; the app's other shortcuts wait for it.
    if (!prefs.welcomed) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Shortcuts (Settings → Keyboard). Quick Capture's is also caught
    // system-wide when that's on; inside the app it always works.
    const action = shortcuts.match(e, ACTION_IDS);
    if (action) {
      e.preventDefault();
      ACTIONS[action]!();
    } else if (mod && key === 'z' && databaseUndo(e)) {
      e.preventDefault();
      if (e.shiftKey) void databases.redo();
      else void databases.undo();
    } else if (mod && key === 'y' && databaseUndo(e)) {
      e.preventDefault();
      void databases.redo();
    } else if (mod && key === 's') {
      // Everything autosaves; just flush now instead of "Save page as…".
      e.preventDefault();
      window.dispatchEvent(new Event('td:flush'));
      void flushAll();
    } else if (mod && !e.shiftKey && (key === 'o' || key === 'j')) {
      // Browser shortcuts (open file, downloads) that make no sense here.
      e.preventDefault();
    } else if (import.meta.env.PROD && (e.key === 'F5' || (mod && key === 'r'))) {
      // A reload would only interrupt typing; data is already saved.
      e.preventDefault();
    }
  }

  /** Ctrl+Z belongs to databases when focus is in one (not in a text box)
   * or nowhere in particular on a database page. */
  function databaseUndo(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return false;
    if (ui.anyModalOpen) return false;
    return !!el.closest('.dbv') || (el === document.body && store.current?.kind === 'database');
  }

  // Mouse back/forward buttons.
  function onMouseUp(e: MouseEvent) {
    if (e.button === 3) {
      e.preventDefault();
      store.back();
    } else if (e.button === 4) {
      e.preventDefault();
      store.forward();
    }
  }

  // Files dropped where nothing else takes them go to the library, instead
  // of the webview navigating away to show the file.
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  function onDragOver(e: DragEvent) {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
  }
  async function onDrop(e: DragEvent) {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const added = await library.add(Array.from(e.dataTransfer?.files ?? []));
    if (added.length) {
      ui.toast(t('app.filesAdded', { count: added.length, name: added[0].name }), {
        label: t('common.actions.show'),
        run: () => (added.length === 1 ? library.preview(added[0].id) : store.go('files')),
      });
    }
  }

  // Only editable areas get the native context menu (spelling, copy/paste).
  function onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} onmouseup={onMouseUp} oncontextmenu={onContextMenu} ondragover={onDragOver} ondrop={onDrop} />

<div class="app">
  {#if prefs.sidebarOpen}
    <div class="sidebar-slot" in:sidebarSlide={{ duration: 280 }} out:sidebarSlide={{ duration: 220 }}>
      <Sidebar />
    </div>
  {/if}
  <main class="main" class:split={showSplit || previewing}>
    <TitleBar {words} {scrolled} />
    <div class="panes" class:split={showSplit || previewing} style:padding-right={makeRoom ? `${makeRoom}px` : null} bind:clientWidth={panesWidth}>
    <!-- Clicking or focusing a side marks it as the one in use (not an action). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="scroller" class:active={showSplit && activePane === 'main'} class:fill={store.view === 'galaxy' && prefs.galaxyOn} class:targeted={split.preview === 'main'} onfocusin={() => (activePane = 'main')} onpointerdown={() => (activePane = 'main')} data-nav={store.navDirection} bind:this={scroller} use:paneSize onscroll={() => (scrolled = (scroller?.scrollTop ?? 0) > 2)}>
      {#if store.view === 'home'}
        {#if planner.loaded && library.loaded}<HomeView />{/if}
      {:else if store.view === 'tag' && store.tag}
        {#key store.tag}<TagView name={store.tag} />{/key}
      {:else if store.view === 'course' && store.courseId}
        {#if planner.loaded && library.loaded}
          {#key store.courseId}<CourseView id={store.courseId} />{/key}
        {/if}
      {:else if store.view === 'assignments'}
        {#if planner.loaded}<AssignmentsView />{/if}
      {:else if store.view === 'calendar'}
        {#if planner.loaded}<CalendarView />{/if}
      {:else if store.view === 'files'}
        {#if library.loaded}<FilesView />{/if}
      {:else if store.view === 'cards'}
        <FlashcardsView />
      {:else if store.view === 'friends'}
        <FriendsView />
      {:else if store.view === 'galaxy'}
        {#if !prefs.galaxyOn}<GalaxyIntro />{:else if planner.loaded}<GalaxyView />{/if}
      {:else if store.view === 'page' && store.current?.kind === 'database'}
        {#if databases.loaded}
          {#key store.currentId}<DatabaseView id={store.current.id} />{/key}
        {/if}
      {:else if page && store.currentId === page.id}
        {#key `${page.id}:${page.sharedRoom ?? ''}:${cowork.isLive(page.id)}`}
          <PageView {page} onstats={(w) => (words = w)} />
        {/key}
      {:else if store.loaded && !store.currentId}
        <div class="empty">
          <Logo size={48} class="empty-logo" />
          <h2>{t('app.empty.title')}</h2>
          <p>{t('app.empty.body')}</p>
          <button class="btn primary" onclick={() => void store.create(null)}>
            <Icon name="plus" size={15} stroke={2.2} /> {t('app.empty.newPage')}
          </button>
        </div>
      {/if}
    </div>
    {#if showSplit}
      <!-- A focusable separator is a resize control (arrow keys move it). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="divider"
        class:dragging={resizing}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('app.resizeSplit')}
        aria-valuenow={Math.round((1 - split.ratio) * 100)}
        tabindex="0"
        onpointerdown={startResize}
        ondblclick={() => (split.ratio = 0.5)}
        onkeydown={(e) => {
          if (e.key === 'ArrowLeft') split.ratio += 0.02;
          else if (e.key === 'ArrowRight') split.ratio -= 0.02;
        }}
      ><span class="grip"></span></div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="side" class:active={activePane === 'side'} class:targeted={split.preview === 'side'} onfocusin={() => (activePane = 'side')} onpointerdown={() => (activePane = 'side')} style:width="{split.ratio * 100}%" in:splitIn out:splitOut>
        <SplitPane />
      </div>
    {/if}
    <SplitDrop tiled={showSplit} narrow={panesWidth < 720} />
    </div>
  </main>
</div>

{#if !prefs.welcomed}<Welcome />{/if}
{#if ui.searchOpen}<SearchPalette />{/if}
{#if ui.settingsOpen}<SettingsModal />{/if}
{#if ui.shortcutsHelp}<ShortcutsHelp />{/if}
{#if ui.trashOpen}<TrashModal />{/if}
{#if ui.menu}
  {#key ui.menu}<Menu menu={ui.menu} />{/key}
{/if}
{#if ui.iconPicker}
  {#key ui.iconPicker}<IconPicker picker={ui.iconPicker} />{/key}
{/if}
{#if ui.assignmentSheet}
  {#key ui.assignmentSheet}<AssignmentSheet sheet={ui.assignmentSheet} />{/key}
{/if}
{#if ui.eventSheet}
  {#key ui.eventSheet}<EventSheet sheet={ui.eventSheet} />{/key}
{/if}
{#if ui.filePreview}
  {#key ui.filePreview}<FilePreview id={ui.filePreview} />{/key}
{/if}
{#if ui.study}
  {#key ui.study}<StudySheet title={ui.study.title} deck={ui.study.cards} />{/key}
{/if}
{#if ui.liveSheet}<LiveSheet pageId={ui.liveSheet} />{/if}
{#if ui.inviteSheet}<InviteSheet pageId={ui.inviteSheet} />{/if}
{#if ui.accountSheet}<AccountSheet />{/if}
{#if ui.newDatabase}<NewDatabaseSheet parentId={ui.newDatabase.parentId} onCreated={ui.newDatabase.onCreated} />{/if}
{#if ui.formula}
  {@const f = ui.formula}
  {@const fp = databases.prop(f.dbId, f.propId)}
  {#if fp}<FormulaEditor dbId={f.dbId} prop={fp} onclose={() => (ui.formula = null)} />{/if}
{/if}
{#if ui.importSheet}
  {#key ui.importSheet}<ImportSheet name={ui.importSheet.name} items={ui.importSheet.items} />{/key}
{/if}
{#if ui.tagPicker}
  {#key ui.tagPicker}<TagPicker picker={ui.tagPicker} />{/key}
{/if}
{#if ui.capture}<CaptureSheet start={ui.capture.text} />{/if}
{#if ui.filePicker}
  {#key ui.filePicker}<FilePicker picker={ui.filePicker} />{/key}
{/if}
{#if ui.confirmState}<ConfirmDialog dialog={ui.confirmState} />{/if}
<Toasts />
<Tooltip />

<style>
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  /* A page or view arriving: it fades in and settles, rising for a new
     place, or drifting in from the side it came from on Back and Forward.
     "backwards" fill only: no transform lingers once it has arrived (which
     would misplace fixed-position menus inside it). */
  .scroller > :global(*) {
    animation: route-in 280ms var(--ease-out) backwards;
  }
  .scroller[data-nav='back'] > :global(*) {
    animation-name: route-back;
  }
  .scroller[data-nav='forward'] > :global(*) {
    animation-name: route-forward;
  }
  .scroller[data-nav='tab'] > :global(*) {
    animation: route-tab 160ms var(--ease-out) backwards;
  }
  @keyframes route-tab {
    from {
      opacity: 0;
    }
  }
  @keyframes route-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @keyframes route-back {
    from {
      opacity: 0;
      transform: translateX(-12px);
    }
  }
  @keyframes route-forward {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scroller > :global(*) {
      animation: none;
    }
  }
  /* While sliding (only then), the slot clips the panel and the panel
     rides the edge; at rest the resize handle may reach past it. */
  .sidebar-slot {
    flex: none;
    display: flex;
    height: 100%;
  }
  .sidebar-slot > :global(.sidebar) {
    transform: translateX(var(--slide, 0px));
    opacity: var(--slide-fade, 1);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .panes {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .scroller {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
  }
  /* A view that fills the pane edge to edge (the Galaxy's sky) has nothing to scroll. */
  .scroller.fill {
    overflow: hidden;
    scrollbar-gutter: auto;
  }
  /* Split view, after tiling window managers: each side is a rounded card
     on the sidebar's colour, the gap between them is the divider, and the
     side in use has a firmer edge. */
  .main {
    transition: background-color var(--dur) var(--ease);
  }
  .main.split {
    background: var(--bg-sidebar);
  }
  .main.split :global(.titlebar) {
    background: transparent;
  }
  .main.split :global(.titlebar.scrolled::after) {
    opacity: 0;
  }
  .panes {
    position: relative;
    transition: padding 320ms cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .panes.split {
    padding: 2px 10px 10px;
  }
  .panes.split .scroller,
  .side {
    border-radius: var(--r-lg);
    background: var(--bg);
    box-shadow: 0 0 0 1px var(--hairline);
    transition:
      box-shadow var(--dur) var(--ease),
      transform 260ms cubic-bezier(0.22, 0.8, 0.24, 1),
      border-radius var(--dur) var(--ease);
  }
  /* The card a drop would replace eases back a little. */
  .panes.split .scroller.targeted,
  .side.targeted {
    transform: scale(0.985);
  }
  /* The side in use: a slightly firmer edge and a soft lift, not a bright line. */
  .panes.split .scroller.active,
  .side.active {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--text) 16%, transparent),
      0 8px 24px -16px rgb(0 0 0 / 0.28);
  }
  .side {
    position: relative;
    flex: none;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .side > :global(.pane) {
    flex: 1;
  }
  /* The gap is the divider: grab anywhere in it; a handle shows on hover. */
  .divider {
    position: relative;
    flex: none;
    width: 10px;
    cursor: col-resize;
    outline: none;
  }
  .grip {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 4px;
    height: 36px;
    border-radius: 2px;
    background: var(--hairline);
    transform: translate(-50%, -50%);
    transition:
      background-color var(--dur-fast) var(--ease),
      height var(--dur-fast) var(--ease);
    pointer-events: none;
  }
  .divider:hover .grip,
  .divider:focus-visible .grip,
  .divider.dragging .grip {
    height: 56px;
    background: var(--accent);
  }
  .empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 32px 12vh;
    text-align: center;
  }
  .empty :global(.empty-logo) {
    margin-bottom: 20px;
  }
  .empty h2 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: var(--fw-650);
    letter-spacing: -0.018em;
  }
  .empty p {
    margin: 0 0 22px;
    max-width: 300px;
    font-size: var(--fs-callout);
    line-height: 1.5;
    color: var(--text-2);
    text-wrap: balance;
  }
</style>
