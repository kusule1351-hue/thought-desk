<script lang="ts">
  import Logo from './Logo.svelte';
  import PageIcon from './PageIcon.svelte';
  import Icon from './Icon.svelte';
  import TreeItem, { drag, pageDragImage } from './TreeItem.svelte';
  import { prefs } from '../prefs.svelte';
  import { shownInSidebar, sidebarItemMenu } from '../sidebar-items';
  import { tabs } from '../tabs.svelte';
  import { friends } from '../friends.svelte';
  import { cowork } from '../cowork.svelte';
  import { store, type AppView } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { planner } from '../planner.svelte';
  import { library } from '../library.svelte';
  import { cards } from '../cards.svelte';
  import { databases } from '../databases.svelte';
  import { pageMenuItems } from '../page-actions';
  import { itemsByDay } from '../calendar.svelte';
  import { clock } from '../clock.svelte';
  import { dueState } from '../dates';
  import { colorVar } from '../colors';
  import { comboKeys, shortcuts, type ShortcutId } from '../shortcuts.svelte';
  import { Progressive, sliceKeeping } from '../progressive.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  const MIN = 208;
  const MAX = 420;
  const DEFAULT = 252;

  let resizing = $state(false);
  let rootDrop = $state(false);

  // Thousands of top-level pages render as you scroll to them.
  const lazyRoots = new Progressive(100, 200);
  const roots = $derived(sliceKeeping(store.roots, lazyRoots.limit, (p) => store.openPath.has(p.id)));

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    resizing = true;
    const startX = e.clientX;
    const startW = prefs.sidebarWidth;
    const move = (ev: PointerEvent) => {
      prefs.sidebarWidth = Math.round(Math.min(MAX, Math.max(MIN, startW + ev.clientX - startX)));
    };
    const up = () => {
      resizing = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  function toggleSection(name: string) {
    prefs.sections[name] = !prefs.sections[name];
  }

  // Dropping below the tree moves a page to the end of the top level.
  function onRootDragOver(e: DragEvent) {
    if (!drag.id || drag.from) return;
    e.preventDefault();
    rootDrop = true;
  }

  function onRootDrop(e: DragEvent) {
    rootDrop = false;
    const id = drag.id;
    if (!id || drag.from) return;
    e.preventDefault();
    const count = store.roots.filter((p) => p.id !== id).length;
    void store.move(id, null, count);
  }

  const overdue = $derived(planner.dueSoon.some((a) => dueState(a, clock.today, clock.time) === 'overdue'));
  const todayEvents = $derived.by(() => {
    const d = itemsByDay(clock.today, clock.today).get(clock.today);
    return d ? d.allDay.length + d.timed.length : 0;
  });

  const nav: { view: AppView; label: string; icon: string; key: ShortcutId }[] = [
    { view: 'home', label: t('common.views.home'), icon: 'home', key: 'goHome' },
    { view: 'assignments', label: t('common.views.assignments'), icon: 'assignment', key: 'goAssignments' },
    { view: 'calendar', label: t('common.views.calendar'), icon: 'calendar', key: 'goCalendar' },
    { view: 'files', label: t('common.views.files'), icon: 'files', key: 'goFiles' },
    { view: 'cards', label: t('common.views.flashcards'), icon: 'cards', key: 'goCards' },
    { view: 'friends', label: t('common.views.friends'), icon: 'users', key: 'goFriends' },
    { view: 'galaxy', label: t('common.views.galaxy'), icon: 'galaxy', key: 'goGalaxy' },
  ];
  const shownNav = $derived(nav.filter((n) => shownInSidebar(n.view)));
  const searchKeys = $derived(shortcuts.combos('search')[0] ? comboKeys(shortcuts.combos('search')[0]).join(' ') : '');
  /** Friend requests and invites to write together, waiting for an answer. */
  const waiting = $derived(friends.incoming.length + cowork.incoming.length);
  const counts = $derived<Record<string, number>>({
    assignments: planner.dueSoon.length,
    calendar: todayEvents,
    files: library.live.length,
    cards: cards.dueCount,
    friends: waiting,
  });
  const countTips = $derived<Record<string, string>>({
    assignments: t(overdue ? 'shell.sidebar.dueSoonOverdue' : 'shell.sidebar.dueSoon', { count: planner.dueSoon.length }),
    calendar: t('shell.sidebar.eventsToday', { count: todayEvents }),
    files: t('shell.sidebar.fileCount', { count: library.live.length }),
    cards: t('shell.sidebar.cardsToStudy', { count: cards.dueCount }),
    friends: t('shell.sidebar.waiting', { count: waiting }),
  });
  /** A count at the end of a row: the locale's digits, no thousands separator (there's little room). */
  const badge = (n: number) => fmt.number(n, { useGrouping: false });


  /** Open assignments per course. */
  const courseOpen = $derived.by(() => {
    const map = new Map<string, number>();
    for (const a of planner.live) if (a.courseId && a.status !== 'done') map.set(a.courseId, (map.get(a.courseId) ?? 0) + 1);
    return map;
  });

  /** The database open, or the one whose row is open. */
  const openDb = $derived(store.current?.kind === 'database' ? store.current.id : databases.dbOf(store.currentId));
  let dbMenuFor = $state<string | null>(null);

  function dbMenu(e: MouseEvent, id: string, anchor?: Element) {
    e.preventDefault();
    e.stopPropagation();
    dbMenuFor = id;
    const items = pageMenuItems(id, { sidebar: true });
    const onClose = () => (dbMenuFor = null);
    if (anchor) ui.openMenuAt(anchor, items, { onClose });
    else ui.openMenu({ x: e.clientX, y: e.clientY, items, onClose });
  }

  async function addCourse() {
    const c = await planner.promptCourse();
    if (c) store.openCourse(c.id);
  }

  // Courses go in any order: dragged, or moved with their menu (which a keyboard reaches too).
  let courseDrag = $state<string | null>(null);
  let courseDrop = $state<{ id: string; after: boolean } | null>(null);

  function courseDragOver(e: DragEvent, id: string) {
    if (!courseDrag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    courseDrop = { id, after: e.clientY > r.top + r.height / 2 };
  }

  function courseDropped(e: DragEvent) {
    e.preventDefault();
    const [id, at] = [courseDrag, courseDrop];
    courseDrag = courseDrop = null;
    if (!id || !at || at.id === id) return;
    const i = planner.courses.filter((c) => c.id !== id).findIndex((c) => c.id === at.id);
    planner.moveCourse(id, i + (at.after ? 1 : 0));
  }

  function courseMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    const i = planner.courses.findIndex((c) => c.id === id);
    const items = [
      { label: t('shell.sidebar.moveCourseUp'), icon: 'arrow-up', disabled: i <= 0, action: () => planner.moveCourse(id, i - 1) },
      { label: t('shell.sidebar.moveCourseDown'), icon: 'arrow-down', disabled: i === planner.courses.length - 1, action: () => planner.moveCourse(id, i + 1) },
    ];
    // From the keyboard (the menu key) there's no pointer to open at.
    if (!e.clientX && !e.clientY) ui.openMenuAt(e.currentTarget as Element, items);
    else ui.openMenu({ x: e.clientX, y: e.clientY, items });
  }

</script>

<aside class="sidebar" class:resizing style:width="{prefs.sidebarWidth}px">
  <div class="head" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <Logo size={20} />
      <span data-tauri-drag-region>Thought Desk</span>
    </div>
    <div class="head-actions">
      <button class="icon-btn collapse" onclick={() => (prefs.sidebarOpen = false)} data-tip={t('shell.sidebar.hide')} data-tip-key={shortcuts.label('sidebar')}>
        <Icon name="sidebar-left" />
      </button>
      <button class="icon-btn" onclick={() => void store.create(null)} data-tip={t('shell.newPage')} data-tip-key={shortcuts.label('newPage')}>
        <Icon name="compose" />
      </button>
    </div>
  </div>

  <button class="search" onclick={() => (ui.searchOpen = true)}>
    <span class="lead search-icon"><Icon name="search" size={15} stroke={2} /></span>
    <span>{t('common.views.search')}</span>
    {#if searchKeys}<kbd>{searchKeys}</kbd>{/if}
  </button>

  {#if shownNav.length}
  <nav class="views" aria-label={t('shell.sidebar.views')}>
    {#each shownNav as n (n.view)}
      <div class="nav-row" class:active={store.view === n.view}>
        <button class="nav-main" onclick={(e) => (e.ctrlKey || e.metaKey ? tabs.open({ view: n.view, id: null }, { focus: false }) : store.go(n.view))} onmousedown={(e) => e.button === 1 && e.preventDefault()} onauxclick={(e) => e.button === 1 && (e.preventDefault(), tabs.open({ view: n.view, id: null }, { focus: false }))} oncontextmenu={(e) => sidebarItemMenu(e, n.view)} aria-current={store.view === n.view ? 'page' : undefined} data-tip={n.label} data-tip-key={shortcuts.label(n.key)}>
          <span class="lead tinted"><Icon name={n.icon} /></span>
          <span class="label">{n.label}</span>
        </button>
        {#if counts[n.view]}
          <span class="count" class:alert={n.view === 'assignments' && overdue} class:news={n.view === 'friends'} data-tip={countTips[n.view]}>{badge(counts[n.view])}</span>
        {/if}
      </div>
    {/each}
  </nav>
  {/if}

  <div class="scroll">
    {#if store.favorites.length && shownInSidebar('favorites')}
      <section>
        <div class="section-head">
          <button class="section-title" onclick={() => toggleSection('favorites')} oncontextmenu={(e) => sidebarItemMenu(e, 'favorites')} aria-expanded={!prefs.sections.favorites}>
            {t('shell.sidebar.sections.favorites')}
            <span class="caret" class:closed={prefs.sections.favorites}><Icon name="chevron-down" size={11} stroke={2.4} /></span>
          </button>
        </div>
        {#if !prefs.sections.favorites}
          <div role="tree" aria-label={t('shell.sidebar.sections.favorites')}>
            {#each store.favorites as p (p.id)}
              <TreeItem page={p} favorite />
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if planner.loaded && shownInSidebar('courses')}
      <section>
        <div class="section-head">
          <button class="section-title" onclick={() => toggleSection('courses')} oncontextmenu={(e) => sidebarItemMenu(e, 'courses')} aria-expanded={!prefs.sections.courses}>
            {t('shell.sidebar.sections.courses')}
            <span class="caret" class:closed={prefs.sections.courses}><Icon name="chevron-down" size={11} stroke={2.4} /></span>
          </button>
          <button class="section-add" onclick={addCourse} data-tip={t('shell.sidebar.newCourse')}><Icon name="plus" size={14} stroke={2} /></button>
        </div>
        {#if !prefs.sections.courses}
          <div class="tag-list" role="list">
            {#each planner.courses as c (c.id)}
              {@const open = courseOpen.get(c.id) ?? 0}
              <div
                class="nav-row"
                role="listitem"
                class:active={store.view === 'course' && store.courseId === c.id}
                class:dragging={courseDrag === c.id}
                class:drop-before={courseDrop?.id === c.id && !courseDrop.after}
                class:drop-after={courseDrop?.id === c.id && courseDrop.after}
                ondragover={(e) => courseDragOver(e, c.id)}
                ondrop={courseDropped}
              >
                <button
                  class="nav-main"
                  draggable="true"
                  onclick={() => store.openCourse(c.id)}
                  oncontextmenu={(e) => courseMenu(e, c.id)}
                  ondragstart={(e) => {
                    courseDrag = c.id;
                    if (e.dataTransfer) {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', c.name || t('common.untitled'));
                    }
                  }}
                  ondragend={() => (courseDrag = courseDrop = null)}
                >
                  <span class="lead"><span class="dot" style:--dot={colorVar(c.color)}></span></span>
                  <span class="label">{c.name || t('common.untitled')}</span>
                </button>
                {#if open}<span class="count" data-tip={t('shell.sidebar.openAssignments', { count: open })}>{badge(open)}</span>{/if}
              </div>
            {:else}
              <button class="row-btn muted" onclick={addCourse}>
                <span class="lead"><Icon name="plus" /></span>
                <span class="label">{t('shell.sidebar.addCourse')}</span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if databases.loaded && shownInSidebar('databases')}
      <section>
        <div class="section-head">
          <button class="section-title" onclick={() => toggleSection('databases')} oncontextmenu={(e) => sidebarItemMenu(e, 'databases')} aria-expanded={!prefs.sections.databases}>
            {t('shell.sidebar.sections.databases')}
            <span class="caret" class:closed={prefs.sections.databases}><Icon name="chevron-down" size={11} stroke={2.4} /></span>
          </button>
          <button class="section-add" onclick={() => (ui.newDatabase = { parentId: null })} data-tip={t('shell.sidebar.newDatabase')}><Icon name="plus" size={14} stroke={2} /></button>
        </div>
        {#if !prefs.sections.databases}
          <div class="tag-list">
            {#each databases.list as d (d.id)}
              {@const n = databases.rowCount(d.id)}
              <div class="nav-row db-row" class:active={openDb === d.id} class:menu-open={dbMenuFor === d.id}>
                <button
                  class="nav-main"
                  draggable="true"
                  onclick={() => store.open(d.id)}
                  onpointerenter={() => void databases.ensure([d.id])}
                  oncontextmenu={(e) => dbMenu(e, d.id)}
                  ondragstart={(e) => {
                    drag.id = d.id;
                    drag.from = undefined;
                    e.dataTransfer?.setData('text/plain', d.title || t('common.untitledDatabase'));
                    pageDragImage(e, d.title || t('common.untitledDatabase'), d.icon);
                  }}
                  ondragend={() => (drag.id = null)}
                >
                  <span class="lead">{#if d.icon}<span class="emoji"><PageIcon icon={d.icon} /></span>{:else}<Icon name="database" />{/if}</span>
                  <span class="label">{d.title || t('common.untitledDatabase')}</span>
                </button>
                <button class="row-more" onclick={(e) => dbMenu(e, d.id, e.currentTarget as Element)} aria-label={t('common.actions.more')} data-tip={t('common.actions.more')}><Icon name="more" size={15} /></button>
                {#if n}<span class="count" data-tip={t('shell.rowCount', { count: n })}>{badge(n)}</span>{/if}
              </div>
            {:else}
              <button class="row-btn muted" onclick={() => (ui.newDatabase = { parentId: null })}>
                <span class="lead"><Icon name="plus" /></span>
                <span class="label">{t('shell.sidebar.addDatabase')}</span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if tags.used.length && shownInSidebar('tags')}
      <section>
        <div class="section-head">
          <button class="section-title" onclick={() => toggleSection('tags')} oncontextmenu={(e) => sidebarItemMenu(e, 'tags')} aria-expanded={!prefs.sections.tags}>
            {t('common.tags')}
            <span class="caret" class:closed={prefs.sections.tags}><Icon name="chevron-down" size={11} stroke={2.4} /></span>
          </button>
        </div>
        {#if !prefs.sections.tags}
          <div class="tag-list">
            {#each tags.used as name (name)}
              <div class="nav-row" class:active={store.view === 'tag' && store.tag === name}>
                <button class="nav-main" onclick={() => store.openTag(name)}>
                  <span class="lead"><span class="dot" style:--dot={tags.color(name)}></span></span>
                  <span class="label">#{name}</span>
                </button>
                <span class="count">{badge(tags.counts.get(name) ?? 0)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    <section>
      <div class="section-head">
        <button class="section-title" onclick={() => toggleSection('pages')} aria-expanded={!prefs.sections.pages}>
          {t('shell.sidebar.sections.pages')}
          <span class="caret" class:closed={prefs.sections.pages}><Icon name="chevron-down" size={11} stroke={2.4} /></span>
        </button>
        <button class="section-add" onclick={() => void store.create(null)} data-tip={t('shell.newPage')}><Icon name="plus" size={14} stroke={2} /></button>
      </div>
      {#if !prefs.sections.pages}
        <div role="tree" aria-label={t('shell.sidebar.sections.pages')}>
          {#each roots as p (p.id)}
            <TreeItem page={p} />
          {/each}
          {#if roots.length < store.roots.length}<div {@attach lazyRoots.more}></div>{/if}
        </div>
        {#if store.loaded && store.roots.length === 0}
          <button class="row-btn muted" onclick={() => void store.create(null)}>
            <span class="lead"><Icon name="plus" /></span>
            <span class="label">{t('shell.sidebar.addPage')}</span>
          </button>
        {/if}
        <div
          class="root-drop"
          class:over={rootDrop}
          role="presentation"
          ondragover={onRootDragOver}
          ondragleave={() => (rootDrop = false)}
          ondrop={onRootDrop}
        ></div>
      {/if}
    </section>
  </div>

  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={startResize}
    ondblclick={() => (prefs.sidebarWidth = DEFAULT)}
   
  ></div>
</aside>

<style>
  .sidebar {
    position: relative;
    /* Above the page, so the resize handle's outer half can be grabbed. */
    z-index: 1;
    flex: none;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-sidebar);
    box-shadow: inset -1px 0 0 var(--separator);
    user-select: none;
  }
  .sidebar.resizing {
    cursor: col-resize;
  }

  /* Header: aligned to the title bar's height. */
  .head {
    height: var(--titlebar-h);
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* The logo sits in the rows' 20px icon column (16px in), the name on
       the label column, and the buttons line up with the rows' actions. */
    padding: 0 10px 0 calc(16px + var(--traffic-lights));
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-650);
    letter-spacing: -0.012em;
    color: var(--text);
  }
  .brand span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .brand :global(.logo) {
    flex: none;
    --logo-hands: var(--bg-sidebar);
  }
  .head-actions {
    display: flex;
    gap: 2px;
  }
  .collapse {
    opacity: 0;
    transition:
      opacity var(--dur) var(--ease),
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .sidebar:hover .collapse,
  .collapse:focus-visible {
    opacity: 1;
  }

  /* Search field */
  .search {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--h-md);
    margin: 0 8px 16px;
    padding: 0 6px 0 8px;
    border-radius: var(--r-sm);
    background: var(--fill);
    color: var(--text-3);
    font-size: var(--fs-body-ui);
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .search:hover {
    background: var(--fill-2);
  }
  .search > span:not(.lead) {
    flex: 1;
  }
  .search .search-icon {
    color: var(--text-3);
  }
  .search kbd {
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 0.5px 1px rgba(0, 0, 0, 0.06);
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 8px;
  }
  section + section {
    margin-top: 16px;
  }

  /* Section headers */
  .section-head {
    display: flex;
    align-items: center;
    height: var(--h-sm);
    padding: 0 12px 0 8px;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--h-xs);
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    letter-spacing: 0.01em;
    color: var(--text-3);
    transition: color var(--dur-fast) var(--ease);
  }
  .section-title:hover {
    color: var(--text-2);
  }
  .caret {
    display: grid;
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease),
      transform var(--dur) var(--ease-out);
  }
  .section-head:hover .caret,
  .caret.closed {
    opacity: 1;
  }
  .caret.closed {
    transform: rotate(-90deg);
  }
  .section-add {
    margin-left: auto;
    display: grid;
    place-items: center;
    width: var(--h-xs);
    height: var(--h-xs);
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .section-head:hover .section-add {
    opacity: 1;
  }
  .section-add:hover {
    background: var(--fill-2);
    color: var(--text);
  }

  /* Navigation rows share the tree rows' metrics: a 30px row
     inset 10px from the edges, a 20px icon slot, and trailing accessories
     that sit 4px from the right edge, like a tree row's actions. */
  .nav-row.dragging {
    opacity: 0.4;
  }
  /* Where a dragged course will go: a line above or below a row, as in the page tree. */
  .nav-row.drop-before,
  .nav-row.drop-after {
    position: relative;
  }
  .nav-row.drop-before::before,
  .nav-row.drop-after::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    border-radius: 2px;
    background: var(--text);
    pointer-events: none;
  }
  .nav-row.drop-before::before {
    top: -1px;
  }
  .nav-row.drop-after::after {
    bottom: -1px;
  }
  .nav-row {
    display: flex;
    align-items: center;
    height: var(--h-row);
    margin: 0 8px;
    border-radius: var(--r-sm);
    color: var(--text-sidebar);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .nav-row:hover {
    background: var(--fill);
  }
  .nav-row:has(.nav-main:active) {
    background: var(--fill-2);
  }
  .nav-row.active {
    background: var(--fill-2);
    color: var(--text);
    font-weight: var(--fw-550);
  }
  .nav-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body-ui);
    text-align: left;
  }
  .nav-main:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1.5px var(--focus);
  }
  .nav-row .count {
    margin-right: 12px;
  }
  .emoji {
    font-size: 15px;
    line-height: 1;
  }
  .row-more {
    display: none;
    place-items: center;
    width: var(--h-xs);
    height: var(--h-xs);
    margin-right: 4px;
    border-radius: var(--r-xs);
    color: var(--text-3);
  }
  .db-row:hover .row-more,
  .db-row.menu-open .row-more {
    display: grid;
  }
  .db-row:hover .count,
  .db-row.menu-open .count {
    display: none;
  }
  .row-more:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .db-row.menu-open {
    background: var(--fill);
  }
  .count.alert {
    color: var(--danger);
    font-weight: var(--fw-600);
  }
  .count.news {
    color: var(--accent);
    font-weight: var(--fw-600);
  }
  .views {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 16px;
  }
  .tinted {
    color: var(--tint);
  }
  .tag-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    /* Full width like every other row (it isn't always in a flex row). */
    width: calc(100% - 16px);
    min-width: 0;
    height: var(--h-row);
    margin: 0 8px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body-ui);
    color: var(--text-sidebar);
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .row-btn:hover {
    background: var(--fill);
  }
  .row-btn:active {
    background: var(--fill-2);
  }
  .row-btn.muted {
    color: var(--text-3);
  }
  .lead {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .root-drop {
    height: 24px;
    margin: 0 8px;
    border-radius: var(--r-sm);
  }
  .root-drop.over {
    box-shadow: inset 0 2px 0 var(--text);
  }

  /* Resize grip: invisible until hovered, then a 2px rule. */
  .resizer {
    position: absolute;
    top: 0;
    right: -4px;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
  }
  .resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: var(--separator-strong);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .resizer:hover::after,
  .resizing .resizer::after {
    opacity: 1;
    transition-delay: 80ms;
  }
</style>
