<script lang="ts">
  /**
   * "Get set up" on Home, for a new workspace: the few steps that make the
   * app useful for school, each ticked off as soon as it's done (whichever
   * way it was done). It goes away when every step is done, or when closed.
   */
  import Icon from '../components/Icon.svelte';
  import { cards } from '../cards.svelte';
  import { t } from '../i18n';
  import { importCalendar } from '../ics-import.svelte';
  import { planner } from '../planner.svelte';
  import { prefs } from '../prefs.svelte';
  import { store } from '../store.svelte';
  import { STARTERS } from '../editor/starters';

  const deck = STARTERS.find((s) => s.key === 'cards')!;

  const steps = $derived([
    {
      key: 'courses',
      title: t('sheets.setup.courses.title'),
      text: t('sheets.setup.courses.text'),
      done: planner.courses.length > 0,
      action: t('sheets.setup.courses.action'),
      run: () => void planner.promptCourse(),
    },
    {
      key: 'schedule',
      title: t('sheets.setup.schedule.title'),
      text: t('sheets.setup.schedule.text'),
      done: planner.events.some((e) => !e.deletedAt),
      action: t('sheets.setup.schedule.action'),
      run: () => void importCalendar(),
    },
    {
      key: 'assignment',
      title: t('sheets.setup.assignment.title'),
      text: t('sheets.setup.assignment.text'),
      done: planner.assignments.some((a) => !a.deletedAt),
      action: t('sheets.setup.assignment.action'),
      run: () => planner.newAssignment(),
    },
    {
      key: 'cards',
      title: t('sheets.setup.cards.title'),
      text: t('sheets.setup.cards.text'),
      done: cards.total > 0,
      action: t('sheets.setup.cards.action'),
      run: () => void store.create(null, { title: deck.title(''), icon: deck.icon, content: deck.content() }),
    },
  ]);
  const doneCount = $derived(steps.filter((s) => s.done).length);
  const next = $derived(steps.find((s) => !s.done));
</script>

{#if !prefs.setupHidden && next}
  <section class="setup" aria-label={t('sheets.setup.label')}>
    <div class="head">
      <div>
        <h2>{t('sheets.setup.title')}</h2>
        <p>{t('sheets.setup.progress', { count: doneCount, total: steps.length })}</p>
      </div>
      <div class="bar" aria-hidden="true"><span style:width="{(doneCount / steps.length) * 100}%"></span></div>
      <button class="icon-btn" onclick={() => (prefs.setupHidden = true)} aria-label={t('sheets.setup.hide')} data-tip={t('sheets.setup.hideTip')}><Icon name="x" size={14} /></button>
    </div>
    <ol class="steps">
      {#each steps as s (s.key)}
        <li class="step" class:done={s.done} class:next={s === next}>
          <span class="mark round" aria-label={s.done ? t('sheets.setup.stepDone') : t('sheets.setup.stepNotDone')}>
            {#if s.done}<Icon name="check" size={12} stroke={2.6} />{/if}
          </span>
          <span class="copy">
            <strong>{s.title}</strong>
            {#if !s.done}<span class="text">{s.text}</span>{/if}
          </span>
          {#if !s.done}
            <button class="btn small" class:primary={s === next} class:raised={s !== next} onclick={s.run}>{s.action}</button>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .setup {
    margin-bottom: 20px;
    padding: 16px 18px 10px;
    border-radius: var(--r-lg);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 6px;
  }
  .head > div:first-child {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-650);
  }
  .head p {
    margin: 2px 0 0;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .bar {
    flex: none;
    width: 120px;
    height: 6px;
    border-radius: 3px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--accent);
    transition: width var(--dur) var(--ease);
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 0;
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .step:last-child {
    box-shadow: none;
  }
  .mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--text-4);
    color: var(--on-accent, #fff);
  }
  .step.done .mark {
    background: var(--accent);
    box-shadow: none;
  }
  .copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .copy strong {
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
  }
  .step.done .copy strong {
    color: var(--text-3);
    font-weight: var(--fw-500);
    text-decoration: line-through;
    text-decoration-color: var(--text-4);
  }
  .text {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .step .btn {
    flex: none;
  }
</style>
