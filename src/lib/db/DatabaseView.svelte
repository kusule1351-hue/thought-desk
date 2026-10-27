<script lang="ts">
  /**
   * A database: its title and description, its views as tabs, a toolbar to
   * search, filter, sort and set up the view, and the view itself. Shown as
   * a page of its own, or inside another page (embedded: a smaller header,
   * and the view choice belongs to the block).
   */
  import PageIcon from '../components/PageIcon.svelte';
  import { tick, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Popover from './Popover.svelte';
  import TableView from './TableView.svelte';
  import BoardView from './BoardView.svelte';
  import GalleryView from './GalleryView.svelte';
  import ListView from './ListView.svelte';
  import CalendarView from './CalendarView.svelte';
  import ChartView from './ChartView.svelte';
  import TimelineView from './TimelineView.svelte';
  import FormView from './FormView.svelte';
  import TemplatesPanel from './TemplatesPanel.svelte';
  import AutomationsPanel from './AutomationsPanel.svelte';
  import FilterPanel from './FilterPanel.svelte';
  import SortPanel from './SortPanel.svelte';
  import ViewSettings from './ViewSettings.svelte';
  import { databases, VIEW_NAMES } from '../databases.svelte';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { randomIcon } from '../page-icon';
  import { OPS, ruleActive, ruleText } from './query';
  import { option } from './schema';
  import type { DbView, FilterRule, Property, ViewType } from '../types';
  import { t, type TextKey } from '../i18n';
  type Label = TextKey;

  let {
    id,
    embedded = false,
    viewId = null,
    onview,
  }: {
    id: string;
    embedded?: boolean;
    /** The view to show (embedded blocks keep their own). */
    viewId?: string | null;
    onview?: (viewId: string) => void;
  } = $props();

  const meta = $derived(store.byId.get(id));
  const schema = $derived(databases.schemas[id]);
  const views = $derived(databases.views(id));
  const chosen = $derived(embedded ? viewId : prefs.dbViews[id]);
  const view = $derived(views.find((v) => v.id === chosen) ?? views[0]);
  let search = $state('');
  let searching = $state(false);
  const result = $derived(view ? databases.query(id, view, search) : { rows: [], groups: null });
  const total = $derived(databases.rowCount(id));
  // Its rows are read the first time it's shown.
  const ready = $derived(databases.ready(id));
  $effect(() => {
    if (!ready) void databases.ensure([id]);
  });
  $effect(() => databases.showing(id));
  // The last few opened full-size are read in the background next time.
  $effect(() => {
    if (embedded) return;
    const db = id;
    untrack(() => {
      prefs.recentDbs = [db, ...prefs.recentDbs.filter((x) => x !== db)].slice(0, 3);
    });
  });

  function show(v: DbView | string) {
    const vid = typeof v === 'string' ? v : v.id;
    if (embedded) onview?.(vid);
    else prefs.dbViews[id] = vid;
  }

  // ------------------------------------------------------------- header

  let titleEl = $state<HTMLHeadingElement>();
  let descEl = $state<HTMLParagraphElement>();

  // Fill the title and description as soon as they're on screen (a fresh
  // copy's schema arrives just after its page), and follow changes made
  // elsewhere, but never while they're being typed here.
  $effect(() => {
    const text = meta?.title ?? '';
    if (titleEl && document.activeElement !== titleEl && titleEl.textContent !== text) titleEl.textContent = text;
  });
  $effect(() => {
    const text = schema?.description ?? '';
    if (descEl && document.activeElement !== descEl && descEl.textContent !== text) descEl.textContent = text;
  });

  $effect(() => {
    if (ui.focusTitle !== id || !titleEl) return;
    ui.focusTitle = null;
    void tick().then(() => {
      titleEl?.focus();
      const sel = window.getSelection();
      if (titleEl) sel?.selectAllChildren(titleEl);
      if (!titleEl?.textContent) sel?.collapseToEnd();
    });
  });

  function onTitleInput() {
    if (!titleEl) return;
    if (titleEl.textContent === '' && titleEl.innerHTML !== '') titleEl.innerHTML = '';
    store.update(id, { title: (titleEl.textContent ?? '').replace(/\s+/g, ' ') });
  }

  function pickIcon(e: MouseEvent) {
    ui.pickIcon(
      e.currentTarget as Element,
      (emoji) => store.update(id, { icon: emoji }, { immediate: true }),
      () => store.update(id, { icon: '' }, { immediate: true }),
      store.byId.get(id)?.icon,
    );
  }

  // -------------------------------------------------------------- popovers

  type PanelKind = 'filter' | 'sort' | 'settings' | 'templates' | 'automations';
  let panel = $state<{ kind: PanelKind; anchor: Element } | null>(null);
  let filterBtn = $state<HTMLButtonElement>();
  let settingsBtn = $state<HTMLButtonElement>();
  let table = $state<{ addRow: (template?: string) => Promise<void> }>();
  const activeRules = $derived(databases.automations(id).filter((a) => !a.config.off).length);
  const templateCount = $derived(databases.templatesOf(id).length);

  const activeFilters = $derived((view?.config.filters ?? []).filter((r) => ruleActive(r, databases.prop(id, r.prop), databases.ctx(id))));
  const sorts = $derived((view?.config.sorts ?? []).filter((s) => databases.prop(id, s.prop)));

  async function filterOn(p: Property) {
    if (!view) return;
    const kind = databases.kind(id, p);
    const rule: FilterRule = { id: crypto.randomUUID().slice(0, 8), prop: p.id, op: OPS[kind][0].op };
    databases.updateView(id, view.id, { filters: [...(view.config.filters ?? []), rule] });
    await tick();
    if (filterBtn) panel = { kind: 'filter', anchor: filterBtn };
  }

  function openSettings() {
    if (settingsBtn) panel = { kind: 'settings', anchor: settingsBtn };
  }

  /** "Status is Done, Doing", "Due is before today"… for the chips (worded by query.ts, beside the filters' labels). */
  function describe(r: FilterRule): string {
    const p = databases.prop(id, r.prop);
    if (!p) return '';
    const names = Array.isArray(r.value)
      ? (r.value as string[]).map((k) => (p.type === 'select' || p.type === 'status' || p.type === 'multiSelect' ? (option(p, k)?.name ?? '') : databases.labelFor(p, k)))
      : [];
    return ruleText(p.name, databases.kind(id, p), r, names);
  }

  // ------------------------------------------------------------------ tabs

  function addViewMenu(e: MouseEvent) {
    const types: { type: ViewType; icon: string; hint: Label }[] = [
      { type: 'table', icon: 'table', hint: 'dbTable.layoutHint.table' },
      { type: 'board', icon: 'board', hint: 'dbTable.addViewHint.board' },
      { type: 'gallery', icon: 'grid', hint: 'dbTable.addViewHint.gallery' },
      { type: 'list', icon: 'list', hint: 'dbTable.addViewHint.list' },
      { type: 'calendar', icon: 'calendar', hint: 'dbTable.layoutHint.calendar' },
      { type: 'chart', icon: 'chart', hint: 'dbTable.layoutHint.chart' },
      { type: 'timeline', icon: 'timeline', hint: 'dbTable.layoutHint.timeline' },
      { type: 'form', icon: 'form', hint: 'dbTable.layoutHint.form' },
    ];
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { header: t('dbTable.addView') },
        ...types.map((layout) => ({
          label: VIEW_NAMES[layout.type],
          icon: layout.icon,
          hint: t(layout.hint),
          action: async () => {
            const v = await databases.addView(id, layout.type);
            if (v) show(v);
          },
        })),
      ],
    );
  }

  function tabMenu(e: MouseEvent, v: DbView) {
    e.preventDefault();
    const i = views.indexOf(v);
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t('dbTable.tabMenu.settings'),
          icon: 'sliders',
          action: () => {
            show(v);
            void tick().then(openSettings);
          },
        },
        {
          label: t('common.actions.duplicate'),
          icon: 'copy',
          action: async () => {
            const copy = await databases.duplicateView(id, v.id);
            if (copy) show(copy);
          },
        },
        { label: t('dbTable.tabMenu.moveLeft'), icon: 'arrow-left', disabled: i === 0, action: () => databases.moveView(id, v.id, i - 1) },
        { label: t('dbTable.tabMenu.moveRight'), icon: 'arrow-right', disabled: i === views.length - 1, action: () => databases.moveView(id, v.id, i + 1) },
        { separator: true },
        { label: t('dbTable.deleteView'), icon: 'trash', danger: true, disabled: views.length < 2, action: () => void databases.deleteView(id, v.id) },
      ],
    });
  }

  /** The popovers' names for screen readers. */
  const PANEL_LABELS: Record<PanelKind, Label> = {
    filter: 'dbTable.panel.filter',
    sort: 'dbTable.panel.sort',
    settings: 'dbTable.panel.settings',
    templates: 'dbTable.panel.templates',
    automations: 'dbTable.panel.automations',
  };

  const ICONS: Record<ViewType, string> = {
    table: 'table',
    board: 'board',
    gallery: 'grid',
    list: 'list',
    calendar: 'calendar',
    chart: 'chart',
    timeline: 'timeline',
    form: 'form',
  };

  /** Adds a row (from `template`, or the view's default) where the view shows it. */
  async function addRow(template?: string) {
    if (!view) return;
    panel = null;
    if (view.type === 'table' && table) {
      await table.addRow(template);
      return;
    }
    const row = await databases.addRow(id, { view, template });
    if (row) {
      store.open(row.id);
      ui.focusTitle = row.id;
    }
  }

  // Spreadsheet files dropped on a database become its rows.
  let dropping = $state(false);
  const isSheet = (f: File) => /\.(csv|tsv|txt)$/i.test(f.name) || f.type === 'text/csv';

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropping = true;
  }

  async function onDrop(e: DragEvent) {
    dropping = false;
    const files = Array.from(e.dataTransfer?.files ?? []).filter(isSheet);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of files) await databases.importInto(id, await f.text());
  }
