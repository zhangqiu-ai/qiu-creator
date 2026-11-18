import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { MemorySecretStore } from '../src/ai/secret-store.js';
import { noWakeLocks } from '../src/power/sleep-guard.js';
import { buildServer, type BuildServerOptions, type CreatorHubServer } from '../src/index.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface TestServer extends CreatorHubServer {
  home: string;
  baseUrl: string;
  client: CreatorHubClient;
  close: () => Promise<void>;
}

/** Make a throwaway CREATORHUB_HOME; never the real ~/CreatorHub. */
export function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-test-'));
}

export interface StartOptions extends Omit<BuildServerOptions, 'config'> {
  /** Reuse an existing home (restart scenarios); it is then not deleted on close. */
  home?: string;
}

/**
 * Start a server on a random port with a temp home. ffprobe is disabled
 * unless a test passes one, so results never depend on the machine.
 */
export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const { home: reuse, ...rest } = options;
  const home = reuse ?? makeTempHome();
  const server = await buildServer({
    ffprobe: null,
    // No daily backup timer unless a test asks for one (QC-030).
    backups: { schedule: false },
    // Never the real caffeinate in tests.
    sleep: { provider: noWakeLocks },
    ...rest,
    // Never the real Keychain. Provider adapters only reach the network when a test stores
    // a key, and those tests point them at local fake servers.
    ai: { secrets: new MemorySecretStore(), ...rest.ai },
    config: { home, token: TEST_TOKEN },
  });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  return {
    ...server,
    home,
    baseUrl: address,
    client: createClient({ baseUrl: address, token: TEST_TOKEN }),
    close: async () => {
      await server.app.close();
      if (reuse === undefined) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}
