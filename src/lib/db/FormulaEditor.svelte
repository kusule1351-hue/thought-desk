<script lang="ts">
  import { MOD } from '../platform';
  /**
   * Writes a formula: properties and functions are suggested as you type
   * ({ for a property), the result for a real row shows live, and errors
   * say what's wrong and where.
   */
  import { onMount, tick, untrack } from 'svelte';
  import Modal from '../components/Modal.svelte';
  import Icon from '../components/Icon.svelte';
  import { databases } from '../databases.svelte';
  import { store } from '../store.svelte';
  import { FDate, FN_GROUPS, FN_GROUP_LABELS, FUNCTIONS, FormulaError, formatDateValue, run, toText, type FnGroup } from './formula';
  import { formatNumber, typeInfo } from './schema';
  import { t } from '../i18n';
  import Rich from '../i18n/Rich.svelte';
  import type { Property } from '../types';

  let { dbId, prop: propIn, onclose }: { dbId: string; prop: Property; onclose: () => void } = $props();
  const prop = untrack(() => propIn);

  let src = $state(untrack(() => prop.config.expression ?? ''));
  let name = $state(untrack(() => prop.name));
  let box: HTMLTextAreaElement;
  let caret = $state(untrack(() => src.length));
  let pick = $state(0);
  let hovered = $state<{ name: string; sig: string; doc: string } | null>(null);

  const others = $derived(databases.props(dbId).filter((p) => p.id !== prop.id));
  const rows = $derived(databases.rowsOf(dbId));
  let sampleIndex = $state(0);
  const sample = $derived(rows[sampleIndex] ?? rows[0]);

  onMount(() => {
    box.focus();
    box.setSelectionRange(src.length, src.length);
  });

  const result = $derived.by(() => {
    if (!src.trim()) return null;
    if (!sample) return run(src, { now: Date.now(), prop: (n) => (others.some((p) => p.name.toLowerCase() === n.toLowerCase()) ? null : undefined) });
    // The draft is evaluated against the row as it is now.
    const scope = databases.scope(sample);
    return run(src, scope);
  });

  /** The result, as the property's cells show it: dates as formatDate() writes them, which is formula output and stays English. */
  function show(v: unknown): string {
    if (v instanceof FDate) return formatDateValue(v);
    if (typeof v === 'number') return formatNumber(v, prop.config);
    if (typeof v === 'boolean') return v ? t('dbAuto.formulaEditor.resultTrue') : t('dbAuto.formulaEditor.resultFalse');
    if (Array.isArray(v)) return v.map((x) => toText(x)).join(', ') || t('dbAuto.formulaEditor.emptyList');
    const text = toText(v as never);
    return text === '' ? t('dbAuto.formulaEditor.empty') : t('dbAuto.formulaEditor.quoted', { text });
  }

  // ------------------------------------------------------------ suggestions

  type Suggestion = { kind: 'prop' | 'fn'; label: string; insert: string; detail: string; icon: string; from: number };

  const suggestions = $derived.by((): Suggestion[] => {
    const before = src.slice(0, caret);
    const brace = before.lastIndexOf('{');
    if (brace > before.lastIndexOf('}')) {
      const q = before.slice(brace + 1).toLowerCase();
      return others
        .filter((p) => p.name.toLowerCase().includes(q))
        .map((p) => ({ kind: 'prop', label: p.name, insert: `{${p.name}}`, detail: typeInfo(p.type).label, icon: typeInfo(p.type).icon, from: brace }));
    }
    const m = /[A-Za-z_][\w]*$/.exec(before);
    if (!m) return [];
    const q = m[0].toLowerCase();
    const fns = Object.values(FUNCTIONS)
      .filter((f) => f.name.toLowerCase().startsWith(q))
      .map((f) => ({ kind: 'fn' as const, label: `${f.name}()`, insert: `${f.name}(`, detail: f.doc, icon: 'function', from: m.index }));
    const props = others
      .filter((p) => p.name.toLowerCase().startsWith(q))
      .map((p) => ({ kind: 'prop' as const, label: p.name, insert: `{${p.name}}`, detail: typeInfo(p.type).label, icon: typeInfo(p.type).icon, from: m.index }));
    return [...props, ...fns].slice(0, 8);
  });

  $effect(() => {
    void suggestions.length;
    pick = 0;
  });

  async function insert(text: string, from = caret) {
    src = src.slice(0, from) + text + src.slice(caret);
    caret = from + text.length;
    await tick();
    box.focus();
    box.setSelectionRange(caret, caret);
  }

  function onKey(e: KeyboardEvent) {
    if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || (e.key === 'Enter' && !suggestions.length)) {
      e.preventDefault();
      save();
    } else if (suggestions.length && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      const s = suggestions[pick];
      void insert(s.insert, s.from);
    } else if (suggestions.length && e.key === 'ArrowDown') {
      e.preventDefault();
      pick = (pick + 1) % suggestions.length;
    } else if (suggestions.length && e.key === 'ArrowUp') {
      e.preventDefault();
      pick = (pick - 1 + suggestions.length) % suggestions.length;
    }
  }

  function sync() {
    caret = box.selectionStart;
  }

  function save() {
    databases.updateProperty(dbId, prop.id, { name: name.trim() || prop.name, config: { ...prop.config, expression: src.trim() } }, { immediate: true });
    onclose();
  }

  const fnsBy = (g: FnGroup) => Object.values(FUNCTIONS).filter((f) => f.group === g);

  /** Example formulas: their code is put in the box as it is (formulas are written in English). */
  const EXAMPLES = [
    { label: t('dbAuto.formulaEditor.example.multiply'), src: '{Price} * {Quantity}' },
    { label: t('dbAuto.formulaEditor.example.daysUntil'), src: 'daysUntil({Due})' },
    { label: t('dbAuto.formulaEditor.example.checkboxLabel'), src: 'if({Done}, "✓ Done", "Open")' },
    { label: t('dbAuto.formulaEditor.example.joinText'), src: '{First name} + " " + {Last name}' },
    { label: t('dbAuto.formulaEditor.example.stars'), src: 'repeat("★", {Rating})' },
  ];
