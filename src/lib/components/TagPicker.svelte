<script lang="ts">
  /** Adds and removes tags on one item; stays open for several picks. */
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { fadeOut, pop } from '../motion';
  import { cleanTag, tags } from '../tags.svelte';
  import { ui, type TagPickerState } from '../ui.svelte';
  import { t } from '../i18n';
  import { fmt } from '../i18n/format';
  import Rich from '../i18n/Rich.svelte';

  let { picker: request }: { picker: TagPickerState } = $props();
  // svelte-ignore state_referenced_locally (fixed for this popover's life)
  const picker = request;

  let el: HTMLDivElement;
  let input: HTMLInputElement;
  let list = $state<HTMLDivElement>();
  let query = $state('');
  let selected = $state(0);
  let pos = $state({ left: -9999, top: -9999 });

  const current = $derived(tags.of(picker.table, picker.id));
  const all = $derived([...new Set([...tags.list.map((tag) => tag.name), ...tags.used])].sort(fmt.collator({}).compare));
  const q = $derived(cleanTag(query));
  const shown = $derived(q ? all.filter((tag) => tag.includes(q)) : all);
  const canCreate = $derived(q !== '' && !all.includes(q));
  const total = $derived(shown.length + (canCreate ? 1 : 0));

  onMount(() => {
    input.focus();
    void tick().then(() => {
      // Its laid-out size: the bounding box is still scaled down while it pops in.
      const r = { width: el.offsetWidth, height: el.offsetHeight };
      let { x: left, y: top } = picker;
      if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, picker.y - r.height - 40);
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

  $effect(() => {
    void q;
    selected = 0;
  });
  $effect(() => {
    const i = selected;
    list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    ui.tagPicker = null;
  }

  function toggle(name: string) {
    const next = current.includes(name) ? current.filter((tag) => tag !== name) : [...current, name];
    void tags.set(picker.table, picker.id, next);
  }

  function choose(i: number) {
    if (i < shown.length) toggle(shown[i]);
    else if (canCreate) {
      void tags.set(picker.table, picker.id, [...current, q]);
      query = '';
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = total ? (selected + 1) % total : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = total ? (selected - 1 + total) % total : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected);
    } else if (e.key === 'Backspace' && !query && current.length) {
      void tags.set(picker.table, picker.id, current.slice(0, -1));
    }
  }
</script>

<div class="picker popover" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px" in:pop|global out:fadeOut|global>
  <div class="bar">
    <label class="field">
      <Icon name="tag" size={14} stroke={2} />
      <input bind:this={input} bind:value={query} placeholder={t('onboarding.tagPlaceholder')} spellcheck="false" onkeydown={onKey} />
    </label>
  </div>
  <div class="list" bind:this={list}>
    {#each shown as name, i (name)}
      <button class="row" class:selected={i === selected} data-index={i} onmousemove={() => (selected = i)} onclick={() => choose(i)}>
        <span class="dot" style:--dot={tags.color(name)}></span>
        <span class="name">#{name}</span>
        {#if current.includes(name)}<span class="check"><Icon name="check" size={14} stroke={2.4} /></span>{/if}
      </button>
    {/each}
    {#if canCreate}
      <button class="row" class:selected={selected === shown.length} data-index={shown.length} onmousemove={() => (selected = shown.length)} onclick={() => choose(shown.length)}>
        <span class="plus"><Icon name="plus" size={14} stroke={2.2} /></span>
        <span class="name">
          <Rich key="onboarding.createTag" params={{ name: q }}>
            {#snippet tag(text: string)}<strong>#{text}</strong>{/snippet}
          </Rich>
        </span>
      </button>
    {/if}
    {#if !total}
      <p class="none">{t('onboarding.noTags')}</p>
    {/if}
  </div>
</div>

<style>
  .picker {
    position: fixed;
    z-index: 96;
    width: 256px;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    transform-origin: top left;
  }
  .bar {
    padding: 8px 8px 4px;
  }
  .field {
    color: var(--text-3);
    background: var(--fill-2);
  }
  .field input {
    color: var(--text);
  }
  .list {
    overflow-y: auto;
    padding: 0 4px 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--h-sm);
    padding: 0 8px 0 12px;
    border-radius: var(--r-sm);
    font-size: var(--fs-body-ui);
    text-align: left;
  }
  .row.selected {
    background: var(--fill-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name strong {
    font-weight: var(--fw-600);
  }
  .plus {
    display: grid;
    place-items: center;
    width: 8px;
    color: var(--text-2);
  }
  .check {
    display: grid;
    color: var(--text);
  }
  .none {
    margin: 12px 0;
    text-align: center;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
</style>
