import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The mailbox tests run inside the Workers runtime (real Durable Objects and R2,
// simulated locally). The sign-in tests (auth.test.ts) stay on Node's own runner.
// The local runtime has no jurisdictions, so the EU setting the deployed relay
// runs with (VAULT_JURISDICTION, see src/region.ts) is switched off here.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { VAULT_JURISDICTION: '' } } })],
  test: { include: ['test/*.spec.ts'] },
});
