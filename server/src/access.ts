/**
 * Who may use sync. The app hides sync until it is ready, but the app is open
 * source: anyone can build one that shows it, sign in with their own account
 * and reach these routes. So the relay decides. Until sync is opened to
 * everyone, only the accounts the owner lists get in; everyone else is told
 * it is closed, and nothing of theirs is stored.
 *
 * Closed is the default: a missing or misspelt setting never opens it.
 */

export interface AccessEnv {
  /** "everyone" once sync is open. Anything else, or nothing, means testers only. */
  SYNC_ACCESS?: string;
  /** The Clerk user ids that may use sync meanwhile, comma-separated. Set as a
   *  secret (`npx wrangler secret put SYNC_TESTERS`), so the list is not in
   *  the repository and changing it needs no deploy. */
  SYNC_TESTERS?: string;
}

export function mayUseSync(sub: string, env: AccessEnv): boolean {
  if (env.SYNC_ACCESS === 'everyone') return true;
  return (env.SYNC_TESTERS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(sub);
}
