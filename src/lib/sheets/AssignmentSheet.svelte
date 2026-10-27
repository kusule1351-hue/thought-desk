<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Backlinks from '../ui/Backlinks.svelte';
  import TagRow from '../ui/TagRow.svelte';
  import StatusCheck from '../ui/StatusCheck.svelte';
  import { clock } from '../clock.svelte';
  import { colorVar, nextColor } from '../colors';
  import { addDays, dueState, formatDue, startOfWeek } from '../dates';
  import { openNotesPage } from '../item-actions';
  import { courseCategories, formatPercent, formatWeight, letterGrade, scorePercent } from '../grades';
  import { t } from '../i18n';
  import { library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { relativeWhen, formatBytes } from '../time';
  import { ui, type SheetState } from '../ui.svelte';
  import type { AssignmentPatch, AssignmentStatus, FileMeta } from '../types';

  let { sheet }: { sheet: SheetState<AssignmentPatch> } = $props();

  // The sheet is re-created per item, and closing clears the prop, so keep
  // what's needed after closing.
  // svelte-ignore state_referenced_locally
  const { id, onCreated } = sheet;
  const existing = $derived(id ? planner.assignmentById.get(id) : undefined);
  // svelte-ignore state_referenced_locally
  let draft = $state({
    title: '',
    courseId: null as string | null,
    dueDate: null as string | null,
    dueTime: null as string | null,
    status: 'todo' as AssignmentStatus,
    priority: 0,
    notes: '',
    fileIds: [] as string[],
    ...sheet.draft,
  });
  const form = $derived(existing ?? draft);
  const course = $derived(form.courseId ? planner.courseById.get(form.courseId) : undefined);
  const page = $derived(existing?.pageId ? store.byId.get(existing.pageId) : undefined);
  const files = $derived(form.fileIds.map((fid) => library.byId.get(fid)).filter((f): f is FileMeta => !!f && !f.deletedAt));
  const urgency = $derived(dueState(form, clock.today, clock.time));
  const percent = $derived(existing ? scorePercent(existing) : null);

  /** A number field's value: empty means "not set". */
  function points(raw: string): number | null {
    const n = Number(raw.replace(',', '.'));
    return raw.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
  }

  function categoryMenu(e: MouseEvent) {
    const current = existing?.category ?? '';
    const weights = course?.weights ?? {};
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: t('sheets.assignment.noCategoryItem'), icon: 'x', checked: !current, action: () => set({ category: '' }) },
        ...courseCategories(course, planner.assignments).map((name) => ({
          label: name,
          hint: name in weights ? formatWeight(weights[name]) : undefined,
          checked: current === name,
          action: () => set({ category: name }),
        })),
        { separator: true },
        {
          label: t('sheets.assignment.newCategory'),
          icon: 'plus',
          action: async () => {
            const res = await ui.prompt({
              title: t('sheets.assignment.newCategoryTitle'),
              placeholder: t('sheets.categoryPlaceholder'),
              confirmLabel: t('common.actions.add'),
              icon: 'assignment',
            });
            if (res) set({ category: res.value.trim() });
          },
        },
      ],
      { alignRight: true },
    );
  }

  let titleEl: HTMLInputElement;
  let dropping = $state(false);

  onMount(() => {
    if (!existing) titleEl.focus();
  });

  /** Edits the live assignment (autosaved) or the draft of a new one. */
  function set(patch: AssignmentPatch, { typing = false } = {}) {
    if (existing) planner.updateAssignment(existing.id, patch, { immediate: !typing });
    else Object.assign(draft, patch);
  }

  async function add() {
    if (!draft.title.trim()) {
      titleEl.focus();
      return;
    }
    ui.assignmentSheet = null;
    const a = await planner.addAssignment({ ...draft, title: draft.title.trim() });
    if (a) onCreated?.(a.id);
  }

  /** Closing never loses work: a new assignment with a title is kept. */
  function close() {
    if (!existing && draft.title.trim()) void add();
    else ui.assignmentSheet = null;
  }

  function cancel() {
    ui.assignmentSheet = null;
  }

  function courseMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: t('sheets.coursePicker.noCourse'), icon: 'x', checked: !form.courseId, action: () => set({ courseId: null }) },
        ...(planner.courses.length ? [{ separator: true } as const] : []),
        ...planner.courses.map((c) => ({
          label: c.name || t('common.untitled'),
          dot: colorVar(c.color),
          checked: form.courseId === c.id,
          action: () => set({ courseId: c.id }),
        })),
        { separator: true },
        {
          label: t('sheets.coursePicker.newCourse'),
          icon: 'plus',
          action: async () => {
            const res = await ui.prompt({
              title: t('sheets.coursePicker.newCourseTitle'),
              placeholder: t('sheets.coursePicker.namePlaceholder'),
              confirmLabel: t('sheets.coursePicker.addCourse'),
              icon: 'book',
              color: nextColor(planner.courses.map((c) => c.color)),
            });
            if (!res) return;
            const c = await planner.addCourse(res.value, res.color);
            if (c) set({ courseId: c.id });
          },
        },
      ],
      { alignRight: true },
    );
  }

  const quickDates = $derived([
    { label: t('common.today'), date: clock.today },
    { label: t('common.tomorrow'), date: addDays(clock.today, 1) },
    { label: t('sheets.assignment.nextWeek'), date: addDays(startOfWeek(clock.today, 1), 7) },
  ]);

  /** "Created just now", "Created 3 days ago", "Created Oct 20, 2025". */
  function createdText(ms: number): string {
    const when = relativeWhen(ms);
    if (when.kind === 'now') return t('sheets.created.now');
    if (when.kind === 'relative') return t('sheets.created.relative', { when: when.text });
    return t('sheets.created.date', { date: when.text });
  }

  function attach(list: FileMeta[]) {
    const ids = [...form.fileIds];
    for (const f of list) if (!ids.includes(f.id)) ids.push(f.id);
    set({ fileIds: ids });
  }

  function detach(fid: string) {
    set({ fileIds: form.fileIds.filter((x) => x !== fid) });
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropping = true;
  }

  async function onDrop(e: DragEvent) {
    dropping = false;
    const list = Array.from(e.dataTransfer?.files ?? []);
    if (!list.length) return;
    e.preventDefault();
    attach(await library.add(list));
  }

  async function notesPage() {
    if (existing) {
      await openNotesPage('assignment', existing.id);
      return;
    }
    // A new assignment is saved first, so the page can link back to it.
    if (!draft.title.trim()) {
      titleEl.focus();
      return;
    }
    ui.assignmentSheet = null;
    const a = await planner.addAssignment({ ...draft, title: draft.title.trim() });
    if (!a) return;
    onCreated?.(a.id);
    await openNotesPage('assignment', a.id);
  }
