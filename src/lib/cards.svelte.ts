/** Flashcards collected from every page, and studying them. */

import { untrack } from 'svelte';
import { api } from './api';
import { clock } from './clock.svelte';
import { t } from './i18n';
import { isDue, schedule, type Grade } from './srs';
import { store } from './store.svelte';
import { ui } from './ui.svelte';
import type { Card, Deck } from './types';

export type { Deck };

/** New cards per study session, so a big new deck isn't one long sitting. */
const NEW_PER_SESSION = 30;

class Cards {
  // Only counts are kept: the cards themselves (their text) are read when a
  // study session starts, so thousands of cards cost nothing until then.
  #all = $state.raw<Deck[]>([]);
  loaded = $state(false);

  /** Pages with cards, most recently edited first (trashed ones drop out). */
  decks = $derived(
    this.#all.filter((d) => {
      const page = store.byId.get(d.pageId);
      return page && !page.deletedAt;
    }),
  );

  /** Cards to study today (due reviews plus new ones). */
  dueCount = $derived(this.decks.reduce((n, d) => n + d.due + d.fresh, 0));
  /** Every card, in every deck. */
  total = $derived(this.decks.reduce((n, d) => n + d.count, 0));

  #byPage = $derived(new Map(this.decks.map((d) => [d.pageId, d])));

  async load() {
    try {
      window.dispatchEvent(new Event('td:flush'));
      await store.flush();
      this.#all = await api.listDecks(clock.today);
      this.loaded = true;
    } catch (e) {
      ui.error(e);
    }
  }

  deck(pageId: string): Deck | undefined {
    return this.#byPage.get(pageId);
  }

  /** Decks inside a page (a course's notes folder, say), including itself. */
  decksUnder(pageId: string): Deck[] {
    return this.decks.filter((d) => d.pageId === pageId || store.isInside(d.pageId, pageId));
  }

  /**
   * Starts a session: due reviews first, then new cards in page order.
   * `all` studies every card regardless of schedule (cramming before a test).
   */
  async study(pageIds: string[] | null, title: string, { all = false } = {}) {
    let items: Card[];
    try {
      window.dispatchEvent(new Event('td:flush'));
      await store.flush();
      items = await api.listCards();
    } catch (e) {
      ui.error(e);
      return;
    }
    const today = clock.today;
    const only = pageIds && new Set(pageIds);
    const pool = items.filter((c) => {
      const page = store.byId.get(c.pageId);
      return page && !page.deletedAt && (!only || only.has(c.pageId));
    });
    const due = pool.filter((c) => c.review && (all || isDue(c, today))).sort((a, b) => a.review!.due.localeCompare(b.review!.due));
    const fresh = pool.filter((c) => !c.review);
    const queue = all ? [...due, ...fresh] : [...due, ...fresh.slice(0, NEW_PER_SESSION)];
    if (!queue.length) {
      ui.toast(pool.length ? t('library.flashcards.nothingDue') : t('library.flashcards.noCards'));
      return;
    }
    ui.study = { title, cards: queue };
  }

  /** Records an answer; returns the card's new state. */
  async answer(card: Card, grade: Grade) {
    const review = schedule(card.review, grade, clock.today);
    try {
      await api.saveReview(card.pageId, card.id, review);
    } catch (e) {
      ui.error(e);
    }
    reloadSoon(300);
    return review;
  }

  /** Undoes an answer: `card` is the card as it was before (its old progress). */
  async restore(card: Card) {
    try {
      if (card.review) await api.saveReview(card.pageId, card.id, card.review);
      else await api.forgetReview(card.pageId, card.id);
    } catch (e) {
      ui.error(e);
    }
    reloadSoon(300);
  }

  async reset(pageId: string) {
    const page = store.byId.get(pageId);
    const ok = await ui.confirm({
      title: t('library.flashcards.resetTitle'),
      message: t('library.flashcards.resetMessage', { title: page?.title || t('common.untitled') }),
      confirmLabel: t('library.flashcards.reset'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.resetReviews(pageId);
      await this.load();
    } catch (e) {
      ui.error(e);
    }
  }
}

export const cards = new Cards();

let timer: ReturnType<typeof setTimeout> | undefined;
function reloadSoon(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void cards.load(), delay);
}

// Counts follow edits, but only to pages that have (or had) cards: typing in
// any other page never recounts.
window.addEventListener('td:page-saved', (e) => {
  const { id, content } = (e as CustomEvent<{ id: string; content: string }>).detail;
  if (cards.loaded && (cards.deck(id) || content.includes('"flashcard"'))) reloadSoon(800);
});

// What's due changes at midnight.
$effect.root(() => {
  $effect(() => {
    void clock.today;
    if (untrack(() => cards.loaded)) reloadSoon(0);
  });
});
