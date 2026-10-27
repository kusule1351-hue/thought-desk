<script lang="ts" module>
  /** Where the keyboard goes after an edit (Tab, Enter). */
  export type Move = 'right' | 'left' | 'down' | 'up' | null;
</script>

<script lang="ts">
  /**
   * Edits one value in place: a text box over the cell for words and
   * numbers, or the right picker for choices, dates, links and files.
   * Closing reports where the keyboard wants to go next (Tab, Enter).
   */
  import { onMount, tick, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Popover from './Popover.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import DatePicker from './DatePicker.svelte';
  import RelationPicker from './RelationPicker.svelte';
  import { colorVar } from '../colors';
  import { databases } from '../databases.svelte';
  import { library } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import type { CellValue, DateValue, DbRow, Property } from '../types';

  let {
    dbId,
    row: rowIn,
    prop: propIn,
    anchor,
    initial,
    onclose,
  }: {
    dbId: string;
    row: DbRow;
    prop: Property;
    anchor: Element;
    /** A key typed to start editing: it replaces the value. */
    initial?: string;
    onclose: (move?: Move) => void;
  } = $props();

  // One editor, one cell: keep hold of it even as the caller moves on (a
  // field's blur can fire after the caller has let go).
  const row = untrack(() => rowIn);
  const prop = untrack(() => propIn);

  const TEXT = new Set(['title', 'text', 'url', 'email', 'phone', 'number']);
  const isText = TEXT.has(prop.type);

  const current = $derived(databases.cell(row, prop.id));

  function set(value: CellValue) {
    databases.setOne(row, prop, value);
  }

  // --------------------------------------------------------- text and numbers

  function rawText(): string {
    if (prop.type === 'title') return store.byId.get(row.id)?.title ?? '';
    const v = row.cells[prop.id];
    if (prop.type === 'number') return typeof v === 'number' ? String(v) : '';
    return typeof v === 'string' ? v : '';
  }

  let text = $state(untrack(() => initial ?? rawText()));
  let box: HTMLTextAreaElement | undefined = $state();
  // Where the cell is when editing starts (the editor sits over it).
  const rect = untrack(() => anchor.getBoundingClientRect());
  let done = false;

  onMount(() => {
    if (!isText) {
      // Instant ones: a checkbox flips, tags and files use the app's pickers.
      if (prop.type === 'checkbox') {
        set(row.cells[prop.id] !== true);
        onclose(null);
      } else if (prop.type === 'tags') {
        ui.pickTags(anchor, 'pages', row.id);
        onclose(null);
      } else if (!['select', 'multiSelect', 'status', 'date', 'relation', 'course', 'files'].includes(prop.type)) {
        onclose(null);
      }
      return;
    }
    void tick().then(() => {
      if (!box) return;
      box.focus();
      const end = box.value.length;
      box.setSelectionRange(untrack(() => initial) !== undefined ? end : 0, end);
      grow();
    });
  });

  function grow() {
    if (!box) return;
    box.style.height = '0px';
    box.style.height = `${Math.max(rect.height, box.scrollHeight)}px`;
  }

  function commit(move: Move) {
    if (done) return;
    done = true;
    const before = rawText();
    if (text !== before) {
      if (prop.type === 'number' && text.trim() && databases.parse(text, prop) === null) {
        ui.toast(t('dbEdit.cell.notANumber', { text: text.trim() }));
      } else set(prop.type === 'title' ? text.replace(/\s*\n\s*/g, ' ') : databases.parse(text, prop));
    }
    onclose(move);
  }

  function cancel() {
    if (done) return;
    done = true;
    onclose(null);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && !(e.shiftKey && prop.type === 'text')) {
      e.preventDefault();
      commit(e.shiftKey ? 'up' : 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit(e.shiftKey ? 'left' : 'right');
    }
  }

  // ------------------------------------------------------------------ files

  const fileIds = $derived(prop.type === 'files' ? (databases.get(row, prop) as string[]) : []);

  function addFiles(e: MouseEvent) {
    ui.pickFile(e.currentTarget as Element, (files) => set([...fileIds, ...files.map((f) => f.id)]), { exclude: fileIds, multiple: true });
  }

  const width = prop.type === 'date' ? 268 : prop.type === 'relation' ? 300 : 260;
</script>

{#if isText}
  <textarea
    class="cell-edit"
    class:num={prop.type === 'number'}
    class:title={prop.type === 'title'}
    bind:this={box}
    bind:value={text}
    style:left="{rect.left}px"
    style:top="{rect.top}px"
    style:min-width="{Math.max(rect.width, 160)}px"
    style:min-height="{rect.height}px"
    rows="1"
    spellcheck={prop.type === 'text' || prop.type === 'title'}
    oninput={grow}
    onkeydown={onKey}
    onblur={() => commit(null)}
    aria-label={prop.name}
  ></textarea>
{:else if ['select', 'multiSelect', 'status'].includes(prop.type)}
  <Popover {anchor} {width} onclose={() => onclose(null)} label={prop.name}>
    <OptionPicker {dbId} {prop} value={current as string | string[] | null} query={initial ?? ''} onchange={(v) => set(v)} onclose={() => onclose(null)} />
  </Popover>
{:else if prop.type === 'date'}
  <Popover {anchor} {width} onclose={() => onclose(null)} label={prop.name}>
    <DatePicker value={(databases.get(row, prop) as DateValue | null) ?? null} typed={initial} onchange={(v) => set(v)} />
  </Popover>
{:else if prop.type === 'relation'}
  <Popover {anchor} {width} onclose={() => onclose(null)} label={prop.name}>
    <RelationPicker {row} {prop} query={initial ?? ''} onchange={(ids) => set(ids)} />
  </Popover>
{:else if prop.type === 'course'}
  <Popover {anchor} {width} onclose={() => onclose(null)} label={prop.name}>
    {#each planner.courses as c (c.id)}
      <button
        class="pop-item"
        onclick={() => {
          set(current === c.id ? null : c.id);
          onclose(null);
        }}
      >
        <span class="dot" style:--dot={colorVar(c.color)}></span>
        <span class="grow">{c.name || t('common.untitled')}</span>
        {#if current === c.id}<Icon name="check" size={14} stroke={2.4} />{/if}
      </button>
    {:else}
      <p class="none">{t('dbEdit.cell.noCourses')}</p>
    {/each}
    <div class="pop-sep"></div>
    <button
      class="pop-item"
      onclick={async () => {
        const c = await planner.promptCourse();
        if (c) set(c.id);
        onclose(null);
      }}
    >
      <Icon name="plus" size={14} /><span class="grow">{t('dbEdit.cell.newCourse')}</span>
    </button>
    {#if current}
      <button
        class="pop-item"
        onclick={() => {
          set(null);
          onclose(null);
        }}
      >
        <Icon name="x" size={14} /><span class="grow">{t('common.actions.clear')}</span>
      </button>
    {/if}
  </Popover>
{:else if prop.type === 'files'}
  <Popover {anchor} {width} onclose={() => onclose(null)} label={prop.name}>
    {#each fileIds as id (id)}
      {@const f = library.byId.get(id)}
      <div class="file-row">
        <button class="pop-item" onclick={() => library.preview(id)}>
          <Icon name="paperclip" size={14} /><span class="grow">{f?.name ?? t('dbEdit.cell.missingFile')}</span>
        </button>
        <button class="icon-btn" onclick={() => set(fileIds.filter((x) => x !== id))} aria-label={t('dbEdit.removeNamed', { name: f?.name ?? '' })} data-tip={t('common.actions.remove')}><Icon name="x" size={13} /></button>
      </div>
    {:else}
      <p class="none">{t('dbEdit.cell.noFiles')}</p>
    {/each}
    <div class="pop-sep"></div>
    <button class="pop-item" onclick={addFiles}><Icon name="plus" size={14} /><span class="grow">{t('dbEdit.cell.addFromFiles')}</span></button>
  </Popover>
{/if}

<style>
  .cell-edit {
    position: fixed;
    z-index: 84;
    max-width: min(520px, calc(100vw - 32px));
    max-height: 60vh;
    padding: 6px 8px;
    border: none;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-pop);
    font: inherit;
    font-size: var(--fs-body-ui);
    line-height: 20px;
    color: var(--text);
    resize: none;
    outline: none;
    overflow: hidden;
  }
  .cell-edit.title {
    font-weight: var(--fw-500);
  }
  .cell-edit.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .none {
    margin: 4px 8px 6px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
</style>
