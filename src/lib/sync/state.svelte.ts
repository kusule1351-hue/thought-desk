/**
 * What the rest of the app may know about sync without loading it: the
 * engine (engine.svelte.ts, loaded only when sync is on) writes here, and
 * Settings, the meter and the editor read.
 */

import { syncAvailable } from './flag';

/** Every account gets this much sync storage for free, for good. */
export const FREE_SYNC_BYTES = 1024 ** 3;

export interface SyncUsage {
  used: number;
  limit: number;
}

/**
 * off: sync isn't on for this account on this computer.
 * locked: it is, but the key isn't here (a recovery key is needed again).
 * setup: turning on; the first whole cycle isn't done.
 * idle / syncing: working. offline: will catch up. paused-clock: this computer's clock is far off.
 * full: the account's storage is full (downloads go on). needs-update: a newer app wrote something this one can't read.
 * copy-gone: the synced copy this computer belongs to was deleted (and maybe replaced), so nothing goes up or comes down.
 * signed-out: the sign-in was refused; it waits for a sign-in.
 * error: something else went wrong; it tries again.
 */
export type SyncStatusName = 'off' | 'locked' | 'setup' | 'idle' | 'syncing' | 'offline' | 'paused-clock' | 'full' | 'needs-update' | 'copy-gone' | 'signed-out' | 'error';

type Hook = SyncUsage | 'error' | 'loading' | undefined;

/** Tests' fixed numbers (`window.__syncUsage`): development builds only. */
const testHook = () => (import.meta.env.DEV ? (window as unknown as { __syncUsage?: Hook }).__syncUsage : undefined);

/** The storage in use: tests drive it with `window.__syncUsage`; with sync off, nothing is asked and the free storage is shown. */
async function fetchUsage(): Promise<SyncUsage> {
  const hook = testHook();
  if (hook === 'error') throw new Error('sync usage unavailable');
  if (hook === 'loading') return await new Promise<SyncUsage>(() => {});
  if (hook) return hook;
  if (syncState.usage || syncState.status === 'off' || !syncAvailable()) return syncState.usage ?? { used: 0, limit: FREE_SYNC_BYTES };
  const { info } = await import('./client');
  const { used, limit } = await info();
  return { used, limit };
}

class SyncState {
  /** Null until the first answer. */
  usage = $state<SyncUsage | null>(null);
  /** An answer is on its way. */
  loading = $state(false);
  /** The last try failed (the old numbers, if any, stay). */
  failed = $state(false);
  status = $state<SyncStatusName>('off');
  /** When a cycle last got all the way through (ms), or null. */
  lastSynced = $state<number | null>(null);
  /** Why the status is `error`, when it is more than "something went wrong". */
  reason = $state<'' | 'conflicts'>('');
  /** Items that couldn't be read or applied on this computer (kept, or set aside): a quiet line in Settings. */
  unreadable = $state(0);
  /** A copy of the notes from before sync was turned on is kept on this computer. */
  backup = $state(false);
  /** Sync is on, the key is here and the first whole cycle is done: editors bind to documents. */
  ready = $state(false);
  /** Bumped when editors must be built again (sync became ready, was turned off, or a page was rebuilt). */
  generation = $state(0);
  /** A sentence about what turning on is doing, while it is. */
  progress = $state('');
  /** Pages open in an editor that isn't bound to a document (and how many editors). The engine leaves their incoming text alone until they rebind. */
  plain = new Map<string, number>();
  #run = 0;

  holdPlain(id: string) {
    this.plain.set(id, (this.plain.get(id) ?? 0) + 1);
  }

  releasePlain(id: string) {
    const n = (this.plain.get(id) ?? 1) - 1;
    if (n > 0) this.plain.set(id, n);
    else this.plain.delete(id);
  }

  /** Turning on isn't finished: the first whole cycle hasn't happened. */
  get settingUp(): boolean {
    return this.on && this.status !== 'locked' && !this.ready;
  }

  /** Sync is on for this account here, in any state. */
  get on(): boolean {
    return this.status !== 'off';
  }

  async refreshUsage() {
    const run = ++this.#run;
    this.loading = true;
    try {
      const usage = await fetchUsage();
      if (run !== this.#run) return;
      this.usage = usage;
      this.failed = false;
    } catch (e) {
      if (run !== this.#run) return;
      console.warn('Sync: could not read the storage in use', e);
      this.failed = true;
    } finally {
      if (run === this.#run) this.loading = false;
    }
  }

  /** The numbers from any answer that carries them. */
  note(usage: SyncUsage) {
    // A test's fixed numbers stay what they are.
    if (testHook()) return;
    this.usage = usage;
    this.failed = false;
  }
}

export const syncState = new SyncState();
