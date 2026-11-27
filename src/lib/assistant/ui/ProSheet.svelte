<!--
  Before the payment page opens: what Pro is, how it is paid for and stopped,
  and one box to tick, agreeing to the Terms of Use and the Privacy Policy as
  they stand today (both open in the browser from here). The box starts
  empty and the button waits for it. The server makes no checkout without the
  version agreed to, and sends it with the purchase to Polar, so what was
  agreed and when is on record.
-->
<script lang="ts">
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n';
  import Rich from '../../i18n/Rich.svelte';
  import { ui } from '../../ui.svelte';
  import { checkout, plan, read, refreshPlan } from '../plan.svelte';

  let agreed = $state(false);
  let busy = $state(false);

  // Which terms are in force is asked now, in case they changed since the plan was last looked at.
  void refreshPlan(true);

  const close = () => (ui.proSheet = false);

  async function pay() {
    if (!agreed || busy) return;
    busy = true;
    try {
      if (!plan.terms) await refreshPlan(true);
      const failed = plan.terms ? await checkout(plan.terms) : 'failed';
      if (failed === null || failed === 'already') return close();
      if (failed === 'terms') {
        // They changed under the person's feet: read again, tick again.
        agreed = false;
        ui.error(t('assistant.pro.changed'));
      } else ui.error(t('assistant.plan.failed'));
    } finally {
      busy = false;
    }
  }

  function open(e: MouseEvent, which: 'terms' | 'privacy') {
    e.preventDefault();
    void Promise.resolve(read(which)).catch(ui.error);
  }
</script>

<Modal onclose={close} width={440} top="14vh" label={t('assistant.plan.pro')} closeButton>
  <div class="pro">
    <h2>{t('assistant.plan.pro')}</h2>
    <p class="lead">{t('assistant.pro.lead')}</p>
    <ul>
      <li>{t('assistant.pro.billed')}</li>
      <li>{t('assistant.pro.cancel')}</li>
      <li>{t('assistant.pro.refund')}</li>
      <li>{t('assistant.pro.age')}</li>
    </ul>
    <label class="agree">
      <input type="checkbox" bind:checked={agreed} />
      <span>
        <Rich key="assistant.pro.agree">
          {#snippet terms(text: string)}<a href="https://thoughtdesk.org/terms" onclick={(e) => open(e, 'terms')}>{text}</a>{/snippet}
          {#snippet privacy(text: string)}<a href="https://thoughtdesk.org/privacy" onclick={(e) => open(e, 'privacy')}>{text}</a>{/snippet}
        </Rich>
      </span>
    </label>
    <div class="actions">
      <button class="btn" onclick={close}>{t('common.actions.cancel')}</button>
      <button class="btn primary" disabled={!agreed || busy} onclick={() => void pay()}>{t('assistant.pro.continue')}</button>
    </div>
    <p class="note">{t('assistant.pro.note')}</p>
  </div>
</Modal>

<style>
  .pro {
    display: flex;
    flex-direction: column;
    padding: 28px 28px 22px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: var(--fs-title3, 20px);
    font-weight: var(--fw-650);
    letter-spacing: -0.012em;
  }
  .lead {
    margin: 0 0 16px;
    font-size: var(--fs-body-ui);
    color: var(--text-2);
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 18px;
    padding: 14px 16px 14px 32px;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    font-size: var(--fs-ui);
    line-height: 1.45;
    color: var(--text);
  }
  li::marker {
    color: var(--text-3);
  }
  .agree {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 0 2px 18px;
    font-size: var(--fs-body-ui);
    line-height: 1.4;
    cursor: pointer;
  }
  .agree input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 2px 0 0;
    accent-color: var(--tint);
  }
  .agree a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .note {
    margin: 14px 2px 0;
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--text-3);
  }
</style>
