/**
 * Everything about the assistant stays hidden unless a build sets
 * VITE_ASSISTANT=1, which released builds do (.github/workflows/release.yml).
 * While developing, and in the interface tests,
 * setting `window.__assistantBeta = true` turns it on too (read each time, so
 * it needs no reload). A released build ignores that. The same rule as sync's
 * (sync/flag.ts).
 */
export function assistantAvailable(): boolean {
  if (import.meta.env.VITE_ASSISTANT === '1') return true;
  return import.meta.env.DEV && (window as unknown as { __assistantBeta?: boolean }).__assistantBeta === true;
}
