<script lang="ts">
  import PageIcon from './PageIcon.svelte';
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Editor from '../editor/Editor.svelte';
  import Backlinks from '../ui/Backlinks.svelte';
  import TagRow from '../ui/TagRow.svelte';
  import RowProperties from '../db/RowProperties.svelte';
  import { databases } from '../databases.svelte';
  import { randomIcon } from '../page-icon';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { STARTERS, type Starter } from '../editor/starters';
  import type { JSONContent } from '@tiptap/core';
  import type { Page } from '../types';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  let { page, onstats }: { page: Page; onstats?: (words: number) => void } = $props();

  // A database row opened on its own (from search or a link) brings its
  // database's rows, for its properties.
  $effect(() => {
    const db = databases.dbOf(page.id);
    if (db && !databases.ready(db)) void databases.ensure([db]);
  });

  // Live metadata (title/icon/width) comes from the store, content from `page`.
  const meta = $derived(store.byId.get(page.id));
  let titleEl: HTMLHeadingElement;
  let editor = $state<{ focusStart(): void; focusEnd(): void; start(content: JSONContent[]): void; insertDatabase(id: string): void }>();
  /** The body is empty: offer ways to start it. */
  let empty = $state(false);

  function useStarter(s: Starter) {
    // A page with no name yet takes the starter's.
    if (!meta?.title.trim()) {
      const title = s.title(fmt.date(new Date(), { month: 'short', day: 'numeric' }));
      titleEl.textContent = title;
      store.update(page.id, { title, ...(meta?.icon ? {} : { icon: s.icon }) });
    }
    editor?.start(s.content());
  }

  function startDatabase() {
    ui.newDatabase = { parentId: page.id, onCreated: (id) => editor?.insertDatabase(id) };
  }

  onMount(() => {
    titleEl.textContent = page.title;
  });

  // A title changed elsewhere (someone on a shared page) shows here, unless
  // it's being typed in this one.
  $effect(() => {
    const title = meta?.title;
    if (title === undefined || !titleEl || document.activeElement === titleEl) return;
    if ((titleEl.textContent ?? '') !== title) titleEl.textContent = title;
  });

  // Focus the title when a page is created or "Rename" is chosen.
  $effect(() => {
    if (ui.focusTitle !== page.id) return;
    ui.focusTitle = null;
    void tick().then(() => {
      titleEl?.focus();
      const sel = window.getSelection();
      sel?.selectAllChildren(titleEl);
      if (!titleEl.textContent) sel?.collapseToEnd();
    });
  });

  function onTitleInput() {
    // Chromium leaves a <br> behind when everything is deleted.
    if (titleEl.textContent === '' && titleEl.innerHTML !== '') titleEl.innerHTML = '';
    store.update(page.id, { title: (titleEl.textContent ?? '').replace(/\s+/g, ' ') });
  }

  function onTitleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor?.focusStart();
      return;
    }
    if (e.key === 'ArrowDown') {
      const sel = window.getSelection();
      const atEnd = sel?.isCollapsed && sel.focusOffset === (sel.focusNode?.textContent?.length ?? 0);
      if (atEnd || !titleEl.textContent) {
        e.preventDefault();
        editor?.focusStart();
      }
    }
  }

  function pickIcon(e: MouseEvent) {
    ui.pickIcon(
      e.currentTarget as Element,
      (emoji) => store.update(page.id, { icon: emoji }, { immediate: true }),
      () => store.update(page.id, { icon: '' }, { immediate: true }),
      store.byId.get(page.id)?.icon,
    );
  }

  // Clicking the empty area under the content puts the caret at the end.
  function onTailClick() {
    editor?.focusEnd();
  }
</script>

