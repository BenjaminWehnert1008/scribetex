import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// A relative base keeps the build working under any sub-path
// (https://<user>.github.io/<repo>/) without knowing the repository name.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See src/core/engine/blake3-disabled.ts.
      'blake3-wasm/browser.js': fileURLToPath(new URL('./src/core/engine/blake3-disabled.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    restoreMocks: true,
  },
});
