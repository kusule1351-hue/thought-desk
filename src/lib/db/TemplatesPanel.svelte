<script lang="ts">
  /**
   * What a new row starts from: an empty row or one of the database's
   * templates. Click one to add a row from it; each template can be edited
   * (it's a page like any row), made the default, copied or deleted.
   */
  import PageIcon from '../components/PageIcon.svelte';
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import type { DbRow, DbView } from '../types';

  let { dbId, view, onpick, onclose }: { dbId: string; view: DbView; onpick: (templateId: string) => void; onclose: () => void } = $props();

  const templates = $derived(databases.templatesOf(dbId));
  const current = $derived(view.config.template && templates.some((tpl) => tpl.id === view.config.template) ? view.config.template : '');

  function more(e: MouseEvent, tpl: DbRow | null) {
    e.stopPropagation();
    const id = tpl?.id ?? '';
    ui.openMenuAt(e.currentTarget as Element, [
      { label: t('dbAuto.templates.defaultForView'), icon: 'check', checked: current === id, action: () => databases.setDefaultTemplate(dbId, id, view.id) },
      { label: t('dbAuto.templates.defaultForEveryView'), icon: 'layers', action: () => databases.setDefaultTemplate(dbId, id, null) },
      ...(tpl
        ? [
            { separator: true as const },
            {
              label: t('common.actions.edit'),
              icon: 'pencil',
              action: () => {
                onclose();
                store.open(tpl.id);
              },
            },
            { label: t('common.actions.duplicate'), icon: 'copy', action: () => void databases.duplicateRows([tpl.id]) },
            { label: t('common.actions.delete'), icon: 'trash', danger: true, action: () => void databases.deleteRows([tpl.id]) },
          ]
        : []),
    ]);
  }
</script>

<div class="tp">
  <div class="pop-head">{t('dbAuto.templates.newRowFrom')}</div>
  <div class="opt-row">
    <button class="pop-item" onclick={() => onpick('')}>
      <Icon name="page" size={14} />
      <span class="grow">{t('dbAuto.templates.emptyRow')}</span>
      {#if current === ''}<span class="badge">{t('dbAuto.templates.default')}</span>{/if}
    </button>
    <button class="more" onclick={(e) => more(e, null)} aria-label={t('dbAuto.templates.emptyRowOptions')} data-tip={t('dbAuto.templates.makeDefault')}><Icon name="more" size={14} /></button>
  </div>
  {#each templates as tpl (tpl.id)}
    {@const page = store.byId.get(tpl.id)}
    <div class="opt-row">
      <button class="pop-item" onclick={() => onpick(tpl.id)}>
        {#if page?.icon}<span class="emoji"><PageIcon icon={page.icon} /></span>{:else}<Icon name="template" size={14} />{/if}
        <span class="grow name">{page?.title || t('dbAuto.templates.untitled')}</span>
        {#if current === tpl.id}<span class="badge">{t('dbAuto.templates.default')}</span>{/if}
      </button>
      <button
        class="more"
        onclick={() => {
          onclose();
          store.open(tpl.id);
        }}
        aria-label={page?.title ? t('dbAuto.templates.editNamed', { title: page.title }) : t('dbAuto.templates.editUnnamed')}
        data-tip={t('common.actions.edit')}><Icon name="pencil" size={13} /></button
      >
      <button
        class="more"
        onclick={(e) => more(e, tpl)}
        aria-label={page?.title ? t('dbAuto.templates.moreNamed', { title: page.title }) : t('dbAuto.templates.moreUnnamed')}
        data-tip={t('common.actions.more')}><Icon name="more" size={14} /></button
      >
    </div>
  {/each}
  <div class="pop-sep"></div>
  <button
    class="pop-item"
    onclick={() => {
      onclose();
      void databases.newTemplate(dbId);
    }}
  >
    <Icon name="plus" size={14} /><span class="grow">{t('dbAuto.templates.new')}</span>
  </button>
  {#if !templates.length}
    <p class="tip">{t('dbAuto.templates.tip')}</p>
  {/if}
</div>

<style>
  .tp {
    display: flex;
    flex-direction: column;
  }
  .opt-row {
    display: flex;
    align-items: center;
    border-radius: var(--r-sm);
  }
  .opt-row:hover {
    background: var(--fill);
  }
  .opt-row .pop-item {
    flex: 1;
    min-width: 0;
    background: none;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .emoji {
    flex: none;
    width: 16px;
    text-align: center;
    font-size: 14px;
  }
  .badge {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--fill-2);
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    color: var(--text-2);
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
  .opt-row:hover .more {
    opacity: 1;
  }
  .more:hover {
    background: var(--fill-3);
    color: var(--text);
  }
  .tip {
    margin: 6px 8px 4px;
    font-size: var(--fs-footnote);
    line-height: 1.4;
    color: var(--text-3);
  }
</style>
