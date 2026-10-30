/**
 * Keyboard shortcuts: the commands that have one, their defaults, and the
 * user's own choices (Settings → Keyboard). A shortcut is written as
 * modifiers then a key code, e.g. "Mod+Shift+KeyL" or "Alt+ArrowLeft"; "Mod"
 * is Ctrl, or Cmd on a Mac. Key codes name physical keys, so they work on any layout.
 */

import { ALT, MOD, isMac } from './platform';
import { prefs } from './prefs.svelte';
import { t } from './i18n';

export type ShortcutId =
  | 'search'
  | 'newPage'
  | 'capture'
  | 'goHome'
  | 'goAssignments'
  | 'goCalendar'
  | 'goFiles'
  | 'goCards'
  | 'goFriends'
  | 'goGalaxy'
  | 'sidebar'
  | 'theme'
  | 'settings'
  | 'help'
  | 'split'
  | 'back'
  | 'forward'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'calendarPrev'
  | 'calendarNext'
  | 'calendarToday'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset';

/** The sections shortcuts are listed in, in order, and what each is called. */
export const SHORTCUT_GROUPS = ['general', 'tabs', 'goTo', 'calendar'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  general: t('settings.shortcutGroups.general'),
  tabs: t('settings.shortcutGroups.tabs'),
  goTo: t('settings.shortcutGroups.goTo'),
  calendar: t('settings.shortcutGroups.calendar'),
};

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaults: string[];
  /** May be a single key with no modifier (only where typing can't happen). */
  bare?: boolean;
  /** Also works system-wide (Quick Capture). */
  global?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'search', label: t('settings.commands.search'), group: 'general', defaults: ['Mod+KeyK', 'Mod+KeyP'] },
  { id: 'newPage', label: t('settings.commands.newPage'), group: 'general', defaults: ['Mod+KeyN'] },
  { id: 'capture', label: t('settings.commands.capture'), group: 'general', defaults: ['Mod+Shift+Space'], global: true },
  { id: 'sidebar', label: t('settings.commands.sidebar'), group: 'general', defaults: ['Mod+Backslash'] },
  { id: 'split', label: t('settings.commands.split'), group: 'general', defaults: ['Mod+Shift+Backslash'] },
  { id: 'theme', label: t('settings.commands.theme'), group: 'general', defaults: ['Mod+Shift+KeyL'] },
  { id: 'settings', label: t('common.views.settings'), group: 'general', defaults: ['Mod+Comma'] },
  { id: 'help', label: t('settings.commands.help'), group: 'general', defaults: ['Mod+Slash'] },
  { id: 'back', label: t('settings.commands.back'), group: 'general', defaults: ['Alt+ArrowLeft'] },
  { id: 'forward', label: t('settings.commands.forward'), group: 'general', defaults: ['Alt+ArrowRight'] },
  { id: 'zoomIn', label: t('settings.commands.zoomIn'), group: 'general', defaults: ['Mod+Equal', 'Mod+Shift+Equal', 'Mod+NumpadAdd'] },
  { id: 'zoomOut', label: t('settings.commands.zoomOut'), group: 'general', defaults: ['Mod+Minus', 'Mod+NumpadSubtract'] },
  { id: 'zoomReset', label: t('settings.commands.zoomReset'), group: 'general', defaults: ['Mod+Digit0', 'Mod+Numpad0'] },
  { id: 'newTab', label: t('settings.commands.newTab'), group: 'tabs', defaults: ['Mod+KeyT'] },
  { id: 'closeTab', label: t('settings.commands.closeTab'), group: 'tabs', defaults: ['Mod+KeyW'] },
  { id: 'nextTab', label: t('settings.commands.nextTab'), group: 'tabs', defaults: ['Mod+Tab', 'Mod+PageDown'] },
  { id: 'prevTab', label: t('settings.commands.prevTab'), group: 'tabs', defaults: ['Mod+Shift+Tab', 'Mod+PageUp'] },
  { id: 'goHome', label: t('common.views.home'), group: 'goTo', defaults: ['Mod+Digit1'] },
  { id: 'goAssignments', label: t('common.views.assignments'), group: 'goTo', defaults: ['Mod+Digit2'] },
  { id: 'goCalendar', label: t('common.views.calendar'), group: 'goTo', defaults: ['Mod+Digit3'] },
  { id: 'goFiles', label: t('common.views.files'), group: 'goTo', defaults: ['Mod+Digit4'] },
  { id: 'goCards', label: t('common.views.flashcards'), group: 'goTo', defaults: ['Mod+Digit5'] },
  { id: 'goFriends', label: t('common.views.friends'), group: 'goTo', defaults: ['Mod+Digit6'] },
  { id: 'goGalaxy', label: t('common.views.galaxy'), group: 'goTo', defaults: ['Mod+Digit7'] },
  { id: 'calendarPrev', label: t('settings.commands.calendarPrev'), group: 'calendar', defaults: ['ArrowLeft'], bare: true },
  { id: 'calendarNext', label: t('settings.commands.calendarNext'), group: 'calendar', defaults: ['ArrowRight'], bare: true },
  { id: 'calendarToday', label: t('settings.commands.calendarToday'), group: 'calendar', defaults: ['KeyT'], bare: true },
];

