<script lang="ts">
  /**
   * Everything about one property, from its column header: its name and
   * type, its settings (choices, number format, formula, what it links
   * to…), and what this view does with it (sort, filter, hide).
   */
  import { iconText } from '../page-icon';
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import ActionsEditor from './ActionsEditor.svelte';
  import Popover from './Popover.svelte';
  import Switch from '../ui/Switch.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Swatches from '../ui/Swatches.svelte';
  import { colorVar } from '../colors';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { HAS_OPTIONS, NUMBER_FORMATS, ROLLUP_FNS, STATUS_GROUPS, TYPES, TYPE_GROUPS, TYPE_GROUP_LABELS, newOption, options, typeInfo } from './schema';
  import { NO_ROOM } from './freeze';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import type { DbView, NumberFormat, Property, PropertyType, RollupFn, SelectOption } from '../types';

  let {
    dbId,
    prop: propIn,
    view,
    anchor,
    onclose,
    onfilter,
    fresh = false,
    freezeStatus = null,
    recheckFreeze,
  }: {
    dbId: string;
    prop: Property;
    view?: DbView;
    anchor: Element;
    onclose: () => void;
    /** Starts a filter on this property. */
    onfilter?: (p: Property) => void;
    /** Just added: the name is selected, ready to type over. */
    fresh?: boolean;
    /** Geometry for freezing through this property, from the table itself. */
    freezeStatus?: { eligible: boolean; reason: string } | null;
    /** Re-measures on click; false means a resize raced the menu. */
    recheckFreeze?: (propId: string) => boolean;
  } = $props();

  // The menu is for one property; inputs blurring as it closes still see it.
  const prop = untrack(() => propIn);
  let picking = $state(false);
  let nameInput = $state<HTMLInputElement>();
  const isTitle = $derived(prop.type === 'title');

  onMount(() => {
    nameInput?.focus();
    nameInput?.select();
  });

  function update(patch: Partial<Property>) {
    databases.updateProperty(dbId, prop.id, patch);
  }

  function config(patch: Partial<Property['config']>) {
    update({ config: { ...prop.config, ...patch } });
  }

  async function setType(type: PropertyType) {
    picking = false;
    if (type === prop.type) return;
    await databases.changeType(dbId, prop.id, type);
  }

  // ------------------------------------------------------------- choices

  let newChoice = $state('');
  let colorFor = $state<{ id: string; anchor: Element } | null>(null);
  const choices = $derived(options(prop));

  function setChoices(list: SelectOption[]) {
    config({ options: list });
  }

  function addChoice() {
    const name = newChoice.trim();
    if (!name || choices.some((o) => o.name.toLowerCase() === name.toLowerCase())) return;
    setChoices([...choices, newOption(prop, name)]);
    newChoice = '';
  }

  function moveChoice(i: number, by: number) {
    const j = i + by;
    if (j < 0 || j >= choices.length) return;
    const list = [...choices];
    [list[i], list[j]] = [list[j], list[i]];
    setChoices(list);
  }

  // --------------------------------------------------------------- views

  function sort(dir: 'asc' | 'desc') {
    if (!view) return;
    const rest = (view.config.sorts ?? []).filter((s) => s.prop !== prop.id);
    databases.updateView(dbId, view.id, { sorts: [{ prop: prop.id, dir }, ...rest] });
    onclose();
  }

  function hide() {
    if (!view) return;
    databases.updateView(dbId, view.id, { hidden: [...new Set([...(view.config.hidden ?? []), prop.id])] });
    onclose();
  }

  // --------------------------------------------------------------- freeze

  // A resize can land between the menu painting and the click. The table
  // re-measures then; if the boundary no longer fits, keep the menu open and
  // explain instead of saving a freeze it cannot show.
  let freezeDenied = $state(false);
  $effect(() => {
    void freezeStatus;
    freezeDenied = false;
  });
  const freezeBlocked = $derived(freezeDenied || (freezeStatus ? !freezeStatus.eligible : false));
  const freezeReason = $derived(freezeBlocked ? freezeStatus?.reason || NO_ROOM : '');

  function freezeHere() {
    if (!view || freezeBlocked) return;
    if (recheckFreeze && !recheckFreeze(prop.id)) {
      freezeDenied = true;
      return;
    }
    databases.updateView(dbId, view.id, { freezeThrough: prop.id });
    onclose();
  }

  function unfreeze() {
    if (!view) return;
    databases.updateView(dbId, view.id, { freezeThrough: null });
    onclose();
  }

  async function insert(side: -1 | 1) {
    await databases.addProperty(dbId, 'text', side === 1 ? { after: prop.id } : { before: prop.id });
    onclose();
  }

  // ------------------------------------------------- relation and rollup

  const otherDbs = $derived(databases.list);
  const relations = $derived(databases.props(dbId).filter((p) => p.type === 'relation'));
  const rollupRel = $derived(databases.prop(dbId, prop.config.relation));
  const rollupTargets = $derived(rollupRel?.config.database ? databases.props(rollupRel.config.database) : []);
  const twin = $derived(prop.config.database && prop.config.back ? databases.prop(prop.config.database, prop.config.back) : undefined);

  function chooseDatabase(id: string) {
    if (prop.config.back) void databases.linkBack(dbId, prop.id, false);
    config({ database: id, back: null });
  }

  const groupedTypes = $derived(TYPE_GROUPS.map((g) => ({ g, items: TYPES.filter((info) => info.group === g && info.type !== 'title') })));
