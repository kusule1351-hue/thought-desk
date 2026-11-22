/**
 * Keeps face.mood (face.svelte.ts) in step with the assistant for as long as
 * the app runs, once the assistant has been loaded. Only the lazily loaded
 * panel and page import this, so none of it is in the start-up bundle.
 */

import { face } from '../face.svelte';
import { currentMood } from '../mood.svelte';

let started = false;
/** How long it waits, with nothing asked of it, before it looks bored. */
const BORED_AFTER = 45_000;

export function keepFace() {
  if (started) return;
  started = true;
  // Started a moment later, outside the component that asked: an effect made while a
  // component is being set up belongs to that component, and would stop when the panel closed.
  queueMicrotask(() => {
    $effect.root(() => {
      $effect(() => {
        const mood = currentMood(face.typing);
        face.mood = mood;
        if (mood !== 'idle') return;
        const timer = setTimeout(() => (face.mood = 'bored'), BORED_AFTER);
        return () => clearTimeout(timer);
      });
    });
  });
}
