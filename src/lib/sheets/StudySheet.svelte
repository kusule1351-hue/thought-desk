<script lang="ts">
  import { MOD } from '../platform';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import PageIcon from '../components/PageIcon.svelte';
  import RichText from '../ui/RichText.svelte';
  import { cards } from '../cards.svelte';
  import { clock } from '../clock.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import { prefs } from '../prefs.svelte';
  import { GRADES, gapLabel, schedule, type Grade } from '../srs';
  import { store } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import type { Card, RichNode } from '../types';

  let { title, deck }: { title: string; deck: Card[] } = $props();

  const keyOf = (c: Card) => `${c.pageId}:${c.id}`;
  function shuffled<T>(list: T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // The session's cards are fixed when it starts.
  // svelte-ignore state_referenced_locally
  const order = new Map(deck.map((c, i) => [keyOf(c), i]));
  // svelte-ignore state_referenced_locally
  const total = deck.length;
  // svelte-ignore state_referenced_locally
  let queue = $state<Card[]>(prefs.studyShuffle ? shuffled(deck) : [...deck]);
  let flipped = $state(false);
  let busy = $state(false);
  /** Bumped on every answer and undo, so the next card starts face up. */
  let step = $state(0);
  /** Cards answered Hard, Good or Easy (done for this session). */
  let learned = $state(0);
  let again = $state(0);
  /** How each card went the first time it came up: the session's score. */
  let firstTry = $state<Record<string, Grade>>({});
  const started = Date.now();
  let finishedAt = $state(0);

  interface Step {
    card: Card;
    queue: Card[];
    learned: number;
    again: number;
    firstTry: Record<string, Grade>;
  }
  let history = $state.raw<Step[]>([]);

  const card = $derived(queue[0]);
  const source = $derived(card ? store.byId.get(card.pageId) : undefined);
  /** Answer first swaps the sides: recall the front from the back. */
  const question = $derived<RichNode[]>(card ? (prefs.studyReverse ? card.backContent : card.frontContent) : []);
  const answerSide = $derived<RichNode[]>(card ? (prefs.studyReverse ? card.frontContent : card.backContent) : []);
  /** Days each answer would schedule, for the button captions. */
  const gaps = $derived(card ? GRADES.map((g) => schedule(card.review, g.grade, clock.today).interval) : []);

  const close = () => (ui.study = null);

  async function answer(grade: Grade) {
    if (!card || !flipped || busy) return;
    busy = true;
    const current = card;
    history = [...history, { card: current, queue: [...queue], learned, again, firstTry: { ...firstTry } }];
    const review = await cards.answer(current, grade);
    if (!(keyOf(current) in firstTry)) firstTry[keyOf(current)] = grade;
    const rest = queue.slice(1);
    if (grade === 1) {
      // Forgotten: see it again a few cards later.
      again++;
      rest.splice(Math.min(rest.length, 3), 0, { ...current, review });
    } else learned++;
    queue = rest;
    if (!rest.length) finishedAt = Date.now();
    flipped = false;
    step++;
    busy = false;
  }

  /** Takes the last answer back: the card returns, showing its answer. */
  async function undo() {
    const last = history.at(-1);
    if (!last || busy) return;
    busy = true;
    history = history.slice(0, -1);
    await cards.restore(last.card);
    queue = last.queue;
    learned = last.learned;
    again = last.again;
    firstTry = last.firstTry;
    finishedAt = 0;
    step++;
    flipped = true;
    busy = false;
  }

  function toggleShuffle() {
    prefs.studyShuffle = !prefs.studyShuffle;
    // The card on screen stays; the rest are reordered (or put back in page order).
    const [head, ...rest] = queue;
    if (!head) return;
    const reordered = prefs.studyShuffle ? shuffled(rest) : [...rest].sort((a, b) => (order.get(keyOf(a)) ?? 0) - (order.get(keyOf(b)) ?? 0));
    queue = [head, ...reordered];
  }

  function toggleReverse() {
    prefs.studyReverse = !prefs.studyReverse;
    flipped = false;
    step++;
  }

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void undo();
      return;
    }
    if (!card || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === ' ' || e.key === 'Enter') && !flipped) {
      e.preventDefault();
      flipped = true;
    } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      void answer(Number(e.key) as Grade);
    } else if (flipped && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      void answer(3);
    }
  }

  // The summary: how much was remembered the first time, and how long it took.
  const tries = $derived(Object.values(firstTry));
  const remembered = $derived(tries.length ? Math.round((tries.filter((g) => g > 1).length / tries.length) * 100) : 0);
  const breakdown = $derived(GRADES.map((g) => ({ ...g, n: tries.filter((tried) => tried === g.grade).length })));
  // What's left: how many needed another look (if any), then what's still due.
  const nextLine = $derived.by(() => {
    const due = t('library.study.moreDue', { count: cards.dueCount });
    if (!again) return due;
    return t('library.study.twoSentences', { first: t('library.study.neededAnotherLook', { count: again }), second: due });
  });
  const duration = $derived.by(() => {
    const s = Math.max(1, Math.round(((finishedAt || Date.now()) - started) / 1000));
    if (s < 60) return t('library.study.seconds', { count: s });
    const m = Math.round(s / 60);
    return m < 60 ? t('library.study.minutes', { count: m }) : t('library.study.hoursMinutes', { hours: Math.floor(m / 60), minutes: m % 60 });
  });
  /** Above the question: a card seen before or a new one, and whether the sides are swapped. */
  const eyebrow = $derived(
    card?.review
      ? prefs.studyReverse
        ? t('library.study.reviewAnswerFirst')
        : t('library.study.review')
      : prefs.studyReverse
        ? t('library.study.newAnswerFirst')
        : t('library.study.new'),
  );
