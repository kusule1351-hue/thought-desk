/**
 * Sync is not ready yet: everything about it stays hidden unless a build sets
 * VITE_SYNC=1 or a test (or a curious person, from the console) sets
 * `window.__syncBeta = true`. Read each time, so turning it on needs no reload.
 */
export function syncAvailable(): boolean {
  return import.meta.env.VITE_SYNC === '1' || (window as unknown as { __syncBeta?: boolean }).__syncBeta === true;
}
