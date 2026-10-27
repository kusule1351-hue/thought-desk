<script lang="ts">
  /** A view's sorts: by one property, then another to break ties. */
  import Icon from '../components/Icon.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { databases } from '../databases.svelte';
  import { typeInfo } from './schema';
  import { t } from '../i18n';
  import type { DbView, SortRule } from '../types';

  let { dbId, view }: { dbId: string; view: DbView } = $props();

  const rules = $derived(view.config.sorts ?? []);
  const allProps = $derived(databases.props(dbId).filter((p) => p.type !== 'button'));
  const unused = $derived(allProps.filter((p) => !rules.some((r) => r.prop === p.id)));

  function save(next: SortRule[]) {
    databases.updateView(dbId, view.id, { sorts: next });
  }

  function move(i: number, by: number) {
    const j = i + by;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  }
</script>

<div class="sorts">
  {#each rules as rule, i (rule.prop)}
    <div class="rule">
      <span class="lead">{i === 0 ? t('dbEdit.sort.sortBy') : t('dbEdit.sort.then')}</span>
      <select
        class="pop-input"
        value={rule.prop}
        onchange={(e) => save(rules.map((r, j) => (j === i ? { ...r, prop: (e.currentTarget as HTMLSelectElement).value } : r)))}
        aria-label={t('dbEdit.filter.property')}
      >
        {#if !databases.prop(dbId, rule.prop)}<option value={rule.prop} disabled>{t('dbEdit.filter.deletedProperty')}</option>{/if}
        {#each allProps.filter((p) => p.id === rule.prop || !rules.some((r) => r.prop === p.id)) as p (p.id)}
          <option value={p.id}>{p.name || typeInfo(p.type).label}</option>
        {/each}
      </select>
      <Segmented
        label={t('dbEdit.sort.direction')}
        value={rule.dir}
        options={[
          { value: 'asc', label: t('dbEdit.sort.up'), icon: 'arrow-up' },
          { value: 'desc', label: t('dbEdit.sort.down'), icon: 'arrow-down' },
        ]}
        iconOnly
        onchange={(d) => save(rules.map((r, j) => (j === i ? { ...r, dir: d as 'asc' | 'desc' } : r)))}
      />
      {#if rules.length > 1}
        <button class="icon-btn small" onclick={() => move(i, i === 0 ? 1 : -1)} aria-label={t('dbEdit.sort.changePriority')} data-tip={i === 0 ? t('dbEdit.sort.sortSecond') : t('dbEdit.sort.sortFirst')}>
          <Icon name="arrow-up-down" size={13} />
        </button>
      {/if}
      <button class="icon-btn small" onclick={() => save(rules.filter((_, j) => j !== i))} aria-label={t('dbEdit.sort.remove')} data-tip={t('common.actions.remove')}><Icon name="x" size={13} /></button>
    </div>
  {:else}
    <p class="empty">{t('dbEdit.sort.empty')}</p>
  {/each}
  {#if unused.length}
    <button class="pop-item add" onclick={() => save([...rules, { prop: unused[0].id, dir: 'asc' }])}><Icon name="plus" size={14} /><span class="grow">{t('dbEdit.sort.add')}</span></button>
  {/if}
  {#if rules.length}
    <button class="pop-item add" onclick={() => save([])}><Icon name="x" size={14} /><span class="grow">{t('dbEdit.sort.clear')}</span></button>
  {/if}
</div>

<style>
  .sorts {
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
    width: 48px;
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
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .empty {
    margin: 4px 6px 6px;
    font-size: var(--fs-ui);
    line-height: 1.45;
    color: var(--text-3);
  }
  .add {
    color: var(--text-2);
  }
</style>