<article class="page" class:full={meta?.fullWidth}>
  <div class="head" class:has-icon={!!meta?.icon}>
    {#if meta?.icon}
      <button class="page-icon" onclick={pickIcon} data-tip={t('pages.head.changeIcon')}><PageIcon icon={meta.icon} /></button>
    {/if}
    {#if !meta?.icon || !meta?.tags.length}
      <div class="head-tools">
        {#if !meta?.icon}
          <button class="tool" onclick={() => store.update(page.id, { icon: randomIcon() }, { immediate: true })}>
            <Icon name="smile" size={16} />
            {t('pages.head.addIcon')}
          </button>
        {/if}
        {#if !meta?.tags.length}
          <button class="tool" onclick={(e) => ui.pickTags(e.currentTarget as Element, 'pages', page.id)}>
            <Icon name="tag" size={16} />
            {t('pages.head.addTag')}
          </button>
        {/if}
      </div>
    {/if}
    <!-- svelte-ignore a11y_missing_content (filled imperatively to keep the caret stable) -->
    <h1
      class="title"
      bind:this={titleEl}
      contenteditable="plaintext-only"
      spellcheck="false"
      data-placeholder={t('common.untitled')}
      oninput={onTitleInput}
      onkeydown={onTitleKey}
    ></h1>
  </div>

  {#if meta?.tags.length}
    <div class="page-tags"><TagRow table="pages" id={page.id} /></div>
  {/if}

  {#if databases.rows[page.id]}
    <RowProperties rowId={page.id} />
  {/if}

  <Editor bind:this={editor} {page} {onstats} onempty={(e) => (empty = e)} />

  {#if empty}
    <div class="starters" aria-label={t('pages.starters.region')}>
      <span class="starters-label">{t('pages.starters.startWith')}</span>
      {#each STARTERS as s (s.key)}
        <button class="starter" onclick={() => useStarter(s)} data-tip={s.hint}><span class="starter-icon"><PageIcon icon={s.icon} /></span>{s.label}</button>
      {/each}
      <button class="starter" onclick={startDatabase} data-tip={t('pages.starters.databaseHint')}><Icon name="database" size={14} />{t('pages.starters.database')}</button>
    </div>
  {/if}

  <Backlinks id={page.id} />

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="tail" onclick={onTailClick}></div>
</article>

<style>
  .page {
    width: 100%;
    max-width: calc(var(--page-width) + 2 * var(--page-pad));
    margin: 0 auto;
    padding: 0 var(--page-pad);
  }
  .page.full {
    max-width: none;
  }
  .head {
    position: relative;
    padding-top: 88px;
  }
  .head.has-icon {
    padding-top: 56px;
  }
  /* With an icon, the tools float in the space above it instead. */
  .has-icon .head-tools {
    top: 16px;
  }
  .page-tags {
    margin: -2px 0 16px;
  }
  .page-icon {
    display: grid;
    place-items: center;
    width: 80px;
    height: 80px;
    margin: 0 0 16px -8px;
    font-size: 60px;
    line-height: 1;
    border-radius: var(--r-lg);
    transition:
      background-color var(--dur-fast) var(--ease),
      transform var(--dur) var(--ease-out);
  }
  /* A line icon this big reads best a little smaller and finer than an emoji. */
  .page-icon :global(.page-glyph) {
    width: 0.86em;
    height: 0.86em;
    stroke-width: 1.4;
  }
  .page-icon:hover {
    background: var(--fill);
  }
  .page-icon:active {
    transform: scale(0.96);
  }
  /* "Add icon" floats in the space above the title, so it never shifts it. */
  .head-tools {
    position: absolute;
    top: 48px;
    left: -8px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .head:hover .head-tools,
  .head-tools:focus-within {
    opacity: 1;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-sm);
    padding: 0 10px 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .tool:hover {
    background: var(--fill);
    color: var(--text-2);
  }
  .title {
    margin: 0 0 10px;
    font-family: var(--font-page);
    font-size: var(--title-fs);
    font-weight: var(--fw-700);
    line-height: 1.15;
    letter-spacing: -0.03em;
    color: var(--text);
    overflow-wrap: break-word;
    text-wrap: balance;
    outline: none;
    cursor: text;
  }
  :global(:root[data-font="serif"]) .title {
    letter-spacing: -0.015em;
  }
  :global(:root[data-font="mono"]) .title {
    font-size: calc(var(--title-fs) * 0.85);
    letter-spacing: -0.02em;
  }
  .title:empty::before {
    content: attr(data-placeholder);
    color: var(--text-4);
  }
  .tail {
    min-height: 35vh;
    cursor: text;
  }
  .starters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 18px;
    font-family: var(--font-ui);
    animation: starters-in var(--dur) var(--ease) both;
  }
  @keyframes starters-in {
    from {
      opacity: 0;
    }
  }
  .starters-label {
    margin-right: 4px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .starter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    box-shadow: inset 0 0 0 1px var(--hairline);
    font-size: var(--fs-ui);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .starter:hover {
    background: var(--fill);
    color: var(--text);
  }
  .starter :global(.icon) {
    color: var(--text-3);
  }
  .starter-icon {
    font-size: 13px;
  }
</style>
