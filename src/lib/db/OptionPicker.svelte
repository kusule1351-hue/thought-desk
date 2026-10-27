<script lang="ts">
  /**
   * Picks one choice (select, status) or several (multi-select). Typing
   * filters the list; Enter picks the highlighted choice, or makes a new one
   * from what's typed. Each choice can be renamed, recoloured or deleted.
   */
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Popover from './Popover.svelte';
  import Swatches from '../ui/Swatches.svelte';
  import { colorVar } from '../colors';
  import { databases } from '../databases.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import { STATUS_GROUPS, newOption, options as optionsOf } from './schema';
  import type { Property, SelectOption } from '../types';

  let {
    dbId,
    prop,
    value,
    onchange,
    onclose,
    allowCreate = true,
    query: startQuery = '',
  }: {
    dbId: string;
    prop: Property;
    /** An option id (select, status), or ids (multi-select). */
    value: string | string[] | null;
    onchange: (value: string | string[] | null) => void;
    onclose?: () => void;
    allowCreate?: boolean;
    /** What was typed to open the picker. */
    query?: string;
  } = $props();

  const multiple = $derived(prop.type === 'multiSelect');
  const picked = $derived(Array.isArray(value) ? [...new Set(value)] : value ? [value] : []);
  const all = $derived(optionsOf(prop));
  let query = $state(untrack(() => startQuery));
  let active = $state(0);
  let input: HTMLInputElement;

  const q = $derived(query.trim().toLowerCase());
  const shown = $derived(q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all);
  const exact = $derived(all.some((o) => o.name.toLowerCase() === q));
  const canCreate = $derived(allowCreate && !!q && !exact);
  /** Rows the arrow keys move through: options, then "Create". */
  const count = $derived(shown.length + (canCreate ? 1 : 0));

  onMount(() => input?.focus());

  function setOptions(list: SelectOption[]) {
    databases.updateProperty(dbId, prop.id, { config: { ...prop.config, options: list } }, { immediate: true });
  }

  function pick(o: SelectOption) {
    if (multiple) {
      onchange(picked.includes(o.id) ? picked.filter((x) => x !== o.id) : [...picked, o.id]);
      query = '';
    } else {
      onchange(picked[0] === o.id ? null : o.id);
      onclose?.();
    }
  }

  function create() {
    const o = newOption(prop, query);
    setOptions([...all, o]);
    query = '';
    if (multiple) onchange([...picked, o.id]);
    else {
      onchange(o.id);
      onclose?.();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % Math.max(1, count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + count) % Math.max(1, count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < shown.length) pick(shown[active]);
      else if (canCreate) create();
    } else if (e.key === 'Backspace' && !query && multiple && picked.length) {
      onchange(picked.slice(0, -1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onclose?.();
    }
  }

  $effect(() => {
    void q;
    active = 0;
  });

  // ------------------------------------------------------- editing a choice

  let editing = $state<{ id: string; anchor: Element } | null>(null);
  const editOpt = $derived(editing ? all.find((o) => o.id === editing!.id) : undefined);

  function patch(id: string, p: Partial<SelectOption>) {
    setOptions(all.map((o) => (o.id === id ? { ...o, ...p } : o)));
  }

  async function remove(o: SelectOption) {
    editing = null;
    const used = databases.rowsOf(dbId).filter((r) => {
      const v = r.cells[prop.id];
      return Array.isArray(v) ? v.includes(o.id) : v === o.id;
    }).length;
    if (used) {
      const ok = await ui.confirm({
        title: t('dbEdit.choices.deleteTitle', { name: o.name }),
        message: t('dbEdit.choices.deleteMessage', { count: used }),
        confirmLabel: t('common.actions.delete'),
        danger: true,
      });
      if (!ok) return;
    }
    setOptions(all.filter((x) => x.id !== o.id));
  }

  function move(o: SelectOption, by: number) {
    const i = all.indexOf(o);
    const j = i + by;
    if (j < 0 || j >= all.length) return;
    const list = [...all];
    [list[i], list[j]] = [list[j], list[i]];
    setOptions(list);
  }

  const groups = $derived(
    prop.type === 'status'
      ? STATUS_GROUPS.map((g) => ({ ...g, items: shown.filter((o) => (o.group ?? 'todo') === g.key) })).filter((g) => g.items.length)
      : [{ key: 'all', label: '', items: shown }],
  );
</script>

<div class="picker">
  <div class="search">
    {#if multiple}
      {#each picked as id (id)}
        {@const o = all.find((x) => x.id === id)}
        {#if o}
          <span class="pill" style:--pill={colorVar(o.color)}>
            <span>{o.name}</span>
            <button class="x" onclick={() => onchange(picked.filter((x) => x !== id))} aria-label={t('dbEdit.removeNamed', { name: o.name })}><Icon name="x" size={10} stroke={2.6} /></button>
          </span>
        {/if}
      {/each}
    {/if}
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      placeholder={allowCreate ? (all.length ? t('dbEdit.choices.searchOrAdd') : t('dbEdit.choices.typeFirst')) : t('dbEdit.choices.search')}
      aria-label={t('dbEdit.choices.searchLabel')}
    />
  </div>

  <div class="list" role="listbox" aria-multiselectable={multiple}>
    {#each groups as g (g.key)}
      {#if g.label}<div class="pop-head">{g.label}</div>{/if}
      {#each g.items as o (o.id)}
        {@const i = shown.indexOf(o)}
        <div class="opt-row" class:active={i === active} role="option" aria-selected={picked.includes(o.id)}>
          <button class="opt" onclick={() => pick(o)} onmousemove={() => (active = i)}>
            <span class="pill" class:status={prop.type === 'status'} style:--pill={colorVar(o.color)}><span>{o.name}</span></span>
            {#if picked.includes(o.id)}<Icon name="check" size={14} stroke={2.4} />{/if}
          </button>
          {#if allowCreate}
            <button class="more" onclick={(e) => (editing = { id: o.id, anchor: e.currentTarget as Element })} aria-label={t('dbEdit.choices.editNamed', { name: o.name })} data-tip={t('dbEdit.choices.editTip')}>
              <Icon name="more" size={14} />
            </button>
          {/if}
        </div>
      {/each}
    {/each}
    {#if canCreate}
      <button class="pop-item create" class:active={active === shown.length} onmousemove={() => (active = shown.length)} onclick={create}>
        <Icon name="plus" size={14} />
        <span class="grow"
          ><Rich key="dbEdit.choices.create" params={{ name: query.trim() }}
            >{#snippet pill(text: string)}<span class="pill" style:--pill={colorVar(newOption(prop, query).color)}><span>{text}</span></span>{/snippet}</Rich
          ></span
        >
      </button>
    {/if}
    {#if !count}
      <div class="none">{all.length ? t('dbEdit.choices.noMatches') : t('dbEdit.choices.none')}</div>
    {/if}
  </div>
</div>

{#if editing && editOpt}
  <Popover anchor={editing.anchor} side="right" width={232} onclose={() => (editing = null)} label={t('dbEdit.choices.edit')}>
    <div class="edit">
      <input
        class="pop-input"
        value={editOpt.name}
        oninput={(e) => patch(editOpt.id, { name: (e.currentTarget as HTMLInputElement).value })}
        onkeydown={(e) => e.key === 'Enter' && (editing = null)}
        aria-label={t('common.name')}
      />
      {#if prop.type === 'status'}
        <div class="pop-head">{t('dbEdit.choices.stage')}</div>
        {#each STATUS_GROUPS as g (g.key)}
          <button class="pop-item" onclick={() => patch(editOpt.id, { group: g.key })}>
            <span class="grow">{g.label}</span>
            {#if (editOpt.group ?? 'todo') === g.key}<Icon name="check" size={14} stroke={2.4} />{/if}
          </button>
        {/each}
      {/if}
      <div class="pop-head">{t('dbEdit.choices.color')}</div>
      <div class="swatches"><Swatches value={editOpt.color} onchange={(c) => patch(editOpt.id, { color: c })} /></div>
      <div class="pop-sep"></div>
      <button class="pop-item" onclick={() => move(editOpt, -1)} disabled={all.indexOf(editOpt) === 0}><Icon name="arrow-up" size={14} /><span class="grow">{t('dbEdit.choices.moveUp')}</span></button>
      <button class="pop-item" onclick={() => move(editOpt, 1)} disabled={all.indexOf(editOpt) === all.length - 1}><Icon name="arrow-down" size={14} /><span class="grow">{t('dbEdit.choices.moveDown')}</span></button>
      <button class="pop-item danger" onclick={() => remove(editOpt)}><Icon name="trash" size={14} /><span class="grow">{t('common.actions.delete')}</span></button>
    </div>
  </Popover>
{/if}

<style>
  .picker {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    margin: -4px -4px 4px;
    padding: 6px 10px;
    background: var(--fill);
    box-shadow: inset 0 -0.5px 0 var(--hairline);
  }
  .search input {
    flex: 1;
    min-width: 90px;
    height: 20px;
    border: none;
    background: none;
    font-size: var(--fs-body-ui);
    color: var(--text);
    outline: none;
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .search .pill {
    padding-right: 3px;
  }
  .x {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    color: inherit;
    opacity: 0.7;
  }
  .x:hover {
    opacity: 1;
    background: var(--fill-2);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .opt-row {
    display: flex;
    align-items: center;
    border-radius: var(--r-sm);
  }
  .opt-row.active {
    background: var(--fill-2);
  }
  .opt {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: var(--h-sm);
    padding: 0 4px 0 8px;
    text-align: left;
  }
  .more {
    display: grid;
    place-items: center;
    flex: none;
    width: 24px;
    height: 24px;
    margin-right: 2px;
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
  }
  .opt-row:hover .more,
  .opt-row.active .more {
    opacity: 1;
  }
  .more:hover {
    background: var(--fill-3);
    color: var(--text);
  }
  .create .grow {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .none {
    padding: 6px 8px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .edit {
    display: flex;
    flex-direction: column;
  }
  .swatches {
    padding: 2px 8px 6px;
  }
</style>
