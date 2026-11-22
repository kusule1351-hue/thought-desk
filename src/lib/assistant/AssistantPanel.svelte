<script lang="ts">
  /**
   * The assistant's panel: a quiet column beside the page. The conversation
   * is ui/Conversation.svelte; this is its frame: the header, the width, and
   * the close button.
   */
  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n';
  import { prefs } from '../prefs.svelte';
  import { assistant } from './assistant.svelte';
  import { face } from './face.svelte';
  import Face from './ui/Face.svelte';
  import Conversation from './ui/Conversation.svelte';

  const MIN = 280;
  const MAX = 720;
  const DEFAULT = 380;

  let resizing = $state(false);

  function startResize(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    resizing = true;
    const startX = e.clientX;
    const startW = prefs.assistantWidth;
    const move = (ev: PointerEvent) => {
      prefs.assistantWidth = Math.round(Math.min(MAX, Math.max(MIN, startW + startX - ev.clientX)));
    };
    const up = () => {
      resizing = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  function onResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') prefs.assistantWidth = Math.min(MAX, prefs.assistantWidth + step);
    else if (e.key === 'ArrowRight') prefs.assistantWidth = Math.max(MIN, prefs.assistantWidth - step);
    else return;
    e.preventDefault();
  }
</script>


<aside class="assistant" class:resizing aria-label={assistant.name} style:width="{prefs.assistantWidth}px">
  <!-- A focusable separator is a resize control (arrow keys move it). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label={t('assistant.resize')}
    aria-valuemin={MIN}
    aria-valuemax={MAX}
    aria-valuenow={prefs.assistantWidth}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={onResizeKey}
    ondblclick={() => (prefs.assistantWidth = DEFAULT)}
  ></div>

  <header class="head">
    <Face mood={face.mood} size={30} />
    <h2>{assistant.name}</h2>
    <button class="btn small new-chat" disabled={!assistant.items.length} onclick={() => assistant.clear()}>{t('assistant.newChat')}</button>
    <button class="icon-btn" onclick={() => (prefs.assistantOpen = false)} aria-label={t('common.actions.close')} data-tip={t('common.actions.close')}><Icon name="x" /></button>
  </header>

  <Conversation />
</aside>

<style>
  .assistant {
    position: relative;
    flex: none;
    display: flex;
    flex-direction: column;
    height: 100%;
    max-width: calc(100vw - 48px);
    background: var(--bg-sidebar);
    box-shadow: inset 1px 0 0 var(--separator);
    color: var(--text);
    --face-ground: var(--bg-sidebar);
  }
  .assistant.resizing {
    cursor: col-resize;
    user-select: none;
  }

  /* Resize grip on the left edge: invisible until hovered, then a 2px rule (as the sidebar's). */
  .resizer {
    position: absolute;
    top: 0;
    left: -4px;
    z-index: 5;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    outline: none;
  }
  .resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: var(--separator-strong);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .resizer:hover::after,
  .resizer:focus-visible::after,
  .resizing .resizer::after {
    opacity: 1;
    transition-delay: 80ms;
  }

  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--titlebar-h);
    padding: 0 8px 0 16px;
  }
  .head h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600);
  }
</style>
