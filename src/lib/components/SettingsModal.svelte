<script lang="ts">
  import { MOD, isMac } from '../platform';
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Swatches from '../ui/Swatches.svelte';
  import Switch from '../ui/Switch.svelte';
  import ColorWheel from '../ui/ColorWheel.svelte';
  import ShortcutsEditor from './ShortcutsEditor.svelte';
  import { oklchHex, parseHex, rgbToOklch } from '../color-math';
  import { shortcuts } from '../shortcuts.svelte';
  import { api } from '../api';
  import { ACCENTS, PALETTE, PALETTES, colorVar, nextColor, type Accent } from '../colors';
  import { planner } from '../planner.svelte';
  import { prefs, type Font, type TextSize, type RemindAssignments, type RemindEvents, type Theme, type WeekStart } from '../prefs.svelte';
  import { importCalendar } from '../ics-import.svelte';
  import { exportWorkspace } from '../export-workspace';
  import { account } from '../account.svelte';
  import Avatar from './Avatar.svelte';
  import { chooseDataFolder, useDefaultDataFolder } from '../data-folder';
  import { SIDEBAR_ITEMS, setShownInSidebar, shownInSidebar, type SidebarItem } from '../sidebar-items';
  import { changeLook } from '../look-transition';
  import { ui } from '../ui.svelte';
  import { updates } from '../updates.svelte';
  import { MAX_ZOOM, MIN_ZOOM, zoomIn, zoomLabel, zoomOut, zoomReset } from '../zoom.svelte';
  import { formatBytes } from '../time';
  import { LANGUAGES, i18n, t, type MessageKey, type PluralKey } from '../i18n';
  import { fmt } from '../i18n/format';
  import Rich from '../i18n/Rich.svelte';
  import type { DataInfo } from '../types';

  let info = $state<DataInfo | null>(null);

  /** A new language takes a restart of the window: App saves everything, then reloads. */
  function chooseLanguage(next: string) {
    if (next === i18n.choice || !i18n.choose(next)) return;
    window.dispatchEvent(new Event('td:reload'));
  }

  const languageName = (l: (typeof LANGUAGES)[number]) => (l.name === l.english ? l.name : `${l.name} (${l.english})`);
  const systemLanguage = $derived(t('settings.language.system', { language: LANGUAGES.find((l) => l.code === i18n.systemLanguage)?.name ?? 'English' }));
  const languageLabel = $derived(i18n.choice === 'system' ? systemLanguage : languageName(LANGUAGES.find((l) => l.code === i18n.choice) ?? LANGUAGES[0]));

  function languageMenu(e: MouseEvent) {
    ui.openMenuAt(
      e.currentTarget as Element,
      [
        { label: systemLanguage, checked: i18n.choice === 'system', action: () => chooseLanguage('system') },
        { separator: true },
        ...LANGUAGES.map((l) => ({ label: languageName(l), checked: i18n.choice === l.code, action: () => chooseLanguage(l.code) })),
      ],
      { alignRight: true },
    );
  }

  onMount(() => {
    api.dataInfo().then((d) => (info = d), ui.error);
    if (ui.settingsSection) {
      document.getElementById(`settings-${ui.settingsSection}`)?.scrollIntoView({ block: 'start' });
      ui.settingsSection = null;
    }
    // Settings is the most expensive screen to draw. Chromium keeps those
    // graphics around for minutes; let it go as soon as Settings closes.
    return () => void api.trimMemory().catch(() => {});
  });

  const themes: { value: Theme; label: string; icon: string }[] = [
    { value: 'light', label: t('settings.appearance.themes.light'), icon: 'sun' },
    { value: 'dark', label: t('settings.appearance.themes.dark'), icon: 'moon' },
    { value: 'system', label: t('settings.appearance.themes.auto'), icon: 'monitor' },
  ];
  const fonts: { value: Font; label: string }[] = [
    { value: 'sans', label: t('settings.appearance.fonts.sans') },
    { value: 'serif', label: t('settings.appearance.fonts.serif') },
    { value: 'mono', label: t('settings.appearance.fonts.mono') },
  ];
  const textSizes: { value: TextSize; label: string }[] = [
    { value: 'small', label: t('settings.appearance.textSizes.small') },
    { value: 'default', label: t('settings.appearance.textSizes.default') },
    { value: 'large', label: t('settings.appearance.textSizes.large') },
    { value: 'xlarge', label: t('settings.appearance.textSizes.xlarge') },
  ];
  const weekdays = fmt.weekdayNames('long');
  const weekStarts: { value: WeekStart; label: string }[] = [
    { value: 0, label: weekdays[0] },
    { value: 1, label: weekdays[1] },
  ];
  const remindAssignments: { value: RemindAssignments; label: string }[] = [
    { value: 'off', label: t('settings.reminders.assignmentsOff') },
    { value: 'evening', label: t('settings.reminders.eveningBefore') },
    { value: 'morning', label: t('settings.reminders.thatMorning') },
  ];
  const remindEvents: { value: RemindEvents; label: string }[] = [
    { value: 0, label: t('settings.reminders.eventsOff') },
    { value: 5, label: t('settings.reminders.minutes', { count: 5 }) },
    { value: 10, label: t('settings.reminders.minutes', { count: 10 }) },
    { value: 15, label: t('settings.reminders.minutes', { count: 15 }) },
    { value: 30, label: t('settings.reminders.minutes', { count: 30 }) },
  ];

  /** Each sidebar item's switch, by its key (sidebar-items.ts): a new item needs its sentence here. */
  const SHOW_IN_SIDEBAR = {
    home: 'settings.sidebar.show.home',
    assignments: 'settings.sidebar.show.assignments',
    calendar: 'settings.sidebar.show.calendar',
    files: 'settings.sidebar.show.files',
    cards: 'settings.sidebar.show.cards',
    friends: 'settings.sidebar.show.friends',
    galaxy: 'settings.sidebar.show.galaxy',
    favorites: 'settings.sidebar.show.favorites',
    courses: 'settings.sidebar.show.courses',
    databases: 'settings.sidebar.show.databases',
    tags: 'settings.sidebar.show.tags',
  } as const satisfies Record<SidebarItem, MessageKey>;

  /** The wheel's rim is this much chroma (as vivid as sRGB gets for most hues). */
  const MAX_CHROMA = 0.3;
  const customAccentHex = $derived(oklchHex(prefs.customAccent.lightness, prefs.customAccent.chroma, prefs.customAccent.hue));
  const accentLabel = $derived(
    prefs.accent === 'custom'
      ? t('settings.appearance.customAccent', { hex: customAccentHex.toUpperCase() })
      : (ACCENTS.find((a) => a.key === prefs.accent)?.label ?? ACCENTS[0].label),
  );
  let hexDraft = $state('');
  $effect(() => {
    hexDraft = customAccentHex.toUpperCase();
  });

  function setAccentHex(raw: string) {
    const rgb = parseHex(raw);
    if (!rgb) {
      hexDraft = customAccentHex.toUpperCase();
      return;
    }
    const { l, c, h } = rgbToOklch(rgb);
    prefs.customAccent = { hue: c < 0.01 ? prefs.customAccent.hue : h, chroma: Math.min(MAX_CHROMA, c), lightness: l };
  }

  /** The custom theme's sidebar, page and text, for its preview tile and the wheel's knob. */
  const customTheme = $derived.by(() => {
    const { hue: h, tint } = prefs.customTheme;
    return prefs.resolvedTheme === 'dark'
      ? { bg: oklchHex(0.17, 0.028 * tint, h), side: oklchHex(0.2, 0.032 * tint, h), ink: oklchHex(0.95, 0.018 * tint, h), knob: oklchHex(0.5, 0.12 * tint, h) }
      : { bg: oklchHex(0.982, 0.028 * tint, h), side: oklchHex(0.952, 0.042 * tint, h), ink: oklchHex(0.25, 0.045 * tint, h), knob: oklchHex(0.8, 0.12 * tint, h) };
  });

  /** Starting points for a custom theme. */
  const themeIdeas = [
    { label: t('settings.appearance.themeIdeas.ocean'), hue: 235, tint: 0.7 },
    { label: t('settings.appearance.themeIdeas.forest'), hue: 150, tint: 0.6 },
    { label: t('settings.appearance.themeIdeas.sand'), hue: 75, tint: 0.65 },
    { label: t('settings.appearance.themeIdeas.blush'), hue: 15, tint: 0.55 },
    { label: t('settings.appearance.themeIdeas.lavender'), hue: 295, tint: 0.65 },
    { label: t('settings.appearance.themeIdeas.mint'), hue: 175, tint: 0.5 },
  ];

  /** The account sheet replaces Settings (Escape then closes just that). */
  function openAccount() {
    ui.settingsOpen = false;
    ui.accountSheet = true;
  }

  async function copyPath() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.dataDir);
      ui.toast(t('settings.storage.pathCopied'));
    } catch (e) {
      ui.error(e);
    }
  }

  const addCourse = () => planner.promptCourse();

  async function renameCourse(id: string, name: string) {
    const res = await ui.prompt({ title: t('settings.courses.renameTitle'), value: name, confirmLabel: t('common.actions.rename'), icon: 'book' });
    if (res) void planner.updateCourse(id, { name: res.value });
  }

  function colorMenu(e: MouseEvent, id: string, current: string) {
    ui.openMenuAt(
      e.currentTarget as Element,
      PALETTE.map((p) => ({
        label: p.label,
        dot: colorVar(p.key),
        checked: current === p.key,
        action: () => void planner.updateCourse(id, { color: p.key }),
      })),
    );
  }

  /** How many of each there are: a big number with its word under it (the message's <num> and <noun>). */
  const stats = $derived<{ n: number; key: PluralKey }[]>(
    info
      ? [
          { n: info.pageCount, key: 'settings.storage.pages' },
          { n: info.assignmentCount, key: 'settings.storage.assignments' },
          { n: info.eventCount, key: 'settings.storage.events' },
          { n: info.fileCount, key: 'settings.storage.files' },
        ]
      : [],
  );

  /** The account's username as a handle, and its email, as far as there are any. */
  const accountLine = $derived.by(() => {
    const username = account.profile?.username;
    const email = account.user?.email;
    if (username) return email ? t('settings.account.usernameEmail', { username, email }) : t('settings.account.username', { username });
    return email ? t('settings.account.noUsernameEmail', { email }) : t('settings.account.noUsername');
  });
