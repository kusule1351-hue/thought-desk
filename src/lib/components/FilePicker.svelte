<script lang="ts">
  /** A popover for choosing a library file, or uploading a new one. */
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import { fadeOut, pop } from '../motion';
  import { library, pickFiles } from '../library.svelte';
  import { rank } from '../editor/suggestion.svelte';
  import { formatBytes, relativeTime } from '../time';
  import { ui, type FilePickerState } from '../ui.svelte';
  import { t } from '../i18n';

  let { picker: request }: { picker: FilePickerState } = $props();
  // The request is fixed for this popover's life; closing clears the prop.
  // svelte-ignore state_referenced_locally
  const picker = request;

  let el: HTMLDivElement;
  let input: HTMLInputElement;
  let list = $state<HTMLDivElement>();
  let query = $state('');
  let selected = $state(0);
  let pos = $state({ left: -9999, top: -9999 });

  const files = $derived(
    rank(
      library.live.filter((f) => !picker.exclude?.includes(f.id)).map((f) => ({ ...f, title: f.name })),
      query,
      60,
    ),
  );
  // Row 0 is "Upload from Computer…".
  const total = $derived(files.length + 1);

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
    void query;
    selected = 0;
  });
  $effect(() => {
    const i = selected;
    list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    ui.filePicker = null;
  }

  async function choose(i: number) {
    const f = i > 0 ? library.byId.get(files[i - 1].id) : undefined;
    close();
    if (i === 0) {
      const added = await library.add(await pickFiles({ multiple: picker.multiple ?? true }));
      if (added.length) picker.onPick(added);
      return;
    }
    if (f) picker.onPick([f]);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = (selected + 1) % total;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected - 1 + total) % total;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void choose(selected);
    }
  }
</script>

<div class="picker popover" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px" in:pop|global out:fadeOut|global>
  <div class="bar">
    <label class="field">
      <Icon name="search" size={14} stroke={2} />
      <input bind:this={input} bind:value={query} placeholder={t('onboarding.filePicker.placeholder')} spellcheck="false" onkeydown={onKey} />
    </label>
  </div>
  <div class="list" bind:this={list}>
    <button class="row" class:selected={selected === 0} data-index={0} onmousemove={() => (selected = 0)} onclick={() => choose(0)}>
      <span class="up"><Icon name="upload" size={16} stroke={2} /></span>
      <span class="text"><span class="name">{t('onboarding.filePicker.upload')}</span></span>
    </button>
    {#if files.length}
      <div class="eyebrow head">{query ? t('onboarding.filePicker.matching') : t('onboarding.filePicker.library')}</div>
    {/if}
    {#each files as f, i (f.id)}
      <button class="row" class:selected={selected === i + 1} data-index={i + 1} onmousemove={() => (selected = i + 1)} onclick={() => choose(i + 1)}>
        <FileTile file={f} size={28} />
        <span class="text">
          <span class="name">{f.name}</span>
          <span class="meta">{formatBytes(f.size)} · {relativeTime(f.createdAt)}</span>
        </span>
      </button>
    {:else}
      {#if query}<p class="none">{t('onboarding.filePicker.noMatch', { query })}</p>{/if}
    {/each}
  </div>
</div>

<style>
  .picker {
    position: fixed;
    z-index: 96;
    width: 320px;
    max-height: 384px;
    display: flex;
    flex-direction: column;
    transform-origin: top left;
  }
  .bar {
    padding: 12px 12px 8px;
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
  .head {
    padding: 8px 8px 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .row.selected {
    background: var(--fill-2);
  }
  .up {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--tint);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: var(--fs-body-ui);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .none {
    margin: 14px 0;
    text-align: center;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
</style>