</script>

<Popover {anchor} width={292} {onclose} label={t('dbEdit.property.menuLabel', { name: prop.name })}>
  {#if picking}
    <div class="pop-head">
      <button class="back" onclick={() => (picking = false)}><Icon name="chevron-left" size={13} /> {t('dbEdit.property.type')}</button>
    </div>
    {#each groupedTypes as group (group.g)}
      <div class="pop-head">{TYPE_GROUP_LABELS[group.g]}</div>
      {#each group.items as info (info.type)}
        <button class="pop-item" class:active={info.type === prop.type} onclick={() => setType(info.type)}>
          <Icon name={info.icon} size={15} />
          <span class="grow">{info.label}</span>
          <span class="hint">{info.hint}</span>
        </button>
      {/each}
    {/each}
  {:else}
    <div class="name-row">
      <span class="type-icon" data-tip={typeInfo(prop.type).label}><Icon name={typeInfo(prop.type).icon} size={15} /></span>
      <input
        class="pop-input"
        bind:this={nameInput}
        value={prop.name}
        placeholder={t('dbEdit.property.name')}
        oninput={(e) => update({ name: (e.currentTarget as HTMLInputElement).value })}
        onkeydown={(e) => e.key === 'Enter' && onclose()}
        aria-label={t('dbEdit.property.name')}
      />
    </div>
    {#if !isTitle}
      <button class="pop-item" onclick={() => (picking = true)}>
        <span class="grow">{t('dbEdit.property.type')}</span>
        <span class="hint">{typeInfo(prop.type).label}</span>
        <Icon name="chevron-right" size={13} />
      </button>
    {/if}

    {#if HAS_OPTIONS.has(prop.type)}
      <div class="pop-sep"></div>
      <div class="pop-head">{t('dbEdit.choices.heading')}</div>
      {#each STATUS_GROUPS.filter((g) => prop.type === 'status' || g.key === 'todo') as g (g.key)}
        {#if prop.type === 'status'}<div class="sub-head">{g.label}</div>{/if}
        {#each choices.filter((o) => prop.type !== 'status' || (o.group ?? 'todo') === g.key) as o (o.id)}
          {@const i = choices.indexOf(o)}
          <div class="choice">
            <button class="swatch round" style:--dot={colorVar(o.color)} onclick={(e) => (colorFor = { id: o.id, anchor: e.currentTarget as Element })} aria-label={t('dbEdit.choices.colorOf', { name: o.name })}></button>
            <input
              class="choice-name"
              value={o.name}
              oninput={(e) => setChoices(choices.map((x) => (x.id === o.id ? { ...x, name: (e.currentTarget as HTMLInputElement).value } : x)))}
              aria-label={t('dbEdit.choices.name')}
            />
            <button class="mini" onclick={() => moveChoice(i, -1)} disabled={i === 0} aria-label={t('dbEdit.choices.moveUp')}><Icon name="arrow-up" size={12} /></button>
            <button class="mini" onclick={() => moveChoice(i, 1)} disabled={i === choices.length - 1} aria-label={t('dbEdit.choices.moveDown')}><Icon name="arrow-down" size={12} /></button>
            <button class="mini" onclick={() => setChoices(choices.filter((x) => x.id !== o.id))} aria-label={t('dbEdit.choices.deleteNamed', { name: o.name })}><Icon name="x" size={12} /></button>
          </div>
        {/each}
      {/each}
      <div class="choice add">
        <Icon name="plus" size={13} />
        <input
          class="choice-name"
          bind:value={newChoice}
          placeholder={t('dbEdit.choices.add')}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addChoice();
            }
          }}
          onblur={addChoice}
          aria-label={t('dbEdit.choices.new')}
        />
      </div>
    {:else if prop.type === 'number' || (prop.type === 'formula') || (prop.type === 'rollup' && !['show', 'earliest', 'latest'].includes(prop.config.fn ?? 'count'))}
      <div class="pop-sep"></div>
      {#if prop.type === 'formula'}
        <div class="pop-head">{t('dbEdit.property.formula')}</div>
        <button
          class="formula"
          onclick={() => {
            ui.formula = { dbId, propId: prop.id };
            onclose();
          }}
        >
          {#if prop.config.expression}<code>{prop.config.expression}</code>{:else}<span class="hint">{t('dbEdit.property.writeFormula')}</span>{/if}
          <Icon name="pencil" size={13} />
        </button>
      {/if}
      {#if prop.type === 'rollup'}
        {@render rollup()}
      {/if}
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.numberFormat')}</span>
        <select class="pop-input small" value={prop.config.format ?? 'number'} onchange={(e) => config({ format: (e.currentTarget as HTMLSelectElement).value as NumberFormat })}>
          {#each NUMBER_FORMATS as f (f.key)}<option value={f.key}>{t('dbEdit.property.numberFormatOption', { format: f.label, example: f.example })}</option>{/each}
        </select>
      </div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.decimals')}</span>
        <select class="pop-input small" value={prop.config.decimals ?? 'auto'} onchange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          config({ decimals: v === 'auto' ? null : Number(v) });
        }}>
          <option value="auto">{t('dbEdit.property.decimalsAuto')}</option>
          {#each [0, 1, 2, 3, 4] as d (d)}<option value={d}>{fmt.number(d)}</option>{/each}
        </select>
      </div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.showAs')}</span>
        <Segmented
          label={t('dbEdit.property.showNumbersAs')}
          value={prop.config.display ?? 'number'}
          options={[
            { value: 'number', label: fmt.number(123) },
            { value: 'bar', label: t('dbEdit.property.showAsBar') },
            { value: 'ring', label: t('dbEdit.property.showAsRing') },
          ]}
          onchange={(v) => config({ display: v as 'number' | 'bar' | 'ring' })}
        />
      </div>
      {#if prop.config.display === 'bar' || prop.config.display === 'ring'}
        <div class="pop-row">
          <span class="label">{t('dbEdit.property.fullAt')}</span>
          <input class="pop-input small" type="number" value={prop.config.max ?? 100} oninput={(e) => config({ max: Number((e.currentTarget as HTMLInputElement).value) || 100 })} aria-label={t('dbEdit.property.fullAtValue')} />
        </div>
      {/if}
    {:else if prop.type === 'rollup'}
      <div class="pop-sep"></div>
      {@render rollup()}
    {:else if prop.type === 'date'}
      <div class="pop-sep"></div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.showOnCalendar')}</span>
        <Switch on={!!prop.config.onCalendar} label={t('dbEdit.property.showOnCalendarSwitch')} onchange={() => config({ onCalendar: !prop.config.onCalendar })} />
      </div>
    {:else if prop.type === 'relation'}
      <div class="pop-sep"></div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.relation.linksTo')}</span>
        <select class="pop-input small" value={prop.config.database ?? ''} onchange={(e) => chooseDatabase((e.currentTarget as HTMLSelectElement).value)}>
          <option value="" disabled>{t('dbEdit.relation.chooseDatabase')}</option>
          {#each otherDbs as d (d.id)}<option value={d.id}>{iconText(d.icon) ? `${iconText(d.icon)} ` : ''}{d.id === dbId ? t('dbEdit.relation.thisDatabase', { name: d.title || t('common.untitled') }) : d.title || t('common.untitled')}</option>{/each}
        </select>
      </div>
      {#if prop.config.database}
        <div class="pop-row">
          <span class="label"
            >{prop.config.database !== dbId
              ? t('dbEdit.relation.twoWayShowOn', { name: store.byId.get(prop.config.database)?.title || t('common.untitled') })
              : t('dbEdit.relation.twoWay')}</span
          >
          <Switch on={!!twin} label={t('dbEdit.relation.twoWaySwitch')} onchange={() => void databases.linkBack(dbId, prop.id, !twin)} />
        </div>
        {#if twin}<p class="note">{t('dbEdit.relation.linkedAlsoShow', { name: twin.name })}</p>{/if}
      {/if}
    {:else if prop.type === 'button'}
      <div class="pop-sep"></div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.buttonSays')}</span>
        <input class="pop-input small" value={prop.config.label ?? ''} placeholder={prop.name} oninput={(e) => config({ label: (e.currentTarget as HTMLInputElement).value })} aria-label={t('dbEdit.property.buttonText')} />
      </div>
      <div class="pop-head">{t('dbEdit.property.whenClicked')}</div>
      <ActionsEditor {dbId} button actions={prop.config.actions ?? []} onchange={(actions) => config({ actions })} />
    {:else if prop.type === 'id'}
      <div class="pop-sep"></div>
      <div class="pop-row">
        <span class="label">{t('dbEdit.property.prefix')}</span>
        <input class="pop-input small" value={prop.config.prefix ?? ''} placeholder={t('dbEdit.property.prefixExample')} oninput={(e) => config({ prefix: (e.currentTarget as HTMLInputElement).value.trim() })} aria-label={t('dbEdit.property.prefix')} />
      </div>
    {/if}

    <div class="pop-sep"></div>
    <input
      class="pop-input desc"
      value={prop.config.description ?? ''}
      placeholder={t('dbEdit.property.description')}
      oninput={(e) => config({ description: (e.currentTarget as HTMLInputElement).value })}
      aria-label={t('dbEdit.property.descriptionLabel')}
    />

    {#if view}
      {#if prop.type !== 'button'}
        <div class="pop-sep"></div>
        <button class="pop-item" onclick={() => sort('asc')}><Icon name="arrow-up" size={15} /><span class="grow">{t('dbEdit.property.sortAscending')}</span></button>
        <button class="pop-item" onclick={() => sort('desc')}><Icon name="arrow-down" size={15} /><span class="grow">{t('dbEdit.property.sortDescending')}</span></button>
        {#if onfilter}
          <button
            class="pop-item"
            onclick={() => {
              onfilter?.(prop);
              onclose();
            }}
          >
            <Icon name="filter" size={15} /><span class="grow">{t('dbEdit.property.filter')}</span>
          </button>
        {/if}
        {#if !isTitle}<button class="pop-item" onclick={hide}><Icon name="eye-off" size={15} /><span class="grow">{t('dbEdit.property.hide')}</span></button>{/if}
      {/if}
      {#if view.type === 'table'}
        <div class="pop-sep"></div>
        <button
          class="pop-item"
          disabled={freezeBlocked}
          title={freezeBlocked ? freezeReason : undefined}
          aria-describedby={freezeBlocked ? 'freeze-no-room' : undefined}
          onclick={freezeHere}
        >
          <Icon name="pin" size={15} /><span class="grow">{t('dbEdit.property.freeze')}</span>
          {#if view.config.freezeThrough === prop.id}<Icon name="check" size={13} />{/if}
        </button>
        {#if freezeBlocked}
          <p class="note" id="freeze-no-room">{freezeReason}</p>
        {/if}
        {#if view.config.freezeThrough}
          <button class="pop-item" onclick={unfreeze}>
            <Icon name="pin-off" size={15} /><span class="grow">{t('dbEdit.property.unfreeze')}</span>
          </button>
        {/if}
      {/if}
    {/if}
    <div class="pop-sep"></div>
    <button class="pop-item" onclick={() => insert(-1)}><Icon name="arrow-left" size={15} /><span class="grow">{t('dbEdit.property.insertLeft')}</span></button>
    <button class="pop-item" onclick={() => insert(1)}><Icon name="arrow-right" size={15} /><span class="grow">{t('dbEdit.property.insertRight')}</span></button>
    {#if !isTitle}
      <button
        class="pop-item"
        onclick={() => {
          void databases.duplicateProperty(dbId, prop.id);
          onclose();
        }}
      >
        <Icon name="copy" size={15} /><span class="grow">{t('dbEdit.property.duplicate')}</span>
      </button>
      <button
        class="pop-item danger"
        onclick={() => {
          void databases.deleteProperty(dbId, prop.id);
          onclose();
        }}
      >
        <Icon name="trash" size={15} /><span class="grow">{t('dbEdit.property.delete')}</span>
      </button>
    {/if}
  {/if}
</Popover>

{#snippet rollup()}
  <div class="pop-row">
    <span class="label">{t('dbEdit.rollup.relation')}</span>
    <select class="pop-input small" value={prop.config.relation ?? ''} onchange={(e) => config({ relation: (e.currentTarget as HTMLSelectElement).value, target: undefined })}>
      <option value="" disabled>{relations.length ? t('dbEdit.rollup.choose') : t('dbEdit.rollup.addRelationFirst')}</option>
      {#each relations as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
    </select>
  </div>
  {#if rollupRel}
    <div class="pop-row">
      <span class="label">{t('dbEdit.rollup.property')}</span>
      <select class="pop-input small" value={prop.config.target ?? ''} onchange={(e) => config({ target: (e.currentTarget as HTMLSelectElement).value })}>
        <option value="">{t('dbEdit.rollup.countRows')}</option>
        {#each rollupTargets as target (target.id)}<option value={target.id}>{target.name}</option>{/each}
      </select>
    </div>
  {/if}
  <div class="pop-row">
    <span class="label">{t('dbEdit.rollup.calculate')}</span>
    <select
      class="pop-input small"
      value={prop.config.fn ?? 'count'}
      onchange={(e) => {
        const fn = (e.currentTarget as HTMLSelectElement).value as RollupFn;
        // A share of done or checked rows reads best as a progress bar.
        config(fn === 'percentDone' || fn === 'percentChecked' ? { fn, format: 'percent', display: 'bar', max: 100 } : { fn });
      }}
    >
      {#each ROLLUP_FNS as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
    </select>
  </div>
{/snippet}

{#if colorFor}
  <Popover anchor={colorFor.anchor} side="right" width={200} onclose={() => (colorFor = null)} label={t('dbEdit.choices.color')}>
    <div class="swatch-pop">
      <Swatches
        value={choices.find((o) => o.id === colorFor?.id)?.color ?? 'gray'}
        onchange={(c) => {
          setChoices(choices.map((x) => (x.id === colorFor?.id ? { ...x, color: c } : x)));
          colorFor = null;
        }}
      />
    </div>
  </Popover>
{/if}

<style>
  .name-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px 4px 6px;
  }
  .type-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    color: var(--text-2);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text-2);
    font-weight: var(--fw-600);
  }
  .sub-head {
    padding: 4px 8px 2px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 4px 0 8px;
    border-radius: var(--r-sm);
  }
  .choice:hover {
    background: var(--fill);
  }
  .choice.add {
    color: var(--text-3);
    gap: 8px;
    padding-left: 9px;
  }
  .swatch {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--dot);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }
  .choice-name {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: none;
    border-radius: var(--r-xs);
    background: transparent;
    font-size: var(--fs-body-ui);
    color: var(--text);
    outline: none;
  }
  .choice-name:focus {
    background: var(--bg-elevated);
    box-shadow: 0 0 0 1.5px var(--focus);
  }
  .choice-name::placeholder {
    color: var(--text-3);
  }
  .mini {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: var(--r-xs);
    color: var(--text-3);
    opacity: 0;
  }
  .choice:hover .mini {
    opacity: 1;
  }
  .mini:hover:not(:disabled) {
    background: var(--fill-2);
    color: var(--text);
  }
  .mini:disabled {
    opacity: 0 !important;
  }
  .pop-input.small {
    width: 150px;
    height: 26px;
    flex: none;
    font-size: var(--fs-ui);
  }
  .pop-input.desc {
    margin: 2px 0;
    font-size: var(--fs-ui);
  }
  .formula {
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% - 8px);
    margin: 0 4px 4px;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: var(--fill);
    text-align: left;
    color: var(--text-2);
  }
  .formula:hover {
    background: var(--fill-2);
  }
  .formula code {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .formula .hint {
    flex: 1;
    color: var(--text-3);
  }
  .note {
    margin: 0 8px 4px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .swatch-pop {
    padding: 6px;
  }
</style>
