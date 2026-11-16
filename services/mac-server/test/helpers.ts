import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { buildServer, type CreatorHubServer } from '../src/index.js';

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

export async function startTestServer(): Promise<TestServer> {
  const home = makeTempHome();
  const server = await buildServer({ config: { home, token: TEST_TOKEN } });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  return {
    ...server,
    home,
    baseUrl: address,
    client: createClient({ baseUrl: address, token: TEST_TOKEN }),
    close: async () => {
      await server.app.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}
