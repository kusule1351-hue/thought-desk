<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import CaptureBox from '../ui/CaptureBox.svelte';
  import { t } from '../i18n';
  import { ui } from '../ui.svelte';

  let { start }: { start: string } = $props();
  // svelte-ignore state_referenced_locally (seeded once when opened)
  let text = $state(start);
  let box = $state<{ save(): Promise<void> }>();

  const close = () => (ui.capture = null);
</script>

<Modal onclose={close} top="16vh" label={t('sheets.capture.title')}>
  <header class="modal-head">
    <h2>{t('sheets.capture.title')}</h2>
    <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </header>
  <div class="modal-body">
    <CaptureBox bind:this={box} bind:text autofocus onsaved={close} />
  </div>
  <footer class="modal-foot">
    <span>{t('sheets.capture.footer')}</span>
    <div class="actions">
      <button class="btn small" onclick={close}>{t('common.actions.cancel')}</button>
      <button class="btn small primary" onclick={() => box?.save()} disabled={!text.trim()}>{t('common.actions.save')}</button>
    </div>
  </footer>
</Modal>