</script>

<Modal onclose={onclose} width={760} label={t('dbAuto.formulaEditor.title')} top="8vh">
  <div class="modal-head">
    <h2><Icon name="function" size={18} /></h2>
    <input class="name" bind:value={name} placeholder={t('common.name')} aria-label={t('dbAuto.formulaEditor.propertyName')} />
    <button class="icon-btn" onclick={onclose} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </div>
  <div class="modal-body">
    <div class="editor">
      <textarea
        bind:this={box}
        bind:value={src}
        class="src"
        rows="3"
        spellcheck="false"
        placeholder={t('dbAuto.formulaEditor.placeholder', { example: '{Price} * {Quantity}' })}
        oninput={sync}
        onkeyup={sync}
        onclick={sync}
        onkeydown={onKey}
        aria-label={t('dbAuto.formulaEditor.title')}
      ></textarea>
      {#if suggestions.length}
        <div class="suggest" role="listbox">
          {#each suggestions as s, i (s.kind + s.label)}
            <button class="pop-item" class:active={i === pick} onmousemove={() => (pick = i)} onmousedown={(e) => e.preventDefault()} onclick={() => insert(s.insert, s.from)}>
              <Icon name={s.icon} size={14} />
              <span class="name">{s.label}</span>
              <span class="grow detail">{s.detail}</span>
            </button>
          {/each}
          <div class="tip"><Rich key="dbAuto.formulaEditor.tabToInsert" /></div>
        </div>
      {/if}
    </div>

    <div class="result" class:error={result instanceof FormulaError}>
      {#if result instanceof FormulaError}
        <Icon name="info" size={15} />
        <span>
          {#if result.at >= 0 && src}<Rich key="dbAuto.formulaEditor.errorAt" params={{ error: result.message, snippet: src.slice(Math.max(0, result.at - 8), result.at + 8) }}
              >{#snippet where(text: string)}<span class="where">{text}</span>{/snippet}</Rich
            >{:else}{result.message}{/if}
        </span>
      {:else if src.trim()}
        <span class="label">
          {#if sample}{t('dbAuto.formulaEditor.forRow', { title: store.byId.get(sample.id)?.title || t('common.untitled') })}{:else}{t('dbAuto.formulaEditor.result')}{/if}
        </span>
        <span class="value">{show(result)}</span>
        {#if rows.length > 1}
          <button class="icon-btn small" onclick={() => (sampleIndex = (sampleIndex + 1) % rows.length)} data-tip={t('dbAuto.formulaEditor.nextRow')}><Icon name="arrow-down" size={13} /></button>
        {/if}
      {:else}
        <span class="label">{t('dbAuto.formulaEditor.emptyResult')}</span>
      {/if}
    </div>

    <div class="ref">
      <section>
        <h3 class="eyebrow">{t('dbAuto.formulaEditor.properties')}</h3>
        <div class="items">
          {#each others as p (p.id)}
            <button
              class="ref-item"
              onclick={() => insert(`{${p.name}}`)}
              onmouseenter={() => (hovered = { name: p.name, sig: typeInfo(p.type).label, doc: t('dbAuto.formulaEditor.insertProperty', { code: `{${p.name}}` }) })}
            >
              <Icon name={typeInfo(p.type).icon} size={13} /> {p.name}
            </button>
          {/each}
        </div>
        <h3 class="eyebrow">{t('dbAuto.formulaEditor.examples')}</h3>
        <div class="items">
          {#each EXAMPLES as ex (ex.src)}
            <button class="ref-item" onclick={() => (src = ex.src)} onmouseenter={() => (hovered = { name: ex.label, sig: '', doc: ex.src })}>{ex.label}</button>
          {/each}
        </div>
      </section>
      <section class="fns">
        {#each FN_GROUPS as g (g)}
          <h3 class="eyebrow">{FN_GROUP_LABELS[g]}</h3>
          <div class="items">
            {#each fnsBy(g) as f (f.name)}
              <button class="ref-item mono" onclick={() => insert(`${f.name}(`)} onmouseenter={() => (hovered = { name: `${f.name}()`, sig: f.sig, doc: f.doc })}>{f.name}</button>
            {/each}
          </div>
        {/each}
      </section>
    </div>
    <div class="doc">
      {#if hovered}
        <strong>{hovered.name}</strong>{#if hovered.sig}<span class="sig"> · {hovered.sig}</span>{/if}
        <p>{hovered.doc}</p>
      {:else}
        <p><Rich key="dbAuto.formulaEditor.help" params={{ example: '{Due}' }}>{#snippet code(text: string)}<code>{text}</code>{/snippet}</Rich></p>
      {/if}
    </div>
  </div>
  <div class="modal-foot">
    <span><Rich key="dbAuto.formulaEditor.saveHint" params={{ mod: MOD }} /></span>
    <div class="actions">
      <button class="btn" onclick={onclose}>{t('common.actions.cancel')}</button>
      <button class="btn primary" onclick={save}>{t('common.actions.done')}</button>
    </div>
  </div>
</Modal>

<style>
  .modal-head h2 {
    flex: none;
    display: grid;
    color: var(--text-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    margin-left: -6px;
    border: none;
    border-radius: var(--r-sm);
    background: none;
    font-size: 17px;
    font-weight: var(--fw-650);
    letter-spacing: -0.016em;
    color: var(--text);
    outline: none;
  }
  .name:hover,
  .name:focus {
    background: var(--fill);
  }
  .editor {
    position: relative;
  }
  .src {
    display: block;
    width: 100%;
    min-height: 72px;
    padding: 10px 12px;
    border: none;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    box-shadow: inset 0 0 0 0.5px var(--hairline);
    font-family: var(--font-mono);
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
    resize: vertical;
    outline: none;
  }
  .src:focus {
    box-shadow: 0 0 0 1.5px var(--focus);
  }
  .suggest {
    position: absolute;
    left: 8px;
    right: 8px;
    top: calc(100% + 4px);
    z-index: 2;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-pop);
  }
  .suggest .name {
    flex: none;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .detail {
    color: var(--text-3);
    font-size: var(--fs-footnote);
  }
  .tip {
    padding: 4px 8px 2px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .result {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    margin: 10px 0 16px;
    padding: 6px 8px 6px 12px;
    border-radius: var(--r-sm);
    background: var(--fill);
    font-size: var(--fs-ui);
  }
  .result .label {
    color: var(--text-3);
  }
  .result .value {
    flex: 1;
    min-width: 0;
    font-weight: var(--fw-600);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result.error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }
  .where {
    font-family: var(--font-mono);
    font-size: 12px;
    opacity: 0.8;
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .ref {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 20px;
    max-height: 34vh;
    overflow-y: auto;
  }
  .eyebrow {
    margin: 10px 0 6px;
  }
  .eyebrow:first-child {
    margin-top: 0;
  }
  .items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .ref-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    background: var(--fill);
    font-size: var(--fs-footnote);
    color: var(--text);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .ref-item:hover {
    background: var(--fill-3);
  }
  .ref-item.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .ref-item :global(.icon) {
    color: var(--text-2);
  }
  .doc {
    min-height: 56px;
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--bg-grouped);
    font-size: var(--fs-ui);
  }
  .doc p {
    margin: 2px 0 0;
    color: var(--text-2);
    line-height: 1.45;
  }
  .doc .sig {
    color: var(--text-3);
  }
  .doc code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
