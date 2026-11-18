// QC-031 acceptance server: the real mac-server (QC-030 backups) with an
// in-memory AI key store and providers that are never reached, so the
// Keychain is not touched and nothing is sent to any AI service.
// Usage (from services/mac-server):
//   CREATORHUB_HOME=<temp home> CREATORHUB_PORT=7555 QC031_RELOAD=in_process|restart \
//     npx tsx ../../docs/evidence/qc031-server.mjs
// `in_process` runs through startHost (a restore reloads the service in
// place, as in production); `restart` builds the server without a reload hook,
// so a restore answers `restart_required` and writes get 503 `restoring`.
// The daily backup check runs 3 s after start and then every 5 s.
import { ProviderError } from '../../services/mac-server/src/ai/provider.ts';
import { loadConfig } from '../../services/mac-server/src/config.ts';
import { startHost } from '../../services/mac-server/src/host.ts';
import { buildServer } from '../../services/mac-server/src/server.ts';

const home = process.env['CREATORHUB_HOME'] ?? '';
if (!home.includes('/tmp/')) throw new Error('CREATORHUB_HOME must be a temp dir');

/** @param {'anthropic' | 'gemini' | 'openai'} id */
const unreachable = (id) => ({
  id,
  generateText() {
    return Promise.reject(new ProviderError('provider_unavailable', 'not used in QC-031'));
  },
});

const values = new Map();
const secrets = {
  get: (p) => Promise.resolve(values.get(p) ?? null),
  set: (p, v) => {
    values.set(p, v);
    return Promise.resolve();
  },
  delete: (p) => Promise.resolve(values.delete(p)),
};

const config = loadConfig();
const options = {
  config,
  ai: {
    secrets,
    providers: {
      anthropic: unreachable('anthropic'),
      gemini: unreachable('gemini'),
      openai: unreachable('openai'),
    },
  },
  backups: { initialDelayMs: 3000, checkMs: 5000 },
};

let close;
if (process.env['QC031_RELOAD'] === 'restart') {
  const { app } = await buildServer(options);
  await app.listen({ host: config.host, port: config.port });
  close = () => app.close();
} else {
  const host = await startHost(options, { host: config.host, port: config.port }, (err) => {
    console.error('reload failed', err);
    process.exit(1);
  });
  close = () => host.close();
}
process.once('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
console.log(`qc031 server ready (${process.env['QC031_RELOAD'] ?? 'in_process'})`);
