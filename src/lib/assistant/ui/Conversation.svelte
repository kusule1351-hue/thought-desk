<script lang="ts">
  /**
   * The conversation itself: what the assistant says and proposes (from
   * assistant.svelte.ts), the person's answers, and the message box. The side
   * panel and the assistant's page both show it; `roomy` is the page's, with
   * more air around the same things.
   */
  import { onMount, tick, type Snippet } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n';
  import { prefs } from '../../prefs.svelte';
  import { ui } from '../../ui.svelte';
  import { assistant, type AskItem, type Item, type Notice } from '../assistant.svelte';
  import { face } from '../face.svelte';
  import Face from './Face.svelte';
  import ChangeCard from './ChangeCard.svelte';
  import Markdown from './Markdown.svelte';
  import Spinner from './Spinner.svelte';
  import { keepFace } from './keep-face.svelte';
  import { plan, refreshPlan, upgrade } from '../plan.svelte';

  let {
    roomy = false,
    typing = $bindable(false),
    top,
  }: {
    roomy?: boolean;
    /** Whether the person is typing to it (the box has words and focus), so its face can listen. */
    typing?: boolean;
    /** Something above the conversation, scrolling with it (the page's introduction). */
    top?: Snippet;
  } = $props();

  let draft = $state('');
  let focused = $state(false);
  let field = $state<HTMLTextAreaElement>();
  let body = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  /** Whether the conversation follows what is being written (the person has not scrolled up). */
  let stick = true;

  keepFace();
  $effect(() => {
    typing = focused && !!draft.trim();
  });
  $effect(() => {
    face.typing = typing;
    return () => (face.typing = false);
  });

  const ready = $derived(assistant.gate === 'ready');
  const canSend = $derived(!!draft.trim() && !assistant.busy);
  const percent = $derived.by(() => {
    const a = assistant.allowance;
    return a && a.limit > 0 ? Math.max(0, Math.min(100, Math.round((a.used / a.limit) * 100))) : null;
  });

  /** The conversation as turns: what the person asked, then everything the assistant did about it. */
  type Turn = { key: string; ask: AskItem } | { key: string; ask: null; items: Item[] };
  const turns = $derived.by(() => {
    const out: Turn[] = [];
    let asked = 0;
    for (const item of assistant.items) {
      const last = out[out.length - 1];
      if (item.type === 'ask') {
        asked = item.id;
        out.push({ key: `ask-${item.id}`, ask: item });
      } else if (last && !last.ask) last.items.push(item);
      else out.push({ key: `after-${asked}`, ask: null, items: [item] });
    }
    return out;
  });

  // ---- the conversation follows its end while it grows

  function onScroll() {
    if (body) stick = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  }

  onMount(() => {
    if (!content || !body) return;
    const watch = new ResizeObserver(() => {
      if (stick && body) body.scrollTop = body.scrollHeight;
    });
    watch.observe(content);
    return () => watch.disconnect();
  });

  // ---- the message box

  /** Grows with what is typed, up to about eight lines. */
  function fit() {
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }
  $effect(() => {
    void draft;
    void field;
    fit();
  });

  // Focus starts in the box, and the allowance and the plan are looked up, once it can be used.
  $effect(() => {
    if (!ready) return;
    void assistant.refreshAllowance();
    void refreshPlan();
  });
  // Pro arrived (or went) while the app was open: the allowance is a different one now.
  $effect(() => {
    void plan.pro;
    if (ready) void assistant.refreshAllowance();
  });

  const goPro = () => upgrade();
  $effect(() => {
    if (field) field.focus({ preventScroll: true });
  });

  async function send(text = draft) {
    text = text.trim();
    if (!text || assistant.busy) return;
    draft = '';
    stick = true;
    const sending = assistant.send(text);
    await tick();
    field?.focus();
    await sending;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void send();
  }

  async function stop() {
    assistant.stop();
    await tick();
    field?.focus();
  }

  /** Starts the sentence in the box for the person to finish. */
  async function startFind() {
    draft = t('assistant.examples.find').replace(/\s*…$/, ' ');
    await tick();
    field?.focus();
    field?.setSelectionRange(draft.length, draft.length);
  }

  // ---- notices

  function noticeText(reason: Notice): string {
    switch (reason) {
      case 'signed-out':
        return t('assistant.notice.signedOut');
      case 'closed':
        return t('assistant.notice.closed');
      case 'off':
        return t('assistant.notice.off');
      case 'spent':
        return t('assistant.notice.spent');
      case 'busy':
        return t('assistant.notice.busy');
      case 'fast':
        return t('assistant.notice.fast');
      case 'offline':
        return t('assistant.notice.offline');
      case 'bad':
        return t('assistant.notice.bad');
      case 'failed':
        return t('assistant.notice.failed');
      case 'refused':
        return t('assistant.notice.refused');
      case 'cut':
        return t('assistant.notice.cut');
      case 'steps':
        return t('assistant.notice.steps');
    }
  }
  const RETRY: Notice[] = ['busy', 'fast', 'offline', 'bad', 'failed'];
