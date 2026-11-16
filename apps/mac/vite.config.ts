import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { contentSecurityPolicy } from './src/main/csp.js';

/** file:// pages get no response headers, so the production CSP goes in a meta tag. */
function cspMeta(): Plugin {
  return {
    name: 'qc-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(null) },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), cspMeta()],
  server: { port: 5180, strictPort: true, host: 'localhost' },
  build: {
    outDir: path.join(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
