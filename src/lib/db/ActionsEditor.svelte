<script lang="ts" module>
  import { databases, ACTION_TYPES } from '../databases.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { option } from './schema';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import type { ActionValue, DbAction, Property } from '../types';

  /**
   * An action in words, for an automation's sentence ("When …, set Status
   * to Done, then add a row to Reading list"): one whole message for each
   * kind of action and value.
   */
  export function describeAction(dbId: string, a: DbAction): string {
    switch (a.type) {
      case 'set': {
        const p = databases.prop(dbId, a.prop);
        if (!p) return t('dbAuto.actions.describe.setProperty');
        return describeSet(p, a.value);
      }
      case 'add': {
        if (a.db === dbId) return t('dbAuto.actions.describe.addRowHere');
        const title = store.byId.get(a.db)?.title;
        return title ? t('dbAuto.actions.describe.addRowTo', { database: title }) : t('dbAuto.actions.describe.addRowSomewhere');
      }
      case 'open':
        return t('dbAuto.actions.describe.openPage');
      case 'url':
        return a.url ? t('dbAuto.actions.describe.openUrl', { url: a.url }) : t('dbAuto.actions.describe.openLink');
    }
  }

  /** A "set" action in words: "set Status to Done". */
  function describeSet(p: Property, v: ActionValue): string {
    const property = p.name;
    switch (v.mode) {
      case 'clear':
        return p.type === 'checkbox' ? t('dbAuto.actions.describe.setUnchecked', { property }) : t('dbAuto.actions.describe.setEmpty', { property });
      case 'today':
        if (!v.days) return t('dbAuto.actions.describe.setToday', { property });
        if (v.days === 1) return t('dbAuto.actions.describe.setTomorrow', { property });
        return t('dbAuto.actions.describe.setDaysFromToday', { property, count: v.days });
      case 'now':
        return t('dbAuto.actions.describe.setNow', { property });
      case 'toggle':
        return t('dbAuto.actions.describe.setOpposite', { property });
      case 'add': {
        // Every decimal the amount has, as it was typed (a plain number parameter would keep three).
        const amount = fmt.number(Math.abs(v.by), { maximumFractionDigits: 20 });
        return v.by < 0 ? t('dbAuto.actions.describe.setMinus', { property, amount }) : t('dbAuto.actions.describe.setPlus', { property, amount });
      }
      case 'value': {
        const x = v.value;
        if (p.type === 'checkbox') return x ? t('dbAuto.actions.describe.setChecked', { property }) : t('dbAuto.actions.describe.setUnchecked', { property });
        const missing = t('dbAuto.missingOption');
        if (p.type === 'select' || p.type === 'status') return t('dbAuto.actions.describe.setTo', { property, value: option(p, x)?.name ?? missing });
        // Several choices, listed the locale's short way ("A, B" in English, as before).
        if (p.type === 'multiSelect')
          return t('dbAuto.actions.describe.setTo', { property, value: fmt.list((Array.isArray(x) ? x : []).map((id) => option(p, id)?.name ?? missing), 'conjunction', 'narrow') });
        if (p.type === 'course') return t('dbAuto.actions.describe.setTo', { property, value: planner.courseById.get(String(x))?.name ?? missing });
        return t('dbAuto.actions.describe.setText', { property, text: String(x ?? '') });
      }
    }
  }
</script>

