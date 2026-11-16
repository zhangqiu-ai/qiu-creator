import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFfprobe } from '../src/media/ffprobe.js';
import { fakeFfprobe, mp4Bytes, pngBytes } from './fixtures.js';
import { makeTempHome, startTestServer, type StartOptions, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const srv of servers.splice(0)) await srv.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
async function start(options: StartOptions = {}): Promise<TestServer> {
  const srv = await startTestServer(options);
  servers.push(srv);
  return srv;
}
function tempDir(): string {
  const d = makeTempHome();
  dirs.push(d);
  return d;
}

describe('video metadata via ffprobe', () => {
  it('degrades to "unavailable" without error when ffprobe is missing', async () => {
    const srv = await start({ ffprobe: null });
    const { asset } = await srv.client.assets.upload({ data: mp4Bytes(), filename: 'v.mp4' });
    expect(asset.metadata_status).toBe('pending');
    await srv.jobs.drain();

    expect(await srv.client.assets.get(asset.id)).toMatchObject({
      metadata_status: 'unavailable',
      duration: null,
      width: null,
      codec: null,
    });
    const jobs = srv.jobs.list(asset.id);
    expect(jobs.map((j) => [j.kind, j.status, j.last_error])).toEqual([
      ['asset.probe', 'succeeded', null],
    ]);
  });

  it('treats an unusable CREATORHUB_FFPROBE as missing', () => {
    expect(resolveFfprobe('/nonexistent/ffprobe')).toBeNull();
    expect(resolveFfprobe('')).toBeNull();
    expect(resolveFfprobe(undefined, '/nonexistent-dir')).toSatisfy(
      (v: string | null) => v === null || v.endsWith('ffprobe'),
    );
  });

  it('records duration, size and codec from ffprobe output', async () => {
    const ffprobe = fakeFfprobe(tempDir(), {
      json: {
        streams: [
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 },
        ],
        format: { duration: '12.480000' },
      },
    });
    const srv = await start({ ffprobe });
    const { asset } = await srv.client.assets.upload({ data: mp4Bytes(), filename: 'v.mp4' });
    await srv.jobs.drain();
    expect(await srv.client.assets.get(asset.id)).toMatchObject({
      metadata_status: 'ready',
      duration: 12.48,
      width: 1080,
      height: 1920,
      codec: 'h264',
    });
  });

  it('retries a failing probe, then marks the job and asset failed', async () => {
    const ffprobe = fakeFfprobe(tempDir(), { exitCode: 1 });
    const srv = await start({ ffprobe, jobs: { retryBaseMs: 1, pollMs: 5 } });
    const { asset } = await srv.client.assets.upload({ data: mp4Bytes(), filename: 'v.mp4' });
    await srv.jobs.drain();
    const [job] = srv.jobs.list(asset.id);
    expect(job).toMatchObject({ status: 'failed', attempts: 3 });
    expect(job?.last_error).toContain('boom');
    expect((await srv.client.assets.get(asset.id)).metadata_status).toBe('failed');
  });
});

describe('durable job queue', () => {
  it('runs jobs queued before a restart once the server comes back', async () => {
    const home = tempDir();
    const first = await start({ home, jobs: { start: false } });
    const { asset } = await first.client.assets.upload({
      data: await pngBytes(),
      filename: 'a.png',
    });
    expect(first.jobs.list(asset.id).map((j) => j.status)).toEqual(['queued']);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await start({ home });
    await second.jobs.drain();
    expect(second.jobs.list(asset.id).map((j) => j.status)).toEqual(['succeeded']);
    expect((await second.client.assets.get(asset.id)).thumbnail_status).toBe('ready');
  });

  it('re-queues a job left "running" by a crash', async () => {
    const home = tempDir();
    const first = await start({ home, jobs: { start: false } });
    const { asset } = await first.client.assets.upload({
      data: await pngBytes(),
      filename: 'a.png',
    });
    // Simulate a crash mid-job: the row says running, nothing will finish it.
    first.db.prepare("UPDATE background_jobs SET status = 'running', attempts = 1").run();
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await start({ home });
    await second.jobs.drain();
    expect(second.jobs.list(asset.id)).toMatchObject([{ status: 'succeeded', attempts: 2 }]);
  });

  it('does not enqueue duplicate unfinished jobs for the same subject', async () => {
    const srv = await start({ jobs: { start: false } });
    const a = srv.jobs.enqueue('asset.thumbnail', 'x');
    const b = srv.jobs.enqueue('asset.thumbnail', 'x');
    expect(a).toBe(b);
    expect(srv.jobs.list('x')).toHaveLength(1);
  });
});
