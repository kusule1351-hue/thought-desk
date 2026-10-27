// The interface tests: they run the app in Chromium against the in-browser
// stand-in for the Rust side (src/dev-mock.ts) and use it like a person would.
//
//   npm run e2e                      every test
//   npm run e2e -- tests/e2e/math    one area
//   npm run e2e -- --ui              watch them run, step by step
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1280, height: 820 },
    // The tests find things by their English names: the interface follows the
    // system's language, so it's pinned to English whatever the machine runs.
    locale: 'en-US',
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } } }],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:1420',
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      // The live-session relay (server/) in test mode: it lets the fake cloud's
      // sign-ins in, on localhost only. Port 8788, apart from one you run by hand.
      command: 'npm --prefix server run test-relay',
      url: 'http://localhost:8788',
      reuseExistingServer: !CI,
      timeout: 90_000,
      env: { WRANGLER_SEND_METRICS: 'false' },
    },
  ],
});
