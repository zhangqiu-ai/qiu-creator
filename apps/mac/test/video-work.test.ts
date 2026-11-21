import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AiProvider } from '@qiu-creator/contracts';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeGeminiVideo,
  videoResult,
} from '../../../services/mac-server/test/fake-gemini-video.js';
import { pngBytes } from '../../../services/mac-server/test/fixtures.js';
import { rendererOrigin, APP_ORIGIN } from '../src/main/app-protocol.js';
import { VideoSession } from '../src/renderer/ai-video.js';
import { NEW_TYPES } from '../src/renderer/LibraryPage.js';
import { VariantSession } from '../src/renderer/variant-session.js';
import {
  analyzeBlock,
  frameTimes,
  isLongVideo,
  orientationOf,
  scrubPercent,
  seekBy,
  timeLabel,
  videoBodyCounts,
  videoTagCounts,
  videoTitleCounts,
} from '../src/renderer/video-work.js';
import { WorkSession } from '../src/renderer/work-session.js';

const GB = 1024 * 1024 * 1024;

describe('video work rules (QC-046)', () => {
  it('offers 8 evenly spaced frames, never the first or last instant', () => {
    expect(frameTimes(8)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
    expect(frameTimes(0)).toEqual([]);
    expect(frameTimes(Number.NaN)).toEqual([]);
    expect(frameTimes(100, 4)).toEqual([12.5, 37.5, 62.5, 87.5]);
  });

  it('←→ moves 5 seconds inside the video; the scrubber maps time to percent', () => {
    expect(seekBy(12, 5, 60)).toBe(17);
    expect(seekBy(2, -5, 60)).toBe(0);
    expect(seekBy(58, 5, 60)).toBe(60);
    expect(seekBy(10, 5, Number.NaN)).toBe(15);
    expect(scrubPercent(15, 60)).toBe(25);
    expect(scrubPercent(90, 60)).toBe(100);
    expect(scrubPercent(5, 0)).toBe(0);
    expect(timeLabel(42.9)).toBe('0:42');
    expect(timeLabel(3725)).toBe('1:02:05');
  });

  it('knows before asking the service when a video cannot be analysed', () => {
    expect(analyzeBlock({ bytes: 10, duration: 30 }, true)).toBe('uploading');
    expect(analyzeBlock({ bytes: 3 * GB, duration: 30 }, false)).toBe('too_large');
    expect(analyzeBlock({ bytes: 2 * GB, duration: 30 }, false)).toBeNull();
    expect(analyzeBlock({ bytes: 10, duration: 4 * 3600 }, false)).toBe('too_long');
    expect(analyzeBlock({ bytes: 10, duration: 2 * 3600 }, false)).toBeNull();
    expect(analyzeBlock(null, false)).toBeNull();
  });

  it('a video over 1 hour is a long video (analysed in full at low resolution)', () => {
    expect(isLongVideo({ duration: 3601 })).toBe(true);
    expect(isLongVideo({ duration: 3600 })).toBe(false);
    expect(isLongVideo({ duration: null })).toBe(false);
  });

  it('orientation from the size', () => {
    expect(orientationOf(1080, 1920)).toBe('portrait');
    expect(orientationOf(1920, 1080)).toBe('landscape');
    expect(orientationOf(800, 800)).toBe('square');
    expect(orientationOf(null, 1080)).toBeNull();
  });

  it('counts copy against 抖音 and 視頻號 limits', () => {
    const title = '清晨的嵐山竹林：人最少的時段與路線';
    expect(videoTitleCounts(title)).toEqual([
      { platform: 'douyin', actual: 17, limit: 30, over: false },
      { platform: 'wechat_channels', actual: 17, limit: 16, over: true },
    ]);
    expect(videoBodyCounts('a'.repeat(1001)).every((c) => c.over)).toBe(true);
    expect(videoTagCounts(['1', '2', '3', '4', '5', '6'])).toEqual([
      { platform: 'douyin', actual: 6, limit: 5, over: true },
      { platform: 'wechat_channels', actual: 6, limit: null, over: false },
    ]);
  });

  it('新建 offers video now', () => {
    expect(NEW_TYPES.find((n) => n.type === 'video')?.enabled).toBe(true);
  });
});

describe('frames from the player may be read only by this app (QC-046)', () => {
  it('allows the app origin and the dev server, nothing else', () => {
    expect(rendererOrigin(APP_ORIGIN, null)).toBe(APP_ORIGIN);
    expect(rendererOrigin('http://localhost:5173', 'http://localhost:5173/')).toBe(
      'http://localhost:5173',
    );
    expect(rendererOrigin('http://localhost:5173', null)).toBeNull();
    expect(rendererOrigin('https://evil.example', 'http://localhost:5173/')).toBeNull();
    expect(rendererOrigin(null, null)).toBeNull();
    expect(rendererOrigin('http://localhost:5173', 'not a url')).toBeNull();
  });
});

// ---- Sessions on a real service with a fake Gemini ------------------------------------------

const TOKEN = 'test-token-0123456789abcdef';
const FAKE_KEY = 'AIzaFakeQc046Key0123456789';

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

function webm(): Buffer {
  return fs.readFileSync(
    path.join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'e2e',
      'fixtures',
      'media',
      'portrait-8s.webm',
    ),
  );
}

let server: CreatorHubServer;
let fake: FakeGeminiVideo;
let home: string;
let client: CreatorHubClient;
const disposers: (() => void)[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc046-'));
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
});

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await server.app.close();
  await fake.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function videoWork() {
  const asset = (await client.assets.upload({ filename: 'arashiyama.webm', data: webm() })).asset;
  server.db.prepare('UPDATE assets SET duration = 8 WHERE id = ?').run(asset.id);
  const work = await client.works.create({ title: '嵐山', type: 'video', source: 'mac-app' });
  const session = new WorkSession(client, work, { autosaveMs: 5 });
  disposers.push(() => {
    session.dispose();
  });
  return { asset, work, session };
}

