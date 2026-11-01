<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener';
  import Icon from '../components/Icon.svelte';
  import { prefs } from '../prefs.svelte';
  import { goal, SPONSOR_URL } from '../sponsor';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  const dollars = (n: number) => fmt.number(n, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const progress = $derived(t('planner.home.goal.progress', { raised: dollars(goal.raised), target: dollars(goal.target) }));
</script>

<!-- One line under Home's greeting: how much of the sponsorship goal is in, and a way to give. Closing it hides it until the next goal. -->
{#if prefs.goalHidden !== goal.id}
  <div class="goal" role="group" aria-label={t('planner.home.goal.label')}>
    <span class="title"><Icon name="heart" size={13} stroke={2} />{t('planner.home.goal.title')}</span>
    <span class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={goal.raised} aria-valuetext={progress}>
      <span style:width="{Math.min(1, goal.raised / goal.target) * 100}%"></span>
    </span>
    <span class="raised">{progress}</span>
    <span aria-hidden="true">·</span>
    <button class="sponsor" onclick={() => openUrl(SPONSOR_URL).catch(ui.error)}>
      {t('planner.home.goal.sponsor')}
      <Icon name="external" size={11} stroke={2} />
    </button>
    <button class="icon-btn hide" onclick={() => (prefs.goalHidden = goal.id)} aria-label={t('planner.home.goal.hide')} data-tip={t('planner.home.goal.hideTip')}>
      <Icon name="x" size={12} stroke={2} />
    </button>
  </div>
{/if}

<style>
  .goal {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-top: 10px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-2);
  }
  .bar {
    width: 96px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--text-2);
  }
  .raised {
    font-variant-numeric: tabular-nums;
  }
  .sponsor {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-weight: var(--fw-600);
    color: var(--text-2);
    cursor: pointer;
  }
  .sponsor:hover {
    color: var(--text);
  }
  /* The × shows when the line is pointed at or focused, so it doesn't add clutter. */
  .hide {
    width: 20px;
    height: 20px;
    color: var(--text-3);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .goal:hover .hide,
  .hide:focus-visible {
    opacity: 1;
  }
</style>
