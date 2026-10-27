<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import Icon from '../components/Icon.svelte';
  import type { MenuEntry, SuggestionState } from './suggestion.svelte';

  let { ctl }: { ctl: SuggestionState } = $props();

  let el = $state<HTMLDivElement>();
  let height = $state(0);

  // Place below the caret, or above it when there isn't room.
  const pos = $derived.by(() => {
    const r = ctl.rect;
    if (!r) return { left: -9999, top: -9999 };
    const width = 320;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = r.bottom + 8;
    const top = below + height > window.innerHeight - 8 && r.top - height - 8 > 8 ? r.top - height - 8 : below;
    return { left, top };
  });

  // Keep the selected row in view while navigating with the keyboard.
  $effect(() => {
    const i = ctl.selected;
    el?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function groupStart(items: MenuEntry[], i: number) {
    return items[i].group && items[i].group !== items[i - 1]?.group ? items[i].groupLabel : null;
  }
</script>

<div
  class="suggest popover"
  bind:this={el}
  bind:clientHeight={height}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  role="listbox"
>
  {#if ctl.items.length === 0}
    <div class="empty">{ctl.empty}</div>
  {:else}
    {#each ctl.items as item, i (item.id)}
      {@const header = groupStart(ctl.items, i)}
      {#if header}<div class="group">{header}</div>{/if}
      <button
        class="row"
        class:selected={i === ctl.selected}
        data-index={i}
        role="option"
        aria-selected={i === ctl.selected}
        onmousedown={(e) => e.preventDefault()}
        onmousemove={() => (ctl.selected = i)}
        onclick={() => ctl.pick(i)}
      >
        <span class="glyph">
          {#if item.emoji}<span class="emoji"><PageIcon icon={item.emoji} /></span>{:else if item.label}<span class="label">{item.label}</span>{:else if item.icon}<Icon name={item.icon} size={17} />{/if}
        </span>
        <span class="text">
          <span class="title">{item.title}</span>
          {#if item.description}<span class="desc">{item.description}</span>{/if}
        </span>
        {#if item.hint}<kbd>{item.hint}</kbd>{/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .suggest {
    position: fixed;
    z-index: 60;
    width: 320px;
    max-height: min(384px, 52vh);
    overflow-y: auto;
    padding: 4px;
    animation: suggest-in var(--dur) var(--ease-out);
  }
  @keyframes suggest-in {
    from {
      opacity: 0;
      transform: translateY(-3px) scale(0.98);
    }
  }
  .group {
    padding: 8px 8px 4px;
    font-size: var(--fs-caption);
    font-weight: var(--fw-600);
    letter-spacing: 0.01em;
    color: var(--text-3);
  }
  .group:first-child {
    padding-top: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 6px 12px 6px 6px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .row.selected {
    background: var(--fill-2);
  }
  .glyph {
    flex: none;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 1px 2px rgba(0, 0, 0, 0.04);
    color: var(--text);
  }
  .emoji {
    font-size: 18px;
    line-height: 1;
  }
  .label {
    font-size: 13px;
    font-weight: var(--fw-650);
    letter-spacing: -0.01em;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-500);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .desc {
    font-size: var(--fs-footnote);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  kbd {
    flex: none;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .empty {
    padding: 12px 12px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
</style>
