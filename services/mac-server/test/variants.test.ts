import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import {
  charCount,
  PLATFORM_LIMITS,
  type ChangeEvent,
  type Platform,
  type PlatformVariantRecord,
} from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownForArticle, markdownToPlainText } from '../src/variants/draft.js';
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

const MARKDOWN = [
  '---',
  'draft: true',
  '---',
  '# 京都秋天',
  '',
  '今年的**紅葉**比往年更早轉紅，[地圖](https://example.com/map)在這。',
  '',
  '![](assets/a.png)',
  '',
  '## 行程',
  '',
  '- 清水寺',
  '- 嵐山',
  '',
  '1. 早上',
  '2. 下午',
  '',
  '<div>不是正文</div>',
  '',
  '![](assets/b.png)',
].join('\n');

/**
 * A work whose Markdown references two unregistered files in `assets/`, plus
 * a linked `cover` and one extra linked `body` image.
 */
async function richWork(s: TestServer) {
  const work = await s.client.works.create({
    title: '京都秋天',
    markdown: MARKDOWN,
    tags: ['旅行', '京都'],
  });
  const assetsDir = path.join(s.home, 'library/works', work.id, 'assets');
  fs.copyFileSync(await tmpPng(10), path.join(assetsDir, 'a.png'));
  fs.copyFileSync(await tmpPng(11), path.join(assetsDir, 'b.png'));
  const extra = s.assets.registerFromFile(work.id, await tmpPng(12), { role: 'body' }).id;
  const cover = (await s.client.assets.upload({ filename: 'c.png', data: await pngBytes(13, 13) }))
    .asset.id;
  await s.client.workAssets.link(work.id, { asset_id: cover, role: 'cover' });
  return { work, extra, cover };
}

describe('rule-based drafts', () => {
  it('converts Markdown to plain text for posts and keeps Markdown for articles', () => {
    const plain = markdownToPlainText(MARKDOWN, '京都秋天');
    expect(plain).toBe(
      ['今年的紅葉比往年更早轉紅，地圖在這。', '行程', '• 清水寺\n• 嵐山', '1. 早上\n2. 下午'].join(
        '\n\n',
      ),
    );
    const article = markdownForArticle(MARKDOWN, '京都秋天');
    expect(article.startsWith('今年的**紅葉**')).toBe(true);
    expect(article).toContain('![](assets/b.png)');
    expect(article).not.toContain('draft: true');
    // A first heading that is not the title is kept.
    expect(markdownToPlainText('# 別的\n\n內容', '標題')).toBe('別的\n\n內容');
    expect(markdownForArticle('# 別的\n\n內容', '標題')).toBe('# 別的\n\n內容');
  });

  it('generates all four platforms from the original without touching it', async () => {
    const s = await start();
    const { work, extra, cover } = await richWork(s);
    const res = await s.client.variants.generate(work.id);
    expect(res.skipped).toEqual([]);
    expect(res.created.map((v) => v.platform)).toEqual(PLATFORMS);
    for (const v of res.created) {
      expect(v).toMatchObject({
        title: '京都秋天',
        tags: ['旅行', '京都'],
        revision: 1,
        cover_asset_id: cover,
        image_asset_ids: [extra],
        source_work_revision_id: work.current_revision_id,
      });
    }
    const byPlatform = Object.fromEntries(res.created.map((v) => [v.platform, v]));
    expect(byPlatform['xiaohongshu']?.body).toBe(markdownToPlainText(MARKDOWN, '京都秋天'));
    expect(byPlatform['wechat_mp']?.body).toBe(markdownForArticle(MARKDOWN, '京都秋天'));

    const after = await s.client.works.get(work.id);
    expect(after.markdown).toBe(MARKDOWN);
    expect(after.current_revision_id).toBe(work.current_revision_id);
    expect(variantEvents(s, work.id).map((e) => [e.action, e.data['platform']])).toEqual(
      PLATFORMS.map((p) => ['work.variant_created', p]),
    );

    // Second call: nothing created, nothing changed.
    const again = await s.client.variants.generate(work.id, { platforms: ['douyin'] });
    expect(again).toEqual({ created: [], skipped: ['douyin'] });
    expect((await s.client.variants.get(work.id, 'douyin')).revision).toBe(1);
  });

  it('uses Markdown images that are registered assets, in document order, then linked images', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 't', markdown: '![](assets/x.png)' });
    const x = s.assets.registerFromFile(work.id, await tmpPng(14), { role: 'body' });
    // registerFromFile stores `assets/<id>.png`; reference it from the Markdown.
    const rel = `assets/${x.id}.png`;
    expect(fs.existsSync(path.join(s.home, 'library/works', work.id, rel))).toBe(true);
    const y = s.assets.registerFromFile(work.id, await tmpPng(15), { role: 'body' });
    const w2 = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `![](assets/${y.id}.png)\n\n![](${rel})`,
    });
    const v = await s.client.variants.redraft(w2.id, 'xiaohongshu');
    expect(v.image_asset_ids).toEqual([y.id, x.id]);
    expect(v.cover_asset_id).toBe(y.id); // no cover link: first image
  });
});

