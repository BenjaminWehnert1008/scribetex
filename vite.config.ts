import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The page may load code only from its own address. The one connect-src
 * exception is the optional GitHub backup that a user switches on themselves.
 * 'wasm-unsafe-eval' and blob: are what the LaTeX engine's worker needs.
 * Applied to production builds only, because the dev server injects inline scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https://api.github.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  };
}

/**
 * The engine downloads its `.data.gz` bundles and unpacks them itself, which
 * matches how GitHub Pages serves such files: as plain bytes. Vite's own
 * servers would instead label them `Content-Encoding: gzip` (dev) or compress
 * them a second time (preview), and the engine would then read garbage. This
 * plugin answers those requests itself, in `vite` and in `vite preview`.
 */
function serveEngineBundlesAsIs(): Plugin {
  let publicDir = '';
  let outDir = '';
  const handler =
    (baseDir: () => string): Connect.NextHandleFunction =>
    (req, res, next) => {
      const match = /\/engine\/([^?]+\.gz)(\?|$)/.exec(req.url ?? '');
      if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
      const engineDir = path.join(baseDir(), 'engine');
      const file = path.join(engineDir, decodeURIComponent(match[1]!));
      if (!file.startsWith(engineDir + path.sep)) return next();
      fs.stat(file, (error, stat) => {
        if (error || !stat.isFile()) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'no-cache');
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).pipe(res);
      });
    };
  return {
    name: 'serve-engine-bundles-as-is',
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer: (server) => void server.middlewares.use(handler(() => publicDir)),
    configurePreviewServer: (server) => void server.middlewares.use(handler(() => outDir)),
  };
}

// A relative base keeps the build working under any sub-path
// (https://<user>.github.io/<repo>/) without knowing the repository name.
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy(), serveEngineBundlesAsIs()],
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
