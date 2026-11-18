import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { AI_NOTICE_VERSION, TUS_UPLOAD_PATH } from '@qiu-creator/contracts';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAiServer, ok } from './fake-ai.js';
import { mp4Bytes } from './fixtures.js';
import { makeTempHome, TEST_TOKEN } from './helpers.js';
import { serve, startUpstream } from './upstream.js';

const CHILD = fileURLToPath(new URL('./support/child-server.ts', import.meta.url));
const SERVER_DIR = path.dirname(path.dirname(CHILD));

const children: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const c of closers.splice(0)) await c();
});

interface Child {
  proc: ChildProcess;
  address: string;
  client: CreatorHubClient;
}

function spawnChild(env: Record<string, string>): Promise<Child> {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env, CHILD_TOKEN: TEST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let err = '';
  proc.stderr.on('data', (d: Buffer) => {
    err += d.toString();
  });
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /READY (\S+)/.exec(out);
      if (m?.[1] !== undefined) {
        resolve({
          proc,
          address: m[1],
          client: createClient({ baseUrl: m[1], token: TEST_TOKEN }),
        });
      }
    });
    proc.on('exit', (code) => {
      reject(new Error(`child exited (${String(code)}): ${err}`));
    });
  });
}

function sigkill(child: Child): Promise<void> {
  return new Promise((resolve) => {
    child.proc.once('exit', () => {
      resolve();
    });
    child.proc.kill('SIGKILL');
  });
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('crash recovery after SIGKILL (QC-030)', () => {
  // Two real server processes (each starts through tsx), so this needs more than the 5 s default.
  it(
    'committed writes, a tus upload, a URL import and an AI job all continue after kill -9',
    { timeout: 60_000 },
    async () => {
      const home = makeTempHome();
      closers.push(() => {
        fs.rmSync(home, { recursive: true, force: true });
        return Promise.resolve();
      });
      const fake = new FakeAiServer();
      await fake.start();
      closers.push(() => fake.stop());
      const up = await startUpstream();
      closers.push(() => up.close());
      const download = mp4Bytes(256 * 1024);
      let stall = true;
      up.routes.set('/big.mp4', (req, res) => {
        if (!stall) {
          serve(download, 'video/mp4')(req, res);
          return;
        }
        // First attempt: headers and half the body, then nothing (the process dies meanwhile).
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(download.length),
        });
        res.write(download.subarray(0, download.length / 2));
      });
      const env = {
        CHILD_HOME: home,
        CHILD_UPSTREAM_PORT: String(up.port),
        CHILD_OPENAI: fake.baseUrls().openai,
      };

      const a = await spawnChild(env);
      await a.client.ai.setKey('openai', 'sk-proj-fake-crash-0123456789');
      await a.client.ai.consent('openai', AI_NOTICE_VERSION);

      // 1. Committed writes (WAL mode): every 201 must survive.
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          (
            await a.client.works.create({
              title: `第 ${String(i)} 篇`,
              markdown: `# ${String(i)}\n`,
            })
          ).id,
        );
      }

      // 2. A tus upload with part of the bytes received.
      const video = mp4Bytes(1024 * 1024);
      const created = await fetch(`${a.address}${TUS_UPLOAD_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'tus-resumable': '1.0.0',
          'upload-length': String(video.length),
          'upload-metadata': `filename ${Buffer.from('崩潰.mp4').toString('base64')}`,
        },
      });
      expect(created.status).toBe(201);
      const location = created.headers.get('location') ?? '';
      const patch = http.request(new URL(location, a.address), {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'tus-resumable': '1.0.0',
          'upload-offset': '0',
          'content-type': 'application/offset+octet-stream',
          'content-length': String(video.length),
        },
      });
      patch.on('error', () => undefined);
      patch.write(video.subarray(0, 300 * 1024));

      // 3. A URL import in the middle of its download.
      const importJob = await a.client.imports.url({ url: 'http://cdn.example.com/big.mp4' });
      await until(() => up.hits.includes('/big.mp4'), 'the download to start');

      // 4. An AI job waiting on the provider.
      fake.script('openai', { delayMs: 120_000, body: ok('openai', '不會送到').body });
      const work = await a.client.works.create({ title: 'AI', markdown: '# 原文\n' });
      const { job: aiJob } = await a.client.ai.rewrite(work.id, {
        provider: 'openai',
        mode: 'polish',
      });
      await until(() => fake.for('openai').length === 1, 'the AI request');
      await until(async () => {
        const r = await fetch(new URL(location, a.address), {
          method: 'HEAD',
          headers: { authorization: `Bearer ${TEST_TOKEN}`, 'tus-resumable': '1.0.0' },
        });
        return Number(r.headers.get('upload-offset')) > 0;
      }, 'upload bytes on disk');

      await sigkill(a);
      patch.destroy();
      stall = false;
      fake.script('openai', ok('openai', '重啟後的潤色結果'));

      const b = await spawnChild(env);
      // Writes: all there.
      const listed = new Set((await b.client.works.list({ limit: 100 })).items.map((w) => w.id));
      for (const id of ids) expect(listed.has(id)).toBe(true);

      // Upload: continue from the offset the server kept.
      const head = await fetch(new URL(location, b.address), {
        method: 'HEAD',
        headers: { authorization: `Bearer ${TEST_TOKEN}`, 'tus-resumable': '1.0.0' },
      });
      expect(head.status).toBe(200);
      const offset = Number(head.headers.get('upload-offset'));
      expect(offset).toBeGreaterThan(0);
      expect(offset).toBeLessThanOrEqual(300 * 1024);
      const finish = await fetch(new URL(location, b.address), {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'tus-resumable': '1.0.0',
          'upload-offset': String(offset),
          'content-type': 'application/offset+octet-stream',
        },
        body: video.subarray(offset),
      });
      expect(finish.status).toBe(200);
      const assets = (await b.client.assets.list()).items;
      expect(assets.some((x) => x.original_name === '崩潰.mp4' && x.bytes === video.length)).toBe(
        true,
      );

      // Import: re-queued and finished.
      const imported = await b.client.jobs.wait(importJob.id, {
        intervalMs: 20,
        timeoutMs: 10_000,
      });
      expect(imported.status).toBe('succeeded');

      // AI: re-queued, sent once more, finished once.
      await until(
        async () => (await b.client.ai.job(aiJob.id)).status === 'succeeded',
        'the AI job',
      );
      expect((await b.client.ai.job(aiJob.id)).attempts).toBe(2);
      expect(fake.for('openai')).toHaveLength(2);

      // A clean stop, then the database file is sound.
      await new Promise<void>((resolve) => {
        b.proc.once('exit', () => {
          resolve();
        });
        b.proc.kill('SIGTERM');
      });
      const db = new Database(path.join(home, 'data', 'creatorhub.sqlite'), { readonly: true });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      db.close();
    },
  );
});
