import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import {
  charCount,
  PLATFORM_LIMITS,
  type ChangeEvent,
  type Platform,
  type VariantView,
} from '@qiu-creator/contracts';
import { deriveVariantBody } from '@qiu-creator/platform-preview';
import { afterEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes } from './fixtures.js';
import { authHeaders, startTestServer, type TestServer } from './helpers.js';

const PLATFORMS: Platform[] = ['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels'];
const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A PNG file in a throwaway folder (for `registerFromFile`). */
async function tmpPng(size: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-png-'));
  dirs.push(dir);
  const f = path.join(dir, `p${String(size)}.png`);
  fs.writeFileSync(f, await pngBytes(size, size));
  return f;
}

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { pollMs: 5 } });
  servers.push(s);
  return s;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const variantEvents = (s: TestServer, workId: string): ChangeEvent[] =>
  s.feed.since(0).filter((e) => e.entity_id === workId && e.action.startsWith('work.variant_'));

async function upload(s: TestServer, size: number): Promise<string> {
  return (
    await s.client.assets.upload({
      filename: `i${String(size)}.png`,
      data: await pngBytes(size, 4),
    })
  ).asset.id;
}

const MARKDOWN = [
  '---',
  'draft: true',
  '---',
  '# 京都秋天',
  '',
  '今年的**紅葉**比往年更早轉紅，[地圖](https://example.com/map)在這。',
  '',
  '## 行程',
  '',
  '- 清水寺',
  '- 嵐山',
].join('\n');

/** A work with two linked `body` images and a linked `cover`. */
async function richWork(s: TestServer) {
  const work = await s.client.works.create({
    title: '京都秋天',
    markdown: MARKDOWN,
    tags: ['旅行', '京都'],
  });
  const a = s.assets.registerFromFile(work.id, await tmpPng(12), { role: 'body' }).id;
  const b = s.assets.registerFromFile(work.id, await tmpPng(14), { role: 'body' }).id;
  const cover = await upload(s, 13);
  await s.client.workAssets.link(work.id, { asset_id: cover, role: 'cover' });
  return { work, a, b, cover };
}

