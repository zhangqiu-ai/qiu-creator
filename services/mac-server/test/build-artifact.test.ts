import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@qiu-creator/api-client';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServerArtifact } from '../scripts/build.js';
import { pngBytes } from './fixtures.js';
import { makeTempHome, TEST_TOKEN } from './helpers.js';

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

function symlinks(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

describe('standalone build artifact (QC-030)', () => {
  // Bundles the server, copies native modules and Node (~200 MB), then starts it in another
  // folder: far longer than the 5 s default for unit tests.
  it(
    'runs from any folder without tsx or the repository, with native modules and build info',
    { timeout: 120_000 },
    async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-build-'));
      temps.push(work);
      const built = path.join(work, 'dist');
      const { commit } = await buildServerArtifact(built);
      // "Install": copy to a folder outside the repo, like ~/Library/Application Support/qiu-creator/server.
      const installed = path.join(work, 'Application Support', 'qiu-creator', 'server');
      fs.cpSync(built, installed, { recursive: true });
      fs.rmSync(built, { recursive: true, force: true });

      expect(symlinks(installed)).toEqual([]);
      const modules = fs.readdirSync(path.join(installed, 'node_modules'));
      expect(modules).toContain('better-sqlite3');
      expect(modules).not.toContain('tsx');
      expect(modules).not.toContain('@qiu-creator');
      expect(fs.existsSync(path.join(installed, 'bin', 'node'))).toBe(true);

      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      expect(commit?.startsWith(head)).toBe(true);

      // The keyring addon loads (nothing is read from the Keychain).
      const loaded = execFileSync(
        path.join(installed, 'bin', 'node'),
        ['-e', "import('@napi-rs/keyring').then((m) => console.log(typeof m.Entry))"],
        { cwd: installed, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
      ).trim();
      expect(loaded).toBe('function');

      const home = makeTempHome();
      temps.push(home);
      const port = await freePort();
      const proc = spawn(path.join(installed, 'bin', 'node'), ['server.mjs'], {
        cwd: installed,
        // A launchd-like environment: no PATH to the repo, no NODE_PATH, no tsx.
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          CREATORHUB_HOME: home,
          CREATORHUB_PORT: String(port),
          CREATORHUB_TOKEN: TEST_TOKEN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      proc.stdout.on('data', (d: Buffer) => (log += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (log += d.toString()));
      try {
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        for (let i = 0; i < 200 && !log.includes('mac-server ready'); i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(log).toContain('mac-server ready');
        const client = createClient({ baseUrl, token: TEST_TOKEN });
        expect(await client.health()).toEqual({
          status: 'ok',
          service: 'creatorhub-mac-server',
          version: expect.any(String) as string,
          commit,
          built_at: expect.any(String) as string,
        });
        // SQLite (better-sqlite3) and thumbnails (sharp) work from the copied modules.
        const created = await client.works.create({ title: '安裝版', markdown: '# 可用\n' });
        expect((await client.works.get(created.id)).title).toBe('安裝版');
        const { asset } = await client.assets.upload({
          filename: 'a.png',
          data: await pngBytes(64, 48),
        });
        let thumb = asset.thumbnail_status;
        for (let i = 0; i < 200 && thumb !== 'ready' && thumb !== 'failed'; i++) {
          await new Promise((r) => setTimeout(r, 25));
          thumb = (await client.assets.get(asset.id)).thumbnail_status;
        }
        expect(thumb).toBe('ready');
        expect((await fetch(`${baseUrl}/docs/`)).status).toBe(200);
      } finally {
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          proc.once('exit', () => {
            resolve();
          });
        });
      }
      expect(log).not.toMatch(/Cannot find (module|package)/);
    },
  );
});
