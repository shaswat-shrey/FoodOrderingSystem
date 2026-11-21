import { defineConfig } from 'vitest/config';

const THRESHOLDS = { statements: 93, branches: 88, functions: 89, lines: 93 };

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Just below the measured values (Phase 13); raise as coverage grows.
      thresholds: THRESHOLDS,
    },
  },
});
