import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Integration tests run against TEST_DATABASE_URL (never DATABASE_URL), which is
// wiped and rebuilt from the migrations in globalSetup.
const env = loadEnv('test', new URL('../..', import.meta.url).pathname, '');
// Set on this process so both globalSetup and the test workers see the same value.
process.env.TEST_DATABASE_URL ??= env.TEST_DATABASE_URL ?? '';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