<script lang="ts">
  /**
   * Edits a list of actions (a button's, or an automation's "then"): set a
   * property, add a row somewhere, open the page, open a link.
   */
  import Icon from '../components/Icon.svelte';
  import Rich from '../i18n/Rich.svelte';
  import { options } from './schema';

  let {
    dbId,
    actions,
    onchange,
    button = false,
  }: {
    dbId: string;
    actions: DbAction[];
    onchange: (actions: DbAction[]) => void;
    /** A button's actions can also open things. */
    button?: boolean;
  } = $props();

  const settable = $derived(databases.props(dbId).filter((p) => ACTION_TYPES.has(p.type)));

  function update(i: number, a: DbAction) {
    onchange(actions.map((x, j) => (j === i ? a : x)));
  }

  function firstValue(p: Property | undefined): ActionValue {
    if (!p) return { mode: 'clear' };
    switch (p.type) {
      case 'checkbox':
        return { mode: 'value', value: true };
      case 'date':
        return { mode: 'today' };
      case 'number':
        return { mode: 'add', by: 1 };
      case 'select':
      case 'status': {
        const o = p.type === 'status' ? (options(p).find((x) => x.group === 'done') ?? options(p)[0]) : options(p)[0];
        return o ? { mode: 'value', value: o.id } : { mode: 'clear' };
      }
      case 'multiSelect':
        return options(p)[0] ? { mode: 'value', value: [options(p)[0].id] } : { mode: 'clear' };
      case 'course':
        return planner.courses[0] ? { mode: 'value', value: planner.courses[0].id } : { mode: 'clear' };
      default:
        return { mode: 'value', value: '' };
    }
  }

  function newAction(type: DbAction['type']): DbAction {
    switch (type) {
      case 'set': {
        const p = settable.find((x) => x.type !== 'title') ?? settable[0];
        return { type: 'set', prop: p?.id ?? '', value: firstValue(p) };
      }
      case 'add':
        return { type: 'add', db: dbId, title: '' };
      case 'open':
        return { type: 'open' };
      case 'url':
        return { type: 'url', url: '' };
    }
  }

  /** What a "set" action's value picker shows, as one key. */
  function valueKey(p: Property, v: ActionValue): string {
    if (v.mode === 'value') {
      if (p.type === 'checkbox') return v.value ? 'on' : 'off';
      if (p.type === 'multiSelect') return `o:${(v.value as string[])?.[0] ?? ''}`;
      if (p.type === 'select' || p.type === 'status' || p.type === 'course') return `o:${String(v.value ?? '')}`;
      return 'set';
    }
    if (v.mode === 'today') return `today:${v.days ?? 0}`;
    return v.mode;
  }

  function fromKey(p: Property, key: string, cur: ActionValue): ActionValue {
    if (key === 'clear' || key === 'now' || key === 'toggle') return { mode: key };
    if (key === 'on' || key === 'off') return { mode: 'value', value: key === 'on' };
    if (key.startsWith('today:')) return { mode: 'today', days: Number(key.slice(6)) };
    if (key === 'add') return { mode: 'add', by: cur.mode === 'add' ? cur.by : 1 };
    if (key === 'set') return { mode: 'value', value: cur.mode === 'value' ? cur.value : p.type === 'number' ? 0 : '' };
    const id = key.slice(2);
    return { mode: 'value', value: p.type === 'multiSelect' ? [id] : id };
  }

  const otherDbs = $derived(databases.list);
  /** Relations in database `db` that point back to this one (to link the new row). */
  const linksIn = (db: string) => databases.props(db).filter((p) => p.type === 'relation' && p.config.database === dbId);
</script>

