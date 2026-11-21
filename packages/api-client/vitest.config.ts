import { defineConfig } from 'vitest/config';

const THRESHOLDS = { statements: 32, branches: 77, functions: 27, lines: 32 };

export default defineConfig({
  test: {
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
