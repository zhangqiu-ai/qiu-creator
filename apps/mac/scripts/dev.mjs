// Development: Vite renderer on 5180 + Electron pointed at it.
// The Mac service is NOT started here; run `corepack pnpm dev` at the repo root.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer } from 'vite';
import { buildElectron } from './build-electron.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (!process.env.CREATORHUB_HOME) {
  console.error('CREATORHUB_HOME is not set. Use the same temporary directory as the dev service.');
  process.exit(1);
}

await buildElectron();
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5180/';

// Extra arguments go to Electron, e.g. `--remote-debugging-port=9333` for automated checks.
const child = spawn(String(electronPath), [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', (code) => {
  void server.close().then(() => process.exit(code ?? 0));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
