/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    strictPort: true,
    // Same-origin API in development (mirrors the production reverse proxy).
    proxy: {
      '/api': API_TARGET,
      '/health': API_TARGET,
      '/socket.io': { target: API_TARGET, ws: true },
    },
  },
  preview: { port: 5175, strictPort: true },
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'] },
});
