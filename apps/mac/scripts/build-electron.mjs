// Bundles the Electron main process and preload script into CommonJS files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function buildElectron() {
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'warning',
  };
  await Promise.all([
    build({
      ...common,
      entryPoints: [path.join(root, 'src/main/main.ts')],
      outfile: path.join(root, 'dist-electron/main.cjs'),
    }),
    build({
      ...common,
      entryPoints: [path.join(root, 'src/preload/preload.ts')],
      outfile: path.join(root, 'dist-electron/preload.cjs'),
    }),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildElectron();
}
