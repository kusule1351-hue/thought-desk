/**
 * Sync's front door, small on purpose: everything else (the engine, the
 * mailbox, the documents) is loaded with `import()` only when sync is on, so
 * a person without it pays nothing. Call `syncAvailable()` before anything.
 */

import { untrack } from 'svelte';
import { account } from '../account.svelte';
import { api } from '../api';
import { syncAvailable } from './flag';
import { syncState } from './state.svelte';

let loading: Promise<typeof import('./engine.svelte')> | null = null;

/** The engine, loaded on first use. */
export function loadEngine(): Promise<typeof import('./engine.svelte')> {
  return (loading ??= import('./engine.svelte'));
}

let following: string | null = null;

async function follow(id: string | null) {
  following = id;
  if (!id) {
    if (loading) (await loading).engine.follow(null);
    else syncState.status = 'off';
    return;
  }
  // Only when sync is on for this account here is anything loaded.
  if (!loading) {
    const st = await api.syncStatus().catch(() => null);
    if (following !== id) return;
    if (!st?.enabled || st.account !== id) {
      syncState.status = 'off';
      return;
    }
  }
  const { engine } = await loadEngine();
  if (following === id) await engine.follow(id);
}

/** Follows whoever is signed in: starts syncing if sync is on for them on this computer. */
export function initSync() {
  if (!syncAvailable()) return;
  $effect.root(() => {
    $effect(() => {
      const id = account.user?.id ?? null;
      untrack(() => void follow(id));
    });
  });
}
