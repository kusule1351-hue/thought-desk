<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import { cards, type Deck } from '../cards.svelte';
  import { colorVar } from '../colors';
  import { t } from '../i18n';
  import { planner } from '../planner.svelte';
  import { Progressive, takeGrouped } from '../progressive.svelte';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { STARTERS } from '../editor/starters';

  /** A new page with a first, empty card to type into. */
  function startDeck() {
    const deck = STARTERS.find((s) => s.key === 'cards')!;
    void store.create(null, { title: deck.title(''), icon: deck.icon, content: deck.content() });
  }

  onMount(() => void cards.load());

  /** Decks under each course's notes folder, then the rest. */
  const groups = $derived.by(() => {
    const used = new Set<string>();
    const out: { key: string; label: string; color: string | null; courseId: string | null; decks: Deck[] }[] = [];
    for (const c of planner.courses) {
      if (!c.pageId) continue;
      const decks = cards.decksUnder(c.pageId);
      if (!decks.length) continue;
      decks.forEach((d) => used.add(d.pageId));
      out.push({ key: c.id, label: c.name || t('common.untitled'), color: colorVar(c.color), courseId: c.id, decks });
    }
    const rest = cards.decks.filter((d) => !used.has(d.pageId));
    if (rest.length) out.push({ key: 'other', label: out.length ? t('library.flashcards.otherDecks') : t('library.flashcards.decks'), color: null, courseId: null, decks: rest });
    return out;
  });

  // Decks render as you scroll.
  const lazy = new Progressive(40);
  const shownGroups = $derived(takeGrouped(groups, (g) => g.decks, lazy.limit));
  const deckCount = $derived(groups.reduce((n, g) => n + g.decks.length, 0));

  const total = $derived(cards.total);

  const summary = $derived.by(() => {
    if (!total) return t('library.flashcards.emptySubtitle');
    const decks = cards.decks.length;
    // Two phrases side by side, each whole: what's waiting, and what there is.
    const due = t('library.flashcards.dueToday', { count: cards.dueCount });
    const all = decks === 1 ? t('library.flashcards.cardsInDeck', { count: total, decks }) : t('library.flashcards.cardsInDecks', { count: total, decks });
    return `${due} · ${all}`;
  });

  function deckTitle(pageId: string) {
    return store.byId.get(pageId)?.title || t('common.untitled');
  }

  function menu(e: MouseEvent, d: Deck) {
    e.preventDefault();
    e.stopPropagation();
    const name = deckTitle(d.pageId);
    const items = [
      { label: t('library.flashcards.studyDue'), icon: 'cards', disabled: !(d.due + d.fresh), action: () => void cards.study([d.pageId], name) },
      { label: t('library.flashcards.studyAll'), icon: 'repeat', action: () => void cards.study([d.pageId], name, { all: true }) },
      { label: t('library.flashcards.openPage'), icon: 'page', action: () => store.open(d.pageId) },
      { separator: true as const },
      { label: t('library.flashcards.resetProgress'), icon: 'restore', danger: true, action: () => void cards.reset(d.pageId) },
    ];
    if (e.type === 'contextmenu') ui.openMenu({ x: e.clientX, y: e.clientY, items });
    else ui.openMenuAt(e.currentTarget as Element, items, { alignRight: true });
  }

  function studyGroup(decks: Deck[], label: string) {
    void cards.study(
      decks.map((d) => d.pageId),
      label,
    );
  }
</script>

