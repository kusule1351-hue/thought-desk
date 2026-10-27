<script lang="ts">
  import { comboLabel, keyName } from '../shortcuts.svelte';
  import type { Editor } from '@tiptap/core';
  import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu';
  import { NodeSelection } from '@tiptap/pm/state';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount, tick } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { ui } from '../ui.svelte';
  import { KINDS, currentKind, turnInto } from './blocks';
  import { PALETTE, type ColorKey } from '../colors';
  import { t, type MessageKey } from '../i18n';

  /** The letter each colour swatch shows its colour on. */
  const SAMPLE = t('editor.bubble.sample');
  /** Each swatch's name for screen readers: the text in that colour, or a highlight in it. */
  const TEXT_COLOR = {
    red: 'editor.bubble.textColor.red',
    orange: 'editor.bubble.textColor.orange',
    yellow: 'editor.bubble.textColor.yellow',
    green: 'editor.bubble.textColor.green',
    teal: 'editor.bubble.textColor.teal',
    blue: 'editor.bubble.textColor.blue',
    indigo: 'editor.bubble.textColor.indigo',
    purple: 'editor.bubble.textColor.purple',
    pink: 'editor.bubble.textColor.pink',
    gray: 'editor.bubble.textColor.gray',
  } as const satisfies Record<ColorKey, MessageKey>;
  const HIGHLIGHT_COLOR = {
    red: 'editor.bubble.highlightColor.red',
    orange: 'editor.bubble.highlightColor.orange',
    yellow: 'editor.bubble.highlightColor.yellow',
    green: 'editor.bubble.highlightColor.green',
    teal: 'editor.bubble.highlightColor.teal',
    blue: 'editor.bubble.highlightColor.blue',
    indigo: 'editor.bubble.highlightColor.indigo',
    purple: 'editor.bubble.highlightColor.purple',
    pink: 'editor.bubble.highlightColor.pink',
    gray: 'editor.bubble.highlightColor.gray',
  } as const satisfies Record<ColorKey, MessageKey>;

  let { editor }: { editor: Editor } = $props();

  let el: HTMLDivElement;
  let linkInput = $state<HTMLInputElement>();
  let mode = $state<'format' | 'link' | 'color'>('format');
  let href = $state('');
  // Bumped on every transaction so the active states re-render.
  let version = $state(0);

  const active = $derived.by(() => {
    void version;
    return {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      highlight: editor.isActive('highlight'),
      textColor: (editor.getAttributes('textColor').color as string | undefined) ?? null,
      highlightColor: editor.isActive('highlight') ? ((editor.getAttributes('highlight').color as string | undefined) ?? 'default') : null,
      link: editor.isActive('link'),
      kind: currentKind(editor),
    };
  });
  const kindLabel = $derived(KINDS.find((k) => k.kind === active.kind)?.label ?? KINDS[0].label);

  onMount(() => {
    const key = 'textBubble';
    editor.registerPlugin(
      BubbleMenuPlugin({
        pluginKey: key,
        editor,
        element: el,
        updateDelay: 120,
        shouldShow: ({ editor, state, from, to }) => {
          if (!editor.isEditable || from === to) return false;
          if (state.selection instanceof NodeSelection) return false;
          if (editor.isActive('codeBlock') || editor.isActive('image')) return false;
          return state.doc.textBetween(from, to, ' ').trim().length > 0 || mode === 'link';
        },
        options: {
          strategy: 'fixed',
          placement: 'top',
          offset: 8,
          flip: true,
          shift: { padding: 8 },
          onHide: () => (mode = 'format'),
        },
      }),
    );
    // Deferred: transactions can fire while Svelte is tearing components
    // down (e.g. the blur on destroy), where state writes aren't allowed.
    let alive = true;
    let queued = false;
    const bump = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (alive) version++;
      });
    };
    editor.on('transaction', bump);
    const onEditLink = (e: Event) => {
      if ((e as CustomEvent<{ editor?: Editor }>).detail?.editor !== editor) return;
      if (!editor.state.selection.empty) void startLink();
    };
    window.addEventListener('td:edit-link', onEditLink);
    return () => {
      alive = false;
      editor.off('transaction', bump);
      window.removeEventListener('td:edit-link', onEditLink);
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  });

  async function startLink() {
    href = editor.getAttributes('link').href ?? '';
    mode = 'link';
    await tick();
    linkInput?.focus();
    linkInput?.select();
  }

  function applyLink() {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) chain.unsetLink().run();
    else chain.setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') ? url : `https://${url}` }).run();
    mode = 'format';
  }

  function removeLink() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    mode = 'format';
  }

  function openTurnInto(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      KINDS.map((k) => ({
        label: k.label,
        icon: k.icon,
        checked: k.kind === active.kind,
        action: () => turnInto(editor, k.kind),
      })),
    );
  }

  function setTextColor(color: string | null) {
    const chain = editor.chain().focus();
    (color ? chain.setTextColor(color) : chain.unsetTextColor()).run();
    mode = 'format';
  }

  function setHighlightColor(color: string | null) {
    const chain = editor.chain().focus();
    (color ? chain.setHighlight({ color }) : chain.unsetHighlight()).run();
    mode = 'format';
  }

  const keep = (e: MouseEvent) => e.preventDefault();
