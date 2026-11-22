/**
 * The editors showing a page right now. A change to a page that doesn't come
 * from typing (the assistant's) goes through its open editor when it has one:
 * it then saves, syncs and undoes exactly like typing, and what is on screen
 * is what is stored.
 */

import type { Editor } from '@tiptap/core';

const open = new Map<string, Set<Editor>>();

/** Lists an editor under its page; the function returned takes it off again. */
export function registerEditor(pageId: string, editor: Editor): () => void {
  let set = open.get(pageId);
  if (!set) open.set(pageId, (set = new Set()));
  set.add(editor);
  return () => {
    set.delete(editor);
    if (!set.size && open.get(pageId) === set) open.delete(pageId);
  };
}

/** Every live editor showing the page (two, when it is open on both sides of split view). */
export function editorsOf(pageId: string): Editor[] {
  return [...(open.get(pageId) ?? [])].filter((e) => !e.isDestroyed);
}
