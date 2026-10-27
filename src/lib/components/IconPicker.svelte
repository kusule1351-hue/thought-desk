<script lang="ts" module>
  /** The colour last chosen, so a run of icons can share one. */
  let lastColor: string | null = null;
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { ALL_EMOJI, EMOJI_GROUPS, EMOJI_GROUP_LABELS, randomEmoji } from '../emoji';
  import { ICON_COLORS, PAGE_ICONS, PAGE_ICON_GROUPS, PAGE_ICON_GROUP_LABELS, lineIcon, parseIcon, type IconColor } from '../page-icon';
  import { colorVar } from '../colors';
  import PageIcon from './PageIcon.svelte';
  import { ui, type IconPickerState } from '../ui.svelte';
  import Icon from './Icon.svelte';
  import { fadeOut, pop } from '../motion';
  import { searchText, t, type MessageKey } from '../i18n';

  let { picker }: { picker: IconPickerState } = $props();

  /** What a screen reader calls each colour swatch. */
  const COLOR_NAMES = {
    red: 'onboarding.iconPicker.colors.red',
    orange: 'onboarding.iconPicker.colors.orange',
    yellow: 'onboarding.iconPicker.colors.yellow',
    green: 'onboarding.iconPicker.colors.green',
    teal: 'onboarding.iconPicker.colors.teal',
    blue: 'onboarding.iconPicker.colors.blue',
    indigo: 'onboarding.iconPicker.colors.indigo',
    purple: 'onboarding.iconPicker.colors.purple',
    pink: 'onboarding.iconPicker.colors.pink',
  } as const satisfies Record<IconColor, MessageKey>;

  let el: HTMLDivElement;
  let input: HTMLInputElement;
  let query = $state('');
  // Positioned after the first render, once the picker's size is known.
  let pos = $state({ left: -9999, top: -9999 });

  // The picker opens on whatever the icon is now (line icons for a new one),
  // in its colour.
  const current = untrack(() => parseIcon(picker.current));
  let tab = $state<'icons' | 'emoji'>(current?.kind === 'emoji' ? 'emoji' : 'icons');
  let color = $state<string | null>(current?.kind === 'icon' ? current.color : lastColor);

  // Emoji and icons are found by English keywords for now, whatever the
  // interface's language; icons also by their names, in it and in English.
  const iconWords = new Map(PAGE_ICONS.map((i) => [i.name, searchText(i.label).toLowerCase()]));
  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_EMOJI.filter((e) => e.keywords.includes(q) || e.emoji === q);
  });
  const iconResults = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return PAGE_ICONS.filter((i) => i.name.includes(q) || iconWords.get(i.name)!.includes(q) || i.keywords.includes(q));
  });
  const iconGroups = PAGE_ICON_GROUPS.map((g) => ({ id: g, items: PAGE_ICONS.filter((i) => i.group === g) }));

  function pickIcon(name: string) {
    lastColor = color;
    pick(lineIcon(name, color));
  }

  function random() {
    if (tab === 'emoji') return pick(randomEmoji());
    pickIcon(PAGE_ICONS[Math.floor(Math.random() * PAGE_ICONS.length)].name);
  }

  onMount(() => {
    input.focus();
    void tick().then(() => {
      // Its laid-out size: the bounding box is still scaled down while it pops in.
      const r = { width: el.offsetWidth, height: el.offsetHeight };
      let { x: left, y: top } = picker;
      if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
      pos = { left: Math.max(8, left), top };
    });
    const onDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  function close() {
    ui.iconPicker = null;
  }

  function pick(emoji: string) {
    picker.onPick(emoji);
    close();
  }
</script>

<div class="picker popover" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px" in:pop|global out:fadeOut|global>
  <div class="tabs" role="tablist">
    <button role="tab" class:on={tab === 'icons'} aria-selected={tab === 'icons'} onclick={() => ((tab = 'icons'), input.focus())}>{t('onboarding.iconPicker.icons')}</button>
    <button role="tab" class:on={tab === 'emoji'} aria-selected={tab === 'emoji'} onclick={() => ((tab = 'emoji'), input.focus())}>{t('onboarding.iconPicker.emoji')}</button>
    <span class="grow"></span>
    <button class="text-btn" onclick={random}>{t('onboarding.iconPicker.random')}</button>
    {#if picker.onRemove}
      <button
        class="text-btn"
        onclick={() => {
          picker.onRemove?.();
          close();
        }}>{t('onboarding.iconPicker.remove')}</button
      >
    {/if}
  </div>
  <div class="bar">
    <label class="field">
      <Icon name="search" size={14} stroke={2} />
      <input
        bind:this={input}
        bind:value={query}
        placeholder={tab === 'icons' ? t('onboarding.iconPicker.searchIcons') : t('onboarding.iconPicker.searchEmoji')}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key !== 'Enter') return;
          if (tab === 'icons' && iconResults?.length) pickIcon(iconResults[0].name);
          else if (tab === 'emoji' && results?.length) pick(results[0].emoji);
        }}
      />
    </label>
  </div>
  {#if tab === 'icons'}
    <div class="colors" role="radiogroup" aria-label={t('onboarding.iconPicker.color')}>
      <button class="swatch plain" class:on={color === null} role="radio" aria-checked={color === null} aria-label={t('onboarding.iconPicker.noColor')} data-tip={t('onboarding.iconPicker.textColor')} onclick={() => (color = null)}></button>
      {#each ICON_COLORS as c (c)}
        <button class="swatch" class:on={color === c} role="radio" aria-checked={color === c} aria-label={t(COLOR_NAMES[c])} style:--sw={colorVar(c)} onclick={() => (color = c)}></button>
      {/each}
    </div>
  {/if}
  <div class="grid-wrap">
    {#if tab === 'icons'}
      {#if iconResults}
        <div class="grid">
          {#each iconResults as i (i.name)}
            <button class="em glyph" onclick={() => pickIcon(i.name)} aria-label={t(i.label)}><PageIcon icon={lineIcon(i.name, color)} /></button>
          {:else}
            <p class="none">{t('onboarding.iconPicker.noIcons')}</p>
          {/each}
        </div>
      {:else}
        {#each iconGroups as g (g.id)}
          <div class="group-name">{t(PAGE_ICON_GROUP_LABELS[g.id])}</div>
          <div class="grid">
            {#each g.items as i (i.name)}
              <button class="em glyph" onclick={() => pickIcon(i.name)} aria-label={t(i.label)}><PageIcon icon={lineIcon(i.name, color)} /></button>
            {/each}
          </div>
        {/each}
      {/if}
    {:else if results}
      <div class="grid">
        {#each results as e (e.emoji)}
          <button class="em" onclick={() => pick(e.emoji)}>{e.emoji}</button>
        {:else}
          <p class="none">{t('onboarding.iconPicker.noEmoji')}</p>
        {/each}
      </div>
    {:else}
      {#each EMOJI_GROUPS as g (g.id)}
        <div class="group-name">{t(EMOJI_GROUP_LABELS[g.id])}</div>
        <div class="grid">
          {#each g.items as e (e.emoji)}
            <button class="em" onclick={() => pick(e.emoji)}>{e.emoji}</button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .picker {
    position: fixed;
    z-index: 95;
    width: 352px;
    display: flex;
    flex-direction: column;
    max-height: 380px;
    transform-origin: top left;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 8px 0;
  }
  .tabs [role='tab'] {
    height: var(--h-md);
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-3);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .tabs [role='tab']:hover {
    color: var(--text);
  }
  .tabs [role='tab'].on {
    background: var(--fill-2);
    color: var(--text);
  }
  .grow {
    flex: 1;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px 8px;
  }
  .colors {
    display: flex;
    gap: 6px;
    padding: 2px 14px 6px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--sw);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent);
    transition: box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
  }
  .swatch:hover {
    transform: scale(1.1);
  }
  .swatch.plain {
    background: var(--text);
  }
  .swatch.on {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 3.5px var(--sw, var(--text));
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--h-md);
    padding: 0 10px;
    border-radius: var(--r-sm);
    background: var(--fill-2);
    color: var(--text-3);
  }
  .field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font-size: var(--fs-ui);
  }
  .text-btn {
    height: var(--h-md);
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .text-btn:hover {
    background: var(--fill);
    color: var(--text);
  }
  .grid-wrap {
    overflow-y: auto;
    padding: 0 8px 12px;
  }
  .group-name {
    padding: 12px 4px 4px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    letter-spacing: 0.01em;
    color: var(--text-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 2px;
  }
  .em {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    font-size: 21px;
    line-height: 1;
    border-radius: var(--r-sm);
    transition:
      background-color var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }
  .em.glyph {
    font-size: 19px;
    color: var(--text-2);
  }
  .em:hover {
    background: var(--fill-2);
  }
  .em:active {
    transform: scale(0.9);
  }
  .none {
    grid-column: 1 / -1;
    margin: 18px 0;
    text-align: center;
    color: var(--text-3);
    font-size: var(--fs-ui);
  }
</style>
