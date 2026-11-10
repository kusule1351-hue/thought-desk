<script lang="ts">
  import { onMount } from 'svelte';
  import { syncState } from '../sync/state.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';

  /** The sync storage in use: a thin bar and one line, in Settings → Account. */
  const usage = $derived(syncState.usage);
  const size = (n: number) => fmt.bytes(n, true);
  const share = $derived(usage && usage.limit > 0 ? Math.min(1, Math.max(0, usage.used / usage.limit)) : 0);
  const full = $derived(!!usage && share >= 1);
  const nearly = $derived(!!usage && !full && share > 0.9);
  const used = $derived(usage ? t('settings.sync.used', { used: size(usage.used), limit: size(usage.limit) }) : '');
  const text = $derived.by(() => {
    if (!usage) return syncState.failed ? t('settings.sync.failed') : t('settings.sync.loading');
    if (full) return t('settings.sync.full');
    if (nearly) return t('settings.sync.left', { used: size(usage.used), limit: size(usage.limit), left: size(usage.limit - usage.used) });
    return used;
  });

  onMount(() => void syncState.refreshUsage());
</script>

<div class="meter" role="group" aria-label={t('settings.sync.label')}>
  {#if usage}
    <span class="bar" role="progressbar" aria-label={t('settings.sync.label')} aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={Math.min(usage.used, usage.limit)} aria-valuetext={used}>
      <span style:width="{share * 100}%"></span>
    </span>
  {/if}
  <span class="text" class:full>{text}</span>
</div>

<style>
  .meter {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .bar {
    display: block;
    width: 100%;
    max-width: 280px;
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
  .text {
    font-variant-numeric: tabular-nums;
  }
  /* Full is the one state that speaks up, and only in its words. */
  .text.full {
    color: var(--danger);
  }
</style>
