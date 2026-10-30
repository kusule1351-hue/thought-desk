<script lang="ts">
  /**
   * Every page as a star in a spiral galaxy, and every link
   * between pages as a thread of light (galaxy/render.ts draws it). Hover a
   * star for its name and links, click it to open the page.
   */
  import { onMount, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import PageIcon from '../components/PageIcon.svelte';
  import SearchField from '../ui/SearchField.svelte';
  import { galaxy } from '../galaxy/galaxy.svelte';
  import { GalaxyRenderer } from '../galaxy/render';
  import { cancelSky, readSky, skyKey, starOf, starPages, Superseded, type Sky } from '../galaxy/sky';
  import { i18n, t } from '../i18n';
  import { planner } from '../planner.svelte';
  import { split } from '../split.svelte';
  import { store } from '../store.svelte';
  import { tabs } from '../tabs.svelte';
  import { ui } from '../ui.svelte';

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let renderer: GalaxyRenderer | null = null;

  let sky = $state.raw<Sky | null>(null);
  let slow = $state(false);
  let query = $state('');
  let hover = $state<{ star: number; x: number; y: number } | null>(null);
  /** The star a keyboard is on in the list of stars. */
  let keyed = -1;

  // Stars come, go or move: not every keystroke in a page somewhere else.
  const pages = $derived.by(() => {
    void store.placed;
    return untrack(starPages);
  });
  const key = $derived(skyKey(pages));
  /** Saves of a page's text, which can change its links and its length. */
  let saves = $state(0);
  // A course's notes are a cluster of their own, so the sky changes with the courses.
  const courseKey = $derived(planner.courses.map((c) => c.pageId ?? '').join(','));

  const title = (star: number) => (sky && store.untracked.get(sky.ids[star])?.title) || t('common.untitled');

  // The canvas fills the view; labels keep out from under the controls on it.
  const ro = new ResizeObserver(() => measure());
  function measure() {
    if (!renderer) return;
    const box = host.getBoundingClientRect();
    const covered = [...host.querySelectorAll('[data-covers]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height };
    });
    renderer.resize(host.clientWidth, host.clientHeight, covered);
  }
  function covers(node: HTMLElement) {
    node.dataset.covers = '';
    ro.observe(node);
    return {
      destroy() {
        ro.unobserve(node);
        queueMicrotask(measure);
      },
    };
  }

  onMount(() => {
    renderer = new GalaxyRenderer(
      canvas,
      {
        hover: (star, x, y) => (hover = star === -1 ? null : { star, x, y }),
        pick: (star, e) => open(star, e),
      },
      title,
    );
    ro.observe(host);
    measure();
    const saved = () => saves++;
    window.addEventListener('td:page-saved', saved);
    return () => {
      window.removeEventListener('td:page-saved', saved);
      ro.disconnect();
      cancelSky();
      renderer?.destroy();
      renderer = null;
      // Opening the Galaxy again from the sidebar shows all of it.
      galaxy.clear();
    };
  });

  // Pages coming, going, moving or saved: read the sky again (soon after, while typing elsewhere).
  let ticket = 0;
  $effect(() => {
    void key;
    void saves;
    void courseKey;
    const list = untrack(() => pages);
    const timer = setTimeout(() => void load(list), untrack(() => sky) ? 600 : 0);
    return () => clearTimeout(timer);
  });

  async function load(list: typeof pages) {
    const mine = ++ticket;
    const wait = setTimeout(() => (slow = true), 250);
    let next: Sky;
    try {
      next = await readSky(list);
    } catch (e) {
      // A newer read stopped this one's layout; it brings the sky itself.
      if (e instanceof Superseded) return;
      throw e;
    } finally {
      clearTimeout(wait);
      if (mine === ticket) slow = false;
    }
    if (mine !== ticket || !renderer) return;
    if (next.failed && !sky?.failed) ui.toast(t('pages.galaxy.failed'));
    const same = sky?.layout === next.layout;
    sky = next;
    if (same) {
      renderer.retitle();
      renderer.recolor(next.heat);
    } else renderer.setLayout(next.layout, next.heat);
  }

  // "Show in Galaxy": centre on that page's star and light up what it's linked with
  // (flying there the first time, lighting it again when the sky is read again).
  let focusedId: string | null = null;
  $effect(() => {
    void galaxy.page;
    void sky;
    untrack(() => applyFocus(galaxy.page !== focusedId));
  });

  function applyFocus(fly: boolean) {
    if (!sky || !renderer) return;
    focusedId = galaxy.page;
    // A database row shines as its database.
    const id = galaxy.page && starOf(galaxy.page);
    const star = id ? sky.ids.indexOf(id) : -1;
    if (keyed !== -1) return;
    renderer.focus(star, { depth: 2, fly });
  }

  function clearFocus() {
    galaxy.clear();
    renderer?.fit();
  }

  function open(star: number, e?: MouseEvent | KeyboardEvent) {
    const id = sky?.ids[star];
    if (!id) return;
    if (e?.altKey) split.show(id);
    else if (e && (e.ctrlKey || e.metaKey)) void tabs.openPage(id, { focus: false });
    else store.open(id);
  }

  // Search: matching stars light up and get their names.
  const matches = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase(i18n.language);
    if (!sky || !q) return null;
    const mask = new Uint8Array(sky.ids.length);
    const found: number[] = [];
    for (let i = 0; i < sky.ids.length; i++) {
      if (title(i).toLocaleLowerCase(i18n.language).includes(q)) {
        mask[i] = 1;
        found.push(i);
      }
    }
    found.sort((a, b) => sky!.layout.mag[b] - sky!.layout.mag[a]);
    return { mask, found };
  });
  $effect(() => renderer?.highlight(matches?.mask ?? null));

  /** Enter flew to a match: a new or cleared search lets go of it again. */
  let searched = false;
  function findFirst(e: SubmitEvent) {
    e.preventDefault();
    const first = matches?.found[0];
    if (first === undefined) return;
    searched = true;
    renderer?.focus(first, { depth: 1 });
  }
  $effect(() => {
    void matches;
    untrack(() => {
      if (!searched) return;
      searched = false;
      applyFocus(false);
    });
  });

  // For keyboards and screen readers: the brightest stars (or the matches) as a list.
  const listed = $derived.by(() => {
    if (!sky) return [];
    if (matches) return matches.found.slice(0, 100);
    const order = Array.from(sky.ids, (_, i) => i).sort((a, b) => sky!.layout.mag[b] - sky!.layout.mag[a] || a - b);
    return order.slice(0, 100);
  });

  // The list is one Tab stop; the arrow keys move along it.
  let current = $state(0);
  let starList: HTMLElement;
  $effect(() => {
    if (current >= listed.length) current = 0;
  });
  function moveAlong(e: KeyboardEvent) {
    const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    let next = e.key === 'Home' ? 0 : e.key === 'End' ? listed.length - 1 : step[e.key] === undefined ? -1 : current + step[e.key];
    if (next < 0 || !listed.length) return;
    e.preventDefault();
    next = Math.min(listed.length - 1, next);
    current = next;
    starList.querySelectorAll('button')[next]?.focus();
  }

  function keyFocus(star: number) {
    keyed = star;
    renderer?.focus(star, { depth: 1 });
  }

  function keyBlur() {
    keyed = -1;
    applyFocus(false);
  }

  const count = $derived(sky?.ids.length ?? 0);
  const linkCount = $derived((sky?.layout.links.length ?? 0) / 2);
  const summary = $derived(`${t('pages.galaxy.stars', { count })} · ${t('pages.galaxy.links', { count: linkCount })}`);
  // A page moved to the Trash isn't something to centre on any more.
  const focusPage = $derived.by(() => {
    const page = galaxy.page ? store.byId.get(galaxy.page) : undefined;
    return page && !page.deletedAt ? page : undefined;
  });

  const card = $derived.by(() => {
    if (!hover || !sky) return null;
    const id = sky.ids[hover.star];
    const page = store.byId.get(id);
    const path = store
      .ancestors(id)
      .map((a) => a.title || t('common.untitled'))
      .join(' / ');
    const left = hover.x > host.clientWidth - 280;
    return {
      page,
      path,
      degree: sky.layout.degree[hover.star],
      words: sky.words[hover.star],
      left,
      x: hover.x,
      // Kept clear of the top and bottom edges.
      y: Math.min(Math.max(hover.y, 48), host.clientHeight - 48),
    };
  });
