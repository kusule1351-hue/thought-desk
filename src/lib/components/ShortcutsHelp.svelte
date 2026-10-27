<script lang="ts">
  import { MOD } from '../platform';
  /**
   * Every keyboard shortcut on one sheet (Ctrl+/). The app's own shortcuts
   * show the keys the user picked; "Change shortcuts" opens Settings there.
   */
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import { EDITOR_KEYS, MARKDOWN_KEYS, SHORTCUTS, SHORTCUT_GROUPS, SHORTCUT_GROUP_LABELS, comboKeys, keyName, shortcuts } from '../shortcuts.svelte';
  import { ui } from '../ui.svelte';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';

  const groups = SHORTCUT_GROUPS.map((g) => ({ id: g, items: SHORTCUTS.filter((s) => s.group === g) }));
  const TABLE_KEYS: { label: string; keys: string[][] }[] = [
    { label: t('settings.help.tableKeys.save'), keys: [[keyName('Enter')]] },
    { label: t('settings.help.tableKeys.next'), keys: [[keyName('Tab')]] },
    { label: t('settings.help.tableKeys.newLine'), keys: [[keyName('Shift'), keyName('Enter')]] },
    { label: t('settings.help.tableKeys.cancel'), keys: [[keyName('Escape')]] },
    { label: t('settings.help.tableKeys.undo'), keys: [[MOD, 'Z']] },
  ];

  const close = () => (ui.shortcutsHelp = false);

  function customize() {
    close();
    ui.settingsSection = 'keyboard';
    ui.settingsOpen = true;
  }
</script>

<Modal onclose={close} label={t('settings.help.dialog')} width={720} top="8vh">
  <header class="modal-head">
    <h2>{t('settings.keyboard.title')}</h2>
    <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </header>

  <div class="modal-body fade">
    <div class="cols">
      <div class="col">
        {#each groups as g (g.id)}
          <h3 class="group-title">{SHORTCUT_GROUP_LABELS[g.id]}</h3>
          <div class="list">
            {#each g.items as s (s.id)}
              {@const combos = shortcuts.combos(s.id)}
              <div class="row">
                <span class="what">{s.label}</span>
                {#if combos.length}
                  <span class="keys">
                    {#each combos.slice(0, 1) as combo (combo)}
                      {#each comboKeys(combo) as k}<kbd>{k}</kbd>{/each}
                    {/each}
                  </span>
                {:else}
                  <span class="none">{t('settings.keyboard.none')}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>

      <div class="col">
        <h3 class="group-title">{t('settings.help.inPage')}</h3>
        <div class="list">
          {#each EDITOR_KEYS as s (s)}
            <div class="row">
              <span class="what">{s.label}</span>
              <span class="keys">
                {#each s.keys as combo, i (i)}
                  {#if i > 0}<span class="or">·</span>{/if}
                  {#each combo as k}<kbd>{k}</kbd>{/each}
                {/each}
              </span>
            </div>
          {/each}
        </div>

        <h3 class="group-title">{t('settings.help.markdown')}</h3>
        <div class="list">
          {#each MARKDOWN_KEYS as m (m.type)}
            <div class="row">
              <span class="what">{m.label}</span>
              <span class="keys"
                >{#if m.now}<kbd class="mono">{m.type}</kbd>{:else}<Rich key="settings.help.typeThenSpace" params={{ type: m.type, space: keyName('Space') }}
                    >{#snippet typed(text: string)}<kbd class="mono">{text}</kbd>{/snippet}{#snippet sep(text: string)}<span class="or">{text}</span>{/snippet}{#snippet keycap(text: string)}<kbd>{text}</kbd>{/snippet}</Rich
                  >{/if}</span
              >
            </div>
          {/each}
        </div>

        <h3 class="group-title">{t('settings.help.inTable')}</h3>
        <div class="list">
          {#each TABLE_KEYS as s (s)}
            <div class="row">
              <span class="what">{s.label}</span>
              <span class="keys">{#each s.keys as combo}{#each combo as k}<kbd>{k}</kbd>{/each}{/each}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <div class="foot">
      <span><Rich key="settings.help.openAnyTime" params={{ mod: MOD }}>{#snippet kbd(text: string)}<kbd>{text}</kbd>{/snippet}</Rich></span>
      <button class="btn small raised" onclick={customize}><Icon name="settings" size={13} /> {t('settings.help.change')}</button>
    </div>
  </div>
</Modal>

<style>
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 28px;
  }
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: 1fr;
    }
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 30px;
    padding: 0 4px;
    border-bottom: 1px solid var(--separator);
  }
  .row:last-child {
    border-bottom: none;
  }
  .what {
    min-width: 0;
    font-size: var(--fs-ui);
    color: var(--text);
  }
  .keys {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  kbd {
    min-width: 20px;
    justify-content: center;
    background: var(--raised);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      0 1px 0 var(--hairline);
    color: var(--text-2);
  }
  kbd.mono {
    font-family: var(--font-mono);
  }
  .or,
  .none {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 18px;
    padding: 0 4px;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .foot kbd {
    margin: 0 1px;
  }
</style>
