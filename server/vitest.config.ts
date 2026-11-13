import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The mailbox tests run inside the Workers runtime (real Durable Objects and R2,
// simulated locally). The sign-in tests (auth.test.ts) stay on Node's own runner.
// The local runtime has no jurisdictions, so the EU setting the deployed relay
// runs with (VAULT_JURISDICTION, see src/region.ts) is switched off here.
// The mailbox tests are about the mailbox, so sync is open to every account in them; the
// tests of who gets in (src/access.ts) pass their own setting.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { VAULT_JURISDICTION: '', SYNC_ACCESS: 'everyone' } } })],
  test: { include: ['test/*.spec.ts'] },
});
