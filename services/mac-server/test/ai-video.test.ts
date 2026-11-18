import fs from 'node:fs';
import path from 'node:path';
import { ApiError, videoUnderstandingOf } from '@qiu-creator/api-client';
import { AI_NOTICE_VERSION, GEMINI_VIDEO_LIMITS, type AiJobRecord } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGeminiVideo } from './fake-gemini-video.js';
import { mp4Bytes, pngBytes } from './fixtures.js';
import { startTestServer, type StartOptions, type TestServer } from './helpers.js';

const KEY = 'AIzaFakeVideoKey0123456789';
const CHUNK = 256 * 1024;

const servers: TestServer[] = [];
const fakes: FakeGeminiVideo[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.stop();
});

async function start(extra: StartOptions['ai'] = {}) {
  const fake = new FakeGeminiVideo();
  await fake.start();
  fakes.push(fake);
  const s = await startTestServer({
    ai: {
      baseUrls: { gemini: fake.baseUrl() },
      retryBaseMs: 10,
      pollMs: 10,
      timeoutMs: 2000,
      video: { chunkBytes: CHUNK, pollMs: 10, processingTimeoutMs: 2000 },
      ...extra,
    },
  });
  servers.push(s);
  await s.client.ai.setKey('gemini', KEY);
  await s.client.ai.consent('gemini', AI_NOTICE_VERSION);
  // 700 KB: three chunks of 256 KiB.
  const video = mp4Bytes(700 * 1024);
  const { asset } = await s.client.assets.upload({ filename: 'arashiyama.mp4', data: video });
  s.db.prepare('UPDATE assets SET duration = 30 WHERE id = ?').run(asset.id);
  return { s, fake, video, assetId: asset.id };
}