describe('platform isolation', () => {
  it('editing one platform never changes the other three or the original', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '原文', markdown: '原文內容', tags: ['a'] });
    await s.client.variants.generate(work.id);
    const img = (await s.client.assets.upload({ filename: 'i.png', data: await pngBytes(6, 6) }))
      .asset.id;

    for (const platform of PLATFORMS) {
      const before = await s.client.variants.list(work.id);
      const target = before.items.find((v) => v.platform === platform);
      if (target === undefined) throw new Error('missing');
      const edited = await s.client.variants.patch(work.id, platform, {
        base_revision: target.revision,
        title: `${platform} 標題`,
        body: `${platform} 正文`,
        cover_asset_id: img,
        image_asset_ids: [img],
        tags: [platform],
      });
      expect(edited).toMatchObject({
        title: `${platform} 標題`,
        body: `${platform} 正文`,
        tags: [platform],
        revision: target.revision + 1,
      });
      const after = await s.client.variants.list(work.id);
      const others = (l: { items: PlatformVariantRecord[] }) =>
        l.items.filter((v) => v.platform !== platform);
      expect(others(after)).toEqual(others(before));
    }
    const final = await s.client.variants.list(work.id);
    expect(final.items.map((v) => [v.platform, v.title, v.revision])).toEqual(
      PLATFORMS.map((p) => [p, `${p} 標題`, 2]),
    );
    const original = await s.client.works.get(work.id);
    expect(original).toMatchObject({ title: '原文', markdown: '原文內容', tags: ['a'] });
    expect((await s.client.works.revisions(work.id)).items).toHaveLength(1);
  });

  it('variants of different works are independent', async () => {
    const s = await start();
    const a = await s.client.works.create({ title: 'A' });
    const b = await s.client.works.create({ title: 'B' });
    await s.client.variants.generate(a.id, { platforms: ['douyin'] });
    await s.client.variants.generate(b.id, { platforms: ['douyin'] });
    await s.client.variants.patch(a.id, 'douyin', { base_revision: 1, title: 'A2' });
    expect((await s.client.variants.get(b.id, 'douyin')).title).toBe('B');
    expect((await apiError(s.client.variants.get(a.id, 'xiaohongshu'))).status).toBe(404);
  });
});

