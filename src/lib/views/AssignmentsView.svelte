<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import AssignmentRow from '../ui/AssignmentRow.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import SearchField from '../ui/SearchField.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { clock } from '../clock.svelte';
  import { colorVar, nextColor, PALETTE } from '../colors';
  import { diffDays, dueState } from '../dates';
  import { planner } from '../planner.svelte';
  import { prefs, type AssignmentScope } from '../prefs.svelte';
  import { Progressive, takeGrouped } from '../progressive.svelte';
  import { ui } from '../ui.svelte';
  import type { Assignment } from '../types';
  import { t, type MessageKey } from '../i18n';
  import { fmt } from '../i18n/format';

  /** 'all', a course id, or 'none' for assignments without a course. */
  let courseFilter = $state<string>('all');
  let query = $state('');
  let quickTitle = $state('');
  let quickDate = $state('');

  const scopes: { value: AssignmentScope; label: string }[] = [
    { value: 'upcoming', label: t('planner.assignments.scope.upcoming') },
    { value: 'all', label: t('planner.assignments.scope.all') },
    { value: 'done', label: t('planner.assignments.scope.done') },
  ];

  /** Due-date buckets in reading order, with their headings. */
  const BUCKETS = [
    ['overdue', 'planner.assignments.group.overdue'],
    ['today', 'common.today'],
    ['tomorrow', 'common.tomorrow'],
    ['week', 'planner.assignments.group.week'],
    ['later', 'planner.assignments.group.later'],
    ['none', 'planner.assignments.group.none'],
    ['done', 'planner.assignments.group.done'],
  ] as const satisfies readonly (readonly [string, MessageKey])[];

  // A course that was deleted can't stay selected.
  $effect(() => {
    if (courseFilter !== 'all' && courseFilter !== 'none' && !planner.courseById.has(courseFilter)) courseFilter = 'all';
  });

  // Rows render as you scroll; a new filter starts from the top again.
  const lazy = new Progressive();
  $effect(() => {
    void [query, courseFilter, prefs.assignmentScope];
    lazy.reset();
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return planner.live.filter((a) => {
      if (prefs.assignmentScope === 'upcoming' && a.status === 'done') return false;
      if (prefs.assignmentScope === 'done' && a.status !== 'done') return false;
      if (courseFilter === 'none' ? a.courseId !== null : courseFilter !== 'all' && a.courseId !== courseFilter) return false;
      if (!q) return true;
      const course = a.courseId ? planner.courseById.get(a.courseId)?.name ?? '' : '';
      return `${a.title} ${a.notes} ${course}`.toLowerCase().includes(q);
    });
  });

  /** Due-date buckets, the way a planner reads: what's late, what's next. */
  const groups = $derived.by(() => {
    const today = clock.today;
    if (prefs.assignmentScope === 'done') {
      const done = [...filtered].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      return done.length ? [{ key: 'done', label: t('planner.assignments.group.done'), items: done }] : [];
    }
    const buckets: Record<string, Assignment[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [], done: [] };
    for (const a of filtered) {
      if (a.status === 'done') buckets.done.push(a);
      else if (!a.dueDate) buckets.none.push(a);
      else if (dueState(a, today, clock.time) === 'overdue') buckets.overdue.push(a);
      else {
        const n = diffDays(today, a.dueDate);
        if (n === 0) buckets.today.push(a);
        else if (n === 1) buckets.tomorrow.push(a);
        else if (n < 7) buckets.week.push(a);
        else buckets.later.push(a);
      }
    }
    return BUCKETS.filter(([k]) => buckets[k].length).map(([key, label]) => ({ key, label: t(label), items: buckets[key] }));
  });

  const shownGroups = $derived(takeGrouped(groups, (g) => g.items, lazy.limit));

  const summary = $derived.by(() => {
    const open = planner.live.filter((a) => a.status !== 'done');
    const overdue = open.filter((a) => dueState(a, clock.today, clock.time) === 'overdue').length;
    const week = open.filter((a) => a.dueDate && a.dueDate >= clock.today && diffDays(clock.today, a.dueDate) < 7).length;
    if (!open.length) return planner.live.length ? t('planner.assignments.allCaughtUp') : t('planner.assignments.intro');
    const parts = [t('planner.dueThisWeek', { count: week })];
    if (overdue) parts.push(t('planner.overdue', { count: overdue }));
    return parts.join(' · ');
  });

  const activeCourse = $derived(courseFilter !== 'all' && courseFilter !== 'none' ? courseFilter : null);

  function newAssignment() {
    planner.newAssignment({ courseId: activeCourse });
  }

  async function quickAdd(e: SubmitEvent) {
    e.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    const a = await planner.addAssignment({ title, courseId: activeCourse, dueDate: quickDate || null });
    if (a) {
      quickTitle = '';
      quickDate = '';
    }
  }

  async function addCourse() {
    const res = await ui.prompt({
      title: t('planner.course.newTitle'),
      placeholder: t('planner.course.namePlaceholder'),
      confirmLabel: t('planner.course.add'),
      icon: 'book',
      color: nextColor(planner.courses.map((c) => c.color)),
    });
    if (!res) return;
    const course = await planner.addCourse(res.value, res.color);
    if (course) courseFilter = course.id;
  }

  function courseMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    const c = planner.courseById.get(id);
    if (!c) return;
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t('planner.course.renameMenu'),
          icon: 'pencil',
          action: async () => {
            const res = await ui.prompt({ title: t('planner.course.renameTitle'), value: c.name, confirmLabel: t('common.actions.rename'), icon: 'book' });
            if (res) void planner.updateCourse(id, { name: res.value });
          },
        },
        { separator: true },
        { header: t('planner.course.color') },
        ...PALETTE.map((p) => ({
          label: p.label,
          dot: colorVar(p.key),
          checked: c.color === p.key,
          action: () => void planner.updateCourse(id, { color: p.key }),
        })),
        { separator: true },
        { label: t('planner.course.deleteMenu'), icon: 'trash', danger: true, action: () => void planner.deleteCourse(id) },
      ],
    });
  }

  const emptyText = $derived(
    query
      ? t('planner.assignments.emptySearch')
      : prefs.assignmentScope === 'done'
        ? t('planner.assignments.emptyDone')
        : prefs.assignmentScope === 'upcoming' && planner.live.length
          ? t('planner.assignments.emptyUpcoming')
          : t('planner.assignments.emptyStart'),
  );
