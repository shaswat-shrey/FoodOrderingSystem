import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace packages (@fos/*) ship TypeScript sources, so they are bundled in.
  // Every third-party package stays external and is resolved from node_modules at
  // runtime — including dependencies of bundled workspace packages, which must
  // therefore be declared in this app's package.json too.
  noExternal: [/^@fos\//],
  external: [/^(?!@fos\/)[^./]/],
});
