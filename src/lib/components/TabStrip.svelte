<script lang="ts">
  import Icon from './Icon.svelte';
  import PageIcon from './PageIcon.svelte';
  import { shortcuts } from '../shortcuts.svelte';
  import { tabs } from '../tabs.svelte';
  import { t } from '../i18n';

  let strip: HTMLDivElement;

  // More tabs than fit scroll sideways: keep the active one in view.
  $effect(() => {
    void tabs.activeId;
    void tabs.list.length;
    queueMicrotask(() => strip?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  /** A mouse wheel scrolls the tabs sideways. */
  function onWheel(e: WheelEvent) {
    if (!e.deltaY || strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }
</script>

<!-- The title bar's tabs (when there are two or more), then New Tab. The
     empty space after them drags the window. -->
<div class="strip" data-tauri-drag-region>
<div class="tabs" role="tablist" aria-label={t('shell.tabs.label')} style:--n={tabs.list.length} bind:this={strip} onwheel={onWheel}>
  {#each tabs.list as tab (tab.id)}
    {@const label = tabs.label(tabs.placeOf(tab))}
    {@const active = tab.id === tabs.activeId}
    <div
      class="tab"
      class:active
      role="tab"
      tabindex="0"
      aria-selected={active}
      data-tip={label.title}
      onclick={() => tabs.activate(tab.id)}
      onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), tabs.activate(tab.id))}
      onmousedown={(e) => e.button === 1 && e.preventDefault()}
      onauxclick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        tabs.close(tab.id);
      }}
    >
      <span class="tab-icon">
        {#if label.pageIcon}<PageIcon icon={label.pageIcon} />{:else}<Icon name={label.icon} size={14} />{/if}
      </span>
      <span class="tab-title">{label.title}</span>
      {#if tab.live}<span class="tab-live" aria-label={t('shell.tabs.liveSession')}></span>{/if}
      <button
        class="tab-close"
        tabindex="-1"
        aria-label={t('shell.tabs.close')}
        data-tip={t('shell.tabs.close')}
        data-tip-key={shortcuts.label('closeTab')}
        onclick={(e) => {
          e.stopPropagation();
          tabs.close(tab.id);
        }}
      >
        <Icon name="x" size={12} stroke={2.2} />
      </button>
    </div>
  {/each}
</div>
<button class="icon-btn new-tab" onclick={() => tabs.newTab()} aria-label={t('shell.newTab')} data-tip={t('shell.newTab')} data-tip-key={shortcuts.label('newTab')}>
  <Icon name="plus" size={15} />
</button>
</div>

<style>
  /* The strip takes the title bar's free space. Tabs are up to 184px each and
     give up width before anything else, down to an icon each; past that they
     scroll. (Their width is set from their number: a tab's own content
     doesn't size it.) */
  .strip {
    display: flex;
    align-items: center;
    flex: 1 1 0;
    min-width: 72px;
    align-self: stretch;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 1 calc(var(--n) * 186px + 8px);
    min-width: 40px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 0 4px;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    container-type: inline-size;
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 0 1 184px;
    min-width: 32px;
    height: 30px;
    padding: 0 6px 0 10px;
    border-radius: var(--r-sm);
    color: var(--text-2);
    font-size: var(--fs-ui);
    cursor: default;
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .tab:hover {
    background: var(--fill);
    color: var(--text);
  }
  .tab.active {
    flex-shrink: 0.25;
    background: var(--fill-2);
    color: var(--text);
    font-weight: var(--fw-550);
  }
  /* A tab squeezed to its icon (Ctrl+W and middle-click still close it). */
  @container (max-width: 76px) {
    .tab-title,
    .tab-close {
      display: none;
    }
  }
  .tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .tab-icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 16px;
    color: var(--text-3);
  }
  .tab-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tab-live {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c-green);
  }
  .tab-close {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    color: var(--text-3);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .tab:hover .tab-close,
  .tab.active .tab-close {
    opacity: 1;
  }
  .tab-close:hover {
    background: var(--fill-2);
    color: var(--text);
  }
</style>
