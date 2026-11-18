import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AiJobRecord, AiProvider, AssetRecord } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeGeminiVideo,
  videoResult,
} from '../../../services/mac-server/test/fake-gemini-video.js';
import { AiSettingsStore, formatUsd, keyState, modelOptions } from '../src/renderer/ai-settings.js';
import { AiActivity, runLabel, uploadPercent, VideoSession } from '../src/renderer/ai-video.js';

/**
 * Integration (QC-025): AI settings and the AI 工作台 video flow against a
 * real mac-server. Gemini is the local fake from the server's tests (Files API
 * and generateContent); keys live in memory. Nothing leaves the machine.
 */
const TOKEN = 'test-token-0123456789abcdef';
const FAKE_KEY = 'AIzaFakeQc025Key0123456789';

class MemorySecrets {
  private readonly values = new Map<AiProvider, string>();
  get(p: AiProvider) {
    return Promise.resolve(this.values.get(p) ?? null);
  }
  set(p: AiProvider, v: string) {
    this.values.set(p, v);
    return Promise.resolve();
  }
  delete(p: AiProvider) {
    return Promise.resolve(this.values.delete(p));
  }
}

let server: CreatorHubServer;
let fake: FakeGeminiVideo;
let home: string;
let client: CreatorHubClient;
let asset: AssetRecord;
const disposers: (() => void)[] = [];

function mp4(size: number): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const body = Buffer.alloc(size - ftyp.length);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([ftyp, body]);
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-aiw-'));
  fake = new FakeGeminiVideo();
  await fake.start();
  server = await buildServer({
    config: { home, token: TOKEN },
    ai: {
      secrets: new MemorySecrets(),
      baseUrls: { gemini: fake.baseUrl() },
      retryBaseMs: 10,
      pollMs: 10,
      timeoutMs: 2000,
      video: { chunkBytes: 256 * 1024, pollMs: 10, processingTimeoutMs: 2000 },
    },
  });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  asset = (await client.assets.upload({ filename: 'arashiyama.mp4', data: mp4(600 * 1024) })).asset;
  server.db.prepare('UPDATE assets SET duration = 30 WHERE id = ?').run(asset.id);
  asset = await client.assets.get(asset.id);
});

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await server.app.close();
  await fake.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

function session() {
  const v = new VideoSession(client, 20);
  disposers.push(() => {
    v.dispose();
  });
  return v;
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const videoJobs = async () =>
  (await client.ai.jobs({ limit: 200 })).items.filter(
    (j) => j.task?.type === 'video_understanding',
  );

describe('AiSettingsStore', () => {
  it('stores a key write-only, needs the notice, and can withdraw and delete', async () => {
    const store = new AiSettingsStore(client);
    await store.load();
    const gemini = () => store.snapshot.providers?.find((p) => p.provider === 'gemini');
    expect(store.snapshot.providers?.map((p) => p.provider)).toEqual([
      'gemini',
      'anthropic',
      'openai',
    ]);
    expect(keyState(gemini() ?? fail())).toBe('none');

    expect(await store.saveKey('gemini', '   ')).toBe(false);
    expect(store.snapshot.error).toEqual({ target: 'gemini', message: '請輸入金鑰' });

    expect(await store.saveKey('gemini', `  ${FAKE_KEY}  `)).toBe(true);
    expect(keyState(gemini() ?? fail())).toBe('needs_consent');
    // The key is never part of what the window holds or the API returns.
    expect(JSON.stringify(store.snapshot)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(await client.ai.providers())).not.toContain(FAKE_KEY);

    const notice = gemini()?.notice;
    expect(notice?.text).toContain('Google');
    expect(await store.consent('gemini', notice?.version ?? 0)).toBe(true);
    expect(keyState(gemini() ?? fail())).toBe('ready');

    expect(await store.setModel('gemini', 'video', 'gemini-3.5-flash-lite')).toBe(true);
    expect(gemini()?.video_model).toBe('gemini-3.5-flash-lite');

    expect(await store.withdrawConsent('gemini')).toBe(true);
    expect(keyState(gemini() ?? fail())).toBe('needs_consent');
    expect(await store.deleteKey('gemini')).toBe(true);
    expect(keyState(gemini() ?? fail())).toBe('none');
  });

  it('sets and clears the monthly reminder and rejects negative amounts', async () => {
    const store = new AiSettingsStore(client);
    await store.load();
    expect(await store.setBudget(5)).toBe(true);
    expect(store.snapshot.settings?.monthly_budget_usd).toBe(5);
    expect(store.snapshot.usage?.budget.budget_usd).toBe(5);
    expect(await store.setBudget(-1)).toBe(false);
    expect(store.snapshot.error?.target).toBe('budget');
    expect(await store.setBudget(null)).toBe(true);
    expect(store.snapshot.settings?.monthly_budget_usd).toBeNull();
  });

  it('formats small costs without rounding them to $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0084)).toBe('$0.0084');
    expect(formatUsd(1.861)).toBe('$1.86');
    expect(formatUsd(null)).toBe('—');
  });

  it('offers the reference models of a provider plus a custom current one', () => {
    expect(modelOptions('gemini', null).every((m) => m.startsWith('gemini-'))).toBe(true);
    expect(modelOptions('anthropic', 'claude-custom')[0]).toBe('claude-custom');
    expect(modelOptions('openai', 'gpt-5.5').filter((m) => m === 'gpt-5.5')).toHaveLength(1);
  });
});

