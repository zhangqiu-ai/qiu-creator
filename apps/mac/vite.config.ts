import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/*
 * No CSP meta tag in the build: the main process serves the renderer from
 * qc-app:// with a CSP header for the actual service address (QC-031). A
 * meta tag baked here would pin 127.0.0.1:7420 and, since both policies
 * apply, block a service on any other port.
 */

export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: { port: 5180, strictPort: true, host: 'localhost' },
  build: {
    outDir: path.join(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