</script>

<div class="view">
  <header class="view-head">
    <div>
      <h1 class="view-title">{t('common.views.assignments')}</h1>
      <p class="view-sub">{summary}</p>
    </div>
    <div class="view-actions">
      <button class="btn primary" onclick={newAssignment}><Icon name="plus" size={15} stroke={2.2} /> {t('planner.newAssignment')}</button>
    </div>
  </header>

  <div class="toolbar">
    <Segmented options={scopes} value={prefs.assignmentScope} onchange={(v) => (prefs.assignmentScope = v)} label={t('planner.assignments.scopeLabel')} />
    <span class="spacer"></span>
    <SearchField bind:value={query} placeholder={t('planner.assignments.search')} width={220} />
  </div>

  <div class="courses" role="radiogroup" aria-label={t('common.course')}>
    <button class="chip" class:on={courseFilter === 'all'} role="radio" aria-checked={courseFilter === 'all'} onclick={() => (courseFilter = 'all')}>
      {t('planner.assignments.allCourses')}
    </button>
    {#each planner.courses as c (c.id)}
      <button
        class="chip"
        class:on={courseFilter === c.id}
        role="radio"
        aria-checked={courseFilter === c.id}
        onclick={() => (courseFilter = c.id)}
        oncontextmenu={(e) => courseMenu(e, c.id)}
        data-tip={t('planner.assignments.editCourseTip')}
      >
        <span class="dot" style:--dot={colorVar(c.color)}></span>{c.name || t('common.untitled')}
      </button>
    {/each}
    {#if planner.live.some((a) => !a.courseId) && planner.courses.length}
      <button class="chip" class:on={courseFilter === 'none'} role="radio" aria-checked={courseFilter === 'none'} onclick={() => (courseFilter = 'none')}>
        {t('planner.assignments.noCourse')}
      </button>
    {/if}
    <button class="chip add" onclick={addCourse}><Icon name="plus" size={13} stroke={2.2} /> {t('planner.course.addChip')}</button>
  </div>

  {#if prefs.assignmentScope !== 'done'}
    <form class="group quick" onsubmit={quickAdd}>
      <span class="quick-icon"><Icon name="plus" size={16} stroke={2.2} /></span>
      <input
        class="quick-title"
        bind:value={quickTitle}
        placeholder={activeCourse
          ? t('planner.assignments.addTo', { course: planner.courseById.get(activeCourse)?.name ?? '' })
          : t('planner.assignments.addAssignment')}
        spellcheck="false"
      />
      <label class="field quick-date" data-tip={t('planner.dueDate')}>
        <input type="date" bind:value={quickDate} aria-label={t('planner.dueDate')} />
      </label>
      <button class="btn small primary" type="submit" disabled={!quickTitle.trim()}>{t('common.actions.add')}</button>
    </form>
  {/if}

  {#each shownGroups as { group: g, items } (g.key)}
    <h2 class="group-title" class:overdue={g.key === 'overdue'}>
      <span>{g.label}</span>
      <span class="count">{fmt.number(g.items.length)}</span>
    </h2>
    <div class="group">
      {#each items as a (a.id)}
        <AssignmentRow {a} showCourse={courseFilter === 'all' || courseFilter === 'none'} />
      {/each}
    </div>
  {:else}
    <EmptyState
      icon="assignment"
      title={query
        ? t('planner.assignments.noMatches')
        : prefs.assignmentScope === 'done'
          ? t('planner.assignments.noneCompleted')
          : t('planner.assignments.noAssignments')}
      text={emptyText}
    >
      {#if !query && prefs.assignmentScope !== 'done'}
        <button class="btn primary" onclick={newAssignment}><Icon name="plus" size={15} stroke={2.2} /> {t('planner.newAssignment')}</button>
      {/if}
    </EmptyState>
  {/each}
  {#if lazy.limit < filtered.length}<div {@attach lazy.more}></div>{/if}
</div>

<style>
  .courses {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: -4px 0 18px;
  }
  .chip.add {
    background: none;
    box-shadow: inset 0 0 0 1px var(--separator-strong);
    color: var(--text-3);
  }
  .chip.add:hover {
    color: var(--text);
    background: var(--fill);
  }

  .quick {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 10px 0 16px;
    margin-bottom: 4px;
  }
  .quick-icon {
    display: grid;
    place-items: center;
    width: 18px;
    color: var(--text-3);
  }
  .quick-title {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font-size: var(--fs-callout);
  }
  .quick-date {
    width: 150px;
    color: var(--text-2);
  }
  .quick-date input {
    font-size: var(--fs-ui);
  }

  .group-title .count {
    font-weight: var(--fw-500);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .group-title.overdue > span:first-child {
    color: var(--danger);
  }
</style>