describe('revisions and conflicts', () => {
  it('concurrent edits from the same base: exactly one wins, the other gets 409', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id, { platforms: ['xiaohongshu'] });
    const send = (title: string) =>
      fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/xiaohongshu`, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ base_revision: 1, title }),
      });
    const results = await Promise.all(['甲', '乙', '丙', '丁'].map(send));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200);
    const winnerTitle = ((await winner?.json()) as { title: string }).title;
    for (const r of results.filter((x) => x.status === 409)) {
      const body = (await r.json()) as { error: { code: string; details: unknown } };
      expect(body.error.code).toBe('revision_conflict');
      expect(body.error.details).toEqual({ current_revision: 2, base_revision: '1' });
    }
    const v = await s.client.variants.get(work.id, 'xiaohongshu');
    expect(v).toMatchObject({ revision: 2, title: winnerTitle });
    expect((await s.client.variants.revisions(work.id, 'xiaohongshu')).items).toHaveLength(2);
  });

  it('If-Match, 428, stale base and ETag', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id, { platforms: ['wechat_mp'] });
    const url = `${s.baseUrl}/api/v1/works/${work.id}/variants/wechat_mp`;
    const get = await fetch(url, { headers: authHeaders() });
    expect(get.headers.get('etag')).toBe('"1"');

    const missing = await apiError(s.client.variants.patch(work.id, 'wechat_mp', { title: 'x' }));
    expect(missing.status).toBe(428);

    const v2 = await s.client.variants.patch(work.id, 'wechat_mp', { title: 'x' }, { ifMatch: 1 });
    expect(v2.revision).toBe(2);
    const stale = await apiError(
      s.client.variants.patch(work.id, 'wechat_mp', { title: 'y' }, { ifMatch: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(stale.currentVariantRevision).toBe(2);
    // Body and header disagreeing is a conflict, never "whichever matches".
    const mixed = await apiError(
      s.client.variants.patch(
        work.id,
        'wechat_mp',
        { base_revision: 1, title: 'z' },
        { ifMatch: 2 },
      ),
    );
    expect(mixed.status).toBe(409);
    expect((await s.client.variants.get(work.id, 'wechat_mp')).title).toBe('x');
  });

  it('keeps full history; redraft needs a base and appends a draft revision', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '一', markdown: '第一版' });
    await s.client.variants.generate(work.id, { platforms: ['douyin'] });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 1, body: '手改' });
    const w2 = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      title: '二',
      markdown: '第二版',
    });

    expect((await apiError(s.client.variants.redraft(work.id, 'douyin'))).status).toBe(428);
    expect((await apiError(s.client.variants.redraft(work.id, 'douyin', 1))).status).toBe(409);
    const v3 = await s.client.variants.redraft(work.id, 'douyin', 2);
    expect(v3).toMatchObject({
      revision: 3,
      title: '二',
      body: '第二版',
      source_work_revision_id: w2.current_revision_id,
    });
    const history = (await s.client.variants.revisions(work.id, 'douyin')).items;
    expect(history.map((r) => [r.revision, r.source, r.body])).toEqual([
      [3, 'draft', '第二版'],
      [2, 'edit', '手改'],
      [1, 'draft', '第一版'],
    ]);
    expect((await s.client.variants.revision(work.id, 'douyin', 2)).body).toBe('手改');
    expect((await apiError(s.client.variants.revision(work.id, 'douyin', 9))).status).toBe(404);

    // Redraft of a platform that has no variant yet creates it (201).
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/wechat_channels/draft`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    expect(res.status).toBe(201);
  });

  it('delete needs If-Match, removes only that platform, and keeps its history', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id);
    const del = (h: Record<string, string>) =>
      fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`, {
        method: 'DELETE',
        headers: authHeaders(h),
      });
    expect((await del({})).status).toBe(428);
    expect((await del({ 'if-match': '"7"' })).status).toBe(409);
    await s.client.variants.remove(work.id, 'douyin', 1);
    expect((await apiError(s.client.variants.get(work.id, 'douyin'))).status).toBe(404);
    expect((await apiError(s.client.variants.revisions(work.id, 'douyin'))).status).toBe(404);
    expect((await del({ 'if-match': '"2"' })).status).toBe(404);
    expect((await s.client.variants.list(work.id)).items.map((v) => v.platform)).toEqual([
      'xiaohongshu',
      'wechat_mp',
      'wechat_channels',
    ]);
    const [deleted] = variantEvents(s, work.id).filter((e) => e.action === 'work.variant_deleted');
    expect(deleted?.data).toEqual({ platform: 'douyin', revision: 2 });

    // Recreating continues after the tombstone (revision 2) and keeps the old history.
    const regenerated = await s.client.variants.generate(work.id);
    expect(regenerated.created.map((v) => [v.platform, v.revision])).toEqual([['douyin', 3]]);
    expect(
      (await s.client.variants.revisions(work.id, 'douyin')).items.map((r) => [
        r.revision,
        r.source,
      ]),
    ).toEqual([
      [3, 'draft'],
      [1, 'draft'],
    ]);
    const res = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`, {
      headers: authHeaders(),
    });
    expect(res.headers.get('etag')).toBe('"3"');
  });

  it('a client holding a pre-delete revision gets 409 after delete and recreate (QC-019)', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T', markdown: '原文' });
    await s.client.variants.generate(work.id, { platforms: ['xiaohongshu'] });
    // The app reads r1.
    const appCopy = await s.client.variants.get(work.id, 'xiaohongshu');
    expect(appCopy.revision).toBe(1);
    // An agent deletes it and generates a fresh draft.
    await s.client.variants.remove(work.id, 'xiaohongshu', 1);
    const fresh = await s.client.variants.redraft(work.id, 'xiaohongshu');
    expect(fresh.revision).toBeGreaterThan(appCopy.revision);

    // The app saves against its stale r1, via body and via If-Match: both 409.
    const viaBody = await apiError(
      s.client.variants.patch(work.id, 'xiaohongshu', {
        base_revision: appCopy.revision,
        title: '舊畫面的修改',
      }),
    );
    expect(viaBody.status).toBe(409);
    expect(viaBody.currentVariantRevision).toBe(fresh.revision);
    const viaHeader = await apiError(
      s.client.variants.patch(
        work.id,
        'xiaohongshu',
        { title: '舊畫面的修改' },
        { ifMatch: appCopy.revision },
      ),
    );
    expect(viaHeader.status).toBe(409);
    // Stale redraft and delete are refused too.
    expect(
      (await apiError(s.client.variants.redraft(work.id, 'xiaohongshu', appCopy.revision))).status,
    ).toBe(409);
    expect(
      (await apiError(s.client.variants.remove(work.id, 'xiaohongshu', appCopy.revision))).status,
    ).toBe(409);
    // The new draft is untouched.
    expect(await s.client.variants.get(work.id, 'xiaohongshu')).toEqual(fresh);

    // Repeated delete/recreate cycles never reuse a number.
    const seen = new Set<number>([1, fresh.revision - 1, fresh.revision]);
    let current = fresh.revision;
    for (let i = 0; i < 3; i++) {
      await s.client.variants.remove(work.id, 'xiaohongshu', current);
      const again = await s.client.variants.redraft(work.id, 'xiaohongshu');
      expect(seen.has(again.revision - 1)).toBe(false);
      expect(seen.has(again.revision)).toBe(false);
      seen.add(again.revision - 1);
      seen.add(again.revision);
      current = again.revision;
    }
    expect(current).toBe(9);
  });
});

