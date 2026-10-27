<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import Icon from '../components/Icon.svelte';
  import AssignmentRow from '../ui/AssignmentRow.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import EventRow from '../ui/EventRow.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import { PALETTE, colorVar } from '../colors';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { library } from '../library.svelte';
  import { store } from '../store.svelte';
  import { tags } from '../tags.svelte';
  import { formatBytes, relativeTime } from '../time';
  import { Progressive } from '../progressive.svelte';
  import { ui } from '../ui.svelte';

  let { name }: { name: string } = $props();

  const items = $derived(tags.itemsWith(name));
  const total = $derived(items.pages.length + items.assignments.length + items.events.length + items.files.length);

  // One budget across the sections, so a tag on thousands of items renders as you scroll.
  const lazy = new Progressive();
  $effect(() => {
    void name;
    lazy.reset();
  });
  const shown = $derived.by(() => {
    let left = lazy.limit;
    const take = <T,>(list: T[]) => {
      const out = list.slice(0, Math.max(0, left));
      left -= out.length;
      return out;
    };
    return { pages: take(items.pages), assignments: take(items.assignments), events: take(items.events), files: take(items.files) };
  });

  function menu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: t('sheets.renameMenu'), icon: 'pencil', action: () => void tags.rename(name) },
        { separator: true },
        { header: t('sheets.color') },
        { label: t('sheets.tag.defaultColor'), icon: 'sparkle', checked: !tags.colorKey(name), action: () => void tags.recolor(name, '') },
        ...PALETTE.map((p) => ({
          label: p.label,
          dot: colorVar(p.key),
          checked: tags.colorKey(name) === p.key,
          action: () => void tags.recolor(name, p.key),
        })),
        { separator: true },
        { label: t('sheets.tag.delete'), icon: 'trash', danger: true, action: () => void tags.remove(name) },
      ],
      { alignRight: true },
    );
  }

  const occ = (e: (typeof items.events)[number]) => ({ event: e, key: e.id, start: e.startDate, end: e.endDate });
</script>

<div class="view">
  <header class="view-head">
    <div>
      <h1 class="view-title tag-title" style:--c={tags.color(name)}><span class="hash">#</span>{name}</h1>
      <p class="view-sub">{t('sheets.tag.items', { count: total })}</p>
    </div>
    <div class="view-actions">
      <button class="icon-btn" onclick={menu} data-tip={t('sheets.tag.options')} aria-label={t('sheets.tag.options')}><Icon name="more" /></button>
    </div>
  </header>

  {#if shown.pages.length}
    <h2 class="group-title"><span>{t('sheets.section.pages')}</span><span class="count">{fmt.number(items.pages.length)}</span></h2>
    <div class="group">
      {#each shown.pages as p (p.id)}
        <button class="group-row link-row" onclick={() => store.open(p.id)}>
          <span class="icon">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name="page" size={16} />{/if}</span>
          <span class="title">{p.title || t('common.untitled')}</span>
          <span class="meta">{relativeTime(p.updatedAt)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if shown.assignments.length}
    <h2 class="group-title"><span>{t('sheets.section.assignments')}</span><span class="count">{fmt.number(items.assignments.length)}</span></h2>
    <div class="group">
      {#each shown.assignments as a (a.id)}
        <AssignmentRow {a} />
      {/each}
    </div>
  {/if}

  {#if shown.events.length}
    <h2 class="group-title"><span>{t('sheets.section.events')}</span><span class="count">{fmt.number(items.events.length)}</span></h2>
    <div class="group">
      {#each shown.events as e (e.id)}
        <EventRow occ={occ(e)} series />
      {/each}
    </div>
  {/if}

  {#if shown.files.length}
    <h2 class="group-title"><span>{t('sheets.section.files')}</span><span class="count">{fmt.number(items.files.length)}</span></h2>
    <div class="group">
      {#each shown.files as f (f.id)}
        <button class="group-row link-row" onclick={() => library.preview(f.id)}>
          <FileTile file={f} size={28} />
          <span class="title">{f.name}</span>
          <span class="meta">{formatBytes(f.size)} · {relativeTime(f.createdAt)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if lazy.limit < total}<div {@attach lazy.more}></div>{/if}

  {#if !total}
    <EmptyState icon="tag" title={t('sheets.tag.nothingTagged', { name })} text={t('sheets.tag.nothingTaggedText')} />
  {/if}
</div>

<style>
  .tag-title {
    color: var(--text);
  }
  .hash {
    margin-right: 2px;
    color: var(--c);
  }
  .count {
    font-weight: var(--fw-500);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .link-row {
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .link-row:hover {
    background: var(--fill);
  }
  .link-row:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .link-row:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    font-size: 16px;
    color: var(--text-3);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
</style>