</script>

<svelte:window onkeydown={onKey} />

{#snippet side(nodes: RichNode[], empty: string)}
  {#if nodes.length}<RichText {nodes} />{:else}<span class="missing">{empty}</span>{/if}
{/snippet}

<Modal onclose={close} width={600} label={t('library.study.label', { title })}>
  <header class="modal-head">
    <h2>{title}</h2>
    <div class="options">
      <button class="icon-btn" class:on={prefs.studyShuffle} onclick={toggleShuffle} aria-pressed={prefs.studyShuffle} data-tip={prefs.studyShuffle ? t('library.study.shuffled') : t('library.study.shuffle')}>
        <Icon name="shuffle" size={15} />
      </button>
      <button class="icon-btn" class:on={prefs.studyReverse} onclick={toggleReverse} aria-pressed={prefs.studyReverse} data-tip={prefs.studyReverse ? t('library.study.answerFirstOn') : t('library.study.answerFirst')}>
        <Icon name="swap" size={15} />
      </button>
    </div>
    {#if card}<span class="progress-text">{t('library.study.progress', { learned, total })}</span>{/if}
    <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </header>
  <div class="bar" class:hidden={!card} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={learned}>
    <span style:width="{(learned / Math.max(1, total)) * 100}%"></span>
  </div>

  <div class="modal-body">
    {#if card}
      {#key `${keyOf(card)}:${step}`}
        <div class="stage">
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="flip" class:flipped onclick={() => (flipped = true)}>
            <div class="face" aria-hidden={flipped}>
              <div class="eyebrow">{eyebrow}</div>
              <div class="question">{@render side(question, t('library.study.nothingWritten'))}</div>
            </div>
            <div class="face back" aria-hidden={!flipped}>
              <div class="asked">{@render side(question, '')}</div>
              <div class="divider"></div>
              <div class="answer">{@render side(answerSide, t('library.study.noAnswer'))}</div>
            </div>
          </div>
          {#if source}
            <button
              class="source"
              onclick={() => {
                close();
                store.open(source.id);
              }}
            >
              {#if source.icon}<span><PageIcon icon={source.icon} /></span>{:else}<Icon name="page" size={12} />{/if}
              {source.title || t('common.untitled')}
            </button>
          {/if}
        </div>
      {/key}
    {:else}
      <div class="done">
        <span class="done-icon"><Icon name="check-circle" size={28} /></span>
        <h3>{t('library.study.complete')}</h3>
        <p class="summary">
          {t('library.study.summary', { count: total, percent: remembered, duration })}
        </p>
        <div class="breakdown" aria-label={t('library.study.breakdown')}>
          {#each breakdown as g (g.grade)}
            <div class="tally g{g.grade}">
              <strong>{fmt.number(g.n)}</strong>
              <span>{g.label}</span>
            </div>
          {/each}
        </div>
        <p class="next">{nextLine}</p>
      </div>
    {/if}
  </div>

  <footer class="modal-foot">
    {#if history.length}
      <button class="btn small undo" onclick={undo} disabled={busy} data-tip={t('library.study.undoTip')} data-tip-key="{MOD} Z">
        <Icon name="undo" size={14} stroke={2} /> {t('library.study.undo')}
      </button>
    {:else if card}
      <span>{flipped ? t('library.study.howWell') : t('library.study.spaceToShow')}</span>
    {:else}
      <span></span>
    {/if}
    {#if !card}
      <div class="actions"><button class="btn small primary" onclick={close}>{t('library.study.done')}</button></div>
    {:else if !flipped}
      <div class="actions"><button class="btn small primary" onclick={() => (flipped = true)}>{t('library.study.showAnswer')}</button></div>
    {:else}
      <div class="grades">
        {#each GRADES as g, i (g.grade)}
          <button class="grade g{g.grade}" onclick={() => answer(g.grade)} data-tip-key={g.key} disabled={busy}>
            <span class="g-label">{g.label}</span>
            <span class="g-gap">{gapLabel(gaps[i])}</span>
          </button>
        {/each}
      </div>
    {/if}
  </footer>
</Modal>

<style>
  .options {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }
  .options .on {
    background: var(--fill-2);
    color: var(--text);
  }
  .progress-text {
    margin: 0 4px 0 8px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 2px;
    margin: 0 24px;
    border-radius: 1px;
    background: var(--fill);
    overflow: hidden;
  }
  /* Kept in place (no jump) but out of sight once the session is over. */
  .bar.hidden {
    visibility: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-slow) var(--ease);
  }

  /* The card turns over like a real one: both faces share one grid cell,
     the back is pre-turned, and the whole card rotates on flip. */
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 8px;
    perspective: 1400px;
    animation: rise var(--dur) var(--ease);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .flip {
    display: grid;
    width: 100%;
    transform-style: preserve-3d;
    transition: transform 520ms cubic-bezier(0.3, 1.25, 0.45, 1);
    cursor: default;
  }
  .flip.flipped {
    transform: rotateY(180deg);
  }
  .face {
    grid-area: 1 / 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 260px;
    padding: 32px 28px;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    box-shadow: 0 0 0 0.5px var(--hairline);
    text-align: center;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }
  .face.back {
    transform: rotateY(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .flip {
      transition: none;
    }
  }
  .eyebrow {
    margin-bottom: 12px;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-600);
    color: var(--text-3);
  }
  /* Text keeps its spacing and line breaks, as written. */
  .question,
  .asked,
  .answer {
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .question {
    font-size: 24px;
    line-height: 32px;
    font-weight: var(--fw-650);
    letter-spacing: -0.016em;
  }
  .asked {
    font-size: var(--fs-callout);
    line-height: 20px;
    font-weight: var(--fw-500);
    color: var(--text-3);
  }
  .divider {
    flex: none;
    width: 48px;
    height: 1px;
    margin: 16px 0 18px;
    background: var(--hairline);
  }
  .answer {
    font-size: 19px;
    line-height: 28px;
    color: var(--text);
  }
  .missing {
    color: var(--text-4);
    font-weight: var(--fw-400);
  }
  .source {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--h-xs);
    margin-top: 16px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .source:hover {
    background: var(--fill);
    color: var(--text);
  }

  .undo {
    gap: 6px;
    min-width: 0;
    background: var(--fill);
    color: var(--text-2);
  }
  .undo:hover:not(:disabled) {
    background: var(--fill-2);
    color: var(--text);
  }
  .grades {
    display: flex;
    gap: 6px;
  }
  .grade {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 44px;
    border-radius: var(--r-sm);
    background: var(--fill);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .grade:hover {
    background: var(--fill-2);
  }
  .g-label {
    color: var(--text);
    font-size: var(--fs-ui);
    line-height: 16px;
    font-weight: var(--fw-600);
  }
  .g-gap {
    font-size: 11px;
    line-height: 16px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .g1 .g-label {
    color: var(--danger);
  }
  .grade.g3 {
    background: var(--accent);
  }
  .grade.g3:hover {
    background: color-mix(in srgb, var(--accent) 88%, var(--text));
  }
  .grade.g3 .g-label,
  .grade.g3 .g-gap {
    color: var(--on-accent);
  }
  .grade.g3 .g-gap {
    opacity: 0.75;
  }

  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 36px 24px 28px;
    text-align: center;
  }
  .done-icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--c-green) 14%, transparent);
    color: var(--c-green);
  }
  .done h3 {
    margin: 16px 0 4px;
    font-size: 17px;
    line-height: 24px;
    font-weight: var(--fw-650);
  }
  .summary {
    margin: 0;
    font-size: var(--fs-callout);
    line-height: 20px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  /* First-try results, one tile per grade. */
  .breakdown {
    display: grid;
    grid-template-columns: repeat(4, 76px);
    gap: 8px;
    margin: 20px 0 16px;
  }
  .tally {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 10px 0 8px;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
  }
  .tally strong {
    font-size: 20px;
    line-height: 24px;
    font-weight: var(--fw-650);
    font-variant-numeric: tabular-nums;
  }
  .tally span {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .tally.g1 strong {
    color: var(--danger);
  }
  .tally.g3 strong {
    color: var(--accent);
  }
  .next {
    margin: 0;
    max-width: 360px;
    font-size: var(--fs-footnote);
    line-height: 18px;
    color: var(--text-3);
  }
</style>
