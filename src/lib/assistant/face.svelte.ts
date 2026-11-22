/**
 * The assistant's face, for the places that show it before (or without) the
 * assistant itself being loaded: the sidebar, the title bar. Nothing here
 * imports the assistant. Once it has been loaded, ui/keep-face.svelte.ts keeps
 * `face.mood` up to date; until then it simply looks idle.
 */

import { prefs } from '../prefs.svelte';
import { cleanName, DEFAULT_NAME } from './name';
import type { Mood } from './mood.svelte';

export const face = $state<{ mood: Mood; /** The person is typing to it. */ typing: boolean }>({ mood: 'idle', typing: false });

/** What the person calls it (the same as assistant.name). */
export function assistantName(): string {
  return cleanName(prefs.assistantName) || DEFAULT_NAME;
}