<!-- A word between a line's menus ("to", "in"), drawn quieter than they are. -->
{#snippet muted(text: string)}<span class="to">{text}</span>{/snippet}

<div class="actions">
  {#each actions as a, i (i)}
    <div class="action">
      <div class="line">
        <select
          class="pop-input small kind"
          value={a.type}
          onchange={(e) => update(i, newAction((e.currentTarget as HTMLSelectElement).value as DbAction['type']))}
          aria-label={t('dbAuto.actions.action')}
        >
          <option value="set">{t('dbAuto.actions.type.set')}</option>
          <option value="add">{t('dbAuto.actions.type.add')}</option>
          {#if button || a.type === 'open'}<option value="open">{t('dbAuto.actions.type.open')}</option>{/if}
          {#if button || a.type === 'url'}<option value="url">{t('dbAuto.actions.type.url')}</option>{/if}
        </select>
        <button class="icon-btn" onclick={() => onchange(actions.filter((_, j) => j !== i))} aria-label={t('dbAuto.actions.remove')} data-tip={t('common.actions.remove')}
          ><Icon name="x" size={13} /></button
        >
      </div>

      {#if a.type === 'set'}
        {@const p = databases.prop(dbId, a.prop)}
        <div class="line">
          {#snippet propertyMenu()}
            <select
              class="pop-input small"
              value={a.prop}
              onchange={(e) => {
                const id = (e.currentTarget as HTMLSelectElement).value;
                update(i, { type: 'set', prop: id, value: firstValue(databases.prop(dbId, id)) });
              }}
              aria-label={t('dbAuto.actions.property')}
            >
              {#each settable as q (q.id)}<option value={q.id}>{q.name}</option>{/each}
            </select>
          {/snippet}
          {#if p}
            <Rich key="dbAuto.actions.setLine" property={propertyMenu} to={muted}>
              {#snippet value()}
                <select class="pop-input small" value={valueKey(p, a.value)} onchange={(e) => update(i, { ...a, value: fromKey(p, (e.currentTarget as HTMLSelectElement).value, a.value) })} aria-label={t('dbAuto.actions.value')}>
                  {#if p.type === 'checkbox'}
                    <option value="on">{t('dbAuto.actions.checked')}</option>
                    <option value="off">{t('dbAuto.actions.unchecked')}</option>
                    <option value="toggle">{t('dbAuto.actions.opposite')}</option>
                  {:else if p.type === 'date'}
                    <option value="today:0">{t('common.today')}</option>
                    <option value="today:1">{t('common.tomorrow')}</option>
                    <option value="today:7">{t('dbAuto.actions.inAWeek')}</option>
                    <option value="now">{t('dbAuto.actions.nowWithTime')}</option>
                    <option value="clear">{t('dbAuto.actions.empty')}</option>
                  {:else if p.type === 'select' || p.type === 'status' || p.type === 'multiSelect'}
                    {#each options(p) as o (o.id)}<option value="o:{o.id}">{o.name}</option>{/each}
                    <option value="clear">{t('dbAuto.actions.empty')}</option>
                  {:else if p.type === 'course'}
                    {#each planner.courses as course (course.id)}<option value="o:{course.id}">{course.name || t('common.untitled')}</option>{/each}
                    <option value="clear">{t('dbAuto.actions.empty')}</option>
                  {:else if p.type === 'number'}
                    <option value="add">{t('dbAuto.actions.itselfPlus')}</option>
                    <option value="set">{t('dbAuto.actions.aNumber')}</option>
                    <option value="clear">{t('dbAuto.actions.empty')}</option>
                  {:else}
                    <option value="set">{t('dbAuto.actions.textValue')}</option>
                    <option value="clear">{t('dbAuto.actions.empty')}</option>
                  {/if}
                </select>
              {/snippet}
            </Rich>
          {:else}
            {@render propertyMenu()}
          {/if}
        </div>
        {#if p && p.type === 'number' && (a.value.mode === 'add' || a.value.mode === 'value')}
          <input
            class="pop-input small"
            type="number"
            value={a.value.mode === 'add' ? a.value.by : Number(a.value.value ?? 0)}
            oninput={(e) => {
              const n = Number((e.currentTarget as HTMLInputElement).value) || 0;
              update(i, { ...a, value: a.value.mode === 'add' ? { mode: 'add', by: n } : { mode: 'value', value: n } });
            }}
            aria-label={t('dbAuto.actions.number')}
          />
        {:else if p && !['checkbox', 'date', 'select', 'status', 'multiSelect', 'course', 'number'].includes(p.type) && a.value.mode === 'value'}
          <input
            class="pop-input small"
            value={String(a.value.value ?? '')}
            placeholder={t('dbAuto.actions.textPlaceholder', { example: '{Name}' })}
            oninput={(e) => update(i, { ...a, value: { mode: 'value', value: (e.currentTarget as HTMLInputElement).value } })}
            aria-label={t('dbAuto.actions.text')}
          />
        {/if}
      {:else if a.type === 'add'}
        <div class="line">
          <Rich key="dbAuto.actions.addIn" to={muted}>
            {#snippet database()}
              <select class="pop-input small" value={a.db} onchange={(e) => update(i, { ...a, db: (e.currentTarget as HTMLSelectElement).value, link: null })} aria-label={t('dbAuto.actions.database')}>
                {#each otherDbs as d (d.id)}<option value={d.id}>{d.id === dbId ? t('dbAuto.actions.thisDatabase', { title: d.title || t('common.untitled') }) : d.title || t('common.untitled')}</option>{/each}
              </select>
            {/snippet}
          </Rich>
        </div>
        <input
          class="pop-input small"
          value={a.title ?? ''}
          placeholder={t('dbAuto.actions.titlePlaceholder', { name: '{Name}' })}
          oninput={(e) => update(i, { ...a, title: (e.currentTarget as HTMLInputElement).value })}
          aria-label={t('dbAuto.actions.title')}
        />
        {#if linksIn(a.db).length}
          <div class="line">
            <Rich key="dbAuto.actions.linkLine" to={muted}>
              {#snippet how()}
                <select class="pop-input small" value={a.link ?? ''} onchange={(e) => update(i, { ...a, link: (e.currentTarget as HTMLSelectElement).value || null })} aria-label={t('dbAuto.actions.linkBack')}>
                  <option value="">{t('dbAuto.actions.dontLink')}</option>
                  {#each linksIn(a.db) as q (q.id)}<option value={q.id}>{q.config.parent ? t('dbAuto.actions.asSubItem') : t('dbAuto.actions.throughRelation', { relation: q.name })}</option>{/each}
                </select>
              {/snippet}
            </Rich>
          </div>
        {/if}
        {#if button}
          <label class="check"><input type="checkbox" checked={!!a.open} onchange={(e) => update(i, { ...a, open: (e.currentTarget as HTMLInputElement).checked })} /> {t('dbAuto.actions.openIt')}</label>
        {/if}
      {:else if a.type === 'url'}
        <input
          class="pop-input small"
          value={a.url}
          placeholder={t('dbAuto.actions.urlPlaceholder', { example: '{URL}' })}
          oninput={(e) => update(i, { ...a, url: (e.currentTarget as HTMLInputElement).value })}
          aria-label={t('dbAuto.actions.link')}
        />
      {/if}
    </div>
  {/each}
  <button class="pop-item add" onclick={() => onchange([...actions, newAction('set')])}><Icon name="plus" size={14} /><span class="grow">{t('dbAuto.actions.add')}</span></button>
</div>

<style>
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .action {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    border-radius: var(--r-sm);
    background: var(--fill);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .line select {
    flex: 1;
    min-width: 0;
  }
  .kind {
    font-weight: var(--fw-600);
  }
  .to {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .icon-btn {
    flex: none;
    width: 24px;
    height: 24px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .add {
    color: var(--text-2);
  }
</style>