</script>

<Modal onclose={close} label={existing ? t('sheets.assignment.label') : t('sheets.assignment.newLabel')}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sheet" class:dropping ondragover={onDragOver} ondragleave={(e) => e.currentTarget === e.target && (dropping = false)} ondrop={onDrop}>
    <header class="modal-head">
      <StatusCheck
        done={form.status === 'done'}
        color={planner.courseColor(form.courseId)}
        size={20}
        label={form.status === 'done' ? t('sheets.assignment.markNotDone') : t('sheets.assignment.markDone')}
        ontoggle={() => set({ status: form.status === 'done' ? 'todo' : 'done' })}
      />
      <input
        class="title"
        class:done={form.status === 'done'}
        bind:this={titleEl}
        value={form.title}
        placeholder={existing ? t('common.untitled') : t('sheets.assignment.titlePlaceholder')}
        spellcheck="false"
        oninput={(e) => set({ title: e.currentTarget.value }, { typing: true })}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (existing) close();
            else void add();
          }
        }}
      />
      <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
    </header>

    <div class="modal-body">
      <div class="group">
        <div class="group-row">
          <div class="row-label">{t('common.course')}</div>
          <button class="btn small raised picker" onclick={courseMenu}>
            {#if course}<span class="dot" style:--dot={colorVar(course.color)}></span>{course.name || t('common.untitled')}{:else}<span class="muted">{t('sheets.coursePicker.none')}</span>{/if}
            <Icon name="chevron-down" size={12} stroke={2.2} />
          </button>
        </div>
        <div class="group-row due-row">
          <div class="row-label">
            {t('sheets.assignment.due')}
            <small class="due-state {urgency}">{form.dueDate ? formatDue(form.dueDate, form.dueTime, clock.today) : t('sheets.assignment.noDueDate')}</small>
          </div>
          <div class="due">
            <div class="due-fields">
              <label class="field date">
                <input
                  type="date"
                  value={form.dueDate ?? ''}
                  aria-label={t('sheets.assignment.dueDate')}
                  onchange={(e) => set({ dueDate: e.currentTarget.value || null })}
                />
              </label>
              {#if form.dueDate}
                {#if form.dueTime !== null}
                  <label class="field time">
                    <input type="time" value={form.dueTime} aria-label={t('sheets.assignment.dueTime')} onchange={(e) => set({ dueTime: e.currentTarget.value || null })} />
                  </label>
                  <button class="icon-btn" onclick={() => set({ dueTime: null })} data-tip={t('sheets.assignment.removeTime')}><Icon name="x" size={14} /></button>
                {:else}
                  <button class="btn small raised" onclick={() => set({ dueTime: '23:59' })}><Icon name="clock" size={13} stroke={2} /> {t('sheets.assignment.addTime')}</button>
                {/if}
              {/if}
            </div>
            <div class="quick">
              {#each quickDates as q, i (i)}
                <button class="chip" class:on={form.dueDate === q.date} onclick={() => set({ dueDate: q.date })}>{q.label}</button>
              {/each}
              {#if form.dueDate}<button class="chip" onclick={() => set({ dueDate: null })}>{t('sheets.assignment.noDue')}</button>{/if}
            </div>
          </div>
        </div>
        <div class="group-row">
          <div class="row-label">{t('sheets.assignment.status')}</div>
          <Segmented
            label={t('sheets.assignment.status')}
            value={form.status}
            onchange={(v) => set({ status: v })}
            options={[
              { value: 'todo', label: t('sheets.assignment.statusTodo') },
              { value: 'doing', label: t('sheets.assignment.statusDoing') },
              { value: 'done', label: t('sheets.assignment.statusDone') },
            ]}
          />
        </div>
        <div class="group-row">
          <div class="row-label">{t('sheets.assignment.priority')}</div>
          <Segmented
            label={t('sheets.assignment.priority')}
            value={form.priority}
            onchange={(v) => set({ priority: v })}
            options={[
              { value: 0, label: t('sheets.assignment.priorityNone') },
              { value: 1, label: t('sheets.assignment.priorityLow') },
              { value: 2, label: t('sheets.assignment.priorityMedium') },
              { value: 3, label: t('sheets.assignment.priorityHigh') },
            ]}
          />
        </div>
      </div>

      {#if existing}
        <div class="group tags-group">
        <div class="group-row tags-row">
          <div class="row-label">{t('common.tags')}</div>
          <TagRow table="assignments" id={existing.id} compact />
        </div>
        </div>
      {/if}

      {#if existing}
        <h3 class="group-title">{t('sheets.assignment.grade')}</h3>
        <div class="group">
          <div class="group-row">
            <div class="row-label">
              {t('sheets.assignment.score')}
              <small>{percent !== null ? `${formatPercent(percent)} · ${letterGrade(percent)}` : t('sheets.assignment.scoreHint')}</small>
            </div>
            <div class="score">
              <label class="field num">
                <input
                  type="number"
                  inputmode="decimal"
                  min="0"
                  step="any"
                  value={existing.score ?? ''}
                  placeholder="—"
                  aria-label={t('sheets.assignment.pointsEarned')}
                  oninput={(e) => set({ score: points(e.currentTarget.value) }, { typing: true })}
                />
              </label>
              <span class="slash">/</span>
              <label class="field num">
                <input
                  type="number"
                  inputmode="decimal"
                  min="0"
                  step="any"
                  value={existing.maxScore ?? ''}
                  placeholder="—"
                  aria-label={t('sheets.assignment.pointsPossible')}
                  oninput={(e) => set({ maxScore: points(e.currentTarget.value) }, { typing: true })}
                />
              </label>
            </div>
          </div>
          <div class="group-row">
            <div class="row-label">
              {t('sheets.assignment.category')}
              {#if course && Object.keys(course.weights).length}<small>{course.name ? t('sheets.assignment.weightedIn', { course: course.name }) : t('sheets.assignment.weightedInCourse')}</small>{/if}
            </div>
            <button class="btn small raised picker" onclick={categoryMenu}>
              {#if existing.category}{existing.category}{:else}<span class="muted">{t('sheets.assignment.noCategory')}</span>{/if}
              <Icon name="chevron-down" size={12} stroke={2.2} />
            </button>
          </div>
        </div>
      {/if}

      <h3 class="group-title">{t('common.notes')}</h3>
      <div class="group">
        <div class="group-row stack">
          <textarea
            class="field notes"
            value={form.notes}
            placeholder={t('sheets.assignment.notesPlaceholder')}
            oninput={(e) => set({ notes: e.currentTarget.value }, { typing: true })}
          ></textarea>
        </div>
        <div class="group-row">
          <div class="row-label">
            {t('sheets.notesPage')}
            <small>{page && !page.deletedAt ? t('sheets.assignment.notesPageLinked') : t('sheets.assignment.notesPageNone')}</small>
          </div>
          {#if page && !page.deletedAt}
            <button class="btn small raised" onclick={notesPage}>
              {#if page.icon}<span><PageIcon icon={page.icon} /></span>{:else}<Icon name="page" size={14} />{/if}
              <span class="page-name">{page.title || t('common.untitled')}</span>
              <Icon name="arrow-right" size={13} stroke={2} />
            </button>
          {:else}
            <button class="btn small raised" onclick={notesPage}><Icon name="page-plus" size={14} /> {t('sheets.createPage')}</button>
          {/if}
        </div>
      </div>

      <h3 class="group-title">
        <span>{t('sheets.assignment.attachments')}</span>
        <button
          class="btn small raised"
          onclick={(e) => ui.pickFile(e.currentTarget as Element, attach, { exclude: form.fileIds })}
        ><Icon name="paperclip" size={13} stroke={2} /> {t('sheets.assignment.attach')}</button>
      </h3>
      <div class="group">
        {#each files as f (f.id)}
          <div class="group-row file">
            <button class="file-main" onclick={() => library.preview(f.id)}>
              <FileTile file={f} size={30} />
              <span class="file-text">
                <span class="file-name">{f.name}</span>
                <span class="file-meta">{f.missing ? t('sheets.assignment.missing') : formatBytes(f.size)}</span>
              </span>
            </button>
            <button class="icon-btn" onclick={() => library.open(f.id)} data-tip={t('common.actions.open')}><Icon name="external" size={15} /></button>
            <button class="icon-btn" onclick={() => detach(f.id)} data-tip={t('common.actions.remove')}><Icon name="x" size={15} /></button>
          </div>
        {:else}
          <div class="group-row empty-files">
            <Icon name="upload" size={15} stroke={2} />
            {t('sheets.assignment.dropFiles')}
          </div>
        {/each}
      </div>

      {#if existing}<Backlinks id={existing.id} inSheet />{/if}
    </div>

    <footer class="modal-foot">
      {#if existing}
        <span>{createdText(existing.createdAt)}</span>
        <div class="actions">
          <button class="btn small destructive" onclick={() => planner.trash('assignments', existing.id)}>{t('common.actions.moveToTrash')}</button>
          <button class="btn small primary" onclick={close}>{t('common.actions.done')}</button>
        </div>
      {:else}
        <span>{t('sheets.assignment.autosave')}</span>
        <div class="actions">
          <button class="btn small" onclick={cancel}>{t('common.actions.cancel')}</button>
          <button class="btn small primary" onclick={add} disabled={!draft.title.trim()}>{t('sheets.assignment.add')}</button>
        </div>
      {/if}
    </footer>

    {#if dropping}
      <div class="drop-hint"><Icon name="paperclip" size={18} stroke={2} /> {t('sheets.assignment.dropToAttach')}</div>
    {/if}
  </div>
</Modal>

<style>
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .title {
    flex: 1;
    min-width: 0;
    height: 36px;
    border: none;
    background: transparent;
    font-size: 17px;
    font-weight: var(--fw-650);
    letter-spacing: -0.016em;
    color: var(--text);
  }
  .title.done {
    color: var(--text-3);
    text-decoration: line-through;
    text-decoration-color: var(--text-4);
  }
  .picker {
    gap: 8px;
    max-width: 240px;
  }
  .muted {
    color: var(--text-3);
  }
  .picker :global(svg) {
    color: var(--text-3);
  }

  .due-row {
    align-items: flex-start;
    padding-top: 12px;
    padding-bottom: 12px;
  }
  .due-state {
    font-variant-numeric: tabular-nums;
  }
  .due-state.overdue {
    color: var(--danger) !important;
  }
  .due-state.today {
    color: var(--c-orange) !important;
  }
  .due {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .due-fields {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .field.date {
    width: 148px;
  }
  .field.time {
    width: 128px;
  }
  .quick {
    display: flex;
    gap: 6px;
  }
  .quick .chip {
    height: 24px;
    padding: 0 10px;
    font-size: var(--fs-footnote);
    background: var(--raised);
    box-shadow: 0 0 0 0.5px var(--hairline);
  }
  .quick .chip.on {
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: none;
  }

  .tags-group {
    margin-top: 8px;
  }
  .score {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .field.num {
    width: 80px;
  }
  .field.num input {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .slash {
    color: var(--text-3);
  }
  .tags-row {
    min-height: 48px;
  }
  .modal-body :global(.backlinks) {
    margin-top: 0;
  }
  .notes {
    min-height: 84px;
  }
  .page-name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file {
    gap: 4px;
    padding: 6px 10px 6px 10px;
  }
  .file-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 2px 6px 2px 6px;
    border-radius: var(--r-sm);
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .file-main:hover {
    background: var(--fill);
  }
  .file-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .file-name {
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-meta {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .empty-files {
    justify-content: center;
    gap: 8px;
    min-height: 56px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }

  .drop-hint {
    position: absolute;
    inset: 8px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    box-shadow: inset 0 0 0 2px var(--accent);
    font-size: var(--fs-callout);
    font-weight: var(--fw-600);
    color: var(--text);
    pointer-events: none;
    z-index: 2;
  }
</style>
