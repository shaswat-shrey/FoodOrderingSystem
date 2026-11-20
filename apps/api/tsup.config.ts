import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript sources, so they are bundled in.
  // Third-party dependencies stay external and are resolved from node_modules.
  noExternal: [/^@fos\//],
  // Dependencies of bundled workspace packages must stay external too (Prisma loads
  // its query engine from disk) and are therefore also declared in this package.json.
  external: ['@prisma/client'],
});
