<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import AssignmentRow from '../ui/AssignmentRow.svelte';
  import CaptureBox from '../ui/CaptureBox.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import EventRow from '../ui/EventRow.svelte';
  import SetupCard from '../ui/SetupCard.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import { itemsByDay } from '../calendar.svelte';
  import { clock } from '../clock.svelte';
  import { addDays, dueState, parseDate } from '../dates';
  import { library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { relativeTime, formatBytes } from '../time';
  import { todos } from '../todos.svelte';
  import { cards } from '../cards.svelte';
  import { Progressive, takeGrouped } from '../progressive.svelte';
  import type { PageMeta, Todo } from '../types';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  onMount(() => void todos.load());

  const greeting = $derived.by(() => {
    const h = Number(clock.time.slice(0, 2));
    // A greeting uses the first name only.
    const name = prefs.name.trim().split(/\s+/)[0] ?? '';
    if (h < 5) return name ? t('planner.home.greeting.lateName', { name }) : t('planner.home.greeting.late');
    if (h < 12) return name ? t('planner.home.greeting.morningName', { name }) : t('planner.home.greeting.morning');
    if (h < 18) return name ? t('planner.home.greeting.afternoonName', { name }) : t('planner.home.greeting.afternoon');
    return name ? t('planner.home.greeting.eveningName', { name }) : t('planner.home.greeting.evening');
  });
  const dateLine = $derived(fmt.date(parseDate(clock.today), { weekday: 'long', month: 'long', day: 'numeric' }));

  const today = $derived(itemsByDay(clock.today, clock.today).get(clock.today));
  const todayEvents = $derived(today ? [...today.allDay, ...today.timed] : []);

  /** Overdue and due within a week, soonest first. */
  const due = $derived(
    planner.live
      .filter((a) => a.status !== 'done' && a.dueDate && a.dueDate <= addDays(clock.today, 7))
      .slice(0, 6),
  );
  const overdue = $derived(due.filter((a) => dueState(a, clock.today, clock.time) === 'overdue').length);

  /** To-dos grouped by the page they're written in. */
  const todoGroups = $derived.by(() => {
    const groups = new Map<string, Todo[]>();
    for (const todo of todos.items) {
      const page = store.byId.get(todo.pageId);
      if (!page || page.deletedAt) continue;
      let list = groups.get(todo.pageId);
      if (!list) groups.set(todo.pageId, (list = []));
      list.push(todo);
    }
    return [...groups].map(([pageId, items]) => ({ page: store.byId.get(pageId)!, items }));
  });
  const openTodos = $derived(todos.items.length - Object.values(todos.done).filter(Boolean).length);
  // Thousands of to-dos render as you scroll down to them.
  const lazyTodos = new Progressive(40);
  const shownTodos = $derived(takeGrouped(todoGroups, (g) => g.items, lazyTodos.limit));
  const todoCount = $derived(todoGroups.reduce((n, g) => n + g.items.length, 0));

  /** The six most recently edited pages (one pass, no sort of every page). */
  const recentPages = $derived.by(() => {
    const top: PageMeta[] = [];
    for (const p of store.all) {
      if (p.deletedAt || (top.length === 6 && p.updatedAt <= top[5].updatedAt) || store.isRow(p)) continue;
      top.push(p);
      top.sort((a, b) => b.updatedAt - a.updatedAt);
      if (top.length > 6) top.pop();
    }
    return top;
  });
  const recentFiles = $derived(library.live.slice(0, 4));

  const summary = $derived.by(() => {
    const parts: string[] = [];
    parts.push(t('planner.home.eventsToday', { count: todayEvents.length }));
    if (due.length) parts.push(overdue ? t('planner.home.dueThisWeekOverdue', { count: due.length, overdue }) : t('planner.dueThisWeek', { count: due.length }));
    if (openTodos) parts.push(t('planner.home.todos', { count: openTodos }));
    if (cards.dueCount) parts.push(t('planner.home.flashcardsToStudy', { count: cards.dueCount }));
    return parts.join(' · ');
  });
</script>

<div class="view home">
  <header class="view-head">
    <div>
      <div class="eyebrow date">{dateLine}</div>
      <h1 class="view-title">{greeting}</h1>
      <p class="view-sub">{summary}</p>
    </div>
  </header>

  <SetupCard />

  <div class="group capture-card">
    <CaptureBox inline onsaved={() => void todos.load()} />
  </div>

  <div class="columns">
    <div class="col">
      <section>
        <h2 class="group-title">
          <span>{t('common.today')}</span>
          <button class="see-all" onclick={() => store.go('calendar')}>{t('common.views.calendar')} <Icon name="chevron-right" size={12} stroke={2.2} /></button>
        </h2>
        {#if todayEvents.length}
          <div class="group">
            {#each todayEvents as occ (occ.key)}
              <EventRow {occ} day={clock.today} />
            {/each}
          </div>
        {:else}
          <div class="group"><EmptyState compact icon="calendar" title={t('planner.home.freeDay')} text={t('planner.home.freeDayText')} /></div>
        {/if}
      </section>

      <section>
        <h2 class="group-title">
          <span>{t('planner.home.dueSoon')}</span>
          <button class="see-all" onclick={() => store.go('assignments')}>{t('common.views.assignments')} <Icon name="chevron-right" size={12} stroke={2.2} /></button>
        </h2>
        {#if due.length}
          <div class="group">
            {#each due as a (a.id)}
              <AssignmentRow {a} />
            {/each}
          </div>
        {:else}
          <div class="group"><EmptyState compact icon="assignment" title={t('planner.home.nothingDue')} text={t('planner.home.nothingDueText')} /></div>
        {/if}
      </section>

      <section>
        <h2 class="group-title">
          <span>{t('planner.home.todosTitle')}</span>
          <span class="count">{openTodos ? t('planner.home.openTodos', { count: openTodos }) : ''}</span>
        </h2>
        {#if todoGroups.length}
          <div class="group">
            {#each shownTodos as { group: g, items } (g.page.id)}
              <button class="group-row compact todo-page" onclick={() => store.open(g.page.id)}>
                <span class="page-icon">{#if g.page.icon}<PageIcon icon={g.page.icon} />{:else}<Icon name="page" size={14} />{/if}</span>
                <span class="page-title">{g.page.title || t('common.untitled')}</span>
                <Icon name="chevron-right" size={12} stroke={2.2} />
              </button>
              {#each items as todo (`${todo.pageId}:${todo.index}`)}
                <div class="group-row compact todo" class:done={todos.isDone(todo)}>
                  <button
                    class="box"
                    class:on={todos.isDone(todo)}
                    role="checkbox"
                    aria-checked={todos.isDone(todo)}
                    aria-label={todos.isDone(todo) ? t('planner.markNotDone') : t('planner.markDone')}
                    onclick={() => todos.toggle(todo)}
                  ></button>
                  <span class="todo-text">{todo.text}</span>
                </div>
              {/each}
            {/each}
          </div>
          {#if lazyTodos.limit < todoCount}<div class="more" {@attach lazyTodos.more}></div>{/if}
        {:else if todos.loaded}
          <div class="group">
            <EmptyState compact icon="todo" title={t('planner.home.noTodos')} text={t('planner.home.noTodosText')} />
          </div>
        {/if}
      </section>
    </div>

    <div class="col">
      <section>
        <h2 class="group-title"><span>{t('planner.home.recentPages')}</span></h2>
        <div class="group">
          {#each recentPages as p (p.id)}
            <button class="group-row compact link-row" onclick={() => store.open(p.id)}>
              <span class="page-icon">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name="page" size={16} />{/if}</span>
              <span class="page-title">{p.title || t('common.untitled')}</span>
              <span class="meta">{relativeTime(p.updatedAt)}</span>
            </button>
          {:else}
            <EmptyState compact icon="page" title={t('planner.home.noPages')} text={t('planner.home.noPagesText')} />
          {/each}
        </div>
      </section>

      {#if recentFiles.length}
        <section>
          <h2 class="group-title">
            <span>{t('planner.home.recentFiles')}</span>
            <button class="see-all" onclick={() => store.go('files')}>{t('common.views.files')} <Icon name="chevron-right" size={12} stroke={2.2} /></button>
          </h2>
          <div class="group">
            {#each recentFiles as f (f.id)}
              <button class="group-row compact link-row" onclick={() => library.preview(f.id)}>
                <FileTile file={f} size={24} />
                <span class="page-title">{f.name}</span>
                <span class="meta">{formatBytes(f.size)}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if tags.used.length}
        <section>
          <h2 class="group-title"><span>{t('common.tags')}</span></h2>
          <div class="tag-cloud">
            {#each tags.used as name (name)}
              {@const n = tags.counts.get(name)}
              <button class="tag-chip round" style:--c={tags.color(name)} onclick={() => store.openTag(name)}>
                #{name}<span class="n">{n === undefined ? '' : fmt.number(n)}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .date {
    margin-bottom: 4px;
    font-size: var(--fs-ui);
  }
  .capture-card {
    padding: 16px;
    margin-bottom: 24px;
  }
  /* Sections keep the grouped-list rhythm: 24px between them. */
  .col > section + section {
    margin-top: 24px;
  }
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 0 32px;
    align-items: start;
  }
  .see-all {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: var(--h-xs);
    padding: 0 6px 0 8px;
    margin-right: -6px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .see-all:hover {
    background: var(--fill);
    color: var(--text);
  }
  .count {
    font-weight: var(--fw-500);
    color: var(--text-3);
  }

  .link-row,
  .todo-page {
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .link-row:hover,
  .todo-page:hover {
    background: var(--fill);
  }
  .group > .link-row:first-child,
  .group > .todo-page:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .group > .link-row:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .page-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 24px;
    font-size: 16px;
    color: var(--text-3);
  }
  .page-title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .todo-page {
    color: var(--text-3);
  }
  .todo-page .page-title {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    color: var(--text-2);
  }
  .meta {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  /* To-do rows: the same square check as in pages, on the 24px icon column. */
  .todo {
    justify-content: flex-start;
    gap: 12px;
  }
  .box {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0 4px;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1.5px var(--text-3);
    transition:
      background-color var(--dur) var(--ease),
      box-shadow var(--dur) var(--ease);
  }
  .box:hover {
    box-shadow: inset 0 0 0 1.5px var(--text-2);
  }
  .box.on {
    background: var(--accent) var(--check) center / 14px no-repeat;
    box-shadow: inset 0 0 0 1.5px var(--accent);
    animation: check-pop var(--dur-slow) var(--spring);
  }
  .todo-text {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    color: var(--text);
    overflow-wrap: anywhere;
    transition: color var(--dur) var(--ease);
  }
  .todo.done .todo-text {
    color: var(--text-3);
    text-decoration: line-through;
    text-decoration-color: var(--text-4);
  }

  .tag-cloud {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-sm);
    padding: 0 12px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--c) 14%, transparent);
    color: color-mix(in srgb, var(--c) 72%, var(--text));
    font-size: var(--fs-ui);
    font-weight: var(--fw-550);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .tag-chip:hover {
    background: color-mix(in srgb, var(--c) 22%, transparent);
  }
  .tag-chip .n {
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }

  /* One column when the pane is narrow (pane-size.ts). */
  :global([data-below-720]) .columns {
    grid-template-columns: minmax(0, 1fr);
  }
</style>
