/**
 * M3 acceptance (QC-026), against local fakes only: Claude and GPT text
 * (`FakeAiServer`), Gemini Files API + video (`FakeGeminiVideo`), keys in memory.
 * Nothing leaves the machine and the Keychain is never touched.
 *
 *   1. a video is sent straight to Gemini (no local transcoding); the result is
 *      stored and reused
 *   2. AI suggestions never overwrite the original
 *   3. no duplicate sends or charges
 *   4. every task's status and failure reason are visible
 * plus: keys never leak, agent tokens are refused, withdrawing consent or
 * deleting a key stops queued jobs, the monthly reminder only reminds.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ApiError,
  createClient,
  rewriteOf,
  suggestionsOf,
  videoUnderstandingOf,
} from '@qiu-creator/api-client';
import {
  AI_NOTICE_VERSION,
  type AiJobRecord,
  type AiProvider,
  type CreateAiJobRequest,
} from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/ai/secret-store.js';
import { fail, FakeAiServer, ok } from './fake-ai.js';
import { FakeGeminiVideo } from './fake-gemini-video.js';
import { mp4Bytes } from './fixtures.js';
import { authHeaders, makeTempHome, startTestServer, type TestServer } from './helpers.js';

const KEYS: Record<AiProvider, string> = {
  anthropic: 'sk-ant-api03-M3ACCEPT0123456789abcdefXYZ',
  openai: 'sk-proj-M3ACCEPT0123456789abcdefXYZ',
  gemini: 'AIzaM3ACCEPT0123456789abcdefXYZ',
};
const CHUNK = 256 * 1024;
const MARKDOWN = '# 京都秋天\n\n今年的紅葉比往年早。\n\n清水寺人很多，嵐山比較安靜。\n';

const servers: TestServer[] = [];
let text = new FakeAiServer();
let video = new FakeGeminiVideo();
const homes: string[] = [];
let secrets = new MemorySecretStore();
let started = false;

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  if (started) {
    await text.stop();
    await video.stop();
    started = false;
  }
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

interface Rig {
  s: TestServer;
  text: FakeAiServer;
  video: FakeGeminiVideo;
  home: string;
  videoBytes: Buffer;
  assetId: string;
}

interface RigOptions {
  /** `false` leaves queued jobs untouched until `s.ai.start()`. */
  start?: boolean;
  keys?: AiProvider[];
}

async function boot(home: string, start: boolean): Promise<TestServer> {
  const s = await startTestServer({
    home,
    jobs: { pollMs: 5 },
    ai: {
      secrets,
      // Claude and GPT text on one fake, Gemini (video) on the other.
      baseUrls: { ...text.baseUrls(), gemini: video.baseUrl() },
      retryBaseMs: 10,
      pollMs: 10,
      timeoutMs: 2000,
      video: { chunkBytes: CHUNK, pollMs: 10, processingTimeoutMs: 2000 },
      start,
    },
  });
  servers.push(s);
  return s;
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  secrets = new MemorySecretStore();
  text = new FakeAiServer();
  video = new FakeGeminiVideo();
  await text.start();
  await video.start();
  started = true;
  const home = makeTempHome();
  homes.push(home);
  const s = await boot(home, options.start ?? true);
  for (const provider of options.keys ?? ['anthropic', 'openai', 'gemini']) {
    await s.client.ai.setKey(provider, KEYS[provider]);
    await s.client.ai.consent(provider, AI_NOTICE_VERSION);
  }
  const videoBytes = mp4Bytes(700 * 1024);
  const { asset } = await s.client.assets.upload({ filename: 'arashiyama.mp4', data: videoBytes });
  s.db.prepare('UPDATE assets SET duration = 30 WHERE id = ?').run(asset.id);
  return { s, text, video, home, videoBytes, assetId: asset.id };
}

/** Stop the server and start another on the same home and the same (in-memory) key store. */
async function restart(r: Rig, start = true): Promise<TestServer> {
  const old = r.s;
  servers.splice(servers.indexOf(old), 1);
  await old.close();
  return boot(r.home, start);
}

async function finished(s: TestServer, id: string): Promise<AiJobRecord> {
  await s.ai.drain();
  return s.client.ai.job(id);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the request to be rejected').toBeInstanceOf(ApiError);
  return err as ApiError;
}