describe('resolved view (QC-084)', () => {
  it('every platform follows the work until something is overridden', async () => {
    const s = await start();
    const { work, a, b, cover } = await richWork(s);
    const list = await s.client.variants.list(work.id);
    expect(list.items.map((v) => v.platform)).toEqual(PLATFORMS);
    for (const v of list.items) {
      expect(v).toMatchObject({
        exists: false,
        revision: 0,
        title: '京都秋天',
        title_source: 'work',
        body_source: 'work',
        cover: { asset_id: cover },
        cover_source: 'work',
        images: [a, b],
        images_source: 'work',
        hidden_images: [],
        tags: ['旅行', '京都'],
        tags_source: 'work',
        updated_at: null,
      });
      const derived = deriveVariantBody(MARKDOWN, v.platform, { title: '京都秋天' });
      expect(v.body).toBe(derived.text);
      expect(v.body_format).toBe(derived.format);
    }
    expect(list.items[0]?.body).toBe(
      '今年的紅葉比往年更早轉紅，地圖在這。\n\n行程\n\n• 清水寺\n• 嵐山',
    );
    expect(list.items[1]?.body.startsWith('今年的**紅葉**')).toBe(true);
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`, {
      headers: authHeaders(),
    });
    expect(res.headers.get('etag')).toBe('"0"');
    // Reading writes nothing.
    expect(variantEvents(s, work.id)).toEqual([]);
  });

  it('the body follows later edits of the work; no variant event for them', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T', markdown: '第一版' });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 0, title: '抖音標題' });
    await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '第二版',
      tags: ['新'],
    });
    const v = await s.client.variants.get(work.id, 'douyin');
    expect(v).toMatchObject({ body: '第二版', title: '抖音標題', tags: ['新'], revision: 1 });
    expect(variantEvents(s, work.id).map((e) => e.action)).toEqual(['work.variant_changed']);
  });

  it('image and video works derive the body from their description', async () => {
    const s = await start();
    const work = await s.client.works.create({
      type: 'image',
      title: '貼圖',
      description: '  圖說 **原樣**\n\n第二段 ',
    });
    for (const v of (await s.client.variants.list(work.id)).items) {
      expect(v).toMatchObject({ body: '圖說 **原樣**\n\n第二段', images: [], cover: null });
    }
  });
});

describe('overrides', () => {
  it('set, follow again with null, and never touch the work or other platforms', async () => {
    const s = await start();
    const { work, a, b, cover } = await richWork(s);
    const other = await upload(s, 30);
    const before = await s.client.variants.list(work.id);
    const v1 = await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 0,
      title: '小紅書標題',
      tags: ['x', 'x', 'y'],
      cover: { asset_id: other },
      images: [b],
    });
    expect(v1).toMatchObject({
      exists: true,
      revision: 1,
      title: '小紅書標題',
      title_source: 'override',
      tags: ['x', 'y'],
      tags_source: 'override',
      cover: { asset_id: other },
      cover_source: 'override',
      images: [b],
      images_source: 'override',
      hidden_images: [a],
    });
    const after = await s.client.variants.list(work.id);
    const others = (items: VariantView[]) => items.filter((v) => v.platform !== 'xiaohongshu');
    expect(others(after.items)).toEqual(others(before.items));
    const original = await s.client.works.get(work.id);
    expect(original).toMatchObject({ title: '京都秋天', markdown: MARKDOWN });
    expect((await s.client.works.revisions(work.id)).items).toHaveLength(1);

    const v2 = await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 1,
      title: null,
      cover: null,
      images: null,
      tags: null,
    });
    expect(v2).toMatchObject({
      revision: 2,
      exists: true,
      title: '京都秋天',
      title_source: 'work',
      cover: { asset_id: cover },
      cover_source: 'work',
      images: [a, b],
      images_source: 'work',
      hidden_images: [],
      tags_source: 'work',
    });
  });

  it('a patch that changes nothing keeps the revision and sends no event', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    const v1 = await s.client.variants.patch(work.id, 'douyin', { base_revision: 0, title: 'A' });
    const same = await s.client.variants.patch(work.id, 'douyin', { base_revision: 1, title: 'A' });
    expect(same.revision).toBe(1);
    expect(same).toEqual(v1);
    // Clearing what already follows on a platform without a row creates nothing.
    const none = await s.client.variants.patch(work.id, 'wechat_mp', {
      base_revision: 0,
      tags: null,
      body: null,
    });
    expect(none).toMatchObject({ exists: false, revision: 0 });
    expect(variantEvents(s, work.id).map((e) => [e.action, e.data])).toEqual([
      ['work.variant_changed', { platform: 'douyin', revision: 1, fields: ['title'] }],
    ]);
  });

  it('rejects a body: the platform body follows the work', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T', markdown: '原文' });
    const err = await apiError(
      s.client.variants.patch(work.id, 'douyin', { base_revision: 0, body: '平台正文' }),
    );
    expect(err.status).toBe(400);
    expect(err.body?.error.code).toBe('body_not_editable');
    // Old fields are refused by the strict schema.
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ base_revision: 0, inherit: true }),
    });
    expect(res.status).toBe(400);
    expect((await s.client.variants.get(work.id, 'douyin')).revision).toBe(0);
  });

  it('image order: hidden images stay hidden, new work images show after, removed ones vanish', async () => {
    const s = await start();
    const { work, a, b } = await richWork(s);
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 0, images: [b] });
    const c = s.assets.registerFromFile(work.id, await tmpPng(16), { role: 'body' }).id;
    let v = await s.client.variants.get(work.id, 'douyin');
    expect(v).toMatchObject({ images: [b, c], hidden_images: [a] });
    await s.client.workAssets.unlink(work.id, b, 'body');
    v = await s.client.variants.get(work.id, 'douyin');
    expect(v).toMatchObject({ images: [c], hidden_images: [a] });
    // Order only: an image that is not the work's is refused.
    const foreign = await upload(s, 40);
    const err = await apiError(
      s.client.variants.patch(work.id, 'douyin', { base_revision: 1, images: [c, foreign] }),
    );
    expect(err.status).toBe(400);
    expect(err.body?.error.details?.['invalid_asset_ids']).toEqual([foreign]);
  });

  it('validates covers and images', async () => {
    const s = await start();
    const { work, a } = await richWork(s);
    const video = (await s.client.assets.upload({ filename: 'v.mp4', data: mp4Bytes() })).asset.id;
    const badCover = await apiError(
      s.client.variants.patch(work.id, 'xiaohongshu', {
        base_revision: 0,
        cover: { asset_id: video },
      }),
    );
    expect(badCover.status).toBe(400);
    expect(badCover.body?.error.details?.['invalid_asset_ids']).toEqual([video]);
    const frame = await apiError(
      s.client.variants.patch(work.id, 'xiaohongshu', {
        base_revision: 0,
        cover: { time_seconds: 1 },
      }),
    );
    expect(frame.status).toBe(400);
    const repeated = await apiError(
      s.client.variants.patch(work.id, 'xiaohongshu', { base_revision: 0, images: [a, a] }),
    );
    expect(repeated.status).toBe(400);
    const unknown = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/weibo`, {
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(400);
    expect((await s.client.variants.get(work.id, 'xiaohongshu')).revision).toBe(0);
  });

  it('variants of different works are independent', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A' });
    const b = await s.client.works.create({ title: 'B' });
    await s.client.variants.patch(a.id, 'douyin', { base_revision: 0, title: 'A2' });
    expect((await s.client.variants.get(b.id, 'douyin')).title).toBe('B');
    expect((await s.client.variants.get(a.id, 'douyin')).title).toBe('A2');
  });
});

