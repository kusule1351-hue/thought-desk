<script lang="ts">
  /**
   * A view's filters: each picks a property, a test ("contains", "is
   * before"…) and a value. Rows must pass all of them, or any.
   */
  import Icon from '../components/Icon.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { OPS, RELATIVE_DAYS } from './query';
  import { shortId, typeInfo } from './schema';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import type { DbView, FilterRule, Property } from '../types';

  let { dbId, view }: { dbId: string; view: DbView } = $props();

  const rules = $derived(view.config.filters ?? []);
  const allProps = $derived(databases.props(dbId).filter((p) => p.type !== 'button'));

  function save(next: FilterRule[]) {
    databases.updateView(dbId, view.id, { filters: next });
  }

  function patch(id: string, p: Partial<FilterRule>) {
    save(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  function opsFor(p: Property | undefined) {
    return p ? OPS[databases.kind(dbId, p)] : [];
  }

  function setProp(rule: FilterRule, propId: string) {
    const p = databases.prop(dbId, propId);
    patch(rule.id, { prop: propId, op: opsFor(p)[0]?.op ?? 'isNotEmpty', value: undefined });
  }

  function add(propId?: string) {
    const p = (propId ? databases.prop(dbId, propId) : undefined) ?? allProps[0];
    if (!p) return;
    save([...rules, { id: shortId(), prop: p.id, op: opsFor(p)[0]?.op ?? 'isNotEmpty' }]);
  }

  /** Choices a filter value can be (options, courses, tags, linked rows). */
  function choices(p: Property): { key: string; label: string; color?: string }[] {
    if (p.type === 'tags') return tags.used.map((tag) => ({ key: tag, label: `#${tag}`, color: tags.color(tag) }));
    if (p.type === 'relation' && p.config.database) {
      return databases.rowsOf(p.config.database).slice(0, 60).map((r) => ({ key: r.id, label: store.byId.get(r.id)?.title || t('common.untitled') }));
    }
    return databases.groupsFor(p);
  }

  function toggleChoice(rule: FilterRule, key: string) {
    const cur = Array.isArray(rule.value) ? (rule.value as string[]) : [];
    patch(rule.id, { value: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key] });
  }
</script>

<div class="filters">
  {#each rules as rule, i (rule.id)}
    {@const p = databases.prop(dbId, rule.prop)}
    {@const info = opsFor(p).find((o) => o.op === rule.op)}
    <div class="rule">
      <span class="lead">{i === 0 ? t('dbEdit.filter.where') : (view.config.match ?? 'all') === 'all' ? t('dbEdit.filter.and') : t('dbEdit.filter.or')}</span>
      <select class="pop-input" value={rule.prop} onchange={(e) => setProp(rule, (e.currentTarget as HTMLSelectElement).value)} aria-label={t('dbEdit.filter.property')}>
        {#if !p}<option value={rule.prop} disabled>{t('dbEdit.filter.deletedProperty')}</option>{/if}
        {#each allProps as q (q.id)}<option value={q.id}>{q.name || typeInfo(q.type).label}</option>{/each}
      </select>
      <select class="pop-input op" value={rule.op} onchange={(e) => patch(rule.id, { op: (e.currentTarget as HTMLSelectElement).value })} aria-label={t('dbEdit.filter.test')}>
        {#each opsFor(p) as o (o.op)}<option value={o.op}>{o.label}</option>{/each}
      </select>
      <button class="icon-btn small" onclick={() => save(rules.filter((r) => r.id !== rule.id))} aria-label={t('dbEdit.filter.remove')} data-tip={t('common.actions.remove')}><Icon name="x" size={13} /></button>
    </div>
    {#if p && info && info.input !== 'none'}
      <div class="value">
        {#if info.input === 'text'}
          <input class="pop-input" value={(rule.value as string) ?? ''} placeholder={t('dbEdit.filter.typeValue')} oninput={(e) => patch(rule.id, { value: (e.currentTarget as HTMLInputElement).value })} aria-label={t('dbEdit.filter.value')} />
        {:else if info.input === 'number'}
          <input class="pop-input" type="number" value={(rule.value as number) ?? ''} placeholder={t('dbEdit.filter.aNumber')} oninput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            patch(rule.id, { value: v === '' ? undefined : Number(v) });
          }} aria-label={t('dbEdit.filter.value')} />
        {:else if info.input === 'days'}
          <div class="days">
            <Rich key="dbEdit.filter.days" params={{ count: typeof rule.value === 'number' ? rule.value : 7 }}>
              {#snippet input()}<input class="pop-input" type="number" min="0" value={(rule.value as number) ?? 7} oninput={(e) => patch(rule.id, { value: Number((e.currentTarget as HTMLInputElement).value) })} aria-label={t('dbEdit.filter.daysLabel')} />{/snippet}
            </Rich>
          </div>
        {:else if info.input === 'date'}
          {@const rel = RELATIVE_DAYS.some((r) => r.key === rule.value)}
          <div class="days">
            <select class="pop-input" value={rel ? (rule.value as string) : rule.value ? 'exact' : ''} onchange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              patch(rule.id, { value: v === 'exact' ? databases.ctx(dbId).today : v || undefined });
            }} aria-label={t('dbEdit.filter.day')}>
              <option value="" disabled>{t('dbEdit.filter.chooseDay')}</option>
              {#each RELATIVE_DAYS as r (r.key)}<option value={r.key}>{r.label}</option>{/each}
              <option value="exact">{t('dbEdit.filter.exactDate')}</option>
            </select>
            {#if rule.value && !rel}
              <input class="pop-input" type="date" value={rule.value as string} onchange={(e) => patch(rule.id, { value: (e.currentTarget as HTMLInputElement).value })} aria-label={t('dbEdit.date.field')} />
            {/if}
          </div>
        {:else if info.input === 'options'}
          <div class="choices">
            {#each choices(p) as c (c.key)}
              {@const on = Array.isArray(rule.value) && (rule.value as string[]).includes(c.key)}
              <button class="pill choice" class:on style:--pill={c.color} onclick={() => toggleChoice(rule, c.key)} aria-pressed={on}>
                {#if on}<Icon name="check" size={11} stroke={2.6} />{/if}<span>{c.label}</span>
              </button>
            {:else}
              <span class="none">{t('dbEdit.filter.nothingToChoose')}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <p class="empty">{t('dbEdit.filter.empty')}</p>
  {/each}

  <div class="foot">
    <button class="pop-item add" onclick={() => add()}><Icon name="plus" size={14} /><span class="grow">{t('dbEdit.filter.add')}</span></button>
    {#if rules.length > 1}
      <Segmented
        label={t('dbEdit.filter.match')}
        value={view.config.match ?? 'all'}
        options={[
          { value: 'all', label: t('dbEdit.filter.matchAll') },
          { value: 'any', label: t('dbEdit.filter.matchAny') },
        ]}
        onchange={(v) => databases.updateView(dbId, view.id, { match: v as 'all' | 'any' })}
      />
    {/if}
  </div>
</div>

<style>
  .filters {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .lead {
    flex: none;
    width: 40px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    text-align: right;
  }
  .rule select {
    flex: 1;
    min-width: 0;
    height: 26px;
    font-size: var(--fs-ui);
  }
  .rule .op {
    flex: 0.9;
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .value {
    padding: 0 30px 4px 46px;
  }
  .value .pop-input {
    height: 26px;
    font-size: var(--fs-ui);
  }
  .days {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .choice {
    cursor: pointer;
    gap: 3px;
    opacity: 0.6;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .choice.on,
  .choice:hover {
    opacity: 1;
  }
  .choice.on {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pill, var(--c-gray)) 60%, transparent);
  }
  .none,
  .empty {
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .empty {
    margin: 4px 6px 6px;
    line-height: 1.45;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .add {
    flex: 1;
    color: var(--text-2);
  }
</style>
