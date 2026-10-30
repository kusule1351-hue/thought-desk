<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n';

  let {
    value = $bindable(''),
    placeholder = t('library.controls.filter'),
    autofocus = false,
    width,
    small = false,
  }: {
    value?: string;
    placeholder?: string;
    autofocus?: boolean;
    width?: number;
    /** 28px tall, to sit in a row of chips and small buttons. */
    small?: boolean;
  } = $props();

  let input: HTMLInputElement;
  onMount(() => {
    if (autofocus) input.focus();
  });
</script>

<label class="field search" class:small style:width={width ? `${width}px` : undefined}>
  <Icon name="search" size={15} stroke={2} />
  <input
    bind:this={input}
    bind:value
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    onkeydown={(e) => {
      if (e.key === 'Escape' && value) {
        e.preventDefault();
        e.stopPropagation();
        value = '';
      }
    }}
  />
  {#if value}
    <button type="button" class="clear round" onclick={() => (value = '')} aria-label={t('common.actions.clear')}><Icon name="x" size={11} stroke={2.6} /></button>
  {/if}
</label>

<style>
  .search {
    color: var(--text-3);
    padding-right: 6px;
  }
  .search.small {
    height: var(--h-sm);
    padding-left: 10px;
    font-size: var(--fs-ui);
  }
  .search :global(input) {
    color: var(--text);
  }
  .clear {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-4);
    color: var(--bg);
  }
  .clear:hover {
    background: var(--text-3);
  }
</style>