/** Shortcuts the editor (and the system) own; they can't be reassigned. */
export const RESERVED: Record<string, string> = {
  'Mod+KeyA': t('settings.editorCommands.selectAll'),
  'Mod+KeyB': t('settings.editorCommands.bold'),
  'Mod+KeyC': t('settings.editorCommands.copy'),
  'Mod+KeyD': t('settings.editorCommands.duplicateBlock'),
  'Mod+KeyE': t('settings.editorCommands.inlineCode'),
  'Mod+KeyI': t('settings.editorCommands.italic'),
  'Mod+KeyS': t('settings.editorCommands.save'),
  'Mod+KeyU': t('settings.editorCommands.underline'),
  'Mod+KeyV': t('settings.editorCommands.paste'),
  'Mod+KeyX': t('settings.editorCommands.cut'),
  'Mod+KeyY': t('settings.editorCommands.redo'),
  'Mod+KeyZ': t('settings.editorCommands.undo'),
  'Mod+Shift+KeyZ': t('settings.editorCommands.redo'),
  'Mod+Shift+KeyS': t('settings.editorCommands.strikethrough'),
  'Mod+Shift+KeyH': t('settings.editorCommands.highlight'),
  'Mod+Shift+KeyE': t('settings.editorCommands.inlineMath'),
  'Mod+Alt+Digit1': t('settings.editorCommands.heading1'),
  'Mod+Alt+Digit2': t('settings.editorCommands.heading2'),
  'Mod+Alt+Digit3': t('settings.editorCommands.heading3'),
  'Alt+F4': t('settings.editorCommands.closeWindow'),
};

/** Keycaps' names for key codes and modifiers: symbols as they are, key names in the interface's language. */
const KEY_NAMES: Record<string, string> = {
  Mod: MOD,
  Alt: ALT,
  Backslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: t('settings.keys.escape'),
  Delete: t('settings.keys.delete'),
  Backspace: t('settings.keys.backspace'),
  PageUp: t('settings.keys.pageUp'),
  PageDown: t('settings.keys.pageDown'),
  Home: t('settings.keys.home'),
  End: t('settings.keys.end'),
  Insert: t('settings.keys.insert'),
  Shift: t('settings.keys.shift'),
  Ctrl: t('settings.keys.ctrl'),
  Tab: t('settings.keys.tab'),
  Enter: t('settings.keys.enter'),
  Space: t('settings.keys.space'),
};

/** The number pad's keys that aren't digits ("NumpadAdd" → "Num Add"). */
const NUMPAD_NAMES: Record<string, string> = {
  NumpadAdd: t('settings.keys.numpadAdd'),
  NumpadSubtract: t('settings.keys.numpadSubtract'),
  NumpadMultiply: t('settings.keys.numpadMultiply'),
  NumpadDivide: t('settings.keys.numpadDivide'),
  NumpadDecimal: t('settings.keys.numpadDecimal'),
  NumpadEnter: t('settings.keys.numpadEnter'),
  NumpadEqual: t('settings.keys.numpadEqual'),
  NumpadComma: t('settings.keys.numpadComma'),
};

/** One key's name: "KeyK" → "K", "Digit1" → "1", "Numpad1" → "Num 1". */
export function keyName(part: string): string {
  if (part.startsWith('Key')) return part.slice(3);
  if (part.startsWith('Digit')) return part.slice(5);
  if (part.startsWith('Numpad')) return NUMPAD_NAMES[part] ?? t('settings.keys.numpad', { key: part.slice(6) });
  return KEY_NAMES[part] ?? part;
}

/** Shortcuts the editor keeps, as keycaps (shown in Settings for reference). */
export const EDITOR_KEYS: { label: string; keys: string[][] }[] = [
  { label: t('settings.editorKeys.insertBlock'), keys: [['/']] },
  { label: t('settings.editorKeys.mention'), keys: [['@']] },
  { label: t('settings.editorKeys.addLink'), keys: [[MOD, 'K']] },
  { label: t('settings.editorKeys.formatting'), keys: [[MOD, 'B'], [MOD, 'I'], [MOD, 'U']] },
  { label: t('settings.editorCommands.duplicateBlock'), keys: [[MOD, 'D']] },
  { label: t('settings.editorKeys.inlineMathSelection'), keys: [[MOD, keyName('Shift'), 'E']] },
  { label: t('settings.editorKeys.inlineMathTyping'), keys: [['$', 'x^2', '$']] },
  { label: t('settings.editorKeys.formula'), keys: [['\\'], [keyName('Tab')], [keyName('Enter')]] },
  { label: t('settings.editorKeys.indent'), keys: [[keyName('Tab')], [keyName('Shift'), keyName('Tab')]] },
  { label: t('settings.editorKeys.flashcards'), keys: [[keyName('Space')], ['1'], ['2'], ['3'], ['4']] },
];

