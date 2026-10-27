<script lang="ts" module>
  /** How editing ended, which decides where the caret goes next. */
  export type MathDone = 'left' | 'right' | 'up' | 'down' | 'blur' | 'delete';

  // The palette stays open or closed the way it was last left.
  let paletteOpen = $state(false);
  let paletteTab = $state(0);
</script>

<script lang="ts">
  import { MOD } from '../platform';
  /**
   * Editing a formula's LaTeX: the formula itself updates as you type (the
   * caller draws it), with suggestions after a backslash, Tab between the
   * {} slots a suggestion leaves, matching braces, and a symbol palette for
   * those who don't know the commands yet.
   */
  import { onMount, tick, untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import { PALETTE, suggest, type MathCommand } from './commands';
  import { katexLoaded, loadKatex, mathError, mathHTML } from './katex';

  let {
    latex: initial,
    display,
    onchange,
    ondone,
  }: { latex: string; display: boolean; onchange: (latex: string) => void; ondone: (latex: string, how: MathDone) => void } = $props();

  // Starts from what the formula holds; from then on this is the source.
  let value = $state(untrack(() => initial));
  let ta: HTMLTextAreaElement;
  let ready = $state(katexLoaded());
  let finished = false;

  /** The backslash command being typed, if any: where it starts and what's typed. */
  let typing = $state<{ from: number; query: string } | null>(null);
  let active = $state(0);
  const suggestions = $derived(typing ? suggest(typing.query) : []);
  // An error shows once typing pauses, not for every half-typed command.
  let settled = $state(untrack(() => value));
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const error = $derived(ready && settled === value ? mathError(value, display) : null);

  /**
   * The formula on the page follows along, but keeps its last good form
   * while what's typed doesn't typeset yet (halfway through "\frac").
   */
  function show(next: string) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => (settled = value), 700);
    if (!ready || !mathError(next, display)) onchange(next);
  }

  onMount(() => {
    void loadKatex().then(() => (ready = true));
    ta.focus();
    ta.setSelectionRange(value.length, value.length);
    fit();
  });

  /** Called by the owner when it closes the editor from outside (a click elsewhere). */
  export function finish(how: MathDone = 'blur') {
    if (finished) return;
    finished = true;
    clearTimeout(settleTimer);
    ondone(value, how);
  }

  function fit() {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function set(next: string, caret: number, end = caret) {
    value = next;
    show(next);
    void tick().then(() => {
      ta.setSelectionRange(caret, end);
      fit();
      look();
    });
  }

  /** Works out whether a backslash command is being typed at the caret. */
  function look() {
    const at = ta.selectionStart;
    if (at !== ta.selectionEnd) return void (typing = null);
    const m = /\\([a-zA-Z]*)$/.exec(value.slice(0, at));
    // "\\" is a line break, not a command.
    if (!m || value[m.index - 1] === '\\') return void (typing = null);
    const next = { from: m.index, query: m[1] };
    if (typing?.query !== next.query) active = 0;
    typing = next;
  }

  function oninput() {
    value = ta.value;
    show(value);
    fit();
    look();
  }

  /** Puts a command in at the caret (or over the typed "\que…"), selection going in its first slot. */
  function insert(cmd: MathCommand, from = ta.selectionStart, to = ta.selectionEnd) {
    const selected = typing ? '' : value.slice(ta.selectionStart, ta.selectionEnd);
    let text = cmd.insert;
    let caret: number;
    const bar = text.indexOf('|');
    if (bar >= 0) {
      text = text.slice(0, bar) + selected + text.slice(bar + 1);
      caret = bar + selected.length;
    } else {
      const slot = text.indexOf('{}');
      if (slot >= 0) {
        text = text.slice(0, slot + 1) + selected + text.slice(slot + 1);
        caret = slot + 1 + selected.length;
        // With something wrapped, go on to the next slot (the denominator).
        if (selected) {
          const next = text.indexOf('{}', caret);
          if (next >= 0) caret = next + 1;
        }
      } else {
        // A plain symbol: keep it apart from letters that follow.
        if (/^\\[a-zA-Z]+$/.test(text) && /^[a-zA-Z]/.test(value.slice(to))) text += ' ';
        caret = text.length;
      }
    }
    typing = null;
    set(value.slice(0, from) + text + value.slice(to), from + caret);
    ta.focus();
  }

  function accept(i = active) {
    const cmd = suggestions[i];
    if (cmd && typing) insert(cmd, typing.from, ta.selectionStart);
  }

  /** The next (or previous) empty {} slot from the caret, as the position inside it. */
  function slot(dir: 1 | -1): number | null {
    const at = ta.selectionStart;
    if (dir > 0) {
      const i = value.indexOf('{}', at);
      return i >= 0 ? i + 1 : null;
    }
    const i = value.lastIndexOf('{}', Math.max(0, at - 2));
    return i >= 0 && i + 1 < at ? i + 1 : null;
  }

  /** Just past the } closing the group the caret is in, if it's in one. */
  function groupEnd(): number | null {
    let depth = 0;
    for (let i = ta.selectionEnd; i < value.length; i++) {
      if (value[i] === '\\') i++;
      else if (value[i] === '{') depth++;
      else if (value[i] === '}' && depth-- === 0) return i + 1;
    }
    return null;
  }

  const lineOf = (pos: number) => value.slice(0, pos).split('\n').length - 1;

  function onkeydown(e: KeyboardEvent) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const collapsed = start === end;
    const mod = e.ctrlKey || e.metaKey;

    if (suggestions.length && typing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !mod) || e.key === 'Tab') {
        e.preventDefault();
        accept();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        typing = null;
        return;
      }
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        return finish(display ? 'down' : 'right');
      case 'Enter':
        if (mod || (!display && !e.shiftKey)) {
          e.preventDefault();
          return finish(display ? 'down' : 'right');
        }
        return;
      case 'Tab': {
        // Next empty slot; else out of the group the caret is in; else done.
        e.preventDefault();
        const to = slot(e.shiftKey ? -1 : 1) ?? (e.shiftKey ? null : groupEnd());
        if (to !== null) ta.setSelectionRange(to, to);
        else if (!e.shiftKey) finish(display ? 'down' : 'right');
        return;
      }
      case 'Backspace':
        if (!value) {
          e.preventDefault();
          return finish('delete');
        }
        // Deleting into an empty pair takes both braces.
        if (collapsed && value[start - 1] === '{' && value[start] === '}') {
          e.preventDefault();
          set(value.slice(0, start - 1) + value.slice(start + 1), start - 1);
        }
        return;
      case '{':
        e.preventDefault();
        set(`${value.slice(0, start)}{${value.slice(start, end)}}${value.slice(end)}`, start + 1, end + 1);
        return;
      case '}':
        if (collapsed && value[start] === '}') {
          e.preventDefault();
          ta.setSelectionRange(start + 1, start + 1);
        }
        return;
      case 'ArrowLeft':
        if (!display && collapsed && start === 0 && !e.shiftKey) {
          e.preventDefault();
          finish('left');
        }
        return;
      case 'ArrowRight':
        if (!display && collapsed && start === value.length && !e.shiftKey) {
          e.preventDefault();
          finish('right');
        }
        return;
      case 'ArrowUp':
        if (display && collapsed && lineOf(start) === 0 && !e.shiftKey) {
          e.preventDefault();
          finish('up');
        }
        return;
      case 'ArrowDown':
        if (display && collapsed && lineOf(start) === lineOf(value.length) && !e.shiftKey) {
          e.preventDefault();
          finish('down');
        }
        return;
    }
  }