describe('limits, validation, events and permissions', () => {
  it('warns about content over the reference limits but still saves it', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id);
    const limit = PLATFORM_LIMITS.wechat_channels;
    const title = '標'.repeat((limit.titleMaxChars ?? 0) + 1);
    const imgs = await Promise.all(
      Array.from(
        { length: (limit.imagesMax ?? 0) + 1 },
        async (_, i) =>
          (
            await s.client.assets.upload({
              filename: `i${String(i)}.png`,
              data: await pngBytes(4 + i, 4),
            })
          ).asset.id,
      ),
    );
    const v = await s.client.variants.patch(work.id, 'wechat_channels', {
      base_revision: 1,
      title,
      image_asset_ids: imgs,
    });
    expect(v.title).toBe(title);
    expect(charCount(title)).toBe((limit.titleMaxChars ?? 0) + 1);
    expect(v.warnings.map((w) => [w.code, w.limit, w.actual])).toEqual([
      ['title_too_long', limit.titleMaxChars, charCount(title)],
      ['too_many_images', limit.imagesMax, imgs.length],
    ]);
    expect(v.warnings[0]?.message).toContain('參考上限');
    // The same title is fine on 公眾號 (64 chars).
    const mp = await s.client.variants.patch(work.id, 'wechat_mp', { base_revision: 1, title });
    expect(mp.warnings).toEqual([]);
    // Emoji count as one character.
    const emoji = await s.client.variants.patch(work.id, 'wechat_channels', {
      base_revision: 2,
      title: '🍁'.repeat(limit.titleMaxChars ?? 0),
    });
    expect(emoji.warnings.filter((w) => w.field === 'title')).toEqual([]);
  });

  it('rejects unknown, non-image or repeated assets and unknown platforms', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id, { platforms: ['xiaohongshu'] });
    const video = (await s.client.assets.upload({ filename: 'v.mp4', data: mp4Bytes() })).asset.id;
    const img = (await s.client.assets.upload({ filename: 'i.png', data: await pngBytes(4, 4) }))
      .asset.id;
    const bad = await apiError(
      s.client.variants.patch(work.id, 'xiaohongshu', {
        base_revision: 1,
        cover_asset_id: video,
        image_asset_ids: [img, '00000000-0000-4000-8000-000000000000'],
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body?.error.details?.['invalid_asset_ids']).toEqual([
      video,
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(
      (
        await apiError(
          s.client.variants.patch(work.id, 'xiaohongshu', {
            base_revision: 1,
            image_asset_ids: [img, img],
          }),
        )
      ).status,
    ).toBe(400);
    const unknown = await fetch(`${s.baseUrl}/api/v1/works/${work.id}/variants/weibo`, {
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(400);
    expect((await s.client.variants.get(work.id, 'xiaohongshu')).revision).toBe(1);
    // Clearing the cover is allowed.
    const cleared = await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 1,
      cover_asset_id: null,
    });
    expect(cleared.cover_asset_id).toBeNull();
  });

  it('records variant events in the change feed behind SSE', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id, { platforms: ['douyin'] });
    await s.client.variants.patch(work.id, 'douyin', { base_revision: 1, tags: ['x', 'x', 'y'] });
    const events = variantEvents(s, work.id);
    expect(events.map((e) => [e.action, e.data])).toEqual([
      ['work.variant_created', { platform: 'douyin', revision: 1, source: 'draft' }],
      ['work.variant_updated', { platform: 'douyin', revision: 2, source: 'edit' }],
    ]);
    expect((await s.client.variants.get(work.id, 'douyin')).tags).toEqual(['x', 'y']);
  });

  it('agent tokens: read can list, write is needed to change', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: 'T' });
    await s.client.variants.generate(work.id, { platforms: ['douyin'] });
    const reader = s.tokens.create({ name: 'r', scopes: ['read'] });
    const writer = s.tokens.create({ name: 'w', scopes: ['write'] });
    const url = `${s.baseUrl}/api/v1/works/${work.id}/variants/douyin`;
    const patch = (secret: string) =>
      fetch(url, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ base_revision: 1, title: 'agent' }),
      });
    expect(
      (await fetch(url, { headers: { authorization: `Bearer ${reader.secret}` } })).status,
    ).toBe(200);
    expect((await patch(reader.secret)).status).toBe(403);
    expect((await patch(writer.secret)).status).toBe(200);
  });
});
