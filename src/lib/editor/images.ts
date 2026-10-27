import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { fileUrl } from '../api';
import { t } from '../i18n';
import { library, pickFiles } from '../library.svelte';
import { ui } from '../ui.svelte';
import type { FileMeta } from '../types';

const MAX_IMAGE_MB = 25;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

export async function pickImageFile(): Promise<File | null> {
  return (await pickFiles({ multiple: false, accept: 'image/*' }))[0] ?? null;
}

/** The node that shows a library file in a page: images inline, others as cards. */
export function fileNode(f: FileMeta) {
  return f.mime.startsWith('image/')
    ? { type: 'image', attrs: { src: fileUrl(f.stored), alt: f.name.replace(/\.[^.]+$/, '') } }
    : { type: 'fileBlock', attrs: { id: f.id } };
}

/** Inserts library files at `pos` (or the selection). */
export function insertFiles(editor: Editor, files: FileMeta[], pos?: number) {
  if (editor.isDestroyed || !files.length) return;
  const nodes = files.map(fileNode);
  if (pos === undefined) editor.chain().focus().insertContent(nodes).run();
  else editor.chain().focus().insertContentAt(pos, nodes).run();
}

/** Adds files from the computer to the library and inserts them. */
export async function insertUploads(editor: Editor, files: File[], pos?: number) {
  const ok = files.filter((f) => {
    if (f.type.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
      ui.toast(t('blocks.images.tooLarge', { size: t('common.units.megabytes', { size: MAX_IMAGE_MB }) }));
      return false;
    }
    return true;
  });
  insertFiles(editor, await library.add(ok), pos);
}

/** Saves an image into the library and inserts it at `pos`. */
export async function insertImage(editor: Editor, file: File, pos?: number) {
  if (file.type.startsWith('image/')) await insertUploads(editor, [file], pos);
}

/** Handles files pasted or dropped into the editor: images and any other file. */
export const ImageDrop = Extension.create({
  name: 'imageDrop',
  addProseMirrorPlugins() {
    const editor = this.editor;
    const files = (list?: FileList | null) => Array.from(list ?? []);
    return [
      new Plugin({
        key: new PluginKey('imageDrop'),
        props: {
          handlePaste(_view, event) {
            const list = files(event.clipboardData?.files);
            if (list.length === 0) return false;
            event.preventDefault();
            void insertUploads(editor, list);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const list = files(event.dataTransfer?.files);
            if (list.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertUploads(editor, list, at);
            return true;
          },
        },
      }),
    ];
  },
});
