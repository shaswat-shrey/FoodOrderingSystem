// Root ESLint flat config for the whole monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/generated/**',
      'docs/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      // NFR-SEC-005: raw SQL only through tagged templates.
      'no-restricted-properties': [
        'error',
        { property: '$queryRawUnsafe', message: 'Use $queryRaw tagged templates (NFR-SEC-005).' },
        {
          property: '$executeRawUnsafe',
          message: 'Use $executeRaw tagged templates (NFR-SEC-005).',
        },
      ],
      // NFR-MAINT-001: packages are consumed through their public entry points only.
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['@fos/*/src/*'], message: 'Import from the package entry point.' }],
        },
      ],
    },
  },
  {
    // NFR-MAINT-001: a backend module may only use another module through its index.ts.
    files: ['apps/api/src/modules/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // ../<other-module>/<anything but index> — the shared ../../platform and
              // ../../config layers stay importable.
              regex: '^\\.\\./(?!\\.\\.)[^/]+/(?!index(\\.js)?$).+',
              message: "Use the other module's public index.ts (NFR-MAINT-001).",
            },
            { group: ['@fos/*/src/*'], message: 'Import from the package entry point.' },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/*-web/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
      'packages/api-client/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
