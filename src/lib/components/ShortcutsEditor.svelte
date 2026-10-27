<script lang="ts">
  import { ALT, MOD } from '../platform';
  /**
   * Settings → Keyboard: every command's shortcut, which can be changed by
   * clicking it and pressing new keys. Esc cancels, Backspace removes it.
   */
  import Icon from './Icon.svelte';
  import { prefs } from '../prefs.svelte';
  import { EDITOR_KEYS, SHORTCUTS, SHORTCUT_GROUPS, SHORTCUT_GROUP_LABELS, comboKeys, comboLabel, comboOf, keyName, shortcuts, type ShortcutDef, type ShortcutId } from '../shortcuts.svelte';
  import { t } from '../i18n';

  let recording = $state<ShortcutId | null>(null);
  /** A note under the row just changed (a clash, or what moved). */
  let note = $state<{ id: ShortcutId; text: string; error?: boolean } | null>(null);

  const groups = SHORTCUT_GROUPS.map((g) => ({ id: g, items: SHORTCUTS.filter((s) => s.group === g) }));
  const anyCustom = $derived(Object.keys(prefs.shortcuts).length > 0);

  function start(id: ShortcutId) {
    recording = recording === id ? null : id;
    note = null;
  }

  function onKey(e: KeyboardEvent) {
    if (!recording) return;
    // Nothing else reacts to the keys being recorded (not even Esc closing Settings).
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = recording;
    const def = SHORTCUTS.find((s) => s.id === id)!;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      recording = null;
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      shortcuts.set(id, null);
      recording = null;
      note = { id, text: t('settings.keyboard.noShortcut') };
      return;
    }
    const combo = comboOf(e);
    if (!combo) return; // just a modifier so far
    const hasMod = /^(Mod|Alt)\+/.test(combo);
    const fKey = /(^|\+)F\d{1,2}$/.test(combo);
    if (!hasMod && !fKey && !def.bare) {
      note = { id, text: t('settings.keyboard.needsModifier', { mod: MOD, alt: ALT }), error: true };
      return;
    }
    const clash = shortcuts.conflict(id, combo);
    if (clash && !clash.id) {
      note = { id, text: t('settings.keyboard.usedFor', { keys: comboLabel(combo), command: clash.label }), error: true };
      return;
    }
    shortcuts.set(id, combo);
    recording = null;
    note = clash?.id ? { id, text: t('settings.keyboard.takenFrom', { command: clash.label }) } : null;
  }

  function hint(s: ShortcutDef): string {
    if (s.id === 'capture' && prefs.globalCapture) return t('settings.keyboard.worksAnywhere');
    if (s.bare) return t('settings.keyboard.whenNotTyping');
    return '';
  }

  /** What the keys button says to a screen reader: the command, its keys ("Ctrl K or Ctrl P"), and that it changes them. */
  function keysLabel(s: ShortcutDef, combos: string[]): string {
    if (!combos.length) return t('settings.keyboard.keysLabelNone', { command: s.label });
    const keys = combos.map((c) => comboKeys(c).join(' ')).reduce((first, second) => t('settings.keyboard.orKeys', { first, second }));
    return t('settings.keyboard.keysLabel', { command: s.label, keys });
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<h3 class="group-title" id="settings-keyboard">
  <span>{t('settings.keyboard.title')}</span>
  {#if anyCustom}
    <button class="btn small raised" onclick={() => shortcuts.reset()}><Icon name="restore" size={13} stroke={2} /> {t('settings.keyboard.resetAll')}</button>
  {/if}
</h3>
<p class="group-note top">{t('settings.keyboard.intro', { escape: keyName('Escape'), backspace: keyName('Backspace') })}</p>

{#each groups as g (g.id)}
  {#if g.id !== 'general'}<h3 class="group-title sub">{SHORTCUT_GROUP_LABELS[g.id]}</h3>{/if}
  <div class="group">
    {#each g.items as s (s.id)}
      {@const combos = shortcuts.combos(s.id)}
      {@const h = hint(s)}
      <div class="group-row compact">
        <div class="row-label">
          {s.label}
          {#if note?.id === s.id}
            <small class:error={note.error}>{note.text}</small>
          {:else if h}
            <small>{h}</small>
          {/if}
        </div>
        <div class="right">
          {#if shortcuts.isCustom(s.id)}
            <button class="icon-btn reset" onclick={() => shortcuts.reset(s.id)} data-tip={t('settings.keyboard.backToDefault')} aria-label={t('settings.keyboard.reset', { command: s.label })}>
              <Icon name="restore" size={14} />
            </button>
          {/if}
          <button
            class="keys-btn"
            class:recording={recording === s.id}
            onclick={() => start(s.id)}
            aria-label={keysLabel(s, combos)}
          >
            {#if recording === s.id}
              <span class="listening">{t('settings.keyboard.pressKeys')}</span>
            {:else if combos.length}
              {#each combos as combo, i (combo)}
                {#if i > 0}<span class="or">{t('settings.keyboard.or')}</span>{/if}
                <span class="combo">{#each comboKeys(combo) as k}<kbd>{k}</kbd>{/each}</span>
              {/each}
            {:else}
              <span class="none">{t('settings.keyboard.none')}</span>
            {/if}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/each}

<h3 class="group-title sub">{t('settings.keyboard.inEditor')}</h3>
<div class="group">
  {#each EDITOR_KEYS as s (s)}
    <div class="group-row compact">
      <div class="row-label">{s.label}</div>
      <div class="right fixed">
        {#each s.keys as combo, i (i)}
          {#if i > 0}<span class="or">·</span>{/if}
          <span class="combo">{#each combo as k}<kbd>{k}</kbd>{/each}</span>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .group-title.sub {
    margin-top: 16px;
  }
  .group-note.top {
    margin: -4px 4px 8px;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .right.fixed {
    gap: 6px;
    padding-right: 8px;
  }
  .keys-btn {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 96px;
    height: var(--h-sm);
    padding: 0 8px;
    border-radius: var(--r-sm);
    transition:
      background-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .keys-btn:hover {
    background: var(--fill);
  }
  .keys-btn.recording {
    justify-content: center;
    background: var(--bg-elevated);
    box-shadow: 0 0 0 1.5px var(--accent);
  }
  .listening {
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-2);
    animation: pulse 1.2s var(--ease) infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  .none {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .combo {
    display: flex;
    gap: 4px;
  }
  .combo kbd {
    min-width: 20px;
    justify-content: center;
    background: var(--raised);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 1px 0 var(--hairline);
    color: var(--text-2);
  }
  .or {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .reset {
    width: var(--h-sm);
    height: var(--h-sm);
    color: var(--text-3);
  }
  small.error {
    color: var(--danger);
  }
</style>
