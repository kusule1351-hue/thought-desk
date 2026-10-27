<script lang="ts">
  /** One assignment in a grouped list: check, title, details, due date. */
  import Icon from '../components/Icon.svelte';
  import StatusCheck from './StatusCheck.svelte';
  import { clock } from '../clock.svelte';
  import { dueState, formatDue, formatTime } from '../dates';
  import { assignmentMenuItems } from '../item-actions';
  import { planner } from '../planner.svelte';
  import { formatPercent, formatPoints, isGraded, scorePercent } from '../grades';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import type { Assignment } from '../types';
  import { t, type MessageKey, type PluralKey } from '../i18n';
  import { fmt } from '../i18n/format';

  let { a, compact = false, showCourse = true }: { a: Assignment; compact?: boolean; showCourse?: boolean } = $props();

  /** Priority 1–3 (0 is none). */
  const PRIORITIES: Partial<Record<number, Exclude<MessageKey, PluralKey>>> = {
    1: 'planner.assignment.priority.low',
    2: 'planner.assignment.priority.medium',
    3: 'planner.assignment.priority.high',
  };

  const course = $derived(a.courseId ? planner.courseById.get(a.courseId) : undefined);
  const urgency = $derived(dueState(a, clock.today, clock.time));
  const page = $derived(a.pageId ? store.byId.get(a.pageId) : undefined);
  // In the calendar the day is already known, so show only the time.
  const due = $derived(compact ? (a.dueTime ? formatTime(a.dueTime) : '') : formatDue(a.dueDate, a.dueTime, clock.today));

  let menuOpen = $state(false);
  function menu(e: MouseEvent, anchor?: Element) {
    e.preventDefault();
    e.stopPropagation();
    const items = assignmentMenuItems(a.id);
    const onClose = () => (menuOpen = false);
    menuOpen = true;
    if (anchor) ui.openMenuAt(anchor, items, { alignRight: true, onClose });
    else ui.openMenu({ x: e.clientX, y: e.clientY, items, onClose });
  }
</script>

<div
  class="group-row a-row"
  class:done={a.status === 'done'}
  class:menu-open={menuOpen}
  class:compact
  role="button"
  tabindex="0"
  onclick={() => planner.openAssignment(a.id)}
  onkeydown={(e) => e.key === 'Enter' && planner.openAssignment(a.id)}
  oncontextmenu={menu}
>
  <StatusCheck
    done={a.status === 'done'}
    color={planner.courseColor(a.courseId)}
    label={a.status === 'done' ? t('planner.markNotDone') : t('planner.markDone')}
    ontoggle={() => planner.toggleDone(a.id)}
  />
  <div class="main">
    <span class="title">{a.title || t('common.untitled')}</span>
    {#if (showCourse && course) || a.status === 'doing' || a.priority || a.fileIds.length || (page && !page.deletedAt) || isGraded(a)}
      <span class="meta">
        {#if isGraded(a)}
          <span class="bit grade" data-tip={t('planner.assignment.points', { score: formatPoints(a.score!), max: formatPoints(a.maxScore!) })}
            >{formatPercent(scorePercent(a))}</span
          >
        {/if}
        {#if showCourse && course}<span class="bit"><span class="dot" style:--dot={planner.courseColor(course.id)}></span>{course.name}</span>{/if}
        {#if a.status === 'doing'}<span class="bit doing"><Icon name="clock" size={12} stroke={2.2} />{t('planner.assignment.inProgress')}</span>{/if}
        {#if a.priority}
          {@const prio = PRIORITIES[a.priority]}
          <span class="bit prio p{a.priority}"><Icon name="flag" size={12} stroke={2.2} />{prio ? t(prio) : ''}</span>
        {/if}
        {#if a.fileIds.length}<span class="bit"><Icon name="paperclip" size={12} stroke={2.2} />{fmt.number(a.fileIds.length)}</span>{/if}
        {#if page && !page.deletedAt}<span class="bit"><Icon name="note" size={12} stroke={2.2} />{t('planner.assignment.hasNotes')}</span>{/if}
      </span>
    {/if}
  </div>
  {#if due}<span class="due {urgency}">{due}</span>{/if}
  <button class="act" tabindex="-1" onclick={(e) => menu(e, e.currentTarget as Element)} data-tip={t('common.actions.more')} aria-label={t('common.actions.more')}
    ><Icon name="more" size={15} /></button
  >
</div>

<style>
  .a-row {
    gap: 12px;
    min-height: 52px;
    padding: 8px 8px 8px 16px;
    cursor: default;
    outline: none;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .a-row.compact {
    min-height: 44px;
    padding-left: 12px;
  }
  /* Rounded hover that respects the group's corners. */
  .a-row:hover,
  .a-row.menu-open {
    background: var(--fill);
  }
  .a-row:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .a-row:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .a-row:focus-visible {
    box-shadow: inset 0 0 0 1.5px var(--focus);
  }
  .a-row + :global(.a-row)::before {
    left: 46px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    font-size: var(--fs-callout);
    line-height: 20px;
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color var(--dur) var(--ease);
  }
  .compact .title {
    font-size: var(--fs-body-ui);
  }
  .done .title {
    color: var(--text-3);
    text-decoration: line-through;
    text-decoration-color: var(--text-4);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    font-size: var(--fs-footnote);
    line-height: 16px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
  }
  .bit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .bit :global(svg) {
    flex: none;
  }
  .doing {
    color: var(--tint);
  }
  .prio.p1 {
    color: var(--c-blue);
  }
  .prio.p2 {
    color: var(--c-orange);
  }
  .prio.p3 {
    color: var(--c-red);
  }
  .due {
    flex: none;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .due.overdue {
    color: var(--danger);
  }
  .due.today {
    color: var(--c-orange);
  }
  .due.soon {
    color: var(--text-2);
  }
  .due.done {
    color: var(--text-4);
  }
  .act {
    flex: none;
    display: grid;
    place-items: center;
    width: var(--h-xs);
    height: var(--h-xs);
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .a-row:hover .act,
  .a-row.menu-open .act {
    opacity: 1;
  }
  .act:hover {
    background: var(--fill-2);
    color: var(--text);
  }
  .grade {
    color: var(--text-2);
    font-weight: var(--fw-600);
    font-variant-numeric: tabular-nums;
  }
</style>
