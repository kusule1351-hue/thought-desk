/** Context menu for a library file, shared by Files, previews and pages. */

import { library, previewable } from './library.svelte';
import { ui, type MenuItem } from './ui.svelte';
import { t } from './i18n';

export async function renameFile(id: string) {
  const f = library.byId.get(id);
  if (!f) return;
  const res = await ui.prompt({ title: t('pages.file.renameTitle'), value: f.name, confirmLabel: t('common.actions.rename'), icon: 'file', select: 'stem' });
  if (res) await library.rename(id, res.value);
}

export function fileMenuItems(id: string, { preview = true } = {}): MenuItem[] {
  const f = library.byId.get(id);
  if (!f) return [];
  const items: MenuItem[] = [];
  if (preview) items.push({ label: previewable(f) ? t('pages.file.preview') : t('pages.file.getInfo'), icon: 'eye', action: () => library.preview(id) });
  items.push(
    { label: t('pages.file.openInDefaultApp'), icon: 'external', disabled: f.missing, action: () => void library.open(id) },
    { label: t('pages.showInFolder'), icon: 'folder', disabled: f.missing, action: () => void library.reveal(id) },
    { label: t('pages.file.saveCopy'), icon: 'download', disabled: f.missing, action: () => void library.saveCopy(id) },
    { separator: true },
    { label: t('pages.file.renameMenu'), icon: 'pencil', action: () => void renameFile(id) },
    { separator: true },
    { label: t('common.actions.moveToTrash'), icon: 'trash', danger: true, action: () => void library.trash(id) },
  );
  return items;
}
