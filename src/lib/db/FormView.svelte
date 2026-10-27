<script lang="ts">
  /**
   * A form: a quick way to add a row, one question per property. Submit
   * adds the row (from the view's template, running automations) and the
   * form clears for the next one. "Edit form" chooses, orders and requires
   * the questions.
   */
  import { tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Popover from './Popover.svelte';
  import DatePicker from './DatePicker.svelte';
  import RelationPicker from './RelationPicker.svelte';
  import Switch from '../ui/Switch.svelte';
  import { colorVar } from '../colors';
  import { databases, FORM_TYPES } from '../databases.svelte';
  import { library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { formatDateValue, options, typeInfo } from './schema';
  import type { CellValue, DateValue, DbRow, DbView, Property } from '../types';

  let { dbId, view }: { dbId: string; view: DbView } = $props();

  type Form = NonNullable<DbView['config']['form']>;
  const form = $derived<Form>(view.config.form ?? { fields: [] });
  const fields = $derived(
    form.fields.flatMap((f) => {
      const p = databases.prop(dbId, f.prop);
      return p && FORM_TYPES.has(p.type) ? [{ prop: p, required: !!f.required }] : [];
    }),
  );
  const dbTitle = $derived(store.byId.get(dbId)?.title || t('common.untitledDatabase'));

  /** Typed answers (text, numbers, links, tags) and picked ones (choices, dates…). */
  let texts = $state<Record<string, string>>({});
  let values = $state<Record<string, CellValue>>({});
  let errors = $state<Record<string, string>>({});
  let sent = $state.raw<DbRow | null>(null);
  let busy = $state(false);
  let editing = $state(false);
  let picker = $state<{ prop: Property; anchor: Element } | null>(null);

  const TYPED = new Set(['title', 'text', 'number', 'url', 'email', 'phone', 'tags']);
  const draft = $derived<DbRow>({ id: '__form', dbId, sortKey: '', number: 0, cells: values });

  function answered(p: Property): boolean {
    if (TYPED.has(p.type)) return !!(texts[p.id] ?? '').trim();
    const v = values[p.id];
    return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length);
  }

  async function submit() {
    if (busy) return;
    const next: Record<string, string> = {};
    const cells: Record<string, CellValue> = {};
    let title = '';
    let tagList: string[] = [];
    for (const { prop: p, required } of fields) {
      if (required && !answered(p) && p.type !== 'checkbox') {
        next[p.id] = t('dbViews.form.answerRequired');
        continue;
      }
      if (p.type === 'title') title = (texts[p.id] ?? '').trim();
      else if (p.type === 'tags') tagList = databases.parse(texts[p.id] ?? '', p) as string[];
      else if (TYPED.has(p.type)) {
        const raw = texts[p.id] ?? '';
        if (!raw.trim()) continue;
        const v = databases.parse(raw, p);
        if (p.type === 'number' && v === null) next[p.id] = t('dbViews.form.notANumber', { text: raw.trim() });
        else cells[p.id] = v;
      } else if (answered(p)) cells[p.id] = $state.snapshot(values[p.id]) as CellValue;
    }
    errors = next;
    if (Object.keys(next).length) {
      await tick();
      document.querySelector('.form .q.bad input, .form .q.bad textarea, .form .q.bad button')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    busy = true;
    const row = await databases.addRow(dbId, { view, title, cells, tags: tagList });
    busy = false;
    if (!row) return;
    sent = row;
    texts = {};
    values = {};
  }

  // ------------------------------------------------------------- editing

  function patch(p: Partial<Form>) {
    databases.updateView(dbId, view.id, { form: { ...$state.snapshot(form), ...p } });
  }

  function setField(i: number, f: Partial<Form['fields'][number]>) {
    patch({ fields: form.fields.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  }

  function moveField(i: number, by: number) {
    const list = [...form.fields];
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    patch({ fields: list });
  }

  const unused = $derived(databases.props(dbId).filter((p) => FORM_TYPES.has(p.type) && !form.fields.some((f) => f.prop === p.id)));

  function addQuestion(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      unused.length
        ? unused.map((p) => ({ label: p.name, icon: typeInfo(p.type).icon, action: () => patch({ fields: [...form.fields, { prop: p.id }] }) }))
        : [{ header: t('dbViews.form.allPropertiesUsed') }],
    );
  }

  const indexOf = (p: Property) => form.fields.findIndex((f) => f.prop === p.id);

  function toggle(p: Property, id: string) {
    if (p.type === 'multiSelect') {
      const cur = Array.isArray(values[p.id]) ? (values[p.id] as string[]) : [];
      values[p.id] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    } else values[p.id] = values[p.id] === id ? null : id;
    delete errors[p.id];
  }

  function addFiles(e: MouseEvent, p: Property) {
    const cur = Array.isArray(values[p.id]) ? (values[p.id] as string[]) : [];
    ui.pickFile(e.currentTarget as Element, (files) => (values[p.id] = [...cur, ...files.map((f) => f.id)]), { exclude: cur, multiple: true });
  }

  const inputType = (p: Property) => (p.type === 'email' ? 'email' : p.type === 'url' ? 'url' : p.type === 'phone' ? 'tel' : 'text');
  const placeholder = (p: Property) =>
    p.type === 'tags'
      ? t('dbViews.form.tagsPlaceholder')
      : p.type === 'number'
        ? '0'
        : p.type === 'url'
          ? 'https://'
          : p.type === 'title'
            ? t('common.name')
            : t('dbViews.form.answerPlaceholder');

  /** The heading once a row is added: its title, if it was given one. */
  const addedHeading = (row: DbRow) => {
    const title = store.byId.get(row.id)?.title;
    return title ? t('dbViews.form.addedTitle', { title, database: dbTitle }) : t('dbViews.form.added', { database: dbTitle });
  };

  /** A relation question before rows are picked: the database they come from. */
  const linkHint = (p: Property) => {
    const title = store.byId.get(p.config.database ?? '')?.title;
    return title ? t('dbViews.form.linkTo', { database: title }) : t('dbViews.form.linkToRows');
  };
</script>

<div class="form-wrap">
  <div class="form" class:editing>
    <div class="top">
      {#if editing}
        <input class="f-title-input" value={form.title ?? ''} placeholder={dbTitle} oninput={(e) => patch({ title: (e.currentTarget as HTMLInputElement).value })} aria-label={t('dbViews.form.titleLabel')} />
        <textarea class="f-intro-input" rows="2" value={form.intro ?? ''} placeholder={t('dbViews.form.introPlaceholder')} oninput={(e) => patch({ intro: (e.currentTarget as HTMLTextAreaElement).value })} aria-label={t('dbViews.form.introLabel')}></textarea>
      {:else}
        <h2 class="f-title">{form.title || dbTitle}</h2>
        {#if form.intro}<p class="f-intro">{form.intro}</p>{/if}
      {/if}
      <button class="btn small raised edit-btn" onclick={() => (editing = !editing)}>
        <Icon name={editing ? 'check' : 'pencil'} size={13} />
        {editing ? t('common.actions.done') : t('dbViews.form.edit')}
      </button>
    </div>

    {#if sent && !editing}
      <div class="sent">
        <span class="sent-icon"><Icon name="check" size={20} stroke={2.4} /></span>
        <h3>{addedHeading(sent)}</h3>
        <div class="sent-actions">
          <button class="btn small primary" onclick={() => (sent = null)}>{t('dbViews.form.addAnother')}</button>
          <button class="btn small raised" onclick={() => sent && store.open(sent.id)}>{t('dbViews.form.openIt')}</button>
        </div>
      </div>
    {:else}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {#each fields as f (f.prop.id)}
          {@const p = f.prop}
          {@const i = indexOf(p)}
          <div class="q" class:bad={!!errors[p.id]}>
            <div class="q-row">
              <label class="q-label" for="ff-{p.id}">
                {p.name}{#if f.required}<span class="req" aria-label={t('dbViews.form.requiredMark')}>*</span>{/if}
              </label>
              {#if editing}
                <span class="tools">
                  <span class="req-switch"><span>{t('dbViews.form.required')}</span><Switch on={f.required} label={t('dbViews.form.required')} onchange={() => setField(i, { required: !f.required })} /></span>
                  <button type="button" class="icon-btn" onclick={() => moveField(i, -1)} disabled={i === 0} aria-label={t('dbViews.form.moveUp')} data-tip={t('dbViews.form.moveUp')}><Icon name="arrow-up" size={13} /></button>
                  <button type="button" class="icon-btn" onclick={() => moveField(i, 1)} disabled={i === form.fields.length - 1} aria-label={t('dbViews.form.moveDown')} data-tip={t('dbViews.form.moveDown')}><Icon name="arrow-down" size={13} /></button>
                  <button type="button" class="icon-btn" onclick={() => patch({ fields: form.fields.filter((_, j) => j !== i) })} aria-label={t('dbViews.form.removeQuestion')} data-tip={t('common.actions.remove')}><Icon name="x" size={13} /></button>
                </span>
              {/if}
            </div>
            {#if p.config.description}<p class="hint">{p.config.description}</p>{/if}

            {#if p.type === 'text'}
              <textarea id="ff-{p.id}" class="input" rows="3" bind:value={texts[p.id]} placeholder={placeholder(p)} oninput={() => delete errors[p.id]}></textarea>
            {:else if TYPED.has(p.type)}
              <input
                id="ff-{p.id}"
                class="input"
                type={inputType(p)}
                inputmode={p.type === 'number' ? 'decimal' : undefined}
                bind:value={texts[p.id]}
                placeholder={placeholder(p)}
                oninput={() => delete errors[p.id]}
              />
            {:else if p.type === 'select' || p.type === 'status' || p.type === 'multiSelect'}
              <div class="choices" role={p.type === 'multiSelect' ? 'group' : 'radiogroup'} aria-label={p.name}>
                {#each options(p) as o (o.id)}
                  {@const on = Array.isArray(values[p.id]) ? (values[p.id] as string[]).includes(o.id) : values[p.id] === o.id}
                  <button type="button" class="choice" class:on onclick={() => toggle(p, o.id)} role={p.type === 'multiSelect' ? 'checkbox' : 'radio'} aria-checked={on}>
                    <span class="pill" class:status={p.type === 'status'} style:--pill={colorVar(o.color)}><span>{o.name}</span></span>
                    {#if on}<Icon name="check" size={13} stroke={2.4} />{/if}
                  </button>
                {:else}
                  <span class="none">{t('dbViews.form.noChoices')}</span>
                {/each}
              </div>
            {:else if p.type === 'course'}
              <div class="choices" role="radiogroup" aria-label={p.name}>
                {#each planner.courses as course (course.id)}
                  <button type="button" class="choice" class:on={values[p.id] === course.id} onclick={() => toggle(p, course.id)} role="radio" aria-checked={values[p.id] === course.id}>
                    <span class="dot" style:--dot={colorVar(course.color)}></span>{course.name || t('common.untitled')}
                    {#if values[p.id] === course.id}<Icon name="check" size={13} stroke={2.4} />{/if}
                  </button>
                {:else}
                  <span class="none">{t('dbViews.form.noCourses')}</span>
                {/each}
              </div>
            {:else if p.type === 'checkbox'}
              <div class="check-row">
                <Switch on={values[p.id] === true} label={p.name} onchange={() => (values[p.id] = values[p.id] !== true)} />
                <span>{values[p.id] === true ? t('common.yes') : t('common.no')}</span>
              </div>
            {:else if p.type === 'date'}
              <button type="button" id="ff-{p.id}" class="input pick" onclick={(e) => (picker = { prop: p, anchor: e.currentTarget as Element })}>
                <Icon name="calendar" size={14} />
                {#if values[p.id]}{formatDateValue(values[p.id] as DateValue)}{:else}<span class="ph">{t('dbViews.form.pickDate')}</span>{/if}
              </button>
            {:else if p.type === 'relation'}
              {@const linked = databases.related(draft, p)}
              <button type="button" id="ff-{p.id}" class="input pick" onclick={(e) => (picker = { prop: p, anchor: e.currentTarget as Element })}>
                <Icon name="relation" size={14} />
                {#if linked.length}
                  <span class="linked">{fmt.list(linked.map((r) => databases.title(r)), 'conjunction', 'narrow')}</span>
                {:else}<span class="ph">{linkHint(p)}</span>{/if}
              </button>
            {:else if p.type === 'files'}
              {@const ids = Array.isArray(values[p.id]) ? (values[p.id] as string[]) : []}
              <div class="files">
                {#each ids as fid (fid)}
                  <span class="file"><Icon name="paperclip" size={12} />{library.byId.get(fid)?.name ?? t('dbViews.form.file')}<button type="button" class="x" onclick={() => (values[p.id] = ids.filter((x) => x !== fid))} aria-label={t('common.actions.remove')}><Icon name="x" size={10} /></button></span>
                {/each}
                <button type="button" class="btn small raised" onclick={(e) => addFiles(e, p)}><Icon name="plus" size={13} /> {t('dbViews.form.addFiles')}</button>
              </div>
            {/if}
            {#if errors[p.id]}<p class="error">{errors[p.id]}</p>{/if}
          </div>
        {:else}
          <p class="none">{editing ? t('dbViews.form.noQuestions') : t('dbViews.form.noQuestionsHint')}</p>
        {/each}

        {#if editing}
          <button type="button" class="add-q" onclick={addQuestion}><Icon name="plus" size={14} /> {t('dbViews.form.addQuestion')}</button>
          <div class="q">
            <label class="q-label" for="ff-submit">{t('dbViews.form.button')}</label>
            <input id="ff-submit" class="input" value={form.submit ?? ''} placeholder={t('dbViews.form.submit')} oninput={(e) => patch({ submit: (e.currentTarget as HTMLInputElement).value })} />
          </div>
        {/if}

        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy || !fields.length}>{form.submit || t('dbViews.form.submit')}</button>
          <span class="note">{t('dbViews.form.addsRowTo', { database: dbTitle })}</span>
        </div>
      </form>
    {/if}
  </div>
</div>

{#if picker}
  {@const p = picker.prop}
  <Popover anchor={picker.anchor} width={p.type === 'date' ? 268 : 300} onclose={() => (picker = null)} label={p.name}>
    {#if p.type === 'date'}
      <DatePicker
        value={(values[p.id] as DateValue | null) ?? null}
        onchange={(v) => {
          values[p.id] = v;
          delete errors[p.id];
        }}
      />
    {:else}
      <RelationPicker
        row={draft}
        prop={p}
        onchange={(ids) => {
          values[p.id] = p.config.parent ? ids.slice(-1) : ids;
          delete errors[p.id];
        }}
      />
    {/if}
  </Popover>
{/if}

<style>
  .form-wrap {
    display: flex;
    justify-content: center;
    padding: 4px 0 24px;
  }
  .form {
    width: min(100%, 620px);
    padding: 28px 32px 24px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 1px var(--separator),
      0 2px 10px rgb(0 0 0 / 0.04);
  }
  .top {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-right: 120px;
    margin-bottom: 22px;
  }
  .edit-btn {
    position: absolute;
    top: 0;
    right: 0;
  }
  .f-title {
    margin: 0;
    font-size: 24px;
    font-weight: var(--fw-700);
    letter-spacing: -0.018em;
  }
  .f-intro {
    margin: 0;
    font-size: var(--fs-body-ui);
    color: var(--text-2);
    white-space: pre-wrap;
  }
  .f-title-input,
  .f-intro-input {
    border: none;
    border-radius: var(--r-xs);
    background: var(--fill);
    padding: 6px 8px;
    font: inherit;
    color: var(--text);
    outline: none;
    resize: vertical;
  }
  .f-title-input {
    font-size: 22px;
    font-weight: var(--fw-700);
  }
  .f-intro-input {
    font-size: var(--fs-body-ui);
  }
  .f-title-input:focus,
  .f-intro-input:focus {
    box-shadow: 0 0 0 2px var(--accent);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .q {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .form.editing .q {
    padding: 10px 12px;
    margin: 0 -12px;
    border-radius: var(--r-md);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .q-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }
  .q-label {
    flex: 1;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600);
    color: var(--text);
  }
  .req {
    margin-left: 3px;
    color: var(--danger);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tools .icon-btn {
    width: 26px;
    height: 26px;
  }
  .req-switch {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: 6px;
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .hint {
    margin: -2px 0 0;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .input {
    width: 100%;
    min-height: 36px;
    padding: 7px 10px;
    border: none;
    border-radius: var(--r-sm);
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--separator);
    font: inherit;
    font-size: var(--fs-body-ui);
    color: var(--text);
    outline: none;
    resize: vertical;
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .input:focus,
  .input:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .q.bad .input {
    box-shadow: inset 0 0 0 1.5px var(--danger);
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    cursor: pointer;
  }
  .pick :global(.icon) {
    flex: none;
    color: var(--text-3);
  }
  .ph {
    color: var(--text-3);
  }
  .linked {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .choice {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px 0 6px;
    border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-ui);
    color: var(--text);
    transition:
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .choice:hover {
    background: var(--fill);
  }
  .choice.on {
    box-shadow: inset 0 0 0 1.5px var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .dot {
    width: 8px;
    height: 8px;
    margin-left: 4px;
    border-radius: 50%;
    background: var(--dot);
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .files {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 4px 0 8px;
    border-radius: var(--r-xs);
    background: var(--fill);
    font-size: var(--fs-footnote);
  }
  .x {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    color: var(--text-3);
  }
  .x:hover {
    background: var(--fill-3);
    color: var(--text);
  }
  .none {
    margin: 0;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .error {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .add-q {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 36px;
    border-radius: var(--r-md);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .add-q:hover {
    background: var(--fill);
    color: var(--text);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
  }
  .note {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .sent {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px 0 12px;
    text-align: center;
  }
  .sent h3 {
    margin: 0;
    font-size: 17px;
    font-weight: var(--fw-650);
  }
  .sent-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--c-green, #34c759) 16%, transparent);
    color: var(--c-green, #34c759);
  }
  .sent-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
</style>
