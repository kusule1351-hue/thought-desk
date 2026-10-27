/** Transient UI state: overlays, menus, dialogs and toasts. */

import { t } from './i18n';
import type { AssignmentPatch, EventPatch, FileMeta, TrashTable } from './types';
import type { IcsItem } from './ics';
import type { Card } from './types';

export type MenuItem =
  | {
      label: string;
      icon?: string;
      hint?: string;
      danger?: boolean;
      checked?: boolean;
      disabled?: boolean;
      /** A coloured dot instead of an icon (CSS colour). */
      dot?: string;
      action: () => void;
    }
  | { separator: true }
  | { header: string };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** Align the menu's right edge to x instead of its left edge. */
  alignRight?: boolean;
  onClose?: () => void;
}

export interface IconPickerState {
  x: number;
  y: number;
  onPick: (icon: string) => void;
  onRemove?: () => void;
  /** The icon there now, so the picker opens on its tab and colour. */
  current?: string;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  icon?: string;
  /** Present for prompts: the text field's starting value and placeholder. */
  input?: { value: string; placeholder: string; select?: 'all' | 'stem' };
  /** Present for prompts that also pick a colour. */
  color?: string;
  resolve: (ok: boolean, value?: string, color?: string) => void;
}

export interface FilePickerState {
  x: number;
  y: number;
  /** Files that shouldn't be offered (already attached). */
  exclude?: string[];
  multiple?: boolean;
  onPick: (files: FileMeta[]) => void;
}

export interface TagPickerState {
  x: number;
  y: number;
  table: TrashTable;
  id: string;
}

/** An assignment or event sheet: an existing item (id) or a new one (draft). */
export interface SheetState<P> {
  id: string | null;
  draft: P;
  /** Called with the new item's id when a new one is added. */
  onCreated?: (id: string) => void;
  /** For a repeating event: the session it was opened from. */
  date?: string;
}

export interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  action?: () => void;
}

class UI {
  searchOpen = $state(false);
  settingsOpen = $state(false);
  /** A part of Settings to scroll to when it opens. */
  settingsSection = $state<'keyboard' | null>(null);
  shortcutsHelp = $state(false);
  trashOpen = $state(false);
  menu = $state<MenuState | null>(null);
  iconPicker = $state<IconPickerState | null>(null);
  filePicker = $state<FilePickerState | null>(null);
  tagPicker = $state<TagPickerState | null>(null);
  /** Quick Capture; the text it opens with. */
  capture = $state<{ text: string } | null>(null);
  confirmState = $state<ConfirmState | null>(null);
  assignmentSheet = $state<SheetState<AssignmentPatch> | null>(null);
  eventSheet = $state<SheetState<EventPatch> | null>(null);
  /** File shown in the preview sheet. */
  filePreview = $state<string | null>(null);
  /** Calendar file being imported. */
  importSheet = $state<{ name: string; items: IcsItem[] } | null>(null);
  /** A flashcard study session. */
  study = $state<{ title: string; cards: Card[] } | null>(null);
  /** A database formula being written. */
  formula = $state<{ dbId: string; propId: string } | null>(null);
  /** Choosing how to start a new database (inside `parentId`, or on its own). */
  /** The sign-in and profile sheet. */
  accountSheet = $state(false);
  /** The page whose live session panel is open. */
  liveSheet = $state<string | null>(null);
  /** The page a friend is being invited to. */
  inviteSheet = $state<string | null>(null);
  newDatabase = $state<{ parentId: string | null; onCreated?: (id: string) => void } | null>(null);
  toasts = $state<Toast[]>([]);
  /** Page whose title should take focus once shown (new page, "Rename"). */
  focusTitle = $state<string | null>(null);
  #toastId = 0;