describe('WorkSession for video works (QC-046)', () => {
  it('saves the video, a captured cover and the description in revisions', async () => {
    const { asset, work, session } = await videoWork();
    expect(session.snapshot.draft).toMatchObject({ video: null, cover: null, markdown: '' });
    session.edit({ video: asset.id });
    await session.save();
    const frame = (
      await client.assets.upload({ filename: 'cover-0m03s.png', data: await pngBytes(90, 160) })
    ).asset;
    session.edit({ cover: { asset_id: frame.id }, markdown: '清晨的竹林。' });
    await session.save();
    expect(session.hasUnsavedChanges()).toBe(false);
    const saved = await client.works.get(work.id);
    expect(saved.media?.video?.asset_id).toBe(asset.id);
    expect(saved.media?.cover).toMatchObject({ kind: 'image', item: { asset_id: frame.id } });
    expect(saved.description).toBe('清晨的竹林。');
    expect(session.snapshot.draft.video).toBe(asset.id);
  });

  it('adopts a Gemini suggestion as an ai_accepted revision, and 復原 restores the one before', async () => {
    const { asset, work, session } = await videoWork();
    session.edit({ video: asset.id, title: '嵐山散步' });
    await session.save();
    await client.ai.setKey('gemini', FAKE_KEY);
    fake.generateReplies.push({ body: videoResult({}) });
    const v = new VideoSession(client, 20, work.id);
    disposers.push(() => {
      v.dispose();
    });
    await v.loadProvider();
    await v.select(await client.assets.get(asset.id));
    v.analyze();
    expect(v.snapshot.phase).toBe('confirm');
    await v.confirm();
    await until(() => v.snapshot.phase === 'done', 'analysis');
    const job = v.snapshot.shown;
    if (job === null) throw new Error('no job');
    expect(job.work_id ?? null).toBe(work.id);

    const before = session.snapshot.baseRevision;
    const res = await session.acceptSuggestion(job.id, { title: '清晨的嵐山竹林' });
    expect(res).toEqual({ result: 'accepted', previousRevision: before });
    expect(session.snapshot.draft.title).toBe('清晨的嵐山竹林');
    const revisions = await client.works.revisions(work.id);
    expect(revisions.items[0]?.source).toBe('ai_accepted');

    expect(await session.restore(before)).toBe('restored');
    expect((await client.works.get(work.id)).title).toBe('嵐山散步');
  });

  it('does not adopt over unsaved edits', async () => {
    const { asset, session } = await videoWork();
    session.edit({ video: asset.id });
    await session.save();
    session.edit({ title: '' });
    const res = await session.acceptSuggestion('01J0000000000000000000000', { title: 'x' });
    expect(res.result).toBe('blocked');
  });
});

describe('platform copy follows the shared copy or its own (QC-046)', () => {
  it('turning 沿用 off drafts the platform from the work; on again shows the shared copy, keeping its own', async () => {
    const { asset, work, session } = await videoWork();
    session.edit({ video: asset.id, title: '共用標題', markdown: '共用簡介' });
    await session.save();
    const douyin = new VariantSession(client, work.id, 'douyin', null, 5);
    disposers.push(() => {
      douyin.dispose();
    });
    await douyin.setInherit(false);
    expect(douyin.snapshot.record?.inherit).toBe(false);
    douyin.edit({ title: '抖音自己的標題' });
    await douyin.save();
    expect((await client.variants.get(work.id, 'douyin')).title).toBe('抖音自己的標題');

    await douyin.setInherit(true);
    const following = await client.variants.get(work.id, 'douyin');
    expect(following.inherit).toBe(true);
    expect(following.title).toBe('共用標題');
    await douyin.setInherit(false);
    expect((await client.variants.get(work.id, 'douyin')).title).toBe('抖音自己的標題');
  });

  it('turning 沿用 on for a platform without a version does nothing', async () => {
    const { work } = await videoWork();
    const channels = new VariantSession(client, work.id, 'wechat_channels', null, 5);
    disposers.push(() => {
      channels.dispose();
    });
    await channels.setInherit(true);
    expect(channels.snapshot.record).toBeNull();
    expect((await client.variants.list(work.id)).items).toEqual([]);
  });
});

describe('our own revision echoed over SSE while the request is in flight (QC-046 fix)', () => {
  it('is recognised as ours after restore, not reported as changed elsewhere', async () => {
    const work = await client.works.create({ title: '第一版', markdown: 'a\n', source: 'mac-app' });
    const second = await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: '第二版',
    });
    // The SSE `work.updated` for the new revision lands before the HTTP response.
    let session: WorkSession | null = null;
    const racing: CreatorHubClient = {
      ...client,
      works: {
        ...client.works,
        restore: async (...args: Parameters<CreatorHubClient['works']['restore']>) => {
          const restored = await client.works.restore(...args);
          void session?.remoteRevision(restored.current_revision_id, 'restore');
          return restored;
        },
      },
    };
    const s = new WorkSession(racing, second, { autosaveMs: 5 });
    session = s;
    disposers.push(() => {
      s.dispose();
    });
    expect(await s.restore(work.current_revision_id)).toBe('restored');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.snapshot.remote).toBeNull();
    expect(s.snapshot.draft.title).toBe('第一版');
    // And the next restore is not blocked by a phantom remote change.
    expect(await s.restore(second.current_revision_id)).toBe('restored');
  });
});