const claude = (body: string) => ok('anthropic', body, 'claude-opus-5-5');
const job = (provider: AiProvider): CreateAiJobRequest => ({
  provider,
  action: 'suggest_title',
  input: { system: '你是編輯', prompt: '幫這篇京都遊記想一個標題', max_output_tokens: 256 },
});

async function workState(s: TestServer, id: string, file: string) {
  const work = await s.client.works.get(id);
  return {
    markdown: work.markdown,
    revision: work.current_revision_id,
    revisions: (await s.client.works.revisions(id)).items.length,
    disk: fs.readFileSync(file, 'utf8'),
  };
}

const sourceFile = (r: Rig, workId: string): string =>
  path.join(r.home, 'library', 'works', workId, 'source.md');

describe('1. a video goes straight to Gemini; the result is kept and reusable', () => {
  it('uploads the original file, no local transcoding, and stores a checked result', async () => {
    const r = await rig();
    const est = await r.s.client.ai.estimateVideo(r.assetId);
    expect(est.cached_job_id).toBeNull();
    expect(est.estimate.estimated).toBe(true);
    // Estimating sends nothing.
    expect(r.video.starts).toHaveLength(0);

    const res = await r.s.client.ai.analyzeVideo(r.assetId);
    const done = await finished(r.s, res.job.id);
    expect(done.status).toBe('succeeded');

    // The exact original bytes went up (no ffmpeg, no frames, no subtitles), then one generateContent
    // that references the uploaded file.
    expect(r.video.lastUpload()?.equals(r.videoBytes)).toBe(true);
    expect(r.video.starts).toHaveLength(1);
    expect(r.video.generates).toHaveLength(1);
    const body = JSON.stringify(r.video.generates[0]);
    expect(body).toContain('"fileUri"');
    expect(body).not.toContain(KEYS.gemini);
    expect(r.text.seen).toHaveLength(0);

    const result = videoUnderstandingOf(done);
    expect(result?.summary).toBeTruthy();
    expect(result?.key_moments.length).toBeGreaterThan(0);
    expect(result?.key_moments.map((m) => m.needs_verification)).not.toContain(false);
    expect(result?.disclaimer).toContain('核驗');
    // The remote copy does not outlive the analysis.
    expect(r.video.deletes).toHaveLength(1);
  });

  it('keeps the result across a restart and reuses it for free', async () => {
    const r = await rig();
    const first = await r.s.client.ai.analyzeVideo(r.assetId);
    const done = await finished(r.s, first.job.id);
    const before = (await r.s.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini');

    const s2 = await restart(r);
    const stored = await s2.client.ai.job(first.job.id);
    expect(videoUnderstandingOf(stored)).toEqual(videoUnderstandingOf(done));

    const again = await s2.client.ai.analyzeVideo(r.assetId);
    expect(again).toMatchObject({ cached: true, in_progress: false, job: { id: first.job.id } });
    expect(again.budget).toBeNull();
    expect(r.video.starts).toHaveLength(1);
    expect(r.video.generates).toHaveLength(1);
    expect((await s2.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini')).toEqual(
      before,
    );
  });

  it('reuses the result when the same video is uploaded again under another name', async () => {
    const r = await rig();
    const first = await r.s.client.ai.analyzeVideo(r.assetId);
    await finished(r.s, first.job.id);
    const again = await r.s.client.assets.upload({
      filename: '另存的名字.mp4',
      data: r.videoBytes,
    });
    expect(again.deduplicated).toBe(true);
    const reuse = await r.s.client.ai.analyzeVideo(again.asset.id);
    expect(reuse).toMatchObject({ cached: true, job: { id: first.job.id } });
    expect(r.video.starts).toHaveLength(1);
  });
});

describe('2. AI suggestions never overwrite the original', () => {
  it('a rewrite is only a candidate: the work, its file and its history stay as they were', async () => {
    const r = await rig();
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    const file = sourceFile(r, work.id);
    const before = await workState(r.s, work.id, file);
    r.text.script('anthropic', claude('# 京都秋天\n\n今年紅葉來得比較早。\n'));
    const { job: queued } = await r.s.client.ai.rewrite(work.id, {
      provider: 'anthropic',
      mode: 'polish',
    });
    const done = await finished(r.s, queued.id);
    expect(done.status).toBe('succeeded');
    expect(rewriteOf(done)?.full_markdown).toContain('比較早');
    expect(await workState(r.s, work.id, file)).toEqual(before);
    expect(
      r.s.feed.since(0).some((e) => e.entity_id === work.id && e.action === 'work.updated'),
    ).toBe(false);
  });

  it('accepting after the original changed is 409 and writes nothing', async () => {
    const r = await rig();
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    const file = sourceFile(r, work.id);
    r.text.script('anthropic', claude('縮短後的版本'));
    const { job: queued } = await r.s.client.ai.rewrite(work.id, {
      provider: 'anthropic',
      mode: 'shorten',
    });
    await finished(r.s, queued.id);

    // The user edits in the app, then somebody edits the file outside.
    const edited = await r.s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `${MARKDOWN}\n使用者補的一句。\n`,
    });
    fs.writeFileSync(file, `${edited.markdown}Typora 又補了一句。\n`);

    const err = await apiError(
      r.s.client.ai.accept(work.id, queued.id, { markdown: '縮短後的版本' }),
    );
    expect([err.status, err.code]).toEqual([409, 'revision_conflict']);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${edited.markdown}Typora 又補了一句。\n`);
    expect((await r.s.client.ai.job(queued.id)).accepted_revision_id ?? null).toBeNull();
    const sources = (await r.s.client.works.revisions(work.id)).items.map((x) => x.source);
    expect(sources).not.toContain('ai_accepted');
  });

  it('accepting a fresh candidate makes an ai_accepted revision that can be restored from history', async () => {
    const r = await rig();
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    const file = sourceFile(r, work.id);
    r.text.script('anthropic', claude('# 京都秋天\n\n今年紅葉來得比較早。\n'));
    const { job: queued } = await r.s.client.ai.rewrite(work.id, {
      provider: 'anthropic',
      mode: 'polish',
    });
    const candidate = rewriteOf(await finished(r.s, queued.id));
    const accepted = await r.s.client.ai.accept(work.id, queued.id, {
      markdown: candidate?.full_markdown ?? '',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(accepted.markdown);
    const [head, original] = (await r.s.client.works.revisions(work.id)).items;
    expect(head).toMatchObject({ source: 'ai_accepted', ai_job_id: queued.id });
    expect(original?.revision_id).toBe(work.current_revision_id);

    const restored = await r.s.client.works.restore(work.id, work.current_revision_id, {
      base_revision: accepted.current_revision_id,
    });
    expect(restored.markdown).toBe(MARKDOWN);
    expect(fs.readFileSync(file, 'utf8')).toBe(MARKDOWN);
    // Nothing was lost: original, AI version and the restore are all in history.
    const history = await r.s.client.works.revisions(work.id);
    expect(history.items.map((x) => x.source)).toEqual(['restore', 'ai_accepted', 'create']);
  });

  it('works for a mounted external file too: the outside editor wins a race with the candidate', async () => {
    const r = await rig();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(r.home, '..', 'creatorhub-m3-')));
    homes.push(dir);
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, MARKDOWN);
    const mount = await r.s.client.mounts.create({ path: dir });
    await r.s.jobs.drain();
    await r.s.mounts.ready(mount.id);
    const work = (await r.s.client.works.list({ limit: 20 })).items.find(
      (w) => w.external_path === 'note.md',
    );
    if (work === undefined) throw new Error('mounted work not indexed');

    r.text.script('anthropic', claude('改寫後的外部檔案'));
    const { job: queued } = await r.s.client.ai.rewrite(work.id, {
      provider: 'anthropic',
      mode: 'polish',
    });
    await finished(r.s, queued.id);
    expect(fs.readFileSync(file, 'utf8')).toBe(MARKDOWN); // candidate only

    fs.writeFileSync(file, '外部編輯器剛存的內容\n');
    const err = await apiError(
      r.s.client.ai.accept(work.id, queued.id, { markdown: '改寫後的外部檔案' }),
    );
    expect(err.status).toBe(409);
    expect(fs.readFileSync(file, 'utf8')).toBe('外部編輯器剛存的內容\n');
  });

  it('platform suggestions are candidates only: no variant is created or changed', async () => {
    const r = await rig();
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    await r.s.client.variants.generate(work.id, { platforms: ['douyin'] });
    const before = (await r.s.client.variants.list(work.id)).items.map((v) => [
      v.platform,
      v.revision,
      v.title,
    ]);
    const state = await workState(r.s, work.id, sourceFile(r, work.id));
    r.text.script(
      'anthropic',
      claude(
        JSON.stringify({
          xiaohongshu: { titles: ['京都紅葉提早報到'], summaries: ['摘要'], tags: [['京都']] },
          wechat_mp: { titles: ['京都秋天'], summaries: ['摘要'], tags: [['旅行']] },
          douyin: { titles: ['京都紅葉'], summaries: ['短'], tags: [['京都']] },
          wechat_channels: { titles: ['紅葉七日'], summaries: ['描述'], tags: [['京都']] },
        }),
      ),
    );
    const { job: queued } = await r.s.client.ai.suggest(work.id, { provider: 'anthropic' });
    const done = await finished(r.s, queued.id);
    expect(suggestionsOf(done)?.platforms).toHaveLength(4);
    expect(
      (await r.s.client.variants.list(work.id)).items.map((v) => [v.platform, v.revision, v.title]),
    ).toEqual(before);
    expect(await workState(r.s, work.id, sourceFile(r, work.id))).toEqual(state);
    expect(
      r.s.feed
        .since(0)
        .filter((e) => e.action.startsWith('work.variant_') && e.entity_id === work.id),
    ).toHaveLength(1); // only the douyin draft made above
  });
});

describe('3. no duplicate sends or charges', () => {
  it('a cache hit sends nothing and costs nothing; only a deliberate re-analysis is billed', async () => {
    const r = await rig();
    const first = await r.s.client.ai.analyzeVideo(r.assetId);
    await finished(r.s, first.job.id);
    const usage1 = (await r.s.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini');
    expect(usage1?.jobs).toBe(1);

    for (let i = 0; i < 3; i++) {
      expect(await r.s.client.ai.analyzeVideo(r.assetId)).toMatchObject({ cached: true });
    }
    expect(r.video.starts).toHaveLength(1);
    expect(r.video.generates).toHaveLength(1);
    expect((await r.s.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini')).toEqual(
      usage1,
    );

    const fresh = await r.s.client.ai.analyzeVideo(r.assetId, { reanalyze: true });
    expect(fresh).toMatchObject({ cached: false, in_progress: false });
    await finished(r.s, fresh.job.id);
    expect(r.video.starts).toHaveLength(2);
    const usage2 = (await r.s.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini');
    expect(usage2?.jobs).toBe(2);
    expect(usage2?.cost_usd ?? 0).toBeGreaterThan(usage1?.cost_usd ?? 0);
  });

  it('simultaneous requests for the same analysis make one job and one upload, even with reanalyze', async () => {
    const r = await rig();
    r.video.processingPolls = 50; // keep the first job running while the others arrive
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        r.s.client.ai.analyzeVideo(r.assetId, { reanalyze: i % 2 === 1 }),
      ),
    );
    expect(new Set(results.map((x) => x.job.id)).size).toBe(1);
    expect(results.filter((x) => !x.in_progress)).toHaveLength(1);
    expect((await r.s.client.ai.jobs()).total).toBe(1);
    r.video.processingPolls = 1;
    await finished(r.s, results[0]?.job.id ?? '');
    expect(r.video.starts).toHaveLength(1);
    expect(r.video.generates).toHaveLength(1);
  });

  it('an Idempotency-Key returns the original job: one job, one request, one charge', async () => {
    const r = await rig();
    r.text.script('anthropic', claude('標題'));
    const a = await r.s.client.ai.submit(job('anthropic'), { idempotencyKey: 'm3-title-1' });
    const again = await fetch(`${r.s.baseUrl}/api/v1/ai/jobs`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json', 'idempotency-key': 'm3-title-1' }),
      body: JSON.stringify(job('anthropic')),
    });
    expect(again.status).toBe(202);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(((await again.json()) as { job: { id: string } }).job.id).toBe(a.job.id);
    await finished(r.s, a.job.id);
    expect(r.text.for('anthropic')).toHaveLength(1);
    expect(
      (await r.s.client.ai.usage()).by_provider.find((p) => p.provider === 'anthropic')?.jobs,
    ).toBe(1);

    // The same key with a different request is refused rather than silently reused.
    const other = await fetch(`${r.s.baseUrl}/api/v1/ai/jobs`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json', 'idempotency-key': 'm3-title-1' }),
      body: JSON.stringify({
        ...job('anthropic'),
        input: { prompt: '另一個請求', max_output_tokens: 64 },
      }),
    });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect((await r.s.client.ai.jobs()).total).toBe(1);
  });

  it('a restart does not run a finished job again or upload a finished video again', async () => {
    const r = await rig();
    const res = await r.s.client.ai.analyzeVideo(r.assetId);
    await finished(r.s, res.job.id);
    r.text.script('anthropic', claude('標題'));
    const t = await r.s.client.ai.submit(job('anthropic'));
    await finished(r.s, t.job.id);

    const s2 = await restart(r);
    await s2.ai.drain();
    expect(r.video.starts).toHaveLength(1);
    expect(r.video.generates).toHaveLength(1);
    expect(r.text.for('anthropic')).toHaveLength(1);
    expect((await s2.client.ai.jobs()).items.every((j) => j.status === 'succeeded')).toBe(true);
  });
});

describe('4. task status and failure reasons are visible', () => {
  it('429 is retried with backoff and, when it does not clear, ends as a readable rate_limited failure', async () => {
    const r = await rig();
    r.text.script(
      'anthropic',
      fail('anthropic', 429, 'rate limit'),
      fail('anthropic', 429, 'rate limit'),
      fail('anthropic', 429, 'rate limit'),
    );
    const j = (await r.s.client.ai.submit(job('anthropic'))).job;
    const done = await finished(r.s, j.id);
    expect(done).toMatchObject({ status: 'failed', error_code: 'rate_limited', attempts: 3 });
    expect(done.error).toBeTruthy();
    const listed = await r.s.client.ai.jobs({ status: 'failed' });
    expect(listed.items.map((x) => x.id)).toContain(j.id);
    const events = r.s.feed
      .since(0)
      .filter((e) => e.entity_id === j.id)
      .map((e) => e.action);
    expect(events.filter((a) => a === 'ai_job.queued')).toHaveLength(3);
    expect(events.at(-1)).toBe('ai_job.failed');
  });

  it('an invalid key fails at once with invalid_key, is not retried, and never echoes the key', async () => {
    const r = await rig();
    r.text.script('anthropic', fail('anthropic', 401, `invalid x-api-key: ${KEYS.anthropic}`));
    const j = (await r.s.client.ai.submit(job('anthropic'))).job;
    const done = await finished(r.s, j.id);
    expect(done).toMatchObject({ status: 'failed', error_code: 'invalid_key', attempts: 1 });
    expect(JSON.stringify(done)).not.toContain(KEYS.anthropic);
    expect(r.text.for('anthropic')).toHaveLength(1);
  });

  it('refusals are content_blocked; a missing key or unconfirmed notice is refused up front with 409', async () => {
    const r = await rig({ keys: ['anthropic'] });
    r.text.script('anthropic', {
      body: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: 'refusal',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    const blocked = await finished(r.s, (await r.s.client.ai.submit(job('anthropic'))).job.id);
    expect(blocked).toMatchObject({ status: 'failed', error_code: 'content_blocked', attempts: 1 });

    expect((await apiError(r.s.client.ai.submit(job('openai')))).code).toBe('ai_key_missing');
    await r.s.client.ai.setKey('openai', KEYS.openai);
    expect((await apiError(r.s.client.ai.submit(job('openai')))).code).toBe('ai_consent_required');
    expect((await r.s.client.ai.jobs()).total).toBe(1);
    expect(r.text.for('openai')).toHaveLength(0);
  });

  it('Gemini processing failure is a readable error and the remote file is deleted', async () => {
    const r = await rig();
    r.video.failProcessing = true;
    const done = await finished(r.s, (await r.s.client.ai.analyzeVideo(r.assetId)).job.id);
    expect(done).toMatchObject({ status: 'failed', error_code: 'file_processing_failed' });
    expect(done.error).toContain('Video codec not supported');
    expect(r.video.deletes).toHaveLength(1);
    expect(r.video.generates).toHaveLength(0);
  });

  it('cancel works on queued and running jobs, and a failed or cancelled job can be retried', async () => {
    const r = await rig({ start: false });
    const queued = (await r.s.client.ai.submit(job('openai'))).job;
    expect((await r.s.client.ai.cancel(queued.id)).status).toBe('cancelled');

    r.text.script('openai', { delayMs: 5000, body: ok('openai', 'late').body });
    const running = (await r.s.client.ai.submit(job('openai'))).job;
    r.s.ai.start();
    await until(() => r.text.for('openai').length === 1, 'the request to reach the provider');
    expect((await r.s.client.ai.cancel(running.id)).status).toBe('cancelled');
    await until(() => r.text.aborted.length === 1, 'the provider call to be aborted');

    r.text.script('openai', ok('openai', '重試的結果'));
    expect((await r.s.client.ai.retry(running.id)).status).toBe('queued');
    expect(await finished(r.s, running.id)).toMatchObject({ status: 'succeeded' });
    expect((await r.s.client.ai.job(queued.id)).status).toBe('cancelled');
  });

  it('a video job interrupted by a service restart finishes once, bills once and leaves no remote copy', async () => {
    const r = await rig();
    r.video.processingPolls = 10_000; // held in Gemini processing
    const res = await r.s.client.ai.analyzeVideo(r.assetId);
    await until(
      async () => (await r.s.client.ai.job(res.job.id)).progress?.phase === 'processing',
      'processing',
    );

    const s2 = await restart(r);
    r.video.processingPolls = 1;
    const done = await finished(s2, res.job.id);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(videoUnderstandingOf(done)).not.toBeNull();
    // Analysed and billed once, and every copy that was uploaded to Gemini is gone again.
    expect(r.video.generates).toHaveLength(1);
    expect(
      (await s2.client.ai.usage()).by_provider.find((p) => p.provider === 'gemini')?.jobs,
    ).toBe(1);
    expect(r.video.deletes).toHaveLength(r.video.files.size);
    expect(r.video.lastUpload()?.equals(r.videoBytes)).toBe(true);
  });

  it('a text job interrupted by a restart runs again exactly once', async () => {
    const r = await rig({ start: false });
    const j = (await r.s.client.ai.submit(job('openai'))).job;
    r.s.db.prepare("UPDATE ai_jobs SET status = 'running' WHERE id = ?").run(j.id);
    const s2 = await restart(r);
    expect((await finished(s2, j.id)).status).toBe('succeeded');
    expect(r.text.for('openai')).toHaveLength(1);
  });
});

describe('secrets, access, consent and the reminder', () => {
  it('no key appears in any API response, event, database row or file under the data directory', async () => {
    const r = await rig();
    r.text.script(
      'anthropic',
      fail('anthropic', 401, `invalid x-api-key: ${KEYS.anthropic}`),
      claude('標題'),
    );
    r.text.script('openai', fail('openai', 401, `Incorrect API key provided: ${KEYS.openai}`));
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    const jobs = [
      (await r.s.client.ai.submit(job('anthropic'))).job.id,
      (await r.s.client.ai.submit(job('openai'))).job.id,
      (await r.s.client.ai.rewrite(work.id, { provider: 'anthropic', mode: 'polish' })).job.id,
      (await r.s.client.ai.analyzeVideo(r.assetId)).job.id,
    ];
    await r.s.ai.drain();

    const bodies: string[] = [];
    const get = async (p: string): Promise<void> => {
      bodies.push(await (await fetch(`${r.s.baseUrl}${p}`, { headers: authHeaders() })).text());
    };
    await get('/api/v1/ai/providers');
    await get('/api/v1/ai/settings');
    await get('/api/v1/ai/jobs');
    await get('/api/v1/ai/usage');
    for (const id of jobs) await get(`/api/v1/ai/jobs/${id}`);
    await get('/docs/json');
    const joined = bodies.join('\n') + JSON.stringify(r.s.feed.since(0));

    const tables = r.s.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    let dump = '';
    for (const { name } of tables) {
      dump += JSON.stringify(r.s.db.prepare(`SELECT * FROM "${name}"`).all());
    }
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(r.home);

    for (const key of Object.values(KEYS)) {
      expect(joined.includes(key), `an API response or event contains ${key.slice(0, 12)}…`).toBe(
        false,
      );
      expect(dump.includes(key), `a database row contains ${key.slice(0, 12)}…`).toBe(false);
      for (const f of files) {
        expect(fs.readFileSync(f).includes(key), `${f} contains ${key.slice(0, 12)}…`).toBe(false);
      }
    }
    expect(files.length).toBeGreaterThan(0);
    // The key store is the only place a key lives.
    expect(await secrets.get('anthropic')).toBe(KEYS.anthropic);
  });

  it('every AI route refuses agent tokens, whatever their scopes (enumerated from the OpenAPI document)', async () => {
    const r = await rig();
    const spec = (await (await fetch(`${r.s.baseUrl}/docs/json`)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const aiRoutes = Object.entries(spec.paths).flatMap(([p, ops]) =>
      p.includes('/ai')
        ? Object.keys(ops)
            .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
            .map((m) => [m.toUpperCase(), p] as const)
        : [],
    );
    expect(aiRoutes.length).toBeGreaterThanOrEqual(19);

    const agent = r.s.tokens.create({ name: 'all', scopes: ['read', 'import', 'write'] });
    const fill = (p: string): string =>
      p
        .replaceAll(/\{provider\}/g, 'openai')
        .replaceAll(/\{(id|jobId)\}/g, '00000000-0000-4000-8000-000000000000');
    for (const [method, p] of aiRoutes) {
      const url = `${r.s.baseUrl}${fill(p)}`;
      const init = { method, body: method === 'GET' ? undefined : '{}' };
      const agentRes = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${agent.secret}`, 'content-type': 'application/json' },
      });
      expect(agentRes.status, `agent ${method} ${p}`).toBe(403);
      const anonymous = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json' },
      });
      expect(anonymous.status, `anonymous ${method} ${p}`).toBe(401);
    }
    // And nothing was sent anywhere.
    expect(r.text.seen).toHaveLength(0);
    expect(r.video.starts).toHaveLength(0);
    // The agent client cannot read or change keys either.
    const agentClient = createClient({ baseUrl: r.s.baseUrl, token: agent.secret });
    expect((await apiError(agentClient.ai.providers())).status).toBe(403);
    expect(
      (await apiError(agentClient.ai.setKey('openai', 'sk-agent-should-not-store'))).status,
    ).toBe(403);
    expect(await secrets.get('openai')).toBe(KEYS.openai);
  });

  it('withdrawing consent or deleting the key stops queued text and video jobs before they send', async () => {
    const r = await rig({ start: false });
    const work = await r.s.client.works.create({ title: '京都秋天', markdown: MARKDOWN });
    const text1 = (await r.s.client.ai.rewrite(work.id, { provider: 'anthropic', mode: 'polish' }))
      .job;
    const text2 = (await r.s.client.ai.submit(job('openai'))).job;
    const vid = (await r.s.client.ai.analyzeVideo(r.assetId)).job;
    await r.s.client.ai.withdrawConsent('anthropic');
    await r.s.client.ai.deleteKey('openai');
    await r.s.client.ai.withdrawConsent('gemini');
    r.s.ai.start();
    await r.s.ai.drain();

    expect(await r.s.client.ai.job(text1.id)).toMatchObject({
      status: 'failed',
      error_code: 'consent_required',
    });
    expect(await r.s.client.ai.job(text2.id)).toMatchObject({
      status: 'failed',
      error_code: 'missing_key',
    });
    expect(await r.s.client.ai.job(vid.id)).toMatchObject({
      status: 'failed',
      error_code: 'consent_required',
    });
    expect(r.text.seen).toHaveLength(0);
    expect(r.video.starts).toHaveLength(0);
    expect(r.video.generates).toHaveLength(0);
  });

  it('the monthly reminder only reminds: text and video jobs still run', async () => {
    const r = await rig();
    await r.s.client.ai.patchSettings({ monthly_budget_usd: 0.000001 });
    r.text.script('anthropic', claude('標題'));
    const t = await r.s.client.ai.submit(job('anthropic'));
    expect(t.budget.over_budget).toBe(true);
    expect(t.budget.warning).toContain('仍會送出');
    expect((await finished(r.s, t.job.id)).status).toBe('succeeded');

    const v = await r.s.client.ai.analyzeVideo(r.assetId);
    expect(v.budget?.over_budget).toBe(true);
    expect((await finished(r.s, v.job.id)).status).toBe('succeeded');
    expect((await r.s.client.ai.usage()).budget.over_budget).toBe(true);
  });
});