async function finished(s: TestServer, id: string): Promise<AiJobRecord> {
  await s.ai.drain();
  return s.client.ai.job(id);
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const actions = (s: TestServer, id: string) => s.feed.since(0).filter((e) => e.entity_id === id);

describe('Gemini video understanding', () => {
  it('uploads in resumable chunks, waits for ACTIVE, analyses and returns a checked result', async () => {
    const { s, fake, video, assetId } = await start();
    fake.processingPolls = 2;

    const est = await s.client.ai.estimateVideo(assetId);
    expect(est).toMatchObject({
      size_bytes: video.length,
      duration_seconds: 30,
      duration_source: 'metadata',
      model: 'gemini-3.8-flash',
      resolution: 'default',
      cached_job_id: null,
      estimate: { provider: 'gemini', max_output_tokens: 4096, estimated: true },
    });
    expect(est.estimate.input_tokens).toBeGreaterThanOrEqual(30 * 300);
    expect(est.estimate.max_cost_usd).toBeGreaterThan(0);

    const res = await s.client.ai.analyzeVideo(assetId);
    expect(res).toMatchObject({
      cached: false,
      in_progress: false,
      job: { status: 'queued', action: 'video_understanding' },
    });
    const done = await finished(s, res.job.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      usage: { input_tokens: 9200, output_tokens: 400 },
      progress: { phase: 'analyzing', uploaded_bytes: video.length, total_bytes: video.length },
      task: {
        type: 'video_understanding',
        asset_id: assetId,
        mime_type: 'video/mp4',
        duration_seconds: 30,
      },
    });
    expect(done.cost_usd).toBeGreaterThan(0);

    // The exact bytes went up in 256 KiB chunks; only the last one finalizes.
    expect(fake.lastUpload()?.equals(video)).toBe(true);
    expect(fake.chunks.map((c) => [c.offset, c.command])).toEqual([
      [0, 'upload'],
      [CHUNK, 'upload'],
      [2 * CHUNK, 'upload, finalize'],
    ]);
    const [startReq] = fake.starts;
    expect(startReq?.headers['x-goog-api-key']).toBe(KEY);
    expect(startReq?.headers['x-goog-upload-protocol']).toBe('resumable');
    expect(startReq?.headers['x-goog-upload-header-content-type']).toBe('video/mp4');
    // The prompt references the uploaded file; the key is never in a body.
    const gen = fake.generates[0];
    expect(JSON.stringify(gen)).toContain('"fileUri"');
    expect(JSON.stringify(gen)).not.toContain(KEY);
    // The remote file is removed once the result is stored.
    expect(fake.deletes).toHaveLength(1);

    const result = videoUnderstandingOf(done);
    if (result === null) throw new Error('no result');
    expect(result.disclaimer).toContain('核驗');
    expect(result.key_moments.map((m) => [m.time_seconds, m.within_duration])).toEqual([
      [3, true],
      [25, true],
      [95, false],
    ]);
    expect(result.key_moments.map((m) => m.needs_verification)).toEqual([true, true, true]);
    expect(result.title_suggestions).toEqual(['清晨的嵐山竹林', '京都人少的時段']);
    expect(result.cover_suggestions).toEqual([
      expect.objectContaining({
        time_seconds: 12,
        needs_verification: true,
        within_duration: true,
      }),
    ]);

    // Progress events: uploading (per chunk) → processing → analyzing, then succeeded.
    const phases = actions(s, res.job.id)
      .filter((e) => e.action === 'ai_job.progress')
      .map((e) => e.data['phase']);
    expect(phases[0]).toBe('uploading');
    expect(phases).toContain('processing');
    expect(phases.at(-1)).toBe('analyzing');
    const uploaded = actions(s, res.job.id)
      .filter((e) => e.data['phase'] === 'uploading')
      .map((e) => e.data['uploaded_bytes']);
    expect(uploaded).toEqual([0, CHUNK, 2 * CHUNK, video.length]);
    expect(actions(s, res.job.id).at(-1)?.action).toBe('ai_job.succeeded');
  });

  it('returns a cached result for free and only re-analyses when asked', async () => {
    const { s, fake, assetId } = await start();
    const first = await s.client.ai.analyzeVideo(assetId);
    await finished(s, first.job.id);

    const again = await s.client.ai.analyzeVideo(assetId);
    expect(again).toMatchObject({
      cached: true,
      in_progress: false,
      budget: null,
      job: { id: first.job.id },
    });
    expect(fake.starts).toHaveLength(1);
    expect(fake.generates).toHaveLength(1);
    expect((await s.client.ai.estimateVideo(assetId)).cached_job_id).toBe(first.job.id);

    // Different model settings are a different analysis.
    expect(
      (await s.client.ai.estimateVideo(assetId, { resolution: 'low' })).cached_job_id,
    ).toBeNull();

    const fresh = await s.client.ai.analyzeVideo(assetId, { reanalyze: true });
    expect(fresh).toMatchObject({ cached: false, in_progress: false });
    expect(fresh.job.id).not.toBe(first.job.id);
    await finished(s, fresh.job.id);
    expect(fake.starts).toHaveLength(2);
    // The newest result is the one served from the cache now.
    expect((await s.client.ai.analyzeVideo(assetId)).job.id).toBe(fresh.job.id);
    const usage = await s.client.ai.usage();
    expect(usage.by_provider.find((p) => p.provider === 'gemini')?.jobs).toBe(2);
  });

  it('never runs the same analysis twice at once', async () => {
    const { s, assetId } = await start({ start: false });
    const a = await s.client.ai.analyzeVideo(assetId);
    const b = await s.client.ai.analyzeVideo(assetId, { reanalyze: true });
    expect(b).toMatchObject({ in_progress: true, cached: false, job: { id: a.job.id } });
    expect((await s.client.ai.jobs()).total).toBe(1);
  });

  it('resumes an interrupted upload from the offset the server confirms', async () => {
    const { s, fake, video, assetId } = await start();
    fake.dropChunks = new Set([2]);
    const res = await s.client.ai.analyzeVideo(assetId);
    const done = await finished(s, res.job.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(fake.starts).toHaveLength(1);
    expect(fake.queries).toEqual([CHUNK + CHUNK / 2]);
    expect(fake.chunks.map((c) => c.offset)).toEqual([
      0,
      CHUNK,
      CHUNK + CHUNK / 2,
      2 * CHUNK + CHUNK / 2,
    ]);
    expect(fake.lastUpload()?.equals(video)).toBe(true);
    // The dropped connection was retried by the runner: queued → running → queued → running.
    expect(
      actions(s, res.job.id)
        .map((e) => e.action)
        .filter((a) => a !== 'ai_job.progress'),
    ).toEqual([
      'ai_job.queued',
      'ai_job.running',
      'ai_job.queued',
      'ai_job.running',
      'ai_job.succeeded',
    ]);
  });

  it('starts the upload over when the server cannot say how much it has', async () => {
    const { s, fake, video, assetId } = await start();
    fake.dropChunks = new Set([1]);
    fake.supportsQuery = false;
    const done = await finished(s, (await s.client.ai.analyzeVideo(assetId)).job.id);
    expect(done.status).toBe('succeeded');
    expect(fake.starts).toHaveLength(2);
    expect(fake.lastUpload()?.equals(video)).toBe(true);
  });

  it('fails clearly when Gemini cannot process the file, and deletes it', async () => {
    const { s, fake, assetId } = await start();
    fake.failProcessing = true;
    const done = await finished(s, (await s.client.ai.analyzeVideo(assetId)).job.id);
    expect(done).toMatchObject({
      status: 'failed',
      error_code: 'file_processing_failed',
      attempts: 1,
    });
    expect(done.error).toContain('Video codec not supported');
    expect(fake.deletes).toHaveLength(1);
    expect(fake.generates).toHaveLength(0);
  });

  it('retries a 429 without uploading again', async () => {
    const { s, fake, assetId } = await start();
    fake.generateReplies.push({ status: 429, body: { error: { code: 429, message: 'quota' } } });
    const res = await s.client.ai.analyzeVideo(assetId);
    const done = await finished(s, res.job.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(fake.starts).toHaveLength(1);
    expect(fake.generates).toHaveLength(2);
    const retried = actions(s, res.job.id).filter((e) => e.action === 'ai_job.queued');
    expect(retried).toHaveLength(2);
  });

  it('cancels while Gemini is processing and deletes the remote file', async () => {
    const { s, fake, assetId } = await start();
    fake.processingPolls = 10_000;
    const res = await s.client.ai.analyzeVideo(assetId);
    for (let i = 0; i < 300; i++) {
      const job = await s.client.ai.job(res.job.id);
      if (job.progress?.phase === 'processing') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await s.client.ai.stop(res.job.id)).status).toBe('cancelled');
    await s.ai.drain();
    for (let i = 0; i < 100 && fake.deletes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.deletes).toHaveLength(1);
    expect(fake.generates).toHaveLength(0);
    expect(actions(s, res.job.id).at(-1)?.action).toBe('ai_job.cancelled');
  });

  it('marks moments as unchecked against the length when the duration is unknown', async () => {
    const { s, assetId } = await start();
    s.db.prepare('UPDATE assets SET duration = NULL WHERE id = ?').run(assetId);
    const done = await finished(s, (await s.client.ai.analyzeVideo(assetId)).job.id);
    expect(videoUnderstandingOf(done)?.key_moments.map((m) => m.within_duration)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('fails as source_unavailable when the video file is gone', async () => {
    const { s, fake, assetId } = await start({ start: false });
    const res = await s.client.ai.analyzeVideo(assetId);
    const asset = await s.client.assets.get(assetId);
    fs.rmSync(path.join(s.home, asset.path));
    s.ai.start();
    expect(await finished(s, res.job.id)).toMatchObject({
      status: 'failed',
      error_code: 'source_unavailable',
    });
    expect(fake.chunks).toHaveLength(0);
  });

  it('checks Gemini limits before sending, with readable errors', async () => {
    const { s, assetId } = await start();
    const png = (await s.client.assets.upload({ filename: 'p.png', data: await pngBytes(8, 8) }))
      .asset;
    expect((await apiError(s.client.ai.analyzeVideo(png.id))).status).toBe(415);

    s.db.prepare('UPDATE assets SET duration = 7200 WHERE id = ?').run(assetId);
    const tooLong = await apiError(s.client.ai.analyzeVideo(assetId));
    expect(tooLong.status).toBe(400);
    expect(tooLong.message).toContain('120 分鐘');
    expect(tooLong.message).toContain('低解析度');
    expect((await s.client.ai.estimateVideo(assetId, { resolution: 'low' })).duration_seconds).toBe(
      7200,
    );

    s.db
      .prepare('UPDATE assets SET duration = NULL, bytes = ? WHERE id = ?')
      .run(GEMINI_VIDEO_LIMITS.maxFileBytes + 1, assetId);
    const tooBig = await apiError(s.client.ai.estimateVideo(assetId));
    expect(tooBig.status).toBe(413);
    expect(tooBig.message).toContain('2 GB');

    s.db
      .prepare("UPDATE assets SET bytes = 1000000, mime_type = 'video/x-matroska' WHERE id = ?")
      .run(assetId);
    expect((await apiError(s.client.ai.estimateVideo(assetId))).status).toBe(415);

    s.db.prepare("UPDATE assets SET mime_type = 'video/quicktime' WHERE id = ?").run(assetId);
    const guessed = await s.client.ai.estimateVideo(assetId);
    expect(guessed).toMatchObject({ duration_source: 'size_guess', duration_seconds: 1.6 });
    expect((await s.client.ai.jobs()).total).toBe(0);
  });

  it('is owner-only, still needs a key and consent, and only takes asset ids', async () => {
    const { s, assetId } = await start();
    const agent = s.tokens.create({ name: 'a', scopes: ['read', 'import', 'write'] });
    for (const suffix of ['', '/estimate']) {
      const res = await fetch(
        `${s.baseUrl}/api/v1/assets/${assetId}/ai/video-understanding${suffix}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${agent.secret}`, 'content-type': 'application/json' },
          body: '{}',
        },
      );
      expect(res.status, suffix).toBe(403);
    }
    await s.client.ai.withdrawConsent('gemini');
    expect((await apiError(s.client.ai.analyzeVideo(assetId))).code).toBe('ai_consent_required');
    const notAnId = await fetch(
      `${s.baseUrl}/api/v1/assets/..%2F..%2Fetc%2Fpasswd/ai/video-understanding`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer test-token-0123456789abcdef`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(notAnId.status).toBe(400);
  });

  it('result reuse survives a different upload of the same bytes (same hash)', async () => {
    const { s, video, assetId } = await start();
    const first = await s.client.ai.analyzeVideo(assetId);
    await finished(s, first.job.id);
    // Identical content deduplicates to the same asset, so the cache applies.
    const again = await s.client.assets.upload({ filename: 'copy.mp4', data: video });
    expect(again.deduplicated).toBe(true);
    expect((await s.client.ai.analyzeVideo(again.asset.id)).cached).toBe(true);
  });
});