</script>

<div class="galaxy" bind:this={host}>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>

  <header class="head" use:covers>
    <h1 class="view-title">{t('common.views.galaxy')}</h1>
    {#if sky && count}<p class="sub">{summary}</p>{/if}
    {#if focusPage}
      <div class="chip">
        <span class="chip-label">{t('pages.galaxy.around', { title: focusPage.title || t('common.untitled') })}</span>
        <button class="chip-btn" onclick={() => store.open(focusPage.id)}>{t('pages.galaxy.open')}</button>
        <button class="chip-x" onclick={clearFocus} aria-label={t('pages.galaxy.clearFocus')} data-tip={t('pages.galaxy.clearFocus')}><Icon name="x" size={13} stroke={2.2} /></button>
      </div>
    {/if}
  </header>

  {#if count}
    <form class="find" onsubmit={findFirst} use:covers>
      <SearchField bind:value={query} placeholder={t('pages.galaxy.find')} width={220} small />
      {#if matches && !matches.found.length}<p class="no-match">{t('pages.galaxy.noMatch', { query: query.trim() })}</p>{/if}
    </form>
  {/if}

  <nav class="stars" aria-label={t('pages.galaxy.list')} bind:this={starList}>
    {#each listed as star, i (star)}
      <button
        class="star"
        tabindex={i === current ? 0 : -1}
        onfocus={() => {
          current = i;
          keyFocus(star);
        }}
        onblur={keyBlur}
        onkeydown={moveAlong}
        onclick={(e) => open(star, e)}
      >
        {t('pages.galaxy.starLabel', { title: title(star), count: sky?.layout.degree[star] ?? 0 })}
      </button>
    {/each}
  </nav>

  {#if card}
    <div class="card" class:left={card.left} style:left="{card.x}px" style:top="{card.y}px">
      <div class="card-title">
        {#if card.page?.icon}<span class="card-icon"><PageIcon icon={card.page.icon} /></span>{/if}
        <span>{card.page?.title || t('common.untitled')}</span>
      </div>
      {#if card.path}<div class="card-path">{card.path}</div>{/if}
      <div class="card-links">{t('pages.galaxy.words', { count: card.words })} · {t('pages.galaxy.starLinks', { count: card.degree })}</div>
    </div>
  {/if}


  <div class="controls" use:covers>
    <button class="ctl" onclick={() => renderer?.zoomBy(1.6)} aria-label={t('pages.galaxy.zoomIn')} data-tip={t('pages.galaxy.zoomIn')}><Icon name="plus" size={15} stroke={2} /></button>
    <button class="ctl" onclick={() => renderer?.zoomBy(1 / 1.6)} aria-label={t('pages.galaxy.zoomOut')} data-tip={t('pages.galaxy.zoomOut')}><Icon name="minus" size={15} stroke={2} /></button>
    <button class="ctl" onclick={() => renderer?.fit()} aria-label={t('pages.galaxy.fit')} data-tip={t('pages.galaxy.fit')}><Icon name="expand" size={14} stroke={2} /></button>
  </div>

  {#if sky && !count}
    <div class="empty">
      <h2>{t('pages.galaxy.emptyTitle')}</h2>
      <p>{t('pages.galaxy.emptyText')}</p>
    </div>
  {:else if sky && count > 1 && !linkCount && !sky.failed}
    <p class="hint">{t('pages.galaxy.noLinks')}</p>
  {/if}
  {#if slow}<p class="gathering">{t('pages.galaxy.gathering')}</p>{/if}
</div>

<style>
  /* Space is black whatever the app's theme, so the controls on it are dark too. */
  .galaxy {
    --text: #f5f5f5;
    --text-2: rgba(255, 255, 255, 0.62);
    --text-3: rgba(255, 255, 255, 0.42);
    --fill: rgba(255, 255, 255, 0.07);
    --fill-2: rgba(255, 255, 255, 0.11);
    --fill-3: rgba(255, 255, 255, 0.16);
    --hairline: rgba(255, 255, 255, 0.1);
    --separator: rgba(255, 255, 255, 0.08);
    --bg-elevated: #161616;
    color-scheme: dark;
    position: relative;
    height: 100%;
    min-height: 420px;
    overflow: hidden;
    border-radius: inherit;
    background: #000;
    color: var(--text);
    user-select: none;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    outline: none;
  }

  .head {
    position: absolute;
    top: 36px;
    left: clamp(20px, calc(var(--pane-w, 100vw) * 0.04), 48px);
    max-width: calc(100% - 320px);
    pointer-events: none;
  }
  .sub {
    margin-top: 4px;
    font-size: var(--fs-ui);
    color: var(--text-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    padding: 4px 4px 4px 12px;
    border-radius: 999px;
    background: rgba(18, 18, 18, 0.66);
    border: 1px solid var(--hairline);
    backdrop-filter: blur(14px);
    pointer-events: auto;
    max-width: 100%;
  }
  .chip-label {
    font-size: var(--fs-ui);
    font-weight: var(--fw-550);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip-btn {
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-sm, 12px);
    font-weight: var(--fw-550);
  }
  .chip-btn:hover {
    background: var(--fill-3);
  }
  .chip-x {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: var(--text-2);
  }
  .chip-x:hover {
    background: var(--fill-2);
    color: var(--text);
  }

  .find {
    position: absolute;
    top: 40px;
    right: clamp(20px, calc(var(--pane-w, 100vw) * 0.04), 48px);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .find :global(.field) {
    background: rgba(18, 18, 18, 0.6);
    backdrop-filter: blur(14px);
  }
  .no-match {
    font-size: 12px;
    color: var(--text-2);
  }

  /* Read by screen readers and reached by Tab; the canvas shows the focus. */
  .stars {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .card {
    position: absolute;
    transform: translate(16px, -50%);
    max-width: 260px;
    padding: 8px 12px 9px;
    border-radius: 12px;
    background: rgba(12, 12, 12, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.45),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(16px);
    pointer-events: none;
    z-index: 3;
    animation: card-in 160ms var(--ease-out, ease-out);
  }
  .card.left {
    transform: translate(calc(-100% - 16px), -50%);
  }
  .card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: var(--fw-600);
    line-height: 18px;
  }
  .card-title span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-icon {
    flex: none;
    font-size: 14px;
  }
  .card-path {
    margin-top: 1px;
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-links {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-2);
  }
  @keyframes card-in {
    from {
      opacity: 0;
    }
  }

  .controls {
    position: absolute;
    right: clamp(20px, calc(var(--pane-w, 100vw) * 0.04), 48px);
    bottom: 24px;
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 12px;
    background: rgba(18, 18, 18, 0.6);
    border: 1px solid var(--hairline);
    backdrop-filter: blur(14px);
  }
  .ctl {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    color: var(--text-2);
  }
  .ctl:hover {
    background: var(--fill-2);
    color: var(--text);
  }

  .empty {
    position: absolute;
    left: 50%;
    bottom: 18%;
    transform: translateX(-50%);
    text-align: center;
    pointer-events: none;
  }
  .empty h2 {
    font-size: 20px;
    font-weight: var(--fw-650);
    letter-spacing: -0.01em;
  }
  .empty p {
    margin-top: 6px;
    color: var(--text-2);
    font-size: var(--fs-ui);
  }
  .hint,
  .gathering {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12.5px;
    color: var(--text-2);
    pointer-events: none;
    white-space: nowrap;
  }
  .hint {
    bottom: 32px;
  }
  .gathering {
    top: 50%;
  }
  :global(.scroller[data-below-640]) .hint {
    bottom: 76px;
    white-space: normal;
    width: 80%;
    text-align: center;
  }

</style>
