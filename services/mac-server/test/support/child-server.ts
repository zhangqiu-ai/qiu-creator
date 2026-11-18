/**
 * A real server process for crash tests (QC-030): the test SIGKILLs it and
 * starts it again on the same home. Test-only: fake DNS and connect override
 * point URL imports at the test's local upstream, AI at a local fake, and
 * keys live in a JSON file in the temp home so they survive the kill.
 * Never the real Keychain, ~/CreatorHub or caffeinate.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AiProvider } from '@qiu-creator/contracts';
import type { SecretStore } from '../../src/ai/secret-store.js';
import { noWakeLocks } from '../../src/power/sleep-guard.js';
import { buildServer } from '../../src/server.js';

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};

const home = env('CHILD_HOME');
if (!home.includes('creatorhub-test-')) throw new Error('refusing a home that is not a test home');

class FileSecretStore implements SecretStore {
  private readonly file = path.join(home, 'test-secrets.json');
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(provider: AiProvider): Promise<string | null> {
    return Promise.resolve(this.read()[provider] ?? null);
  }
  set(provider: AiProvider, value: string): Promise<void> {
    fs.writeFileSync(this.file, JSON.stringify({ ...this.read(), [provider]: value }));
    return Promise.resolve();
  }
  delete(provider: AiProvider): Promise<boolean> {
    const all = this.read();
    const had = provider in all;
    const { [provider]: _gone, ...rest } = all;
    fs.writeFileSync(this.file, JSON.stringify(rest));
    return Promise.resolve(had && _gone !== undefined);
  }
}

const upstreamPort = Number(env('CHILD_UPSTREAM_PORT'));
const { app } = await buildServer({
  config: { home, token: env('CHILD_TOKEN') },
  ffprobe: null,
  backups: { schedule: false },
  sleep: { provider: noWakeLocks },
  jobs: { pollMs: 5, retryBaseMs: 1 },
  download: {
    resolver: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    connectOverride: () => ({ host: '127.0.0.1', port: upstreamPort }),
    connectTimeoutMs: 2000,
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 60_000,
  },
  ai: {
    secrets: new FileSecretStore(),
    baseUrls: { openai: env('CHILD_OPENAI') },
    retryBaseMs: 10,
    pollMs: 10,
    timeoutMs: 60_000,
  },
});
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
process.stdout.write(`READY ${address}\n`);
