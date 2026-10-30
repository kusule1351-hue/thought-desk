<script lang="ts">
  /**
   * What the Galaxy view shows until someone turns it on. It's new, it isn't
   * for everyone, and it costs memory while it's open, so it asks first;
   * nothing of it is read or drawn until then. Not wanting it hides it.
   */
  import EmptyState from '../ui/EmptyState.svelte';
  import { galaxy } from '../galaxy/galaxy.svelte';
  import { t } from '../i18n';
  import { prefs } from '../prefs.svelte';
  import { hideFromSidebar } from '../sidebar-items';
  import { store } from '../store.svelte';

  function notForMe() {
    galaxy.clear();
    hideFromSidebar('galaxy');
    store.go('home');
  }
</script>

<div class="view">
  <header class="view-head">
    <div>
      <h1 class="view-title">{t('common.views.galaxy')}</h1>
    </div>
  </header>
  <EmptyState icon="galaxy" title={t('pages.galaxy.askTitle')} text={t('pages.galaxy.askText')}>
    <button class="btn primary" onclick={() => (prefs.galaxyOn = true)}>{t('pages.galaxy.turnOn')}</button>
    <button class="btn" onclick={notForMe}>{t('pages.galaxy.hide')}</button>
  </EmptyState>
  <p class="cost">{t('pages.galaxy.askCost')}</p>
</div>

<style>
  .cost {
    max-width: 380px;
    margin: -22px auto 0;
    text-align: center;
    text-wrap: balance;
    font-size: var(--fs-footnote);
    line-height: 17px;
    color: var(--text-3);
  }
</style>
