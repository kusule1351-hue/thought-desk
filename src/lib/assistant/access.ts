/**
 * What the assistant may see. A page the person marked as kept from it, and
 * everything inside that page, is never read, searched or changed by a tool;
 * nor is a note shared live with a friend (it holds the friend's writing),
 * unless the person allowed those in Settings. Every tool asks here.
 */

import { prefs } from '../prefs.svelte';
import { store } from '../store.svelte';
import { ToolError } from './types';

/** Whether a page is kept from the assistant (trashed and missing pages are too). */
export function keptFromAssistant(pageId: string): boolean {
  const page = store.untracked.get(pageId);
  if (!page || page.deletedAt) return true;
  if (page.sharedRoom && !prefs.assistantShared) return true;
  const hidden = prefs.assistantHidden;
  if (hidden[pageId]) return true;
  return store.ancestors(pageId).some((a) => hidden[a.id] || (a.sharedRoom && !prefs.assistantShared));
}

/** Whether the page itself is marked (not one it is inside). */
export const markedKept = (pageId: string) => !!prefs.assistantHidden[pageId];

export function setKept(pageId: string, kept: boolean) {
  if (kept) prefs.assistantHidden[pageId] = true;
  else delete prefs.assistantHidden[pageId];
}

/** The page a tool was pointed at, or the error the model is told. */
export function pageFor(id: unknown) {
  const page = typeof id === 'string' ? store.untracked.get(id) : undefined;
  if (!page || page.deletedAt) throw new ToolError(`There is no note with the id "${String(id)}". Use search_notes or list_notes to find the right id.`);
  if (keptFromAssistant(page.id)) throw new ToolError('This note is kept from the assistant by its owner. Do not try to read or change it; say so if it matters.');
  return page;
}
