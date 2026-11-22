/**
 * What the assistant is called. Kept apart from its logic (assistant.svelte.ts,
 * which brings its tools with it) so the sidebar and the title bar can use it
 * without loading any of that.
 */

/** What it is called until the person names it. */
export const DEFAULT_NAME = 'Socrates';
export const MAX_NAME = 24;

/** A name as it may be: one short line of plain text. */
export function cleanName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}
