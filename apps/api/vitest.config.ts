import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Unit tests need nothing; integration tests (test/**) need TEST_DATABASE_URL and
// TEST_REDIS_URL and are skipped with a warning when they are missing.
const env = loadEnv('test', new URL('../..', import.meta.url).pathname, '');
process.env.TEST_DATABASE_URL ??= env.TEST_DATABASE_URL ?? '';
process.env.TEST_REDIS_URL ??= env.TEST_REDIS_URL ?? '';

const THRESHOLDS = { statements: 92, branches: 80, functions: 93, lines: 92 };

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/index.ts', 'src/server.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Just below the measured values (Phase 13); raise as coverage grows.
      thresholds: THRESHOLDS,
    },
  },
});