</script>

{#if schema && meta && view}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="dbv"
    class:embedded
    class:dropping
    data-db={id}
    ondragover={onDragOver}
    ondragleave={(e) => !(e.currentTarget as Element).contains(e.relatedTarget as Node) && (dropping = false)}
    ondrop={onDrop}
  >
    {#if embedded}
      <div class="emb-head">
        <button class="emb-title" onclick={() => store.open(id)} data-tip={t('dbTable.header.openFullPage')}>
          {#if meta.icon}<span class="emoji"><PageIcon icon={meta.icon} /></span>{:else}<Icon name="database" size={16} />{/if}
          <span>{meta.title || t('common.untitledDatabase')}</span>
        </button>
      </div>
    {:else}
      <header class="head" class:has-icon={!!meta.icon}>
        {#if meta.icon}
          <button class="db-icon" onclick={pickIcon} data-tip={t('dbTable.header.changeIcon')}><PageIcon icon={meta.icon} /></button>
        {:else}
          <div class="head-tools">
            <button class="tool" onclick={() => store.update(id, { icon: randomIcon() }, { immediate: true })}><Icon name="smile" size={16} /> {t('dbTable.header.addIcon')}</button>
          </div>
        {/if}
        <!-- svelte-ignore a11y_missing_content -->
        <h1
          class="title"
          bind:this={titleEl}
          contenteditable="plaintext-only"
          spellcheck="false"
          data-placeholder={t('common.untitledDatabase')}
          oninput={onTitleInput}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              descEl?.focus();
            }
          }}
        ></h1>
        <p
          class="desc"
          bind:this={descEl}
          contenteditable="plaintext-only"
          data-placeholder={t('dbTable.header.addDescription')}
          oninput={() => databases.setDescription(id, descEl?.textContent ?? '')}
          onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), descEl?.blur())}
        ></p>
      </header>
    {/if}

    <div class="bar">
      <div class="tabs" role="tablist" aria-label={t('dbTable.viewTabs')}>
        {#each views as v (v.id)}
          <button
            class="tab"
            class:on={v.id === view.id}
            role="tab"
            aria-selected={v.id === view.id}
            onclick={() => (v.id === view.id ? openSettings() : show(v))}
            oncontextmenu={(e) => tabMenu(e, v)}
            data-tip={v.id === view.id ? t('dbTable.viewSettings') : undefined}
          >
            <Icon name={ICONS[v.type]} size={14} />
            <span>{v.name || VIEW_NAMES[v.type]}</span>
          </button>
        {/each}
        <button class="icon-btn add-view" onclick={addViewMenu} aria-label={t('dbTable.addView')} data-tip={t('dbTable.addView')}><Icon name="plus" size={15} /></button>
      </div>
      <div class="tools">
        {#if view.type === 'form'}
          <!-- A form only adds rows. -->
        {:else if searching || search}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="pop-input search"
            bind:value={search}
            placeholder={t('dbTable.toolbar.searchRows')}
            autofocus
            onkeydown={(e) => {
              if (e.key === 'Escape') {
                search = '';
                searching = false;
              }
            }}
            onblur={() => !search && (searching = false)}
            aria-label={t('dbTable.toolbar.searchRows')}
          />
        {:else}
          <button class="icon-btn" onclick={() => (searching = true)} aria-label={t('dbTable.toolbar.search')} data-tip={t('dbTable.toolbar.searchRows')}><Icon name="search" size={15} /></button>
        {/if}
        {#if view.type !== 'form'}
        <button
          class="icon-btn"
          class:active={activeFilters.length > 0}
          bind:this={filterBtn}
          onclick={(e) => (panel = { kind: 'filter', anchor: e.currentTarget as Element })}
          aria-label={t('dbTable.toolbar.filter')}
          data-tip={t('dbTable.toolbar.filter')}
        >
          <Icon name="filter" size={15} />
        </button>
        {/if}
        {#if view.type !== 'chart' && view.type !== 'calendar' && view.type !== 'form'}
          <button class="icon-btn" class:active={sorts.length > 0} onclick={(e) => (panel = { kind: 'sort', anchor: e.currentTarget as Element })} aria-label={t('dbTable.toolbar.sort')} data-tip={t('dbTable.toolbar.sort')}>
            <Icon name="sort" size={15} />
          </button>
        {/if}
        <button
          class="icon-btn"
          class:active={activeRules > 0}
          onclick={(e) => (panel = { kind: 'automations', anchor: e.currentTarget as Element })}
          aria-label={t('dbTable.toolbar.automations')}
          data-tip={activeRules ? t('dbTable.toolbar.automationsOn', { count: activeRules }) : t('dbTable.toolbar.automations')}
        >
          <Icon name="bolt" size={15} />
        </button>
        <button class="icon-btn" bind:this={settingsBtn} onclick={(e) => (panel = { kind: 'settings', anchor: e.currentTarget as Element })} aria-label={t('dbTable.viewSettings')} data-tip={t('dbTable.toolbar.settingsTip')}>
          <Icon name="sliders" size={15} />
        </button>
        {#if view.type !== 'chart' && view.type !== 'form'}
          <div class="new-group">
            <button class="btn small primary new" onclick={() => addRow()}><Icon name="plus" size={14} stroke={2.2} /> {t('common.actions.new')}</button>
            <button
              class="btn small primary new-more"
              onclick={(e) => (panel = { kind: 'templates', anchor: e.currentTarget as Element })}
              aria-label={t('dbTable.toolbar.templates')}
              data-tip={templateCount ? t('dbTable.toolbar.templateCount', { count: templateCount }) : t('dbTable.toolbar.templates')}
            >
              <Icon name="chevron-down" size={13} stroke={2.2} />
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if activeFilters.length || sorts.length || search}
      <div class="chips">
        {#each sorts as s (s.prop)}
          <button class="chip small" onclick={(e) => (panel = { kind: 'sort', anchor: e.currentTarget as Element })}>
            <Icon name={s.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />
            {databases.prop(id, s.prop)?.name}
          </button>
        {/each}
        {#each activeFilters as r (r.id)}
          <button class="chip small" onclick={(e) => (panel = { kind: 'filter', anchor: e.currentTarget as Element })}><Icon name="filter" size={12} /> {describe(r)}</button>
        {/each}
        {#if activeFilters.length || search}<span class="count">{t('dbTable.shownOfTotal', { shown: result.rows.length, count: total })}</span>{/if}
        <button
          class="clear"
          onclick={() => {
            databases.updateView(id, view.id, { filters: [], sorts: [] });
            search = '';
            searching = false;
          }}>{t('dbTable.clearFilters')}</button
        >
      </div>
    {/if}

    <div class="view-body" class:pad={!embedded} class:edge={!embedded && (view.type === 'table' || view.type === 'board')}>
      {#key view.id}
        {#if !ready && !databases.showsEarly(id, view, search)}
          <div class="reading">{t('dbTable.loadingRows')}</div>
        {:else if view.type === 'table'}
          <TableView bind:this={table} dbId={id} {view} rows={result.rows} groups={result.groups} onfilter={filterOn} />
        {:else if view.type === 'board'}
          <BoardView dbId={id} {view} groups={result.groups} onsettings={openSettings} />
        {:else if view.type === 'gallery'}
          <GalleryView dbId={id} {view} rows={result.rows} />
        {:else if view.type === 'list'}
          <ListView dbId={id} {view} rows={result.rows} groups={result.groups} />
        {:else if view.type === 'calendar'}
          <CalendarView dbId={id} {view} rows={result.rows} onsettings={openSettings} />
        {:else if view.type === 'chart'}
          <ChartView dbId={id} {view} rows={result.rows} onsettings={openSettings} />
        {:else if view.type === 'timeline'}
          <TimelineView dbId={id} {view} rows={result.rows} onsettings={openSettings} />
        {:else if view.type === 'form'}
          <FormView dbId={id} {view} />
        {/if}
      {/key}
    </div>
    {#if dropping}
      <div class="drop-hint"><Icon name="upload" size={18} /> {t('dbTable.dropCsv')}</div>
    {/if}
  </section>

  {#if panel}
    <Popover
      anchor={panel.anchor}
      align="end"
      width={panel.kind === 'settings' ? 300 : panel.kind === 'filter' ? 440 : panel.kind === 'templates' ? 280 : panel.kind === 'automations' ? 420 : 360}
      onclose={() => (panel = null)}
      label={t(PANEL_LABELS[panel.kind])}
    >
      {#if panel.kind === 'templates'}
        <TemplatesPanel dbId={id} {view} onpick={(tpl) => void addRow(tpl)} onclose={() => (panel = null)} />
      {:else if panel.kind === 'automations'}
        <AutomationsPanel dbId={id} />
      {:else if panel.kind === 'filter'}
        <FilterPanel dbId={id} {view} />
      {:else if panel.kind === 'sort'}
        <SortPanel dbId={id} {view} />
      {:else}
        <ViewSettings dbId={id} {view} onclose={() => (panel = null)} onswitch={(v) => show(v)} />
      {/if}
    </Popover>
  {/if}
{/if}

<style>
  /* Shown only if reading the rows takes a moment (a big database, opened
     for the first time); a quick read never flashes it. */
  .reading {
    padding: 24px 4px;
    font-size: var(--fs-ui);
    color: var(--text-3);
    opacity: 0;
    animation: reading-in var(--dur) var(--ease) 250ms forwards;
  }
  @keyframes reading-in {
    to {
      opacity: 1;
    }
  }
  .dbv {
    position: relative;
    min-width: 0;
  }
  .dbv:not(.embedded) {
    padding: 0 0 72px;
  }
  .head {
    position: relative;
    padding: 72px var(--page-pad) 0;
  }
  .head.has-icon {
    padding-top: 48px;
  }
  .db-icon {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    margin: 0 0 12px -6px;
    font-size: 54px;
    line-height: 1;
    border-radius: var(--r-lg);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .db-icon :global(.page-glyph) {
    width: 0.86em;
    height: 0.86em;
    stroke-width: 1.4;
  }
  .db-icon:hover {
    background: var(--fill);
  }
  .head-tools {
    position: absolute;
    top: 32px;
    left: calc(var(--page-pad) - 8px);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .head:hover .head-tools,
  .head-tools:focus-within {
    opacity: 1;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-sm);
    padding: 0 10px 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-3);
  }
  .tool:hover {
    background: var(--fill);
    color: var(--text-2);
  }
  .title {
    margin: 0 0 6px;
    font-size: 36px;
    font-weight: var(--fw-700);
    line-height: 1.15;
    letter-spacing: -0.028em;
    outline: none;
    overflow-wrap: break-word;
  }
  .title:empty::before,
  .desc:empty::before {
    content: attr(data-placeholder);
    color: var(--text-4);
  }
  .desc {
    margin: 0 0 20px;
    max-width: 720px;
    font-size: var(--fs-callout);
    line-height: 1.5;
    color: var(--text-2);
    outline: none;
  }
  .desc:empty:not(:focus)::before {
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .head:hover .desc:empty::before {
    opacity: 1;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 var(--page-pad);
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .embedded .bar {
    padding: 0;
  }
  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    padding: 0 10px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-3);
    transition: color var(--dur-fast) var(--ease);
  }
  .tab:hover {
    color: var(--text-2);
  }
  .tab.on {
    color: var(--text);
  }
  .tab.on::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--text);
  }
  .add-view {
    width: 26px;
    height: 26px;
    color: var(--text-3);
  }
  .tools {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tools .icon-btn.active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .search {
    width: 180px;
    height: 28px;
    margin-right: 4px;
  }
  .new-group {
    display: flex;
    margin-left: 6px;
  }
  .new {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .new-more {
    width: 24px;
    padding: 0;
    justify-content: center;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    box-shadow: inset 1px 0 0 color-mix(in srgb, var(--on-accent, #fff) 25%, transparent);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px var(--page-pad) 0;
  }
  .embedded .chips {
    padding: 8px 0 0;
  }
  .chip.small {
    height: 24px;
    padding: 0 10px;
    font-size: var(--fs-footnote);
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .clear {
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .clear:hover {
    color: var(--text);
  }
  .view-body {
    padding-top: 8px;
  }
  .view-body.pad {
    padding-left: var(--page-pad);
    padding-right: var(--page-pad);
  }
  /* Tables and boards run to the window's edge (scrolling sideways there),
     their first column lined up with the title. */
  .view-body.pad.edge {
    padding-left: 0;
    padding-right: 0;
    --edge: var(--page-pad);
  }
  .emb-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
  }
  .emb-title {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 2px;
    border-radius: var(--r-sm);
    font-size: 17px;
    font-weight: var(--fw-650);
    letter-spacing: -0.012em;
    color: var(--text);
  }
  .emb-title:hover {
    background: var(--fill);
  }
  .emb-title :global(.icon) {
    color: var(--text-2);
  }
  .emoji {
    font-size: 18px;
    line-height: 1;
  }
  .dbv.dropping {
    outline: 2px dashed var(--accent);
    outline-offset: -4px;
    border-radius: var(--r-md);
  }
  .drop-hint {
    position: absolute;
    left: 50%;
    top: 120px;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-radius: var(--r-lg);
    background: var(--ink);
    color: var(--on-ink);
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    pointer-events: none;
  }
</style>
