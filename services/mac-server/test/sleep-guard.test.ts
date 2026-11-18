import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { AI_NOTICE_VERSION, TUS_UPLOAD_PATH } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAFFEINATE,
  CaffeinateWakeLocks,
  type WakeLockProvider,
} from '../src/power/sleep-guard.js';
import { ok, FakeAiServer } from './fake-ai.js';
import { mp4Bytes } from './fixtures.js';
import { authHeaders, startTestServer, type TestServer } from './helpers.js';
import { serve, startUpstream, type Upstream } from './upstream.js';

/** Records what the guard asked for instead of touching the real power settings. */
class FakeWakeLocks implements WakeLockProvider {
  readonly log: string[] = [];
  held = 0;
  acquire(reason: string) {
    this.log.push(`acquire ${reason}`);
    this.held++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.held--;
        this.log.push('release');
      },
    };
  }
}

const servers: TestServer[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const c of closers.splice(0)) await c();
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function start(locks: FakeWakeLocks, extra: Parameters<typeof startTestServer>[0] = {}) {
  const s = await startTestServer({
    sleep: { provider: locks, checkMs: 20, lingerMs: 100 },
    ...extra,
  });
  servers.push(s);
  return s;
}

describe('idle-sleep prevention during long tasks (QC-030)', () => {
  it('holds one lock while an AI job runs and releases it after the linger time', async () => {
    const fake = new FakeAiServer();
    await fake.start();
    closers.push(() => fake.stop());
    const locks = new FakeWakeLocks();
    const s = await start(locks, {
      ai: { baseUrls: fake.baseUrls(), retryBaseMs: 10, pollMs: 10, timeoutMs: 5000 },
    });
    expect(s.sleep.status()).toEqual({ held: false, reasons: [] });
    await s.client.ai.setKey('openai', 'sk-proj-fake-sleep-0123456789');
    await s.client.ai.consent('openai', AI_NOTICE_VERSION);
    fake.script('openai', { delayMs: 300, body: ok('openai', '結果').body });
    const work = await s.client.works.create({ title: '睡眠', markdown: '# 內容\n' });
    const { job } = await s.client.ai.rewrite(work.id, { provider: 'openai', mode: 'polish' });
    await until(() => locks.held === 1, 'the lock');
    expect(s.sleep.status()).toMatchObject({ held: true, reasons: ['ai'] });
    await s.ai.drain();
    expect((await s.client.ai.job(job.id)).status).toBe('succeeded');
    // Still held during the linger time, then released exactly once.
    expect(locks.held).toBe(1);
    await until(() => locks.held === 0, 'the release');
    expect(locks.log).toEqual(['acquire ai', 'release']);
  });

  it('holds while an import job downloads', async () => {
    const up: Upstream = await startUpstream();
    closers.push(() => up.close());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = mp4Bytes(64 * 1024);
    up.routes.set('/slow.mp4', (req, res) => {
      void gate.then(() => {
        serve(body, 'video/mp4')(req, res);
      });
    });
    const locks = new FakeWakeLocks();
    const s = await start(locks, {
      download: up.download(),
      jobs: { retryBaseMs: 1, pollMs: 5 },
    });
    const job = await s.client.imports.url({ url: 'http://cdn.example.com/slow.mp4' });
    await until(() => locks.held === 1, 'the lock');
    expect(s.sleep.status().reasons).toContain('import');
    release();
    const done = await s.client.jobs.wait(job.id, { intervalMs: 10, timeoutMs: 5000 });
    expect(done.status).toBe('succeeded');
    await until(() => locks.held === 0, 'the release');
    expect(locks.log).toEqual(['acquire import', 'release']);
  });

  it('holds while upload bytes are being received, not after', async () => {
    const locks = new FakeWakeLocks();
    const s = await start(locks);
    const video = mp4Bytes(1024 * 1024);
    const create = await fetch(`${s.baseUrl}${TUS_UPLOAD_PATH}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'tus-resumable': '1.0.0',
        'upload-length': String(video.length),
        'upload-metadata': `filename ${Buffer.from('a.mp4').toString('base64')}`,
      },
    });
    const location = create.headers.get('location') ?? '';
    await until(() => locks.held === 0, 'the creation request to end');
    const req = http.request(new URL(location, s.baseUrl), {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
        'content-type': 'application/offset+octet-stream',
        'content-length': String(video.length),
      },
    });
    req.on('error', () => undefined);
    req.write(video.subarray(0, 1000));
    await until(() => locks.held === 1, 'the lock');
    expect(s.sleep.status().reasons).toEqual(['upload']);
    req.destroy();
    await until(() => locks.held === 0, 'the release');
  });

  it('queued jobs left by a crash take the lock again when the service starts', async () => {
    const locks = new FakeWakeLocks();
    const first = await start(locks, { jobs: { start: false } });
    first.db
      .prepare(
        `INSERT INTO background_jobs (id, kind, subject_id, status, attempts, run_after, created_at, updated_at)
         VALUES ('j1', 'thumbnail', 'x', 'running', 1, 'now', 'now', 'now')`,
      )
      .run();
    first.sleep.check();
    expect(locks.held).toBe(1);
  });

  it.runIf(process.platform === 'darwin' && fs.existsSync(CAFFEINATE))(
    'the macOS provider runs caffeinate -i -w <pid> and stops it on release',
    async () => {
      const find = () =>
        execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l.includes(`caffeinate -i -w ${String(process.pid)}`));
      const lock = new CaffeinateWakeLocks().acquire();
      await until(() => find().length === 1, 'caffeinate to start');
      lock.release();
      await until(() => find().length === 0, 'caffeinate to stop');
    },
  );
});
