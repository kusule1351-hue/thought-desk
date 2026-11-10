import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The mailbox tests run inside the Workers runtime (real Durable Objects and R2,
// simulated locally). The sign-in tests (auth.test.ts) stay on Node's own runner.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['test/*.spec.ts'] },
});
