<script lang="ts">
  /**
   * The assistant's own page: the same conversation as the side panel, with
   * room. Before anything is said its face is the centre of it, large, with a
   * line in its own voice; once there is a conversation it shrinks to a slim
   * strip on top and the conversation takes the page.
   */
  import { t } from '../i18n';
  import { assistant } from '../assistant/assistant.svelte';
  import { face } from '../assistant/face.svelte';
  import type { Mood } from '../assistant/mood.svelte';
  import Face from '../assistant/ui/Face.svelte';
  import Conversation from '../assistant/ui/Conversation.svelte';
  import { keepFace } from '../assistant/ui/keep-face.svelte';

  keepFace();

  let typing = $state(false);
  const started = $derived(assistant.gate === 'ready' && assistant.items.length > 0);

  /** What it says, for the face it is making. */
  function line(mood: Mood): string {
    switch (mood) {
      case 'asleep':
        return t('assistant.mood.asleep');
      case 'curious':
        return t('assistant.mood.curious');
      case 'idle':
        return t('assistant.mood.idle');
      case 'bored':
        return t('assistant.mood.bored');
      case 'scheming':
        return t('assistant.mood.scheming');
      case 'flattered':
        return t('assistant.mood.flattered');
      case 'listening':
        return t('assistant.mood.listening');
      case 'thinking':
        return t('assistant.mood.thinking');
      case 'reading':
        return t('assistant.mood.reading');
      case 'writing':
        return t('assistant.mood.writing');
      case 'asking':
        return t('assistant.mood.asking');
      case 'proud':
        return t('assistant.mood.proud');
      case 'sad':
        return t('assistant.mood.sad');
      case 'oops':
        return t('assistant.mood.oops');
      case 'dizzy':
        return t('assistant.mood.dizzy');
      case 'broke':
        return t('assistant.mood.broke');
      case 'nope':
        return t('assistant.mood.nope');
    }
  }
  const said = $derived(line(face.mood));
</script>

<section class="assistant-page" aria-label={assistant.name}>
  <div class="column">
    {#if started}
      <header class="strip">
        <div class="who">
          <h1>{assistant.name}</h1>
          <p>{said}</p>
        </div>
        <button class="btn small new-chat" onclick={() => assistant.clear()}>{t('assistant.newChat')}</button>
      </header>
    {/if}
    <Conversation roomy bind:typing>
      {#snippet top()}
        {#if !started}
          <div class="hero">
            <Face mood={face.mood} size={128} />
            <h1>{assistant.name}</h1>
            <p class="line">{said}</p>
          </div>
        {/if}
      {/snippet}
    </Conversation>
  </div>
</section>

<style>
  .assistant-page {
    display: flex;
    justify-content: center;
    height: 100%;
    background: var(--bg);
    color: var(--text);
  }
  .column {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 760px;
    min-width: 0;
    height: 100%;
    padding: 0 24px;
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: clamp(16px, 8vh, 88px) 0 32px;
    text-align: center;
  }
  .hero h1 {
    margin: 16px 0 0;
    font-size: 40px;
    line-height: 1.1;
    font-weight: var(--fw-650);
    letter-spacing: -0.02em;
  }
  .line {
    margin: 0;
    max-width: 36ch;
    font-size: var(--fs-callout);
    line-height: 1.5;
    color: var(--text-2);
  }

  .strip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 0;
    background: var(--bg);
    box-shadow: 0 0.5px 0 var(--separator);
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .who h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
    font-weight: var(--fw-650);
  }
  .who p {
    margin: 2px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
</style>
