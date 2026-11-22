import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { FakeAiServer } from '../../services/mac-server/test/fake-ai.js';
import { FakeGeminiVideo } from '../../services/mac-server/test/fake-gemini-video.js';
import {
  makeTempHome,
  startTestServer,
  TEST_TOKEN,
  type TestServer,
} from '../../services/mac-server/test/helpers.js';

const requireMacDependency = createRequire(new URL('../../apps/mac/package.json', import.meta.url));
const entry = fileURLToPath(new URL('./electron-entry.mjs', import.meta.url));

/** Stands in for macOS's /usr/bin/trash: e2e never touches the user's real Trash (QC-037). */
export interface FakeSystemTrash {
  /** Absolute paths "moved to the Trash", in order. */
  moved: string[];
  moveToTrash(absPath: string): Promise<void>;
}

interface Desktop {
  page: Page;
  /** The Electron app, for main-process checks such as the menu bar (QC-042). */
  app: ElectronApplication;
  /** userData of this run (holds preferences.json). */
  profile: string;
  backend: TestServer;
  upstream: FakeAiServer;
  /** Local stand-in for Gemini video understanding (QC-046). */
  geminiVideo: FakeGeminiVideo;
  systemTrash: FakeSystemTrash;
  /**
   * Quit the app and start it again on the same profile and service (QC-047:
   * tabs restored on the next launch). `page` and `app` above stay the first
   * launch's; use the returned ones.
   */
  relaunch: () => Promise<{ page: Page; app: ElectronApplication }>;
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
      const trashDir = path.join(home, 'fake-system-trash');
      await mkdir(trashDir);
      const systemTrash: FakeSystemTrash = {
        moved: [],
        async moveToTrash(absPath) {
          await rename(
            absPath,
            path.join(trashDir, `${String(this.moved.length)}-${path.basename(absPath)}`),
          );
          this.moved.push(absPath);
        },
      };
      // QC-046: Gemini video understanding goes to a local fake (Files API and
      // generateContent); no spec uses Gemini text, so all Gemini traffic goes there.
      const geminiVideo = new FakeGeminiVideo();
      resources.defer(() => geminiVideo.stop());
      await geminiVideo.start();
      // Reuse the service test harness for MemorySecretStore and loopback ports.
      const backend = await startTestServer({
        home,
        ai: {
          baseUrls: { ...upstream.baseUrls(), gemini: geminiVideo.baseUrl() },
          retryBaseMs: 10,
          video: { chunkBytes: 256 * 1024, pollMs: 20, processingTimeoutMs: 5000 },
        },
        assetLibrary: { trash: systemTrash },
      });
      resources.defer(() => backend.close());

      const executablePath: unknown = requireMacDependency('electron');
      if (typeof executablePath !== 'string') throw new Error('Missing workspace Electron binary');
      const profile = path.join(home, 'electron-profile');
      await mkdir(profile);
      // Specs find elements by the 繁體中文 source text (QC-042): pin the language,
      // since a fresh profile follows macOS, which may prefer English.
      await writeFile(
        path.join(profile, 'preferences.json'),
        `${JSON.stringify({ language: 'zh-Hant' })}\n`,
      );
      const address = new URL(backend.baseUrl);
      const launch = () =>
        playwright._electron.launch({
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
            // QC-060: no Dock icon, no focus, no native dialogs, no Finder.
            CREATORHUB_E2E_BACKGROUND: '1',
          },
        });
      const app = await launch();
      let current: ElectronApplication = app;
      resources.defer(() => current.close());
      // Playwright Test records the spec steps but leaves Electron context tracing to the fixture.
      const tracing = app.context().tracing;
      await tracing.start({ screenshots: true, snapshots: true });
      resources.defer(async () => {
        // After relaunch() the traced launch is already closed and its trace gone.
        if (current !== app) return;
        if (testInfo.status === testInfo.expectedStatus) {
          await tracing.stop();
          return;
        }
        const trace = testInfo.outputPath('electron-trace.zip');
        await tracing.stop({ path: trace });
        await testInfo.attach('Electron trace', { path: trace, contentType: 'application/zip' });
      });
      const relaunch = async () => {
        await current.close();
        current = await launch();
        return { page: await current.firstWindow(), app: current };
      };
      await use({
        page: await app.firstWindow(),
        app,
        profile,
        backend,
        upstream,
        geminiVideo,
        systemTrash,
        relaunch,
      });
    } finally {
      await resources.disposeAsync();
    }
  },
});