</script>

<Modal onclose={() => (ui.settingsOpen = false)} label={t('common.views.settings')}>
  <header class="modal-head">
    <h2>{t('common.views.settings')}</h2>
    <button class="icon-btn" onclick={() => (ui.settingsOpen = false)} aria-label={t('common.actions.close')}><Icon name="x" /></button>
  </header>

  <div class="modal-body fade">
    <h3 class="group-title">{t('settings.you.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">
          {t('settings.you.name')}
          <small>{t('settings.you.nameHint')}</small>
        </div>
        <input
          class="field name-field"
          value={prefs.name}
          placeholder={t('settings.you.yourName')}
          maxlength="40"
          spellcheck="false"
          aria-label={t('settings.you.yourName')}
          onchange={(e) => (prefs.name = e.currentTarget.value.trim())}
          onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
    </div>

    <h3 class="group-title">{t('settings.account.title')}</h3>
    <div class="group">
      {#if account.user}
        <div class="group-row">
          <div class="account-row">
            <Avatar name={account.name} url={account.profile?.avatarUrl} seed={account.user.id} size={32} />
            <div class="row-label">
              {account.name}
              <small>{accountLine}</small>
            </div>
          </div>
          <button class="btn small raised" onclick={openAccount}>{t('settings.account.editProfile')}</button>
        </div>
      {:else}
        <div class="group-row">
          <div class="row-label">
            {t('settings.account.signedOut')}
            <small>{t('settings.account.signedOutHint')}</small>
          </div>
          <button class="btn small raised" disabled={!account.ready} onclick={openAccount}>{t('settings.account.signIn')}</button>
        </div>
      {/if}
    </div>

    <h3 class="group-title">{t('settings.appearance.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">{t('settings.appearance.theme')}</div>
        <Segmented options={themes} value={prefs.theme} onchange={(v) => changeLook(() => (prefs.theme = v))} label={t('settings.appearance.theme')} />
      </div>
      <div class="group-row stack">
        <div class="row-label">
          {t('settings.appearance.colorTheme')}
          <small>{t('settings.appearance.colorThemeHint')}</small>
        </div>
        <div class="palettes" role="radiogroup" aria-label={t('settings.appearance.colorTheme')}>
          {#each PALETTES as p (p.key)}
            {@const [bg, side, ink] = prefs.resolvedTheme === 'dark' ? p.dark : p.light}
            <button class="palette" class:on={prefs.palette === p.key} role="radio" aria-checked={prefs.palette === p.key} onclick={() => (prefs.palette = p.key)}>
              <span class="mini" style:--bg={bg} style:--side={side} style:--ink={ink}>
                <span class="mini-side"><i></i><i></i><i></i></span>
                <span class="mini-page"><b></b><i></i><i></i><i class="short"></i></span>
              </span>
              <span class="pname">{p.label}</span>
            </button>
          {/each}
          <button class="palette" class:on={prefs.palette === 'custom'} role="radio" aria-checked={prefs.palette === 'custom'} onclick={() => (prefs.palette = 'custom')}>
            <span class="mini" style:--bg={customTheme.bg} style:--side={customTheme.side} style:--ink={customTheme.ink}>
              <span class="mini-side"><i></i><i></i><i></i></span>
              <span class="mini-page"><b></b><i></i><i></i><i class="short"></i></span>
              <span class="mini-wheel round"></span>
            </span>
            <span class="pname">{t('settings.appearance.customTheme')}</span>
          </button>
        </div>
        {#if prefs.palette === 'custom'}
          <div class="picker">
            <ColorWheel
              kind="theme"
              label={t('settings.appearance.themeColor')}
              hue={prefs.customTheme.hue}
              amount={prefs.customTheme.tint}
              knob={customTheme.knob}
              onchange={(hue, tint) => (prefs.customTheme = { hue, tint })}
            />
            <div class="picker-side">
              <div class="picker-text">
                <strong>{t('settings.appearance.ownTheme')}</strong>
                <span>{t('settings.appearance.ownThemeHint')}</span>
              </div>
              <label class="slider">
                <span>{t('settings.appearance.tint')}</span>
                <input
                  class="range"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={prefs.customTheme.tint}
                  style:--track="linear-gradient(to right, {oklchHex(0.9, 0, 0)}, {oklchHex(0.82, 0.12, prefs.customTheme.hue)})"
                  oninput={(e) => (prefs.customTheme = { ...prefs.customTheme, tint: Number(e.currentTarget.value) })}
                />
              </label>
              <div class="ideas">
                {#each themeIdeas as idea (idea.hue)}
                  <button
                    class="chip idea"
                    style:--c={oklchHex(0.8, 0.1, idea.hue)}
                    onclick={() => (prefs.customTheme = { hue: idea.hue, tint: idea.tint })}
                  ><span class="dot"></span>{idea.label}</button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
      <div class="group-row">
        <div class="row-label">
          {t('settings.appearance.accentColor')}
          <small>{accentLabel}</small>
        </div>
        <Swatches keys={[...ACCENTS]} value={prefs.accent} onchange={(k) => (prefs.accent = k as Accent)} label={t('settings.appearance.accentColor')} custom={customAccentHex} />
      </div>
      {#if prefs.accent === 'custom'}
        <div class="group-row stack">
          <div class="picker">
            <ColorWheel
              kind="accent"
              label={t('settings.appearance.accentColor')}
              hue={prefs.customAccent.hue}
              amount={Math.min(1, prefs.customAccent.chroma / MAX_CHROMA)}
              knob={customAccentHex}
              onchange={(hue, amount) => (prefs.customAccent = { ...prefs.customAccent, hue, chroma: amount * MAX_CHROMA })}
            />
            <div class="picker-side">
              <label class="slider">
                <span>{t('settings.appearance.brightness')}</span>
                <input
                  class="range"
                  type="range"
                  min="0.35"
                  max="0.9"
                  step="0.005"
                  value={prefs.customAccent.lightness}
                  style:--track="linear-gradient(to right, {oklchHex(0.35, prefs.customAccent.chroma, prefs.customAccent.hue)}, {oklchHex(0.62, prefs.customAccent.chroma, prefs.customAccent.hue)}, {oklchHex(0.9, prefs.customAccent.chroma, prefs.customAccent.hue)})"
                  oninput={(e) => (prefs.customAccent = { ...prefs.customAccent, lightness: Number(e.currentTarget.value) })}
                />
              </label>
              <div class="hex-row">
                <label class="field hex">
                  <span class="swatch-dot round" style:background={customAccentHex}></span>
                  <input
                    value={hexDraft}
                    spellcheck="false"
                    aria-label={t('settings.appearance.hexColor')}
                    maxlength="7"
                    oninput={(e) => (hexDraft = e.currentTarget.value)}
                    onchange={(e) => setAccentHex(e.currentTarget.value)}
                    onkeydown={(e) => e.key === 'Enter' && setAccentHex(e.currentTarget.value)}
                  />
                </label>
                <div class="accent-preview" aria-hidden="true">
                  <span class="pv-btn">{t('settings.appearance.previewButton')}</span>
                  <span class="pv-check round"></span>
                  <span class="pv-sel">{t('settings.appearance.previewSelected')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      {/if}
      <div class="group-row tall">
        <div class="row-label">
          {t('settings.appearance.pageFont')}
          <small>{t('settings.appearance.pageFontHint')}</small>
        </div>
        <div class="fonts" role="radiogroup" aria-label={t('settings.appearance.pageFont')}>
          {#each fonts as f}
            <button class="font" class:on={prefs.font === f.value} data-font={f.value} role="radio" aria-checked={prefs.font === f.value} onclick={() => (prefs.font = f.value)}>
              <span class="ag">{t('settings.appearance.fontSample')}</span>
              <span class="fname">{f.label}</span>
            </button>
          {/each}
        </div>
      </div>
      <div class="group-row">
        <div class="row-label">
          {t('settings.appearance.zoom')}
          <small>{isMac ? t('settings.appearance.zoomHintMac') : t('settings.appearance.zoomHint', { mod: MOD })}</small>
        </div>
        <div class="stepper" role="group" aria-label={t('settings.appearance.zoom')}>
          <button onclick={zoomOut} disabled={prefs.zoom <= MIN_ZOOM} aria-label={t('settings.commands.zoomOut')} data-tip={t('settings.commands.zoomOut')} data-tip-key={shortcuts.label('zoomOut')}><Icon name="minus" size={14} stroke={2} /></button>
          <button class="level" onclick={zoomReset} disabled={prefs.zoom === 1} aria-label={t('settings.appearance.zoomLevel', { level: zoomLabel(prefs.zoom), normal: zoomLabel(1) })} data-tip={t('settings.commands.zoomReset')} data-tip-key={shortcuts.label('zoomReset')}>{zoomLabel(prefs.zoom)}</button>
          <button onclick={zoomIn} disabled={prefs.zoom >= MAX_ZOOM} aria-label={t('settings.commands.zoomIn')} data-tip={t('settings.commands.zoomIn')} data-tip-key={shortcuts.label('zoomIn')}><Icon name="plus" size={14} stroke={2} /></button>
        </div>
      </div>
      <div class="group-row">
        <div class="row-label">
          {t('settings.appearance.textSize')}
          <small>{t('settings.appearance.textSizeHint')}</small>
        </div>
        <Segmented options={textSizes} value={prefs.textSize} onchange={(v) => (prefs.textSize = v)} label={t('settings.appearance.textSize')} />
      </div>
      {#if LANGUAGES.length > 1}
        <div class="group-row">
          <div class="row-label">
            {t('settings.language.label')}
            <small>{t('settings.language.hint')}</small>
          </div>
          <button class="btn small raised language" onclick={languageMenu} aria-haspopup="menu" aria-label={`${t('settings.language.label')}: ${languageLabel}`}>
            <span class="language-name">{languageLabel}</span>
            <Icon name="chevron-down" size={12} stroke={2.2} />
          </button>
        </div>
      {/if}
    </div>

    <h3 class="group-title">{t('settings.sidebar.title')}</h3>
    <div class="group">
      {#each SIDEBAR_ITEMS as item (item.key)}
        <div class="group-row">
          <div class="row-label">{item.label}</div>
          <Switch on={shownInSidebar(item.key)} label={t(SHOW_IN_SIDEBAR[item.key])} onchange={() => setShownInSidebar(item.key, !shownInSidebar(item.key))} />
        </div>
      {/each}
    </div>
    <p class="group-note">{t('settings.sidebar.note')}</p>

    <h3 class="group-title">{t('settings.writing.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">
          {t('settings.writing.spellcheck')}
          <small>{t('settings.writing.spellcheckHint')}</small>
        </div>
        <Switch on={prefs.spellcheck} label={t('settings.writing.spellcheck')} onchange={() => (prefs.spellcheck = !prefs.spellcheck)} />
      </div>
    </div>

    <h3 class="group-title">{t('settings.capture.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">
          {t('settings.capture.anywhere')}
          <small
            >{shortcuts.label('capture')
              ? t('settings.capture.anywhereHint', { shortcut: shortcuts.label('capture') })
              : t('settings.capture.anywhereHintNoShortcut')}</small
          >
        </div>
        <Switch on={prefs.globalCapture} label={t('settings.capture.anywhere')} onchange={() => (prefs.globalCapture = !prefs.globalCapture)} />
      </div>
    </div>

    <h3 class="group-title">{t('settings.calendar.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">{t('settings.calendar.weekStart')}</div>
        <Segmented options={weekStarts} value={prefs.weekStart} onchange={(v) => (prefs.weekStart = v)} label={t('settings.calendar.weekStart')} />
      </div>
      <div class="group-row">
        <div class="row-label">
          {t('settings.calendar.import')}
          <small>{t('settings.calendar.importHint')}</small>
        </div>
        <button class="btn small raised" onclick={importCalendar}><Icon name="download" size={13} stroke={2.2} /> {t('settings.calendar.importButton')}</button>
      </div>
    </div>

    <h3 class="group-title">{t('settings.reminders.title')}</h3>
    <div class="group">
      <div class="group-row">
        <div class="row-label">
          {t('settings.reminders.assignments')}
          <small>{t('settings.reminders.assignmentsHint')}</small>
        </div>
        <Segmented options={remindAssignments} value={prefs.remindAssignments} onchange={(v) => (prefs.remindAssignments = v)} label={t('settings.reminders.assignmentReminders')} />
      </div>
      <div class="group-row">
        <div class="row-label">
          {t('settings.reminders.events')}
          <small>{t('settings.reminders.eventsHint')}</small>
        </div>
        <Segmented options={remindEvents} value={prefs.remindEvents} onchange={(v) => (prefs.remindEvents = v)} label={t('settings.reminders.eventReminders')} />
      </div>
    </div>

    <h3 class="group-title">
      <span>{t('settings.courses.title')}</span>
      <button class="btn small raised" onclick={addCourse}><Icon name="plus" size={13} stroke={2.2} /> {t('settings.courses.add')}</button>
    </h3>
    <div class="group">
      {#each planner.courses as c (c.id)}
        {@const used = planner.live.filter((a) => a.courseId === c.id).length}
        <div class="group-row compact course">
          <button class="course-color" onclick={(e) => colorMenu(e, c.id, c.color)} data-tip={t('settings.courses.changeColor')} aria-label={t('settings.courses.changeColor')}>
            <span class="dot" style:--dot={colorVar(c.color)}></span>
          </button>
          <div class="row-label course-name">
            {c.name || t('common.untitled')}
            <small>{t('settings.courses.assignmentCount', { count: used })}</small>
          </div>
          <div class="course-actions">
            <button class="icon-btn" onclick={() => renameCourse(c.id, c.name)} data-tip={t('common.actions.rename')} aria-label={t('common.actions.rename')}><Icon name="pencil" size={15} /></button>
            <button class="icon-btn" onclick={() => planner.deleteCourse(c.id)} data-tip={t('common.actions.delete')} aria-label={t('common.actions.delete')}><Icon name="trash" size={15} /></button>
          </div>
        </div>
      {:else}
        <div class="group-row"><div class="row-label"><small>{t('settings.courses.empty')}</small></div></div>
      {/each}
    </div>

    <h3 class="group-title">{t('settings.storage.title')}</h3>
    <div class="group">
      {#if info}
        <div class="group-row stats">
          {#each stats as st}
            <div class="stat"
              ><Rich key={st.key} params={{ count: st.n }}
                >{#snippet num(text: string)}<strong>{text}</strong>{/snippet}{#snippet noun(text: string)}<span>{text}</span>{/snippet}</Rich
              ></div
            >
          {/each}
        </div>
        <div class="group-row">
          <div class="row-label">{t('settings.storage.size')}</div>
          <span class="value">{t('settings.storage.sizes', { database: formatBytes(info.dbBytes), files: formatBytes(info.fileBytes) })}</span>
        </div>
        <div class="group-row">
          <div class="row-label path-label">
            {t('settings.storage.location')}
            <small class="path" data-tip={info.dataDir}>{info.dataDir}</small>
          </div>
          <button class="btn small raised" onclick={copyPath}>{t('settings.storage.copyPath')}</button>
          {#if !info.envDir}
            <button class="btn small raised" onclick={() => void chooseDataFolder()}>{t('settings.storage.change')}</button>
          {/if}
        </div>
        {#if info.missingDir}
          <div class="group-row">
            <div class="row-label path-label">
              {t('settings.storage.missing')}
              <small class="path" data-tip={info.missingDir}>{t('settings.storage.missingHint', { path: info.missingDir })}</small>
            </div>
            <button class="btn small raised" onclick={() => void useDefaultDataFolder(true)}>{t('settings.storage.useThisFolder')}</button>
          </div>
        {:else if info.chosenDir && !info.envDir}
          <div class="group-row">
            <div class="row-label path-label">
              {t('settings.storage.ownFolder')}
              <small class="path" data-tip={info.defaultDir}>{info.defaultDir}</small>
            </div>
            <button class="btn small raised" onclick={() => void useDefaultDataFolder()}>{t('settings.storage.useDefault')}</button>
          </div>
        {/if}
        <div class="group-row">
          <div class="row-label">
            {t('settings.storage.export')}
            <small>{t('settings.storage.exportHint')}</small>
          </div>
          <button class="btn small raised" onclick={() => void exportWorkspace()}>{t('settings.storage.exportButton')}</button>
        </div>
      {:else}
        <div class="group-row"><div class="row-label"><small>{t('common.loading')}</small></div></div>
      {/if}
    </div>
    <p class="group-note">{t('settings.storage.note')}</p>

    <ShortcutsEditor />

    <p class="about">
      {t('settings.about.version', { version: info?.version ?? '' })} ·
      {#if updates.progress !== null}
        {updates.progress
          ? t('settings.about.updatingPercent', { percent: fmt.number(Math.round(updates.progress * 100) / 100, { style: 'percent' }) })
          : t('settings.about.updating')} ·
      {:else if updates.available}
        <button class="link" onclick={() => void updates.install()}>{t('settings.about.install', { version: updates.available.version })}</button> ·
      {:else}
        <button class="link" disabled={updates.checking} onclick={() => void updates.check(false)}>{updates.checking ? t('settings.about.checking') : t('settings.about.check')}</button> ·
      {/if}
      <button
        class="link"
        onclick={() => {
          ui.settingsOpen = false;
          prefs.welcomed = false;
        }}>{t('settings.about.showWelcome')}</button
      >
    </p>
  </div>
</Modal>

<style>
  /* Colour themes: a tiny window drawn in each theme's colours. */
  .palettes {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
  }
  .palette {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border-radius: var(--r-md);
    color: var(--text-2);
    transition: color var(--dur) var(--ease);
  }
  .palette:hover,
  .palette.on {
    color: var(--text);
  }
  /* 10px tile − 4px padding = 6px picture corners. */
  .mini {
    position: relative;
    display: flex;
    width: 100%;
    aspect-ratio: 4 / 3;
    border-radius: var(--r-xs);
    background: var(--bg);
    box-shadow: 0 0 0 1px var(--hairline);
    overflow: hidden;
    transition: box-shadow var(--dur) var(--ease);
  }
  .palette.on .mini {
    box-shadow:
      0 0 0 2px var(--bg-grouped),
      0 0 0 4px var(--accent);
  }
  .mini-side {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 30%;
    padding: 8px 4px;
    background: var(--side);
  }
  .mini-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 6px;
  }
  .mini i,
  .mini b {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--ink);
    opacity: 0.22;
  }
  .mini b {
    width: 60%;
    height: 5px;
    opacity: 0.85;
  }
  .mini i.short {
    width: 50%;
  }
  .pname {
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
  }

  /* The custom tile shows a little wheel in its corner. */
  .palettes {
    grid-template-columns: repeat(7, 1fr);
  }
  .mini-wheel {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: conic-gradient(
      oklch(0.75 0.15 0),
      oklch(0.75 0.15 90),
      oklch(0.75 0.15 180),
      oklch(0.75 0.15 270),
      oklch(0.75 0.15 360)
    );
    box-shadow: 0 0 0 1.5px var(--bg);
  }

  /* Colour wheel rows */
  .picker {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 8px 0 4px;
  }
  .picker-side {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .picker-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .picker-text strong {
    font-size: var(--fs-body-ui);
    font-weight: var(--fw-600);
  }
  .picker-text span {
    font-size: var(--fs-footnote);
    line-height: 16px;
    color: var(--text-2);
  }
  .slider {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .slider > span {
    font-size: var(--fs-footnote);
    font-weight: var(--fw-500);
    color: var(--text-2);
  }
  .ideas {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .idea {
    gap: 6px;
    height: var(--h-xs);
    padding: 0 10px 0 8px;
    font-size: var(--fs-footnote);
    background: var(--raised);
    box-shadow: 0 0 0 0.5px var(--hairline);
  }
  .idea .dot {
    --dot: var(--c);
  }
  .hex-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .language {
    flex: none;
    gap: 8px;
    max-width: 240px;
  }
  .language-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .language :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .field.hex {
    width: 128px;
    font-family: var(--font-mono);
    font-size: var(--fs-ui);
  }
  .swatch-dot {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.2);
  }
  .accent-preview {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pv-btn {
    display: inline-grid;
    place-items: center;
    height: var(--h-sm);
    padding: 0 12px;
    border-radius: var(--r-sm);
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--fs-ui);
    font-weight: var(--fw-600);
  }
  .pv-check {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent) var(--check) center / 72% no-repeat;
  }
  .pv-sel {
    padding: 1px 3px;
    border-radius: 3px;
    background: var(--selection);
    font-size: var(--fs-ui);
  }

  /* Font picker */
  /* Zoom: minus, the level (click for 100%), plus, on one track like a segmented control. */
  .stepper {
    display: flex;
    flex: none;
    padding: 2px;
    border-radius: var(--r-sm);
    background: var(--fill-2);
  }
  .stepper button {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: var(--h-sm);
    border-radius: var(--r-xs);
    color: var(--text-2);
    transition:
      background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }
  .stepper button:hover:not(:disabled) {
    background: var(--knob);
    color: var(--text);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-sm);
  }
  .stepper button:disabled {
    color: var(--text-4);
  }
  .stepper .level {
    width: 56px;
    font-size: var(--fs-ui);
    font-weight: var(--fw-500);
    font-variant-numeric: tabular-nums;
  }
  .stepper .level:disabled {
    color: var(--text);
  }
  .fonts {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .font {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    width: 64px;
    height: 56px;
    border-radius: var(--r-sm);
    background: var(--raised);
    box-shadow: 0 0 0 1px var(--hairline);
    color: var(--text-2);
    transition:
      box-shadow var(--dur) var(--ease),
      color var(--dur) var(--ease);
  }
  .font:hover {
    color: var(--text);
  }
  .font.on {
    color: var(--text);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .ag {
    font-size: 21px;
    line-height: 1.15;
  }
  .font[data-font='sans'] .ag {
    font-family: var(--font-sans);
    font-weight: var(--fw-500);
  }
  .font[data-font='serif'] .ag {
    font-family: var(--font-serif);
  }
  .font[data-font='mono'] .ag {
    font-family: var(--font-mono);
    font-size: 18px;
  }
  .fname {
    font-size: var(--fs-caption);
    font-weight: var(--fw-500);
  }

  /* Courses */
  .course {
    justify-content: flex-start;
    gap: 12px;
    min-height: 48px;
  }
  .course-color {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: var(--r-xs);
    transition: background-color var(--dur-fast) var(--ease);
  }
  .course-color:hover {
    background: var(--fill-2);
  }
  .course-color .dot {
    width: 12px;
    height: 12px;
  }
  .course-name {
    flex: 1;
  }
  .course-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .course:hover .course-actions,
  .course-actions:focus-within {
    opacity: 1;
  }
  .course + :global(.course)::before {
    left: 52px;
  }

  .account-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  /* Storage */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    padding: 14px 16px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .stat + .stat {
    padding-left: 16px;
    box-shadow: inset 1px 0 0 var(--hairline);
  }
  .stat strong {
    font-size: 17px;
    font-weight: var(--fw-600);
    letter-spacing: -0.012em;
    font-variant-numeric: tabular-nums;
  }
  .stat span {
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .value {
    font-size: var(--fs-ui);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .path-label {
    flex: 1;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 12px !important;
    color: var(--text-2) !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }

  .about {
    margin: 20px 0 0;
    text-align: center;
    font-size: var(--fs-footnote);
    color: var(--text-3);
  }
  .about .link {
    font-size: inherit;
    color: var(--text-2);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .about .link:hover {
    color: var(--text);
  }
  .name-field {
    width: 220px;
  }
</style>