describe('revisions and conflicts', () => {
  it('concurrent first overrides from base 0: exactly one wins, the others get 409', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    const send = (title: string) =>
      fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/xiaohongshu`, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ base_revision: 0, title }),
      });
    const results = await Promise.all(['甲', '乙', '丙', '丁'].map(send));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200);
    const winnerTitle = ((await winner?.json()) as { title: string }).title;
    for (const r of results.filter((x) => x.status === 409)) {
      const body = (await r.json()) as { error: { code: string; details: unknown } };
      expect(body.error.code).toBe('revision_conflict');
      expect(body.error.details).toEqual({ current_revision: 1, base_revision: '0' });
    }
    expect(await s.client.variants.get(work.id, 'xiaohongshu')).toMatchObject({
      revision: 1,
      title: winnerTitle,
    });
    expect((await s.client.variants.revisions(work.id, 'xiaohongshu')).items).toHaveLength(1);
  });

  it('If-Match, 428, stale base and ETag', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    const missing = await apiError(s.client.variants.patch(work.id, 'wechat_mp', { title: 'x' }));
    expect(missing.status).toBe(428);
    const v1 = await s.client.variants.patch(work.id, 'wechat_mp', { title: 'x' }, { ifMatch: 0 });
    expect(v1.revision).toBe(1);
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/wechat_mp`, {
      headers: authHeaders(),
    });
    expect(res.headers.get('etag')).toBe('"1"');
    const stale = await apiError(
      s.client.variants.patch(work.id, 'wechat_mp', { title: 'y' }, { ifMatch: 0 }),
    );
    expect(stale.status).toBe(409);
    expect(stale.currentVariantRevision).toBe(1);
    // Body and header disagreeing is a conflict, never "whichever matches".
    const mixed = await apiError(
      s.client.variants.patch(
        work.id,
        'wechat_mp',
        { base_revision: 0, title: 'z' },
        { ifMatch: 1 },
      ),
    );
    expect(mixed.status).toBe(409);
    expect((await s.client.variants.get(work.id, 'wechat_mp')).title).toBe('x');
  });

  it('history lists override changes only', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '一', markdown: '原文' });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 0, title: '甲' });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 1, tags: ['t'] });
    await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: '改了原文',
    });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 2, title: null });
    const history = (await s.client.variants.revisions(work.id, 'douyin')).items;
    expect(
      history.map((r) => [r.revision, r.source, r.overrides?.title, r.overrides?.tags]),
    ).toEqual([
      [3, 'override', null, ['t']],
      [2, 'override', '甲', ['t']],
      [1, 'override', '甲', null],
    ]);
    expect(history.every((r) => r.legacy === null)).toBe(true);
    expect((await s.client.variants.revision(work.id, 'douyin', 2)).overrides?.title).toBe('甲');
    expect((await apiError(s.client.variants.revision(work.id, 'douyin', 9))).status).toBe(404);
    expect((await apiError(s.client.variants.revisions(work.id, 'wechat_mp'))).status).toBe(404);
  });

  it('delete drops every override, keeps history, and revisions never repeat (QC-019)', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 0, title: '甲' });
    const del = (h: Record<string, string>) =>
      fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`, {
        method: 'DELETE',
        headers: authHeaders(h),
      });
    expect((await del({})).status).toBe(428);
    expect((await del({ 'if-match': '"7"' })).status).toBe(409);
    const appCopy = await s.client.variants.get(work.id, 'douyin');
    await s.client.variants.remove(work.id, 'douyin', 1);
    expect(await s.client.variants.get(work.id, 'douyin')).toMatchObject({
      exists: false,
      revision: 2,
      title: 'T',
      title_source: 'work',
    });
    expect((await del({ 'if-match': '"2"' })).status).toBe(404);
    const [deleted] = variantEvents(s, work.id).filter((e) => e.action === 'work.variant_deleted');
    expect(deleted?.data).toEqual({ platform: 'douyin', revision: 2 });

    // A client still holding revision 1 gets 409; a new override continues at 3.
    const stale = await apiError(
      s.client.variants.patch(work.id, 'douyin', { base_revision: appCopy.revision, title: '舊' }),
    );
    expect(stale.status).toBe(409);
    expect(stale.currentVariantRevision).toBe(2);
    const again = await s.client.variants.patch(work.id, 'douyin', {
      base_revision: 2,
      title: '乙',
    });
    expect(again).toMatchObject({ exists: true, revision: 3 });
    expect(
      (await s.client.variants.revisions(work.id, 'douyin')).items.map((r) => [
        r.revision,
        r.overrides?.title ?? null,
      ]),
    ).toEqual([
      [3, '乙'],
      [2, null],
      [1, '甲'],
    ]);
  });
});

describe('deprecated generate and draft endpoints', () => {
  it('generate creates rows without overrides; draft follows the work again', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T', markdown: '原文' });
    const res = await s.client.variants.generate(work.id, { platforms: ['douyin', 'wechat_mp'] });
    expect(res.created.map((v) => [v.platform, v.revision, v.exists])).toEqual([
      ['wechat_mp', 1, true],
      ['douyin', 1, true],
    ]);
    expect(res.created.every((v) => v.title_source === 'work' && v.body === '原文')).toBe(true);
    expect(await s.client.variants.generate(work.id, { platforms: ['douyin'] })).toEqual({
      created: [],
      skipped: ['douyin'],
    });

    await s.client.variants.patch(work.id, 'douyin', { base_revision: 1, title: '甲' });
    expect((await apiError(s.client.variants.redraft(work.id, 'douyin'))).status).toBe(428);
    expect((await apiError(s.client.variants.redraft(work.id, 'douyin', 1))).status).toBe(409);
    const v = await s.client.variants.redraft(work.id, 'douyin', 2);
    expect(v).toMatchObject({ revision: 3, title: 'T', title_source: 'work' });

    const created = await fetch(
      `${s.baseUrl}/api/v1/works/${work.id}/variants/wechat_channels/draft`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: '{}',
      },
    );
    expect(created.status).toBe(201);
  });
});

describe('limits, events and permissions', () => {
  it('warns on resolved values; body_too_long says where the platform cuts', async () => {
    const s = await start();
    const limit = PLATFORM_LIMITS.xiaohongshu;
    const bodyMax = limit.bodyMaxChars ?? 0;
    const markdown = `# T\n\n**粗**${'字'.repeat(bodyMax)}`;
    const work = await s.client.works.create({ title: 'T', markdown });
    const v = await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 0,
      title: '標'.repeat((limit.titleMaxChars ?? 0) + 1),
    });
    expect(v.warnings.map((w) => [w.code, w.limit, w.actual])).toEqual([
      ['title_too_long', limit.titleMaxChars, (limit.titleMaxChars ?? 0) + 1],
      ['body_too_long', bodyMax, bodyMax + 1],
    ]);
    const body = v.warnings.find((w) => w.code === 'body_too_long');
    expect(body?.cut_at).toBe(bodyMax);
    // The cut falls before the last 字: in the source that is its offset.
    expect(body?.source_offset).toBe(markdown.length - 1);
    expect(charCount(v.body)).toBe(bodyMax + 1);
    expect(v.body).toBe(`粗${'字'.repeat(bodyMax)}`);
    // 公眾號 takes 20000 characters.
    expect((await s.client.variants.get(work.id, 'wechat_mp')).warnings).toEqual([]);
  });

  it('agent tokens: read can list, write is needed to change', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    const reader = s.tokens.create({ name: 'r', scopes: ['read'] });
    const writer = s.tokens.create({ name: 'w', scopes: ['write'] });
    const url = `${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`;
    const patch = (secret: string) =>
      fetch(url, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision: 0, title: 'agent' }),
      });
    expect(
      (await fetch(url, { headers: { authorization: `Bearer ${reader.secret}` } })).status,
    ).toBe(200);
    expect((await patch(reader.secret)).status).toBe(403);
    expect((await patch(writer.secret)).status).toBe(200);
  });
});
