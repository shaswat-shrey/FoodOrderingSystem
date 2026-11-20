import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite against the production build of the customer app (vite preview,
 * which proxies /api to localhost:4000). Specs named *.fullstack.spec.ts also
 * need the API and worker and only run with E2E_FULL_STACK=1. The complete
 * AC-E2E-* journeys arrive in Phase 12 with the Docker Compose stack.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm --filter @fos/customer-web build && pnpm --filter @fos/customer-web preview',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