function fail(): never {
  throw new Error('missing provider');
}

describe('VideoSession', () => {
  it('shows 未設定 Gemini 金鑰 without a key', async () => {
    const v = session();
    await v.loadProvider();
    expect(v.snapshot.noKey).toBe(true);
  });

  it('estimates, confirms the notice on first use, uploads and shows a result to verify', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    const v = session();
    await v.loadProvider();
    expect(v.snapshot).toMatchObject({ noKey: false, model: 'gemini-3.8-flash' });
    await v.select(asset);
    expect(v.snapshot.phase).toBe('ready');
    expect(v.snapshot.estimate).toMatchObject({
      duration_seconds: 30,
      duration_source: 'metadata',
      cached_job_id: null,
    });
    expect(v.snapshot.estimate?.estimate.estimated).toBe(true);

    v.analyze();
    expect(v.snapshot.phase).toBe('confirm');
    await v.confirm();
    // The notice was confirmed by 同意並上傳分析.
    expect((await client.ai.providers()).items.find((p) => p.provider === 'gemini')?.ready).toBe(
      true,
    );
    await until(() => v.snapshot.phase === 'done', 'result');
    expect(fake.chunks.length).toBeGreaterThan(1);
    const r = v.snapshot.result;
    expect(r?.summary).toContain('嵐山');
    expect(r?.key_moments.map((m) => m.needs_verification)).toEqual([true, true, true]);
    expect(r?.key_moments.find((m) => m.time_seconds === 95)?.within_duration).toBe(false);
    expect(v.snapshot.previous?.status).toBe('succeeded');
  });

  it('offers 沿用結果 for free and charges only for an explicit 重新分析', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    const first = session();
    await first.loadProvider();
    await first.select(asset);
    first.analyze();
    await first.confirm();
    await until(() => first.snapshot.phase === 'done', 'first result');

    const v = session();
    await v.loadProvider();
    await v.select(asset);
    // A known result is shown straight away.
    expect(v.snapshot.phase).toBe('done');
    v.analyze();
    expect(v.snapshot.phase).toBe('reuse');
    await v.reuse();
    expect(v.snapshot.phase).toBe('done');
    expect(await videoJobs()).toHaveLength(1);

    v.analyze();
    v.rerun();
    expect(v.snapshot).toMatchObject({ phase: 'confirm', reanalyze: true });
    await v.confirm();
    await until(() => v.snapshot.phase === 'done' && v.snapshot.job === null, 'second result');
    expect(await videoJobs()).toHaveLength(2);
  });

  it('shows a failure with its reason, offers the last result, and retries', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    const v = session();
    await v.loadProvider();
    await v.select(asset);
    v.analyze();
    await v.confirm();
    await until(() => v.snapshot.phase === 'done', 'first result');

    fake.generateReplies.push({ status: 400, body: { error: { code: 400, message: 'bad' } } });
    v.analyze();
    v.rerun();
    await v.confirm();
    await until(() => v.snapshot.phase === 'failed', 'failure');
    expect(v.snapshot.failure?.code).toBe('bad_request');
    v.showPrevious();
    expect(v.snapshot.phase).toBe('done');

    fake.generateReplies.push({ status: 400, body: { error: { code: 400, message: 'bad' } } });
    v.analyze();
    v.rerun();
    await v.confirm();
    await until(() => v.snapshot.phase === 'failed', 'second failure');
    fake.generateReplies.push({
      body: videoResult({ summary: '重試後的摘要' }),
    });
    await v.retry();
    await until(() => v.snapshot.result?.summary === '重試後的摘要', 'retried result');
  });

  it('cancels a running analysis', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    fake.processingPolls = 10_000;
    const v = session();
    await v.loadProvider();
    await v.select(asset);
    v.analyze();
    await v.confirm();
    expect(v.snapshot.phase).toBe('running');
    const id = v.snapshot.job?.id ?? '';
    await until(() => fake.files.size > 0, 'upload');
    await v.cancel();
    expect(v.snapshot.phase).toBe('ready');
    let job: AiJobRecord = await client.ai.job(id);
    for (let i = 0; i < 100 && job.status !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = await client.ai.job(id);
    }
    expect(job.status).toBe('cancelled');
  });

  it('picks low resolution for videos longer than the default limit', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    server.db.prepare('UPDATE assets SET duration = 4000 WHERE id = ?').run(asset.id);
    const long = await client.assets.get(asset.id);
    const v = session();
    await v.loadProvider();
    await v.select(long);
    expect(v.snapshot).toMatchObject({ resolution: 'low', autoLow: true, estimateError: null });
    expect(v.snapshot.estimate?.resolution).toBe('low');
    // Going back to the default resolution explains why it cannot be sent.
    await v.setResolution('default');
    expect(v.snapshot.estimate).toBeNull();
    expect(v.snapshot.estimateError).toContain('低解析度');
  });

  it('labels the run and only shows a percentage while uploading', () => {
    const job = (progress: AiJobRecord['progress'], status: AiJobRecord['status'] = 'running') =>
      ({ status, progress }) as AiJobRecord;
    expect(uploadPercent(job({ phase: 'uploading', uploaded_bytes: 50, total_bytes: 200 }))).toBe(
      25,
    );
    expect(uploadPercent(job({ phase: 'processing', uploaded_bytes: 200, total_bytes: 200 }))).toBe(
      null,
    );
    expect(runLabel(job({ phase: 'processing', uploaded_bytes: 0, total_bytes: 0 }))).toBe(
      'Gemini 處理影片中',
    );
    expect(runLabel(job(null, 'queued'))).toBe('排隊中');
  });
});

describe('AiActivity', () => {
  it('lists recent jobs and this month’s estimated usage', async () => {
    await client.ai.setKey('gemini', FAKE_KEY);
    const v = session();
    await v.loadProvider();
    await v.select(asset);
    v.analyze();
    await v.confirm();
    await until(() => v.snapshot.phase === 'done', 'result');
    const a = new AiActivity(client);
    await a.load();
    expect(a.snapshot.jobs?.[0]?.task?.type).toBe('video_understanding');
    const gemini = a.snapshot.usage?.by_provider.find((p) => p.provider === 'gemini');
    expect(gemini?.jobs).toBe(1);
    expect(a.snapshot.usage?.budget.spent_usd).toBeGreaterThan(0);
  });
});