<div class="view">
  <header class="view-head">
    <div>
      <h1 class="view-title">{t('common.views.flashcards')}</h1>
      <p class="view-sub">{summary}</p>
    </div>
    <div class="view-actions">
      <button class="btn primary" disabled={!cards.dueCount} onclick={() => cards.study(null, t('library.flashcards.allDecks'))}>
        <Icon name="cards" size={15} stroke={2} /> {t('library.flashcards.study', { count: cards.dueCount })}
      </button>
    </div>
  </header>

  {#if cards.loaded && !total}
    <EmptyState icon="cards" title={t('library.flashcards.empty')} text={t('library.flashcards.emptyText')}>
      <button class="btn primary" onclick={startDeck}><Icon name="plus" size={15} stroke={2.2} /> {t('library.flashcards.startDeck')}</button>
    </EmptyState>
  {/if}

  {#each shownGroups as { group: g, items } (g.key)}
    {@const due = g.decks.reduce((n, d) => n + d.due + d.fresh, 0)}
    <h2 class="group-title">
      <span class="g-label">
        {#if g.color}<span class="dot" style:--dot={g.color}></span>{/if}
        {#if g.courseId}<button class="course-link" onclick={() => store.openCourse(g.courseId!)}>{g.label}</button>{:else}{g.label}{/if}
      </span>
      {#if due && g.decks.length > 1}
        <button class="see-all" onclick={() => studyGroup(g.decks, g.label)}>{t('library.flashcards.study', { count: due })} <Icon name="chevron-right" size={12} stroke={2.2} /></button>
      {/if}
    </h2>
    <div class="group">
      {#each items as d (d.pageId)}
        {@const page = store.byId.get(d.pageId)}
        {@const m = d.mastered}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="group-row deck" oncontextmenu={(e) => menu(e, d)}>
          <button class="deck-main" onclick={() => store.open(d.pageId)}>
            <span class="page-icon">{#if page?.icon}<PageIcon icon={page.icon} />{:else}<Icon name="cards" size={16} />{/if}</span>
            <span class="deck-text">
              <span class="deck-title">{page?.title || t('common.untitled')}</span>
              <span class="meta">
                <span>{t('library.flashcards.cardCount', { count: d.count })}</span>
                {#if d.due}<span class="due">{t('library.flashcards.due', { count: d.due })}</span>{/if}
                {#if d.fresh}<span class="new">{t('library.flashcards.new', { count: d.fresh })}</span>{/if}
                {#if m}<span>{t('library.flashcards.mastered', { percent: Math.round((m / d.count) * 100) })}</span>{/if}
              </span>
            </span>
          </button>
          <div class="mastery" aria-hidden="true"><span style:width="{(m / d.count) * 100}%"></span></div>
          <button class="btn small raised" disabled={!(d.due + d.fresh)} onclick={() => cards.study([d.pageId], page?.title || t('common.untitled'))}>
            {t('library.flashcards.study', { count: d.due + d.fresh })}
          </button>
          <button class="icon-btn" onclick={(e) => menu(e, d)} data-tip={t('common.actions.more')} aria-label={t('common.actions.more')}><Icon name="more" size={15} /></button>
        </div>
      {/each}
    </div>
  {/each}
  {#if lazy.limit < deckCount}<div {@attach lazy.more}></div>{/if}
</div>

<style>
  .g-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .course-link {
    color: inherit;
    font: inherit;
  }
  .course-link:hover {
    color: var(--text);
  }
  .see-all {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: var(--h-xs);
    padding: 0 6px 0 8px;
    margin-right: -6px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .see-all:hover {
    background: var(--fill);
    color: var(--text);
  }
  .deck {
    justify-content: flex-start;
    gap: 12px;
    padding: 8px 12px 8px 16px;
  }
  .deck-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
  }
  .page-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 24px;
    font-size: 18px;
    color: var(--text-3);
  }
  .deck-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .deck-title {
    font-size: var(--fs-body-ui);
    line-height: 20px;
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .deck-main:hover .deck-title {
    text-decoration: underline;
    text-decoration-color: var(--text-4);
    text-underline-offset: 3px;
  }
  .meta {
    display: flex;
    gap: 10px;
    font-size: var(--fs-footnote);
    line-height: 16px;
    color: var(--text-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .due {
    color: var(--text);
    font-weight: var(--fw-600);
  }
  .new {
    color: var(--c-blue);
  }
  /* One width for every count, so the bars and buttons line up down the list. */
  .deck .btn {
    min-width: 88px;
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }
  .mastery {
    flex: none;
    width: 64px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .mastery span {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--c-green);
  }
</style>