</script>

<div class="conversation" class:roomy>
<div class="body" bind:this={body} onscroll={onScroll}>
  <div class="content" bind:this={content}>
    {@render top?.()}
    {#if !assistant.items.length && assistant.gate === 'off'}
      <div class="intro">
        <h3>{t('assistant.intro.canTitle')}</h3>
        <p>{t('assistant.intro.can')}</p>
        <h3>{t('assistant.intro.sendsTitle')}</h3>
        <p>{t('assistant.intro.sends')}</p>
        <h3>{t('assistant.intro.neverTitle')}</h3>
        <p>{t('assistant.intro.never')}</p>
        <button class="btn primary" onclick={() => (prefs.assistantOn = true)}>{t('assistant.intro.turnOn')}</button>
      </div>
    {:else if !assistant.items.length && assistant.gate === 'signed-out'}
      <div class="signed-out">
        <p>{t('assistant.signedOut.text')}</p>
        <button class="btn primary" onclick={() => (ui.accountSheet = true)}>{t('assistant.signIn')}</button>
      </div>
    {:else if !assistant.items.length}
      <div class="empty">
        <p class="hint">{t('assistant.empty.hint')}</p>
        <button class="example" onclick={() => void send(t('assistant.examples.due'))}>{t('assistant.examples.due')}</button>
        <button class="example" onclick={() => void send(t('assistant.examples.cards'))}>{t('assistant.examples.cards')}</button>
        <button class="example" onclick={() => void send(t('assistant.examples.summarise'))}>{t('assistant.examples.summarise')}</button>
        <button class="example" onclick={() => void startFind()}>{t('assistant.examples.find')}</button>
      </div>
    {:else}
      <div class="items">
        {#each turns as turn, n (turn.key)}
          {#if turn.ask}
            <div class="item ask"><p>{turn.ask.text}</p></div>
          {:else}
            <!-- Everything it did about one question, beside one small face; only the latest is alive. -->
            <div class="turn">
              <div class="avatar"><Face mood={n === turns.length - 1 ? face.mood : 'idle'} size={roomy ? 34 : 30} still={n !== turns.length - 1} /></div>
              <div class="said">
                {#each turn.items as item (item.id)}
                {#if item.type === 'answer'}
                  <div class="item answer" data-state={item.writing ? 'writing' : 'done'}>
                    {#if item.text}
                      <Markdown text={item.text} />
                    {:else if item.writing}
                      <span class="thinking">{t('assistant.thinking')}</span>
                    {/if}
                  </div>
                {:else if item.type === 'read'}
                  <div class="item read" data-state={item.state}>
                    {#if item.state === 'running'}
                      <Spinner size={11} label={t('assistant.marks.running')} />
                    {:else if item.state === 'done'}
                      <span class="mark" role="img" aria-label={t('assistant.marks.done')}><Icon name="check" size={11} stroke={2.2} /></span>
                    {/if}
                    <span class="label">{item.label}</span>
                    {#if item.state === 'failed'}<span class="failed">{t('assistant.marks.couldnt')}</span>{/if}
                  </div>
                {:else if item.type === 'change'}
                  <div class="item change" data-state={item.state}>
                    <ChangeCard {item} />
                  </div>
                {:else if item.type === 'notice'}
                  <div class="item notice" data-reason={item.reason}>
                    <span>{noticeText(item.reason)}</span>
                    {#if item.reason === 'signed-out'}
                      <button class="link" onclick={() => (ui.accountSheet = true)}>{t('assistant.signIn')}</button>
                    {:else if item.reason === 'spent' && plan.on && !plan.pro}
                      <button class="link" disabled={plan.busy} onclick={() => void goPro()}>{t('assistant.plan.upgrade')}</button>
                    {:else if RETRY.includes(item.reason)}
                      <button class="link" disabled={assistant.busy} onclick={() => void assistant.retry()}>{t('assistant.tryAgain')}</button>
                    {/if}
                  </div>
                {/if}
                {/each}
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if ready}
  <div class="composer">
    {#if assistant.asking.length > 1}
      <div class="waiting">
        <span>{t('assistant.change.waiting', { count: assistant.asking.length })}</span>
        <button class="btn small primary allow-all" onclick={() => void assistant.allowAll()}>{t('assistant.change.allowAll')}</button>
      </div>
    {/if}
    <div class="box round">
      <textarea
        bind:this={field}
        bind:value={draft}
        rows="1"
        spellcheck="true"
        placeholder={t('assistant.composer.placeholder', { name: assistant.name })}
        aria-label={t('assistant.composer.placeholder', { name: assistant.name })}
        onkeydown={onKeydown}
        onfocus={() => (focused = true)}
        onblur={() => (focused = false)}
      ></textarea>
      {#if assistant.busy}
        <button class="stop round" onclick={() => void stop()} aria-label={t('assistant.composer.stop')} data-tip={t('assistant.composer.stop')}><span class="square"></span></button>
      {:else}
        <button class="send round" disabled={!canSend} onclick={() => void send()} aria-label={t('assistant.composer.send')} data-tip={t('assistant.composer.send')}><Icon name="arrow-up" size={16} stroke={2.4} /></button>
      {/if}
    </div>
    <!-- Said wherever it is talked to: this is a machine, and it can be wrong. -->
    <p class="allowance">{t('assistant.composer.ai', { name: assistant.name })}{#if percent !== null}{' · '}{t('assistant.composer.allowance', { percent })}{/if}</p>
  </div>
{:else if assistant.items.length}
  <!-- An old chat, open where nothing can be asked: it can be read, and this says what asking needs. -->
  <div class="composer closed">
    {#if assistant.gate === 'off'}
      <button class="btn small primary" onclick={() => (prefs.assistantOn = true)}>{t('assistant.intro.turnOn')}</button>
    {:else}
      <span>{t('assistant.signedOut.text')}</span>
      <button class="btn small primary" onclick={() => (ui.accountSheet = true)}>{t('assistant.signIn')}</button>
    {/if}
  </div>
{/if}
</div>

<style>
  .conversation {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
  }
  .content {
    padding: 8px 16px 16px;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* The first-time explanation. */
  .intro {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .intro h3 {
    margin: 12px 0 0;
    font-size: var(--fs-footnote);
    font-weight: var(--fw-600);
    color: var(--text-2);
  }
  .intro h3:first-child {
    margin-top: 0;
  }
  .intro p,
  .signed-out p {
    margin: 0;
    font-size: var(--fs-ui);
    line-height: 1.5;
    color: var(--text);
  }
  .intro .btn {
    margin-top: 16px;
  }
  .signed-out {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .hint {
    margin: 0 0 4px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .example {
    max-width: 100%;
    padding: 7px 14px;
    border-radius: 999px;
    background: var(--fill);
    font-size: var(--fs-ui);
    line-height: 1.4;
    text-align: left;
    color: var(--text);
    transition:
      background-color var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  .example:hover {
    background: var(--fill-3);
  }
  .example:active {
    transform: scale(0.97);
  }

  /* The person's words: a quiet tinted block on the right. */
  .item.ask {
    align-self: flex-end;
    max-width: 88%;
    padding: 7px 13px;
    border-radius: 17px;
    background: var(--fill-2);
  }

  /* Everything it did about one question, beside one small face that stays in view as the answer scrolls. */
  .turn {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 10px;
  }
  .avatar {
    position: sticky;
    top: 6px;
  }
  .said {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .item.ask p {
    margin: 0;
    font-size: var(--fs-ui);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
  .thinking {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    animation: pulse 1.8s var(--ease) infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }

  /* A step it is working through: small, muted, and close to its neighbours. */
  .item.read {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .item.read + .item.read {
    margin-top: -8px;
  }
  .item.read .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item.read .mark {
    display: grid;
    flex: none;
  }
  .item.read .failed {
    flex: none;
    color: var(--text-3);
    font-style: italic;
  }

  .item.notice {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 8px 12px;
    border-radius: var(--r-sm);
    background: var(--bg);
    box-shadow: 0 0 0 0.5px var(--hairline);
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--text-2);
  }
  .link {
    padding: 0 2px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    color: var(--text);
    text-decoration: underline;
    text-decoration-color: var(--text-4);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .link:hover:not(:disabled) {
    text-decoration-color: var(--text);
  }
  .link:disabled {
    color: var(--text-3);
    cursor: default;
  }

  /* The message box and what sits with it. */
  .composer {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 10px;
  }
  .waiting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 4px 4px 12px;
    border-radius: var(--r-sm);
    background: var(--bg);
    box-shadow: 0 0 0 0.5px var(--hairline);
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  /* A capsule: the words on the left, one round button on the right. */
  .box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 5px 5px 5px 16px;
    border-radius: 19px;
    background: var(--fill);
    box-shadow: inset 0 0 0 0.5px var(--hairline);
    transition:
      box-shadow var(--dur) var(--ease),
      background-color var(--dur) var(--ease);
  }
  .box:focus-within {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--focus);
  }
  textarea {
    flex: 1;
    min-width: 0;
    /* About eight lines, then it scrolls. */
    max-height: calc(8 * 1.45em + 8px);
    margin: 0;
    padding: 4px 0;
    border: none;
    background: none;
    resize: none;
    font-size: var(--fs-ui);
    line-height: 1.45;
    color: var(--text);
  }
  /* Send and stop are one round button in the same place: an arrow, or a square while it works. */
  .send,
  .stop {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    transition:
      transform var(--dur-fast) var(--ease),
      background-color var(--dur) var(--ease),
      color var(--dur) var(--ease);
  }
  .send:hover:not(:disabled),
  .stop:hover {
    transform: scale(1.07);
  }
  .send:active:not(:disabled),
  .stop:active {
    transform: scale(0.92);
  }
  .send:disabled {
    background: var(--fill-3);
    color: var(--text-3);
  }
  .square {
    width: 9px;
    height: 9px;
    border-radius: 2.5px;
    background: currentColor;
  }
  @media (prefers-reduced-motion: reduce) {
    .send,
    .stop,
    .example {
      transition: none;
    }
  }
  .composer.closed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px 12px;
    font-size: var(--fs-footnote);
    color: var(--text-2);
  }
  .allowance {
    margin: 0;
    padding: 0 4px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }

  /* On the page there is room: more air, larger type, the first things centred. */
  .roomy .content {
    padding: 8px 0 24px;
  }
  .roomy .items {
    gap: 20px;
  }
  .roomy .item.read + .item.read {
    margin-top: -12px;
  }
  .roomy .item.ask {
    max-width: 78%;
    padding: 9px 16px;
    border-radius: 20px;
  }
  .roomy .turn {
    gap: 14px;
  }
  .roomy .said {
    gap: 20px;
  }
  .roomy .avatar {
    top: 8px;
  }
  .roomy .item.ask p,
  .roomy .intro p,
  .roomy .signed-out p {
    font-size: var(--fs-body-ui);
    line-height: 1.6;
  }
  .roomy .intro {
    max-width: 520px;
    margin: 0 auto;
    gap: 6px;
  }
  .roomy .signed-out {
    align-items: center;
    text-align: center;
  }
  .roomy .empty {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .roomy .hint {
    flex: 0 0 100%;
    margin: 0 0 4px;
    text-align: center;
  }
  .roomy .example {
    padding: 8px 16px;
    text-align: center;
  }
  .roomy .composer {
    padding: 8px 0 20px;
    gap: 8px;
  }
  .roomy .box {
    padding: 7px 7px 7px 20px;
    border-radius: 24px;
  }
  .roomy .send,
  .roomy .stop {
    width: 32px;
    height: 32px;
  }
  .roomy .square {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .roomy textarea {
    padding: 5px 0;
    font-size: var(--fs-body-ui);
  }
  .roomy .allowance {
    text-align: center;
  }
</style>
