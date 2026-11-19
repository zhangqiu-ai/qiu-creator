import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, type Page } from '@playwright/test';
import { FakeAiServer } from '../../services/mac-server/test/fake-ai.js';
import {
  makeTempHome,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from '../../services/mac-server/test/helpers.js';

const requireMacDependency = createRequire(new URL('../../apps/mac/package.json', import.meta.url));
const entry = fileURLToPath(new URL('./electron-entry.mjs', import.meta.url));

interface Desktop {
  page: Page;
  backend: TestServer;
  upstream: FakeAiServer;
}

export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const resources = new AsyncDisposableStack();
    try {
      const home = makeTempHome();
      resources.defer(() => rm(home, { recursive: true, force: true }));

      const upstream = new FakeAiServer();
      resources.defer(() => upstream.stop());
      await upstream.start();
      // Reuse the service test harness for MemorySecretStore and loopback ports.
      const backend = await startTestServer({ home, ai: { baseUrls: upstream.baseUrls() } });
      resources.defer(() => backend.close());

      const executablePath: unknown = requireMacDependency('electron');
      if (typeof executablePath !== 'string') throw new Error('Missing workspace Electron binary');
      const profile = path.join(home, 'electron-profile');
      await mkdir(profile);
      const address = new URL(backend.baseUrl);
      const app = await playwright._electron.launch({
        executablePath,
        args: [entry],
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          CREATORHUB_HOME: home,
          CREATORHUB_HOST: address.hostname,
          CREATORHUB_PORT: address.port,
          CREATORHUB_TOKEN: TEST_TOKEN,
          CREATORHUB_E2E_PROFILE: profile,
        },
      });
      resources.defer(() => app.close());
      // Playwright Test records the spec steps but leaves Electron context tracing to the fixture.
      const tracing = app.context().tracing;
      await tracing.start({ screenshots: true, snapshots: true });
      resources.defer(async () => {
        if (testInfo.status === testInfo.expectedStatus) {
          await tracing.stop();
          return;
        }
        const trace = testInfo.outputPath('electron-trace.zip');
        await tracing.stop({ path: trace });
        await testInfo.attach('Electron trace', { path: trace, contentType: 'application/zip' });
      });
      await use({ page: await app.firstWindow(), backend, upstream });
    } finally {
      await resources.disposeAsync();
    }
  },
});
