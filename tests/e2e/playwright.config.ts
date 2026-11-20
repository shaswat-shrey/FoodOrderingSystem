import { defineConfig, devices } from '@playwright/test';
import { E2E } from './support/env';

/**
 * Full-stack end-to-end suite (AC-E2E-001…009, AC-NFR-002). Global setup migrates
 * and seeds a dedicated `*_e2e` database, then starts the API, the worker and the
 * four built apps on their own ports (support/env.ts); teardown stops them.
 *
 *   pnpm --filter @fos/e2e e2e                 everything
 *   E2E_REUSE_STACK=1 pnpm --filter @fos/e2e e2e journey
 *       reuse a stack left running (see tests/e2e/README.md), no setup
 *
 * The journeys share one database, partners and restaurants, so they run one at a
 * time (workers: 1). Accessibility and shell checks also run on a phone viewport.
 */
export default defineConfig({
  testDir: './specs',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  globalSetup: process.env.E2E_REUSE_STACK ? undefined : './support/global-setup.ts',
  use: {
    baseURL: E2E.apps.customer,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      testMatch: /(a11y|shell)\.spec\.ts$/,
    },
  ],
});
