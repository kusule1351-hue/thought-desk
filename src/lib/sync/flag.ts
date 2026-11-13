/**
 * Sync is not ready yet: everything about it stays hidden unless a build sets
 * VITE_SYNC=1. While developing, and in the interface tests, setting
 * `window.__syncBeta = true` turns it on too (read each time, so it needs no
 * reload). A released build ignores that: nobody can switch unfinished sync on
 * from the console.
 */
export function syncAvailable(): boolean {
  if (import.meta.env.VITE_SYNC === '1') return true;
  return import.meta.env.DEV && (window as unknown as { __syncBeta?: boolean }).__syncBeta === true;
}
