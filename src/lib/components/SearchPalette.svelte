<script lang="ts">
  import { split } from '../split.svelte';
  import PageIcon from './PageIcon.svelte';
  import { colorVar } from '../colors';
  import { importCalendar } from '../ics-import.svelte';
  import { exportWorkspace } from '../export-workspace';
  import { tabs } from '../tabs.svelte';
  import { cards } from '../cards.svelte';
  import { databases } from '../databases.svelte';
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import { api } from '../api';
  import { calendar } from '../calendar.svelte';
  import { clock } from '../clock.svelte';
  import { dueState, formatDate, formatDue } from '../dates';
  import { rank } from '../editor/suggestion.svelte';
  import { KINDS, fileKind, library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { keyName } from '../shortcuts.svelte';
  import { store } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { ui } from '../ui.svelte';
  import { formatBytes, relativeTime } from '../time';
  import { searchText, t, tEn, type TextKey } from '../i18n';
  import { fmt } from '../i18n/format';
  import type { FileMeta, SearchHit } from '../types';

  type Label = TextKey;

  type GroupId = 'recent' | 'upNext' | 'pages' | 'assignments' | 'tags' | 'courses' | 'rows' | 'events' | 'files' | 'goTo' | 'create';
  const GROUP_LABELS: Record<GroupId, Label> = {
    recent: 'onboarding.search.groups.recent',
    upNext: 'onboarding.search.groups.upNext',
    pages: 'onboarding.search.groups.pages',
    assignments: 'onboarding.search.groups.assignments',
    tags: 'common.tags',
    courses: 'onboarding.search.groups.courses',
    rows: 'onboarding.search.groups.rows',
    events: 'onboarding.search.groups.events',
    files: 'onboarding.search.groups.files',
    goTo: 'onboarding.search.groups.goTo',
    create: 'onboarding.search.groups.create',
  };

  /** One result row. Rows of the same group are listed together. */
  interface Row {
    key: string;
    group: GroupId;
    title: string;
    icon?: string;
    emoji?: string;
    file?: FileMeta;
    /** CSS colour for the icon (course and event colours). */
    color?: string;
    path?: string;
    snippet?: string;
    meta?: string;
    metaClass?: string;
    run: () => void;
      /** Alt+Enter: open beside the current page instead. */
    side?: () => void;
  }

  let input: HTMLInputElement;
  let list = $state<HTMLDivElement>();
  let query = $state('');
  let hits = $state<SearchHit[]>([]);
  let selected = $state(0);
  let seq = 0;

  onMount(() => {
    input.focus();
    void run('');
  });

  // One search at a time: typing while one runs only remembers the latest
  // query, so fast typing in a big workspace never queues up stale searches.
  let busy = false;
  let next: string | null = null;

  async function run(q: string) {
    if (busy) {
      next = q;
      return;
    }
    busy = true;
    const mine = ++seq;
    try {
      const result = await api.search(q, 40);
      if (mine === seq && next === null) {
        hits = result;
        selected = 0;
      }
    } catch (e) {
      ui.error(e);
    } finally {
      busy = false;
      if (next !== null) {
        const q2 = next;
        next = null;
        void run(q2);
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function onInput() {
    clearTimeout(timer);
    selected = 0;
    timer = setTimeout(() => run(query), 60);
  }

  function close() {
    ui.searchOpen = false;
  }

  /** Splits an FTS snippet into plain and highlighted runs. */
  function parts(snippet: string): { text: string; hit: boolean }[] {
    const out: { text: string; hit: boolean }[] = [];
    for (const piece of snippet.split('\u0001')) {
      const [hit, rest] = piece.includes('\u0002') ? piece.split('\u0002') : [null, piece];
      if (hit !== null) out.push({ text: hit, hit: true });
      if (rest) out.push({ text: rest, hit: false });
    }
    return out;
  }

  function pathOf(id: string) {
    return store
      .ancestors(id)
      .map((a) => a.title || t('common.untitled'))
      .join(' / ');
  }

  /**
   * A Go To command, named in the interface's language. Its keywords are in
   * that language and in English, with its English name, so typing in
   * English still finds it.
   */
  function command(id: string, name: Label, words: Label, icon: string, run: () => void) {
    const title = t(name);
    const english = tEn(name);
    return { id, title, icon, keywords: title === english ? searchText(words) : `${searchText(words)} ${english}`, run };
  }

  const GOTO = [
    command('home', 'common.views.home', 'onboarding.search.commands.homeWords', 'home', () => store.go('home')),
    command('capture', 'onboarding.search.commands.quickCapture', 'onboarding.search.commands.quickCaptureWords', 'bolt', () => (ui.capture = { text: '' })),
    command('assignments', 'common.views.assignments', 'onboarding.search.commands.assignmentsWords', 'assignment', () => store.go('assignments')),
    command('calendar', 'common.views.calendar', 'onboarding.search.commands.calendarWords', 'calendar', () => store.go('calendar')),
    command('cards', 'common.views.flashcards', 'onboarding.search.commands.flashcardsWords', 'cards', () => store.go('cards')),
    command('study', 'onboarding.search.commands.study', 'onboarding.search.commands.studyWords', 'cards', () => void cards.study(null, t('onboarding.search.allDecks'))),
    command('importCalendar', 'onboarding.search.commands.importCalendar', 'onboarding.search.commands.importCalendarWords', 'download', () => void importCalendar()),
    command('files', 'common.views.files', 'onboarding.search.commands.filesWords', 'files', () => store.go('files')),
    command('friends', 'common.views.friends', 'onboarding.search.commands.friendsWords', 'users', () => store.go('friends')),
    command('galaxy', 'common.views.galaxy', 'onboarding.search.commands.galaxyWords', 'galaxy', () => store.go('galaxy')),
    command('account', 'onboarding.search.commands.account', 'onboarding.search.commands.accountWords', 'user', () => (ui.accountSheet = true)),
    command('newTab', 'onboarding.search.commands.newTab', 'onboarding.search.commands.newTabWords', 'plus', () => void tabs.newTab()),
    command('export', 'onboarding.search.commands.exportMarkdown', 'onboarding.search.commands.exportMarkdownWords', 'download', () => void exportWorkspace()),
    command('newDatabase', 'onboarding.search.commands.newDatabase', 'onboarding.search.commands.newDatabaseWords', 'database', () => (ui.newDatabase = { parentId: null })),
    command('importSheet', 'onboarding.search.commands.importSpreadsheet', 'onboarding.search.commands.importSpreadsheetWords', 'upload', () => (ui.newDatabase = { parentId: null })),
    command('settings', 'common.views.settings', 'onboarding.search.commands.settingsWords', 'settings', () => (ui.settingsOpen = true)),
    command('shortcuts', 'onboarding.search.commands.shortcuts', 'onboarding.search.commands.shortcutsWords', 'keyboard', () => (ui.shortcutsHelp = true)),
    command('trash', 'common.views.trash', 'onboarding.search.commands.trashWords', 'trash', () => (ui.trashOpen = true)),
  ];

  /** When an event starts: its date, and its time when it has one, in the locale's order ("Oct 14, 3:05 PM"). */
  function eventWhen(e: { startDate: string; startTime: string | null }): string {
    if (!e.startTime) return formatDate(e.startDate);
    const [y, mo, d] = e.startDate.split('-').map(Number);
    const [h, m] = e.startTime.split(':').map(Number);
    const year: Intl.DateTimeFormatOptions = y !== new Date().getFullYear() ? { year: 'numeric' } : {};
    // Written in UTC, so a time the clocks skip that night (2:30 when they spring forward) still reads as typed.
    return fmt.dateTime(Date.UTC(y, mo - 1, d, h, m), { month: 'short', day: 'numeric', ...year, hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  }

  const rows = $derived.by((): Row[] => {
    const q = query.trim();
    const out: Row[] = [];
    const pages = hits.map(
      (hit): Row => ({
        key: `p:${hit.id}`,
        group: q ? 'pages' : 'recent',
        title: hit.title || t('common.untitled'),
        emoji: hit.icon || undefined,
        icon: hit.icon ? undefined : store.byId.get(hit.id)?.kind === 'database' ? 'database' : 'page',
        path: pathOf(hit.id) || undefined,
        snippet: hit.snippet || undefined,
        meta: relativeTime(hit.updatedAt),
        run: () => store.open(hit.id),
        side: () => split.show(hit.id),
      }),
    );
    const assignmentRow = (a: (typeof planner.live)[number]): Row => {
      const course = a.courseId ? planner.courseById.get(a.courseId) : undefined;
      return {
        key: `a:${a.id}`,
        group: q ? 'assignments' : 'upNext',
        title: a.title || t('common.untitled'),
        icon: a.status === 'done' ? 'check' : 'assignment',
        color: planner.courseColor(a.courseId),
        path: course?.name,
        meta: formatDue(a.dueDate, a.dueTime, clock.today),
        metaClass: dueState(a, clock.today, clock.time),
        run: () => planner.openAssignment(a.id),
      };
    };

    if (!q) {
      out.push(...pages.slice(0, 8));
      out.push(
        ...planner.live
          .filter((a) => a.status !== 'done' && a.dueDate)
          .slice(0, 3)
          .map(assignmentRow),
      );
      return out;
    }

    // "#exam" lists matching tags first.
    const tagQuery = q.replace(/^#/, '').toLowerCase();
    const tagRows = tags.used
      .filter((tag) => tag.includes(tagQuery))
      .slice(0, q.startsWith('#') ? 8 : 3)
      .map(
        (tag): Row => ({
          key: `t:${tag}`,
          group: 'tags',
          title: `#${tag}`,
          icon: 'tag',
          color: tags.color(tag),
          meta: t('onboarding.search.tagItems', { count: tags.counts.get(tag) ?? 0 }),
          run: () => store.openTag(tag),
        }),
      );
    if (q.startsWith('#')) out.push(...tagRows);
    const courseWords = searchText('onboarding.search.courseWords');
    const courses = planner.courses.map((c) => ({ c, title: c.name, keywords: `${c.teacher} ${c.room} ${courseWords}` }));
    out.push(
      ...rank(courses, q, 3).map(
        ({ c }): Row => ({
          key: `c:${c.id}`,
          group: 'courses',
          title: c.name || t('common.untitled'),
          icon: 'book',
          color: colorVar(c.color),
          path: c.teacher || undefined,
          run: () => store.openCourse(c.id),
        }),
      ),
    );
    out.push(...pages);
    // Rows found by their values ("Tolkien" finds the book by its author).
    out.push(
      ...databases
        .findRows(q, 5)
        .filter(({ row }) => !hits.some((h) => h.id === row.id))
        .map(
          ({ row, prop, text }): Row => ({
            key: `r:${row.id}`,
            group: 'rows',
            title: store.byId.get(row.id)?.title || t('common.untitled'),
            emoji: store.byId.get(row.id)?.icon || undefined,
            icon: store.byId.get(row.id)?.icon ? undefined : 'page',
            path: t('onboarding.search.rowPath', { database: store.byId.get(row.dbId)?.title || t('common.untitledDatabase'), property: prop.name, value: text }),
            run: () => store.open(row.id),
            side: () => split.show(row.id),
          }),
        ),
    );
    const tagWords = (list: string[]) => list.map((tag) => `#${tag} ${tag}`).join(' ');
    const assignments = planner.live.map((a) => ({
      a,
      title: a.title,
      keywords: `${a.notes} ${a.courseId ? (planner.courseById.get(a.courseId)?.name ?? '') : ''} ${tagWords(a.tags)}`,
    }));
    out.push(...rank(assignments, q, 6).map(({ a }) => assignmentRow(a)));
    const events = planner.liveEvents.map((e) => ({ e, title: e.title, keywords: `${e.location} ${e.notes} ${tagWords(e.tags)}` }));
    out.push(
      ...rank(events, q, 5).map(
        ({ e }): Row => ({
          key: `e:${e.id}`,
          group: 'events',
          title: e.title || t('common.untitled'),
          icon: 'calendar',
          color: planner.eventColor(e),
          path: e.location || undefined,
          meta: e.repeat !== 'none' ? t('onboarding.search.repeats', { when: eventWhen(e) }) : eventWhen(e),
          run: () => {
            calendar.show(e.startDate);
            planner.openEvent(e.id);
          },
        }),
      ),
    );
    const files = library.live.map((f) => ({ f, title: f.name, keywords: `${searchText(KINDS[fileKind(f)].labelKey)} ${tagWords(f.tags)}` }));
    out.push(
      ...rank(files, q, 5).map(
        ({ f }): Row => ({
          key: `f:${f.id}`,
          group: 'files',
          title: f.name,
          file: f,
          path: KINDS[fileKind(f)].label,
          meta: formatBytes(f.size),
          run: () => library.preview(f.id),
        }),
      ),
    );
    if (!q.startsWith('#')) out.push(...tagRows);
    out.push(...rank(GOTO, q, 3).map((g): Row => ({ key: `g:${g.id}`, group: 'goTo', title: g.title, icon: g.icon, run: g.run })));
    out.push(
      {
        key: 'new-page',
        group: 'create',
        title: t('onboarding.search.newPage', { query: q }),
        icon: 'page-plus',
        meta: t('onboarding.search.kinds.page'),
        run: () => void store.create(null, { title: q }),
      },
      {
        key: 'new-database',
        group: 'create',
        title: t('onboarding.search.newDatabase', { query: q }),
        icon: 'database',
        meta: t('onboarding.search.kinds.database'),
        run: () => void databases.create({ title: q }),
      },
      {
        key: 'new-assignment',
        group: 'create',
        title: t('onboarding.search.newAssignment', { query: q }),
        icon: 'assignment',
        meta: t('onboarding.search.kinds.assignment'),
        run: () => planner.newAssignment({ title: q }),
      },
      {
        key: 'new-event',
        group: 'create',
        title: t('onboarding.search.newEvent', { query: q }),
        icon: 'calendar',
        meta: t('onboarding.search.kinds.event'),
        run: () => planner.newEvent({ title: q, startDate: clock.today, endDate: clock.today, startTime: '09:00', endTime: '10:00' }),
      },
    );
    return out;
  });

  function choose(i: number, beside = false) {
    const row = rows[i];
    if (!row) return;
    close();
    if (beside && row.side) row.side();
    else row.run();
  }

  function onKey(e: KeyboardEvent) {
    const total = rows.length;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      selected = total ? (selected + 1) % total : 0;
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      selected = total ? (selected - 1 + total) % total : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected, e.altKey);
    }
  }

  $effect(() => {
    const i = selected;
    list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  const nothingFound = $derived(query.trim() !== '' && rows.every((r) => r.group === 'create'));
</script>

<Modal onclose={close} width={640} top="16vh" label={t('common.views.search')} glass>
  <div class="search">
    <Icon name="search" size={20} stroke={2} />
    <input
      bind:this={input}
      bind:value={query}
      oninput={onInput}
      onkeydown={onKey}
      placeholder={t('onboarding.search.placeholder')}
      spellcheck="false"
      autocomplete="off"
    />
  </div>
  {#if rows.length}
    <div class="results" bind:this={list}>
      {#if nothingFound}
        <div class="none">{t('onboarding.search.nothingMatches', { query: query.trim() })}</div>
      {/if}
      {#each rows as row, i (row.key)}
        {#if i === 0 || rows[i - 1].group !== row.group}
          <div class="group">{t(GROUP_LABELS[row.group])}</div>
        {/if}
        <button
          class="hit"
          class:selected={i === selected}
          data-index={i}
          onmousemove={() => (selected = i)}
          onclick={() => choose(i)}
        >
          <span class="hit-icon" style:color={row.color}>
            {#if row.file}<FileTile file={row.file} size={26} />
            {:else if row.emoji}<span class="emoji"><PageIcon icon={row.emoji} /></span>
            {:else if row.icon}<Icon name={row.icon} size={18} />{/if}
          </span>
          <span class="hit-main">
            <span class="hit-line">
              <span class="hit-title">{row.title}</span>
              {#if row.path}<span class="hit-path">{row.path}</span>{/if}
            </span>
            {#if row.snippet}
              <span class="hit-snippet">
                {#each parts(row.snippet) as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
              </span>
            {/if}
          </span>
          {#if row.meta}<span class="hit-time {row.metaClass ?? ''}">{row.meta}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="foot">
      <span class="hint"><kbd>{keyName('ArrowUp')}</kbd><kbd>{keyName('ArrowDown')}</kbd> {t('onboarding.search.navigate')}</span>
      <span class="hint"><kbd>{keyName('Enter')}</kbd> {t('common.actions.open')}</span>
      <span class="hint"><kbd>{keyName('Escape')}</kbd> {t('common.actions.close')}</span>
    </div>
  {/if}
</Modal>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 56px;
    /* The search icon (20px, centred 30px in) shares a column with the
       result icons below (6px list + 10px row padding + half of 28px). */
    padding: 0 20px;
    flex: none;
    color: var(--text-3);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    background: transparent;
    font-size: 19px;
    font-weight: 400;
    letter-spacing: -0.014em;
    color: var(--text);
  }
  input::placeholder {
    color: var(--text-3);
  }
  .results {
    overflow-y: auto;
    padding: 6px;
    box-shadow: inset 0 1px 0 var(--hairline);
  }
  .group {
    padding: 8px 10px 4px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    letter-spacing: 0.01em;
    color: var(--text-3);
  }
  .hit {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 6px 12px 6px 10px;
    border-radius: var(--r-md);
    text-align: left;
  }
  .hit.selected {
    background: var(--fill-2);
  }
  .hit-icon {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .emoji {
    font-size: 19px;
    line-height: 1;
  }
  .hit-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hit-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .hit-title {
    flex: none;
    max-width: 70%;
    font-size: var(--fs-callout);
    font-weight: var(--fw-550);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hit-path {
    min-width: 0;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hit-snippet {
    font-size: var(--fs-ui);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  mark {
    background: none;
    color: var(--text);
    font-weight: var(--fw-650);
  }
  .hit-time {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .hit-time.overdue {
    color: var(--danger);
  }
  .hit-time.today {
    color: var(--c-orange);
  }
  .none {
    padding: 16px 16px 8px;
    text-align: center;
    color: var(--text-3);
    font-size: var(--fs-body-ui);
  }
  .foot {
    flex: none;
    display: flex;
    gap: 16px;
    height: 40px;
    align-items: center;
    padding: 0 16px;
    box-shadow: inset 0 1px 0 var(--hairline);
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hint kbd + kbd {
    margin-left: -3px;
  }
</style>