</script>

<div class="bubble popover" class:tall={mode === 'color'} bind:this={el} style="visibility: hidden">
  {#if mode === 'format'}
    <button class="kind" onmousedown={keep} onclick={openTurnInto}>
      <span>{kindLabel}</span>
      <Icon name="chevron-down" size={12} stroke={2.2} />
    </button>
    <span class="sep"></span>
    <button class="fmt" class:on={active.bold} onmousedown={keep} onclick={() => editor.chain().focus().toggleBold().run()} data-tip={t('editor.bubble.bold')} data-tip-key={comboLabel('Mod+KeyB')}><Icon name="bold" stroke={2.3} /></button>
    <button class="fmt" class:on={active.italic} onmousedown={keep} onclick={() => editor.chain().focus().toggleItalic().run()} data-tip={t('editor.bubble.italic')} data-tip-key={comboLabel('Mod+KeyI')}><Icon name="italic" stroke={2.1} /></button>
    <button class="fmt" class:on={active.underline} onmousedown={keep} onclick={() => editor.chain().focus().toggleUnderline().run()} data-tip={t('editor.bubble.underline')} data-tip-key={comboLabel('Mod+KeyU')}><Icon name="underline" stroke={2.1} /></button>
    <button class="fmt" class:on={active.strike} onmousedown={keep} onclick={() => editor.chain().focus().toggleStrike().run()} data-tip={t('editor.bubble.strikethrough')} data-tip-key={comboLabel('Mod+Shift+KeyS')}><Icon name="strike" stroke={2.1} /></button>
    <button class="fmt" class:on={active.code} onmousedown={keep} onclick={() => editor.chain().focus().toggleCode().run()} data-tip={t('editor.bubble.inlineCode')} data-tip-key={comboLabel('Mod+KeyE')}><Icon name="code" stroke={2.1} /></button>
    <button class="fmt" onmousedown={keep} onclick={() => editor.chain().focus().insertInlineMath().run()} data-tip={t('editor.bubble.math')} data-tip-key={comboLabel('Mod+Shift+KeyE')}><Icon name="function" stroke={2.1} /></button>
    <button class="fmt" class:on={active.highlight} onmousedown={keep} onclick={() => editor.chain().focus().toggleHighlight().run()} data-tip={t('editor.bubble.highlight')} data-tip-key={comboLabel('Mod+Shift+KeyH')}><Icon name="highlight" stroke={2} /></button>
    <button class="fmt" onmousedown={keep} onclick={() => (mode = 'color')} data-tip={t('editor.bubble.color')} aria-label={t('editor.bubble.color')}>
      <span class="glyph swatch-ink" class:text={!!active.textColor} class:tint={!!active.highlightColor && active.highlightColor !== 'default'} data-ink={active.textColor ?? active.highlightColor}>{SAMPLE}</span>
    </button>
    <span class="sep"></span>
    <button class="fmt link" class:on={active.link} onmousedown={keep} onclick={startLink} data-tip={t('editor.bubble.link')} data-tip-key={comboLabel('Mod+KeyK')}><Icon name="link" stroke={2} /><span>{t('editor.bubble.link')}</span></button>
  {:else if mode === 'color'}
    <div class="colors">
      <div class="color-row" role="group" aria-label={t('editor.bubble.textColor.group')}>
        <span class="row-name">{t('editor.bubble.textColor.row')}</span>
        <button class="swatch" class:on={!active.textColor} onmousedown={keep} onclick={() => setTextColor(null)} data-tip={t('editor.bubble.textColor.defaultTip')} aria-label={t('editor.bubble.textColor.default')}><span class="glyph">{SAMPLE}</span></button>
        {#each PALETTE as c (c.key)}
          <button class="swatch" class:on={active.textColor === c.key} onmousedown={keep} onclick={() => setTextColor(c.key)} data-tip={c.label} aria-label={t(TEXT_COLOR[c.key])}><span class="glyph swatch-ink text" data-ink={c.key}>{SAMPLE}</span></button>
        {/each}
      </div>
      <div class="color-row" role="group" aria-label={t('editor.bubble.highlightColor.group')}>
        <span class="row-name">{t('editor.bubble.highlightColor.row')}</span>
        <button class="swatch" class:on={!active.highlightColor} onmousedown={keep} onclick={() => setHighlightColor(null)} data-tip={t('editor.bubble.highlightColor.noneTip')} aria-label={t('editor.bubble.highlightColor.none')}><span class="glyph none">{SAMPLE}</span></button>
        {#each PALETTE as c (c.key)}
          <button class="swatch" class:on={active.highlightColor === c.key} onmousedown={keep} onclick={() => setHighlightColor(c.key)} data-tip={c.label} aria-label={t(HIGHLIGHT_COLOR[c.key])}><span class="glyph swatch-ink tint" data-ink={c.key}>{SAMPLE}</span></button>
        {/each}
      </div>
    </div>
  {:else}
    <form
      class="link-form"
      onsubmit={(e) => {
        e.preventDefault();
        applyLink();
      }}
    >
      <span class="link-icon"><Icon name="link" size={15} stroke={2} /></span>
      <input
        bind:this={linkInput}
        bind:value={href}
        placeholder={t('editor.bubble.linkForm.placeholder')}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            mode = 'format';
            editor.commands.focus();
          }
        }}
      />
      {#if active.link}
        <button type="button" class="fmt" onmousedown={keep} onclick={() => href && openUrl(href).catch(ui.error)} data-tip={t('editor.bubble.linkForm.open')}><Icon name="arrow-right" /></button>
        <button type="button" class="fmt" onmousedown={keep} onclick={removeLink} data-tip={t('editor.bubble.linkForm.remove')}><Icon name="unlink" /></button>
      {/if}
      <button type="submit" class="fmt apply" data-tip={t('editor.bubble.linkForm.apply')} data-tip-key={keyName('Enter')}><Icon name="enter" /></button>
    </form>
  {/if}
</div>

<style>
  .bubble {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 1px;
    height: 40px;
    padding: 0 4px;
    white-space: nowrap;
    border-radius: var(--r-md);
  }
  /* Keyframes rather than transitions: the plugin sets opacity inline and
     re-inserts the element each time it shows, which restarts this. */
  .bubble {
    animation: bubble-in var(--dur) var(--ease-out);
  }
  @keyframes bubble-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    /* 40px bar − 4px padding = 32px buttons; 10px − 4px = 6px corners. */
    height: var(--h-md);
    border-radius: var(--r-xs);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  button:hover {
    background: var(--fill);
    color: var(--text);
  }
  .fmt {
    min-width: var(--h-md);
    padding: 0 8px;
  }
  .fmt.on {
    background: var(--fill-2);
    color: var(--text);
  }
  .kind {
    padding: 0 8px 0 12px;
    gap: 4px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-550);
    color: var(--text);
  }
  .kind :global(svg) {
    color: var(--text-3);
  }
  .link span {
    font-size: var(--fs-ui);
    font-weight: var(--fw-550);
  }
  .sep {
    flex: none;
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--hairline);
  }
  .bubble.tall {
    height: auto;
    padding: 4px;
  }
  .glyph {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    font-size: 14px;
    font-weight: var(--fw-600, 600);
    line-height: 1;
  }
  .glyph.none {
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .colors {
    display: grid;
    gap: 2px;
  }
  .color-row {
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .row-name {
    width: 64px;
    padding-left: 6px;
    font-size: var(--fs-caption, 12px);
    color: var(--text-3);
  }
  .swatch {
    width: 28px;
    height: 28px;
  }
  .swatch.on {
    background: var(--fill-2);
  }
  .link-form {
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .link-icon {
    display: grid;
    place-items: center;
    width: 28px;
    color: var(--text-3);
  }
  .link-form input {
    width: 248px;
    height: var(--h-md);
    padding: 0 6px 0 2px;
    border: none;
    background: transparent;
    font-size: var(--fs-body-ui);
  }
</style>
