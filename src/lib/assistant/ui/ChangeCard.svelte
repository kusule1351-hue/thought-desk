<script lang="ts">
  /**
   * A change the assistant proposes or has made: what it would do, and the
   * person's say. Its preview is shown while the change waits; once decided,
   * the preview folds away (it can be shown again).
   */
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n';
  import { planner } from '../../planner.svelte';
  import { store } from '../../store.svelte';
  import { assistant, type ChangeItem } from '../assistant.svelte';
  import Markdown from './Markdown.svelte';
  import Spinner from './Spinner.svelte';

  let { item }: { item: ChangeItem } = $props();

  const p = $derived(item.preview);
  const hasBoxes = $derived(!!p.body || !!p.before || !!p.after);
  let shown = $state(false);
  const open = $derived(item.state === 'asking' || shown);

  /** An edit's boxes: the text now and after, or only what is added or removed. */
  const boxes = $derived.by(() => {
    if (p.before && p.after) return [{ label: t('assistant.change.now'), text: p.before }, { label: t('assistant.change.after'), text: p.after }];
    if (p.after) return [{ label: t('assistant.change.adding'), text: p.after }];
    if (p.before) return [{ label: t('assistant.change.removing'), text: p.before }];
    return [];
  });

  function openPlace() {
    const place = item.place;
    if (!place) return;
    if (place.kind === 'page') store.open(place.id);
    else if (place.kind === 'assignment') planner.openAssignment(place.id);
    else planner.openEvent(place.id);
  }
</script>

<div class="card">
  <div class="head">
    <h3>{p.title}</h3>
    {#if hasBoxes && item.state !== 'asking'}
      <button class="toggle" aria-expanded={open} onclick={() => (shown = !shown)}>{open ? t('assistant.change.hide') : t('assistant.change.show')}</button>
    {/if}
  </div>

  {#if p.lines?.length}
    <dl class="lines">
      {#each p.lines as line, i (i)}
        <dt>{line.label}</dt>
        <dd>{line.value}</dd>
      {/each}
    </dl>
  {/if}

  {#if open}
    {#if p.body}
      <!-- A box that scrolls is reachable by keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="box" role="region" aria-label={t('assistant.change.preview')} tabindex="0">
        <Markdown text={p.body} />
      </div>
    {/if}
    {#each boxes as box, i (i)}
      <div class="labelled">
        <span class="caption">{box.label}</span>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="box" role="region" aria-label={box.label} tabindex="0">
          <Markdown text={box.text} />
        </div>
      </div>
    {/each}
  {/if}

  <div class="foot">
    {#if item.state === 'asking'}
      <button class="btn small primary allow" onclick={() => void assistant.allow(item.id)}>{t('assistant.change.allow')}</button>
      <button class="btn small decline" onclick={() => void assistant.decline(item.id)}>{t('assistant.change.decline')}</button>
    {:else if item.state === 'working'}
      <span class="state"><Spinner label={t('assistant.marks.running')} /> {t('assistant.change.working')}</span>
    {:else if item.state === 'done'}
      <span class="state done"><Icon name="check" size={13} stroke={2.2} /> <span class="summary">{item.summary}</span></span>
      <span class="actions">
        {#if item.place}<button class="link open-place" onclick={openPlace}>{t('assistant.change.open')}</button>{/if}
        {#if item.canUndo}<button class="link undo" onclick={() => void assistant.undo(item.id)}>{t('assistant.change.undo')}</button>{/if}
      </span>
    {:else if item.state === 'declined'}
      <span class="state muted">{t('assistant.marks.notDone')}</span>
    {:else if item.state === 'undone'}
      <span class="state muted">{t('assistant.change.undone')}</span>
    {:else if item.state === 'failed'}
      <span class="state muted">{t('assistant.change.failed')}</span>
    {/if}
  </div>
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--bg);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-sm);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    min-width: 0;
    margin: 0;
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .toggle,
  .link {
    flex: none;
    padding: 0 2px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    color: var(--text-2);
    text-decoration: underline;
    text-decoration-color: var(--text-4);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .toggle:hover,
  .link:hover {
    color: var(--text);
    text-decoration-color: var(--text);
  }
  .lines {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.45;
  }
  .lines dt {
    color: var(--text-3);
  }
  .lines dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .labelled {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .caption {
    font-size: var(--fs-caption);
    font-weight: var(--fw-550);
    letter-spacing: 0.02em;
    color: var(--text-3);
  }
  .box {
    max-height: 240px;
    overflow: auto;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: var(--bg-grouped);
    box-shadow: 0 0 0 0.5px var(--hairline);
  }
  .box:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: var(--h-xs);
  }
  .foot:has(.allow) {
    justify-content: flex-start;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .state.done {
    color: var(--text);
  }
  .state.muted {
    color: var(--text-3);
  }
  .summary {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .actions {
    display: inline-flex;
    flex: none;
    gap: 8px;
  }
</style>
