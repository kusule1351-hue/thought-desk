<script lang="ts">
  import { MOD } from '../platform';
  /**
   * The first thing a new install shows: a name for Home to greet you by,
   * how the app looks (applied as you choose), three things worth knowing,
   * and off you go. Everything here can be changed later in Settings.
   */
  import Logo from './Logo.svelte';
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import WindowControls from './WindowControls.svelte';
  import { isMac } from '../platform';
  import Swatches from '../ui/Swatches.svelte';
  import { ACCENTS, type Accent } from '../colors';
  import { prefs, type Font, type Theme } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { changeLook } from '../look-transition';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';

  const STEPS = ['welcome', 'look', 'tour', 'done'] as const;
  let step = $state(0);
  /** Which way the last move went, so steps slide the right way. */
  let dir = $state(1);
  let name = $state(prefs.name);
  let nameEl = $state<HTMLInputElement>();
  let nextEl = $state<HTMLButtonElement>();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const first = $derived(name.trim().split(/\s+/)[0] ?? '');

  const themes: { value: Theme; label: string }[] = [
    { value: 'light', label: t('onboarding.look.light') },
    { value: 'dark', label: t('onboarding.look.dark') },
    { value: 'system', label: t('onboarding.look.system') },
  ];
  const fonts: { value: Font; label: string; note: string }[] = [
    { value: 'sans', label: t('onboarding.look.sans'), note: t('onboarding.look.sansNote') },
    { value: 'serif', label: t('onboarding.look.serif'), note: t('onboarding.look.serifNote') },
    { value: 'mono', label: t('onboarding.look.mono'), note: t('onboarding.look.monoNote') },
  ];

  onMount(() => {
    void tick().then(() => nameEl?.focus());
  });

  async function go(to: number) {
    if (to < 0 || to >= STEPS.length) return;
    if (STEPS[step] === 'welcome') prefs.name = name.trim();
    dir = to > step ? 1 : -1;
    step = to;
    await tick();
    // Keyboard users keep going with Enter.
    if (STEPS[step] === 'welcome') nameEl?.focus();
    else nextEl?.focus();
  }

  function finish() {
    prefs.name = name.trim();
    prefs.welcomed = true;
    store.go('home');
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter on a button presses that button; anywhere else it moves on.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    if (step === STEPS.length - 1) finish();
    else void go(step + 1);
  }

  const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

  /** Steps slide in from the side they come from… */
  function slideIn(_node: Element, { from }: { from: number }) {
    return {
      // Starts as the old step is nearly gone, so the two never read on top of each other.
      delay: reduced ? 0 : 140,
      duration: reduced ? 0 : 420,
      css: (x: number) => `opacity:${easeOut(x)}; transform: translateX(${(1 - easeOut(x)) * 40 * from}px)`,
    };
  }

  /** …while the one being left drifts out the other way. */
  function slideOut(_node: Element, { to }: { to: number }) {
    return {
      duration: reduced ? 0 : 170,
      css: (x: number) => `opacity:${x * x * x}; transform: translateX(${(1 - x) * 28 * to}px) scale(${0.985 + 0.015 * x})`,
    };
  }

  /** At the end the whole screen lifts away, showing Home underneath. */
  function leave(_node: Element) {
    return {
      duration: reduced ? 0 : 520,
      css: (x: number) => `opacity:${easeOut(x)}; transform: scale(${1 + (1 - x) * 0.04}); filter: blur(${(1 - x) * 6}px)`,
    };
  }

  /** The little burst of dots around the finished check mark. */
  const BURST = Array.from({ length: 12 }, (_, i) => ({ angle: (i / 12) * 360 + (i % 2 ? 8 : -8), far: i % 3 === 0 ? 62 : i % 3 === 1 ? 52 : 44, size: i % 2 ? 6 : 8 }));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="welcome" class:still={reduced} role="dialog" aria-modal="true" aria-label={t('onboarding.welcome')} tabindex="-1" {onkeydown} out:leave|global>
  <header class="bar" data-tauri-drag-region>
    <div class="grow" data-tauri-drag-region></div>
    {#if !isMac}<WindowControls />{/if}
  </header>

  <div class="stage">
    {#key step}
      <section class="step" in:slideIn={{ from: dir }} out:slideOut={{ to: -dir }}>
        {#if STEPS[step] === 'welcome'}
          <Logo size={88} class="welcome-logo" />
          <h1>{t('onboarding.welcome')}</h1>
          <p class="lead">{t('onboarding.lead')}</p>
          <label class="name">
            <span>{t('onboarding.nameLabel')}</span>
            <input bind:this={nameEl} bind:value={name} placeholder={t('onboarding.namePlaceholder')} maxlength="40" autocomplete="given-name" spellcheck="false" />
          </label>
        {:else if STEPS[step] === 'look'}
          <h1>{t('onboarding.look.title')}</h1>
          <p class="lead">{t('onboarding.look.lead')}</p>

          <div class="field-label">{t('onboarding.look.appearance')}</div>
          <div class="choices three" role="radiogroup" aria-label={t('onboarding.look.appearance')}>
            {#each themes as theme (theme.value)}
              <button class="choice" class:on={prefs.theme === theme.value} role="radio" aria-checked={prefs.theme === theme.value} onclick={() => changeLook(() => (prefs.theme = theme.value))}>
                <span class="window {theme.value}" aria-hidden="true">
                  <span class="half light"><i class="side"></i><i class="line"></i><i class="line short"></i></span>
                  <span class="half dark"><i class="side"></i><i class="line"></i><i class="line short"></i></span>
                </span>
                <span class="choice-label">{theme.label}</span>
              </button>
            {/each}
          </div>

          <div class="field-label">{t('onboarding.look.accentColor')}</div>
          <div class="accent">
            <Swatches keys={[...ACCENTS]} value={prefs.accent === 'custom' ? 'graphite' : prefs.accent} onchange={(k) => changeLook(() => (prefs.accent = k as Accent))} label={t('onboarding.look.accentColor')} />
          </div>

          <div class="field-label">{t('onboarding.look.writingFont')}</div>
          <div class="choices three" role="radiogroup" aria-label={t('onboarding.look.writingFont')}>
            {#each fonts as f (f.value)}
              <button class="choice font" class:on={prefs.font === f.value} role="radio" aria-checked={prefs.font === f.value} onclick={() => changeLook(() => (prefs.font = f.value))}>
                <span class="sample {f.value}" aria-hidden="true">{t('onboarding.look.fontSample')}</span>
                <span class="choice-label">{f.label}</span>
                <span class="note">{f.note}</span>
              </button>
            {/each}
          </div>
        {:else if STEPS[step] === 'tour'}
          <h1>{t('onboarding.tour.title')}</h1>
          <p class="lead">{t('onboarding.tour.lead')}</p>
          <ul class="tips">
            <li style:--n={0}>
              <span class="keys"><kbd>/</kbd></span>
              <span class="tip"><strong>{t('onboarding.tour.slashTitle')}</strong>{t('onboarding.tour.slashBody')}</span>
            </li>
            <li style:--n={1}>
              <span class="keys"><kbd>{MOD}</kbd><kbd>K</kbd></span>
              <span class="tip"><strong>{t('onboarding.tour.searchTitle')}</strong>{t('onboarding.tour.searchBody')}</span>
            </li>
            <li style:--n={2}>
              <span class="keys"><span class="home-ico"><Icon name="home" size={16} /></span></span>
              <span class="tip"><strong>{t('onboarding.tour.homeTitle')}</strong>{t('onboarding.tour.homeBody')}</span>
            </li>
          </ul>
          <p class="aside">
            <Rich key="onboarding.shortcutsAside" params={{ mod: MOD }}>
              {#snippet kbd(text: string)}<kbd>{text}</kbd>{/snippet}
            </Rich>
          </p>
        {:else}
          <div class="done-mark" aria-hidden="true">
            {#each BURST as b, i (i)}<i class="spark" style:--a="{b.angle}deg" style:--far="{b.far}px" style:--s="{b.size}px"></i>{/each}
            <span class="disc">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path class="tick" d="M5 12.5l4.2 4.2L19 7" /></svg>
            </span>
          </div>
          <h1>{first ? t('onboarding.done.titleNamed', { name: first }) : t('onboarding.done.title')}</h1>
          <p class="lead">{t('onboarding.done.lead')}</p>
        {/if}
      </section>
    {/key}
  </div>

  <footer class="nav">
    <div class="nav-side">
      {#if step > 0}
        <button class="btn ghost" onclick={() => go(step - 1)}><Icon name="arrow-left" size={15} /> {t('onboarding.back')}</button>
      {/if}
    </div>
    <div class="dots" aria-label={t('onboarding.stepOf', { step: step + 1, total: STEPS.length })}>
      {#each STEPS as s, i (s)}<span class="dot" class:on={i === step} class:past={i < step}></span>{/each}
    </div>
    <div class="nav-side end">
      {#if step < STEPS.length - 1}
        <button class="btn primary" bind:this={nextEl} onclick={() => go(step + 1)}>
          {step === 0 && !name.trim() ? t('onboarding.skip') : t('onboarding.continue')} <Icon name="arrow-right" size={15} />
        </button>
      {:else}
        <button class="btn primary" bind:this={nextEl} onclick={finish}>{t('onboarding.start')}</button>
      {/if}
    </div>
  </footer>
</div>

<style>
  .welcome {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    outline: none;
    overflow: hidden;
    transform-origin: 50% 40%;
  }
  /* A soft glow of the accent colour that drifts slowly behind everything. */
  .welcome::before {
    content: '';
    position: absolute;
    inset: -30% -10% auto;
    height: 80%;
    background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 8%, transparent), transparent);
    pointer-events: none;
    animation: drift 18s ease-in-out infinite alternate;
  }
  /* Graphite would make a grey haze rather than a glow. */
  :global(:root[data-accent='graphite']) .welcome::before {
    opacity: 0.35;
  }
  @keyframes drift {
    from {
      transform: translate(-6%, -4%) scale(1);
    }
    to {
      transform: translate(6%, 3%) scale(1.12);
    }
  }
  .bar,
  .stage,
  .nav {
    position: relative;
  }

  /* Each step's parts arrive one after another. */
  .step > :global(*) {
    animation: rise 560ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .step > :global(:nth-child(2)) { animation-delay: 60ms; }
  .step > :global(:nth-child(3)) { animation-delay: 120ms; }
  .step > :global(:nth-child(4)) { animation-delay: 180ms; }
  .step > :global(:nth-child(5)) { animation-delay: 220ms; }
  .step > :global(:nth-child(6)) { animation-delay: 260ms; }
  .step > :global(:nth-child(7)) { animation-delay: 300ms; }
  .step > :global(:nth-child(8)) { animation-delay: 340ms; }
  .step > :global(:nth-child(n + 9)) { animation-delay: 380ms; }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }
  /* The logo springs in first. */
  .step > :global(.welcome-logo) {
    animation: spring 760ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  @keyframes spring {
    from {
      opacity: 0;
      transform: scale(0.6) rotate(-8deg);
    }
  }
  .welcome.still .tick {
    stroke-dashoffset: 0;
  }
  .welcome.still::before,
  .welcome.still .step > :global(*),
  .welcome.still :global(*) {
    animation: none !important;
  }
  .bar {
    display: flex;
    align-items: center;
    height: 40px;
    flex: none;
  }
  .grow {
    flex: 1;
    align-self: stretch;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    overflow-y: auto;
    padding: 12px 24px;
  }
  .step {
    grid-area: 1 / 1;
    width: min(540px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .step :global(.welcome-logo) {
    margin-bottom: 20px;
  }
  h1 {
    margin: 0;
    font-size: 30px;
    font-weight: var(--fw-700, 700);
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .lead {
    max-width: 420px;
    margin: 10px 0 0;
    font-size: var(--fs-body-ui, 15px);
    line-height: 1.5;
    color: var(--text-2);
  }
  .name {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(340px, 100%);
    margin-top: 34px;
    text-align: left;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-2);
  }
  .name input {
    height: 44px;
    padding: 0 14px;
    border: none;
    border-radius: var(--r-md);
    background: var(--fill-2);
    font-size: 17px;
    color: var(--text);
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .name input:focus {
    outline: none;
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .field-label {
    align-self: flex-start;
    margin: 26px 0 10px;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-600, 600);
    color: var(--text-2);
  }
  .choices {
    display: grid;
    gap: 10px;
    width: 100%;
  }
  .choices.three {
    grid-template-columns: repeat(3, 1fr);
  }
  .choice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 10px 12px;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 1px var(--separator);
    transition:
      box-shadow var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  .choice:hover {
    box-shadow: inset 0 0 0 1px var(--text-3);
  }
  .choice:active {
    transform: scale(0.98);
  }
  .choice.on {
    box-shadow: inset 0 0 0 2px var(--accent);
    animation: pick 360ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes pick {
    40% {
      transform: scale(0.96);
    }
  }
  .choice.on .sample {
    animation: bob 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes bob {
    40% {
      transform: translateY(-4px) scale(1.08);
    }
  }
  .choice-label {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600, 600);
  }
  .note {
    margin-top: -6px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }

  /* A tiny window in each look; "Match system" is half of each. */
  .window {
    position: relative;
    display: flex;
    width: 100%;
    aspect-ratio: 16 / 10;
    border-radius: var(--r-sm);
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--hairline);
  }
  .half {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 8px 0 30%;
  }
  .half.light {
    background: #ffffff;
    --ink: #d4d4d8;
    --side: #f2f2f4;
  }
  .half.dark {
    background: #1c1c1e;
    --ink: #48484a;
    --side: #2a2a2c;
  }
  .window.light .half.dark,
  .window.dark .half.light {
    display: none;
  }
  .window.system .half.dark .side {
    display: none;
  }
  .window.system .half.dark {
    padding-left: 8px;
  }
  .side {
    position: absolute;
    inset: 0 auto 0 0;
    width: 24%;
    background: var(--side);
  }
  .line {
    display: block;
    height: 5px;
    border-radius: 3px;
    background: var(--ink);
  }
  .line.short {
    width: 60%;
  }
  .accent {
    align-self: flex-start;
  }
  .sample {
    display: grid;
    place-items: center;
    height: 40px;
    font-size: 30px;
    line-height: 1;
    font-family: var(--font-ui);
  }
  .sample.serif {
    font-family: var(--font-serif);
  }
  .sample.mono {
    font-family: var(--font-mono);
    font-size: 27px;
  }

  .tips {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    margin: 28px 0 0;
    padding: 0;
    text-align: left;
  }
  .tips li {
    animation: rise 520ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(140ms + var(--n, 0) * 90ms);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .keys {
    display: flex;
    justify-content: center;
    gap: 3px;
    width: 76px;
    flex: none;
  }
  /* Each tip's keys are pressed once, as if typed. */
  .keys kbd {
    animation: press 300ms ease-in-out both;
    animation-delay: calc(560ms + var(--n, 0) * 160ms);
    min-width: 26px;
    height: 26px;
    justify-content: center;
    font-size: 13px;
    background: var(--raised);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 1px 0 var(--hairline);
    color: var(--text);
  }
  .home-ico {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .tip {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--text-2);
  }
  .tip strong {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600, 600);
    color: var(--text);
  }
  .aside {
    margin: 18px 0 0;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .aside kbd {
    margin: 0 1px;
  }
  @keyframes press {
    50% {
      transform: translateY(2px);
      box-shadow: 0 0 0 0.5px var(--hairline);
      background: var(--fill-2);
    }
  }
  .done-mark {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    margin-bottom: 22px;
  }
  .disc {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    animation: spring 640ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  /* The tick draws itself once the disc has landed. */
  .tick {
    stroke-dasharray: 24;
    stroke-dashoffset: 24;
    animation: draw 420ms 300ms cubic-bezier(0.65, 0, 0.35, 1) forwards;
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  .spark {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--s);
    height: var(--s);
    margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
    border-radius: 50%;
    background: var(--accent);
    opacity: 0;
    animation: burst 760ms 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .spark:nth-child(3n) {
    background: color-mix(in srgb, var(--accent) 55%, var(--bg));
  }
  @keyframes burst {
    0% {
      opacity: 0;
      transform: rotate(var(--a)) translateX(20px) scale(0.4);
    }
    25% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: rotate(var(--a)) translateX(var(--far)) scale(1);
    }
  }

  .nav {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 12px;
    padding: 18px 28px 26px;
    flex: none;
  }
  .nav-side {
    display: flex;
  }
  .nav-side.end {
    justify-content: flex-end;
  }
  .nav .btn {
    height: 38px;
    padding: 0 18px;
    gap: 6px;
  }
  .btn.ghost {
    padding: 0 12px;
    background: transparent;
    color: var(--text-2);
  }
  .btn.ghost:hover {
    background: var(--fill);
    color: var(--text);
  }
  .dots {
    display: flex;
    gap: 7px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fill-3, var(--separator));
    transition:
      background-color var(--dur) var(--ease),
      width var(--dur) var(--ease);
  }
  .dot.past {
    background: var(--text-3);
  }
  .dot.on {
    width: 20px;
    border-radius: 4px;
    background: var(--text);
  }
</style>