</script>

<div class="math-editor" class:display>
  <div class="field">
    <textarea
      bind:this={ta}
      {value}
      {oninput}
      {onkeydown}
      onclick={look}
      onkeyup={(e) => (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') && !suggestions.length && look()}
      rows="1"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      placeholder={t('blocks.math.placeholder', { example: display ? 'E = mc^2' : 'x^2' })}
      aria-label={t('blocks.math.field')}
    ></textarea>
  </div>

  {#if suggestions.length && typing}
    <ul class="suggest" role="listbox" aria-label={t('blocks.math.commands')}>
      {#each suggestions as s, i (s.name)}
        <li role="option" aria-selected={i === active}>
          <button class:on={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => accept(i)} onmouseenter={() => (active = i)}>
            <span class="face">{#if ready}{@html mathHTML(s.preview)}{/if}</span>
            <span class="name">\{s.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if error}<p class="error"><Icon name="info" size={13} /> {error}</p>{/if}

  {#if paletteOpen}
    <div class="palette">
      <div class="tabs" role="tablist">
        {#each PALETTE as g, i (i)}
          <button role="tab" class:on={paletteTab === i} aria-selected={paletteTab === i} onmousedown={(e) => e.preventDefault()} onclick={() => (paletteTab = i)}>{t(g.label)}</button>
        {/each}
      </div>
      <div class="symbols">
        {#each PALETTE[paletteTab].items as s (s.name)}
          <button class="sym" onmousedown={(e) => e.preventDefault()} onclick={() => insert(s)} data-tip={`\\${s.name}`} aria-label={s.name}>
            {#if ready}{@html mathHTML(s.preview)}{:else}{s.name}{/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="foot">
    <button class="pal-btn" class:on={paletteOpen} onmousedown={(e) => e.preventDefault()} onclick={() => (paletteOpen = !paletteOpen)}>
      <Icon name="sigma" size={13} /> {t('blocks.math.symbols')}
    </button>
    <span class="hint">
      {#if display}<Rich key="blocks.math.hintBlock" params={{ mod: MOD }}>{#snippet kbd(text: string)}<kbd>{text}</kbd>{/snippet}</Rich>{:else}<Rich key="blocks.math.hintInline">{#snippet kbd(text: string)}<kbd>{text}</kbd>{/snippet}</Rich>{/if}
    </span>
  </div>
</div>

<style>
  .math-editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field {
    border-radius: var(--r-sm);
    background: var(--fill-2);
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .field:focus-within {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 34px;
    max-height: 260px;
    padding: 8px 10px;
    border: none;
    background: transparent;
    resize: none;
    font-family: var(--font-mono);
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text);
    outline: none;
  }
  textarea::placeholder {
    color: var(--text-3);
  }
  .suggest {
    list-style: none;
    margin: 0;
    padding: 2px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: 0 0 0 1px var(--separator);
  }
  .suggest button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 30px;
    padding: 2px 8px;
    border-radius: var(--r-xs);
    text-align: left;
  }
  .suggest button.on {
    background: var(--fill-2);
  }
  .face {
    display: inline-flex;
    justify-content: center;
    min-width: 44px;
    font-size: 14px;
    color: var(--text);
  }
  .name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-2);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--c-red);
  }
  .palette {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
  }
  .tabs button {
    height: 24px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-3);
    white-space: nowrap;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.on {
    background: var(--fill-2);
    color: var(--text);
  }
  .symbols {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 2px;
    max-height: 150px;
    overflow-y: auto;
  }
  .sym {
    display: grid;
    place-items: center;
    min-height: 34px;
    padding: 2px;
    border-radius: var(--r-xs);
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
  }
  .sym :global(.katex) {
    font-size: 1em;
  }
  .sym:hover {
    background: var(--fill-2);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pal-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-2);
  }
  .pal-btn:hover,
  .pal-btn.on {
    background: var(--fill-2);
    color: var(--text);
  }
  .hint {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .hint kbd {
    margin: 0 1px;
  }
</style>
