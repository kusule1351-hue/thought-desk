<script lang="ts">
  import PageIcon from '../components/PageIcon.svelte';
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import FileTile from '../ui/FileTile.svelte';
  import TagRow from '../ui/TagRow.svelte';
  import { fileMenuItems, renameFile } from '../file-actions';
  import { t } from '../i18n';
  import { KINDS, fileKind, fileSrc, library, previewable } from '../library.svelte';
  import { planner } from '../planner.svelte';
  import { store } from '../store.svelte';
  import { formatBytes, relativeTime } from '../time';
  import { ui } from '../ui.svelte';

  let { id }: { id: string } = $props();

  const file = $derived(library.byId.get(id));
  const mode = $derived(file ? previewable(file) : null);
  const used = $derived(library.usedIn(id));
  let text = $state<string | null>(null);
  let failed = $state(false);

  const TEXT_LIMIT = 200_000;

  onMount(() => {
    void library.refreshUsage();
    if (file && mode === 'text') {
      fetch(fileSrc(file))
        .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText)))
        .then((body) => (text = body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n…` : body))
        .catch(() => (failed = true));
    }
  });

  function close() {
    ui.filePreview = null;
  }

  function more(e: MouseEvent) {
    ui.openMenuAt(e.currentTarget as Element, fileMenuItems(id, { preview: false }), { alignRight: true });
  }

  function openPage(pid: string) {
    close();
    store.open(pid);
  }

  function openAssignment(aid: string) {
    close();
    planner.openAssignment(aid);
  }
</script>

<Modal onclose={close} width={760} top="6vh" label={t('library.preview.label')}>
  {#if file}
    <header class="modal-head">
      <FileTile {file} size={26} thumb={false} />
      <h2><button class="name" onclick={() => renameFile(id)} data-tip={t('common.actions.rename')}>{file.name}</button></h2>
      <button class="btn small raised" onclick={() => library.open(id)} disabled={file.missing}><Icon name="external" size={13} stroke={2} /> {t('common.actions.open')}</button>
      <button class="icon-btn" onclick={more} data-tip={t('common.actions.more')} aria-label={t('common.actions.more')}><Icon name="more" /></button>
      <button class="icon-btn" onclick={close} aria-label={t('common.actions.close')}><Icon name="x" /></button>
    </header>

    <div class="modal-body">
      <div class="stage" class:media={mode === 'image' || mode === 'video'} class:doc={mode === 'text' || mode === 'pdf'}>
        {#if failed}
          <div class="none">
            <FileTile {file} size={72} thumb={false} />
            <p>{t('library.preview.unreadable')}</p>
          </div>
        {:else if mode === 'image'}
          <img src={fileSrc(file)} alt={file.name} onerror={() => (failed = true)} />
        {:else if mode === 'pdf'}
          <iframe src={fileSrc(file)} title={file.name}></iframe>
        {:else if mode === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={fileSrc(file)} controls preload="metadata"></video>
        {:else if mode === 'audio'}
          <div class="none">
            <FileTile {file} size={72} thumb={false} />
            <audio src={fileSrc(file)} controls preload="metadata"></audio>
          </div>
        {:else if mode === 'text'}
          <pre class="text">{text ?? t('common.loading')}</pre>
        {:else}
          <div class="none">
            <FileTile {file} size={72} thumb={false} />
            <p>{file.missing ? t('library.preview.missing') : t('library.preview.noPreview')}</p>
            {#if !file.missing}<button class="btn small raised" onclick={() => library.open(id)}>{t('library.preview.openInDefaultApp')}</button>{/if}
          </div>
        {/if}
      </div>

      <div class="info">
        <div>
          <h3 class="group-title">{t('library.preview.details')}</h3>
          <div class="group">
            <div class="group-row compact"><div class="row-label">{t('library.preview.kind')}</div><span class="v">{KINDS[fileKind(file)].label}</span></div>
            <div class="group-row compact"><div class="row-label">{t('library.preview.size')}</div><span class="v">{formatBytes(file.size)}</span></div>
            <div class="group-row compact"><div class="row-label">{t('library.preview.added')}</div><span class="v">{relativeTime(file.createdAt)}</span></div>
            <div class="group-row compact"><div class="row-label">{t('common.tags')}</div><TagRow table="files" id={file.id} compact /></div>
          </div>
        </div>
        <div>
          <h3 class="group-title">{t('library.preview.usedIn')}</h3>
          <div class="group">
            {#each used.pages as p (p.id)}
              <button class="group-row compact use" onclick={() => openPage(p.id)}>
                <span class="use-icon">{#if p.icon}<PageIcon icon={p.icon} />{:else}<Icon name="page" size={15} />{/if}</span>
                <span class="use-name">{p.title || t('common.untitled')}</span>
                <Icon name="chevron-right" size={13} stroke={2} />
              </button>
            {/each}
            {#each used.assignments as a (a.id)}
              <button class="group-row compact use" onclick={() => openAssignment(a.id)}>
                <span class="use-icon" style:color={planner.courseColor(a.courseId)}><Icon name="assignment" size={15} /></span>
                <span class="use-name">{a.title || t('common.untitled')}</span>
                <Icon name="chevron-right" size={13} stroke={2} />
              </button>
            {/each}
            {#if !used.pages.length && !used.assignments.length}
              <div class="group-row compact"><span class="row-label"><small>{t('library.preview.notUsed')}</small></span></div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="modal-body"><p class="gone">{t('library.preview.gone')}</p></div>
  {/if}
</Modal>

<style>
  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: var(--r-xs);
    padding: 2px 4px;
    margin-left: -4px;
    transition: background-color var(--dur-fast) var(--ease);
  }
  .name:hover {
    background: var(--fill);
  }
  .stage {
    display: grid;
    place-items: center;
    min-height: 200px;
    border-radius: var(--r-md);
    background: var(--bg-grouped);
    overflow: hidden;
  }
  .stage.doc {
    place-items: stretch;
  }
  .stage.media {
    background: repeating-conic-gradient(var(--fill) 0% 25%, transparent 0% 50%) 50% / 20px 20px;
  }
  img,
  video {
    display: block;
    max-width: 100%;
    max-height: 52vh;
    object-fit: contain;
  }
  iframe {
    width: 100%;
    height: 58vh;
    border: none;
    background: #fff;
  }
  .text {
    width: 100%;
    max-height: 52vh;
    margin: 0;
    padding: 16px 18px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .none {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 32px;
    font-size: var(--fs-ui);
    color: var(--text-3);
  }
  .none p {
    margin: 0;
  }
  .info {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 16px;
    align-items: start;
  }
  .info .group-title {
    margin-top: 0;
  }
  .v {
    font-size: var(--fs-body-ui);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .use {
    width: 100%;
    justify-content: flex-start;
    gap: 10px;
    text-align: left;
    color: var(--text-3);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .use:hover {
    background: var(--fill);
  }
  .use:first-child {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  .use:last-child {
    border-bottom-left-radius: var(--r-md);
    border-bottom-right-radius: var(--r-md);
  }
  .use-icon {
    display: grid;
    place-items: center;
    width: 18px;
    font-size: 14px;
    color: var(--text-3);
  }
  .use-name {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-ui);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gone {
    margin: 24px 0;
    text-align: center;
    color: var(--text-3);
  }
  @media (max-width: 720px) {
    .info {
      grid-template-columns: 1fr;
    }
  }
</style>