  get anyModalOpen() {
    return (
      this.searchOpen ||
      this.settingsOpen ||
      this.shortcutsHelp ||
      this.trashOpen ||
      this.confirmState !== null ||
      this.assignmentSheet !== null ||
      this.eventSheet !== null ||
      this.filePreview !== null ||
      this.importSheet !== null ||
      this.study !== null ||
      this.formula !== null ||
      this.newDatabase !== null ||
      this.liveSheet !== null ||
      this.inviteSheet !== null ||
      this.accountSheet ||
      this.capture !== null
    );
  }

  openMenu(state: MenuState) {
    // Let a menu that's being replaced clean up (e.g. un-highlight its row).
    this.menu?.onClose?.();
    this.menu = state;
  }

  openMenuAt(anchor: Element, items: MenuItem[], opts: { alignRight?: boolean; onClose?: () => void } = {}) {
    const r = anchor.getBoundingClientRect();
    this.openMenu({
      x: opts.alignRight ? r.right : r.left,
      y: r.bottom + 6,
      items,
      alignRight: opts.alignRight,
      onClose: opts.onClose,
    });
  }

  closeMenu() {
    const m = this.menu;
    this.menu = null;
    m?.onClose?.();
  }

  pickFile(anchor: Element | DOMRect, onPick: (files: FileMeta[]) => void, opts: { exclude?: string[]; multiple?: boolean } = {}) {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    this.filePicker = { x: r.left, y: r.bottom + 6, onPick, ...opts };
  }

  pickTags(anchor: Element, table: TrashTable, id: string) {
    const r = anchor.getBoundingClientRect();
    this.tagPicker = { x: r.left, y: r.bottom + 6, table, id };
  }

  pickIcon(anchor: Element | DOMRect, onPick: (icon: string) => void, onRemove?: () => void, current?: string) {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    this.iconPicker = { x: r.left, y: r.bottom + 6, onPick, onRemove, current };
  }

  confirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmState = {
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? t('app.confirm'),
        danger: opts.danger ?? false,
        resolve,
      };
    });
  }

  /** Asks for a line of text (and optionally a colour). Null when cancelled. */
  prompt(opts: {
    title: string;
    message?: string;
    value?: string;
    placeholder?: string;
    confirmLabel?: string;
    icon?: string;
    color?: string;
    /** Select the whole value, or just the name before the extension. */
    select?: 'all' | 'stem';
  }): Promise<{ value: string; color: string } | null> {
    return new Promise((resolve) => {
      this.confirmState = {
        title: opts.title,
        message: opts.message ?? '',
        confirmLabel: opts.confirmLabel ?? t('common.actions.save'),
        danger: false,
        icon: opts.icon ?? 'pencil',
        input: { value: opts.value ?? '', placeholder: opts.placeholder ?? '', select: opts.select ?? 'all' },
        color: opts.color,
        resolve: (ok, value, color) => resolve(ok && value?.trim() ? { value: value.trim(), color: color ?? '' } : null),
      };
    });
  }

  toast(message: string, action?: { label: string; run: () => void }, ms = 4500) {
    const id = ++this.#toastId;
    this.toasts.push({ id, message, actionLabel: action?.label, action: action?.run });
    if (this.toasts.length > 3) this.toasts.shift();
    // In another window: the toast waits, and its time starts when you're back.
    const time = () => setTimeout(() => this.dismissToast(id), ms);
    if (document.hasFocus()) time();
    else window.addEventListener('focus', time, { once: true });
    return id;
  }

  /** Changes what a toast that's still showing says (progress). */
  retoast(id: number, message: string) {
    const toast = this.toasts.find((x) => x.id === id);
    if (toast) toast.message = message;
  }

  dismissToast(id: number) {
    const i = this.toasts.findIndex((x) => x.id === id);
    if (i >= 0) this.toasts.splice(i, 1);
  }

  error(e: unknown) {
    console.error(e);
    this.toast(typeof e === 'string' ? e : e instanceof Error ? e.message : t('app.somethingWentWrong'));
  }
}

export const ui = new UI();