/** Typing these at the start of a line (then Space, unless `now`) turns it into a block. */
export const MARKDOWN_KEYS: { label: string; type: string; now?: boolean }[] = [
  { label: t('settings.markdownKeys.heading'), type: '#' },
  { label: t('settings.markdownKeys.bulletedList'), type: '-' },
  { label: t('settings.markdownKeys.numberedList'), type: '1.' },
  { label: t('settings.markdownKeys.checklist'), type: '[ ]' },
  { label: t('settings.markdownKeys.quote'), type: '>' },
  { label: t('settings.markdownKeys.codeBlock'), type: '```' },
  { label: t('settings.markdownKeys.mathBlock'), type: '$$' },
  { label: t('settings.markdownKeys.divider'), type: '---', now: true },
];

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** The shortcut a key press makes, or null for a bare modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code) || !e.code) return null;
  const parts: string[] = [];
  // On a Mac, Ctrl keeps its own uses (Ctrl+A goes to the start of a line).
  if (isMac ? e.metaKey : e.ctrlKey || e.metaKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code);
  return parts.join('+');
}

/** The keys of a shortcut, for keycaps: ["Ctrl", "Shift", "L"]. */
export const comboKeys = (combo: string) => combo.split('+').map(keyName);

/** "Ctrl+Shift+L", for tooltips. */
export const comboLabel = (combo: string) => comboKeys(combo).join('+');

/** The form the system-wide shortcut takes on the Rust side. */
export const toAccelerator = (combo: string) => combo.replace(/^Mod\b/, 'CmdOrCtrl');

class Shortcuts {
  /** The shortcuts in effect for a command (the user's, or the defaults). */
  combos(id: ShortcutId): string[] {
    const custom = prefs.shortcuts[id];
    return custom !== undefined ? (custom ? [custom] : []) : (SHORTCUTS.find((s) => s.id === id)?.defaults ?? []);
  }

  /** The first shortcut's label, for tooltips ("" when there's none). */
  label(id: ShortcutId): string {
    const first = this.combos(id)[0];
    return first ? comboLabel(first) : '';
  }

  matches(e: KeyboardEvent, id: ShortcutId): boolean {
    const combo = comboOf(e);
    return !!combo && this.combos(id).includes(combo);
  }

  /** The command a key press stands for, if any. */
  match(e: KeyboardEvent, among: ShortcutId[] = SHORTCUTS.map((s) => s.id)): ShortcutId | null {
    const combo = comboOf(e);
    if (!combo) return null;
    return among.find((id) => this.combos(id).includes(combo)) ?? null;
  }

  isCustom(id: ShortcutId): boolean {
    return prefs.shortcuts[id] !== undefined;
  }

  /** Who else uses a shortcut (another command, or the editor). */
  conflict(id: ShortcutId, combo: string): { id?: ShortcutId; label: string } | null {
    if (RESERVED[combo]) return { label: RESERVED[combo] };
    for (const s of SHORTCUTS) {
      if (s.id !== id && this.combos(s.id).includes(combo)) return { id: s.id, label: s.label };
    }
    return null;
  }

  /** Sets a command's shortcut (null: none), taking it from another command. */
  set(id: ShortcutId, combo: string | null) {
    const next = { ...prefs.shortcuts };
    if (combo) {
      for (const s of SHORTCUTS) {
        if (s.id === id || !this.combos(s.id).includes(combo)) continue;
        const rest = this.combos(s.id).filter((c) => c !== combo);
        next[s.id] = rest[0] ?? null;
      }
    }
    next[id] = combo;
    // Back to the defaults: forget the override.
    const def = SHORTCUTS.find((s) => s.id === id)!.defaults;
    if (combo && def.length === 1 && def[0] === combo) delete next[id];
    prefs.shortcuts = next;
  }

  /** Back to the default (all of them without `id`). A default that another
   * command took in the meantime is taken back from it. */
  reset(id?: ShortcutId) {
    if (!id) {
      prefs.shortcuts = {};
      return;
    }
    const next: Partial<Record<ShortcutId, string | null>> = { ...prefs.shortcuts };
    delete next[id];
    const defaults = SHORTCUTS.find((s) => s.id === id)!.defaults;
    for (const s of SHORTCUTS) {
      const custom = next[s.id];
      if (s.id !== id && custom && defaults.includes(custom)) next[s.id] = null;
    }
    prefs.shortcuts = next;
  }
}

export const shortcuts = new Shortcuts();
