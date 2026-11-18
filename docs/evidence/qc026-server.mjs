// QC-026 acceptance server: the REAL mac-server (request logger ON, like production) wired to
// the local fake providers from qc026-fakes.mjs. Keys live in a file under QC026_KEYS_DIR,
// a stand-in for the Keychain that survives a restart but is outside the data directory.
// The real Keychain is never touched and nothing leaves the machine.
// Writing <home>/restart-request makes the server kill itself with SIGKILL (a crash), so the
// driver can test "the service restarted while a job was running"; qc026-run.sh restarts it.
// Usage (from services/mac-server): CREATORHUB_HOME=<temp home> QC026_KEYS_DIR=<dir> node --import tsx ../../docs/evidence/qc026-server.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../services/mac-server/src/config.ts';
import { buildServer } from '../../services/mac-server/src/server.ts';

const home = process.env['CREATORHUB_HOME'] ?? '';
const keysDir = process.env['QC026_KEYS_DIR'] ?? '';
if (!path.basename(home).startsWith('qc026-home'))
  throw new Error('CREATORHUB_HOME must be a qc026-home* temp dir');
if (!path.basename(keysDir).startsWith('qc026-keys'))
  throw new Error('QC026_KEYS_DIR must be a qc026-keys* temp dir');

const fakes = JSON.parse(fs.readFileSync(path.join(home, 'fakes.json'), 'utf8'));
const keysFile = path.join(keysDir, 'keys.json');
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  } catch {
    return {};
  }
};
const secrets = {
  get: (p) => Promise.resolve(read()[p] ?? null),
  set: (p, v) => {
    fs.writeFileSync(keysFile, JSON.stringify({ ...read(), [p]: v }), { mode: 0o600 });
    return Promise.resolve();
  },
  delete: (p) => {
    const { [p]: removed, ...rest } = read();
    fs.writeFileSync(keysFile, JSON.stringify(rest), { mode: 0o600 });
    return Promise.resolve(removed !== undefined);
  },
};

const config = loadConfig();
const { app } = await buildServer({
  config,
  logger: true,
  ai: {
    secrets,
    baseUrls: fakes.baseUrls,
    retryBaseMs: 300,
    video: { chunkBytes: 256 * 1024, pollMs: 500, processingTimeoutMs: 120_000 },
  },
});

const restartFile = path.join(home, 'restart-request');
setInterval(() => {
  if (fs.existsSync(restartFile)) {
    fs.rmSync(restartFile);
    process.kill(process.pid, 'SIGKILL');
  }
}, 100);
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
await app.listen({ host: config.host, port: config.port });
console.log('qc026 server ready');
