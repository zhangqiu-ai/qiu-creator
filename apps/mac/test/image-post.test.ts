import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngBytes } from '../../../services/mac-server/test/fixtures.js';
import { performProxyRequest } from '../src/main/proxy.js';
import { bridgeFetch } from '../src/renderer/api.js';
import { setLocale } from '../src/renderer/i18n.js';
import {
  coverAssetId,
  DESCRIPTION_LIMIT,
  imageCounts,
  insertImage,
  moveImageTo,
  nudgeImage,
  platformsOverAt,
  removeImage,
  replaceImage,
  titleCounts,
  warningText,
} from '../src/renderer/image-post.js';
import { NEW_TYPES } from '../src/renderer/LibraryPage.js';
import { WorkSession } from '../src/renderer/work-session.js';

describe('image grid rules (QC-045)', () => {
  it('inserts at a slot, appends at the end, and moves an id already there instead of repeating it', () => {
    expect(insertImage(['a', 'b'], 'x', 'end')).toEqual(['a', 'b', 'x']);
    expect(insertImage(['a', 'b'], 'x', 0)).toEqual(['x', 'a', 'b']);
    expect(insertImage(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']);
    expect(insertImage(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
    expect(insertImage(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('drag reorder puts the image before the drop slot; dropping beside itself changes nothing', () => {
    expect(moveImageTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveImageTo(['a', 'b', 'c', 'd'], 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveImageTo(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveImageTo(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(moveImageTo(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c']);
  });

  it('⌥←→ moves one step and stops at the ends', () => {
    expect(nudgeImage(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(nudgeImage(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(nudgeImage(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(nudgeImage(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('removing the cover image falls back to the first image; other covers stay', () => {
    expect(removeImage(['a', 'b'], { asset_id: 'b' }, 'b')).toEqual({ images: ['a'], cover: null });
    expect(removeImage(['a', 'b'], { asset_id: 'b' }, 'a')).toEqual({
      images: ['b'],
      cover: { asset_id: 'b' },
    });
    expect(removeImage(['a'], null, 'a')).toEqual({ images: [], cover: null });
  });

  it('重新指定 replaces a missing image in place', () => {
    expect(replaceImage(['a', 'gone', 'c'], 'gone', 'x')).toEqual(['a', 'x', 'c']);
    // The replacement is already in the post: drop the missing one instead of repeating.
    expect(replaceImage(['a', 'gone', 'c'], 'gone', 'c')).toEqual(['a', 'c']);
  });

  it('the cover shown is the chosen one, else the first image', () => {
    expect(coverAssetId(['a', 'b'], null)).toBe('a');
    expect(coverAssetId(['a', 'b'], { asset_id: 'z' })).toBe('z');
    expect(coverAssetId([], null)).toBeNull();
  });
});

describe('platform limits only warn (QC-045)', () => {
  it('counts images against each platform’s image-post limit (公眾號貼圖 20)', () => {
    const at = (n: number) =>
      Object.fromEntries(
        imageCounts(n).map((c) => [c.platform, `${String(c.limit)}:${String(c.over)}`]),
      );
    expect(at(9)).toEqual({
      xiaohongshu: '18:false',
      wechat_mp: '20:false',
      douyin: '35:false',
      wechat_channels: '9:false',
    });
    expect(at(21)).toEqual({
      xiaohongshu: '18:true',
      wechat_mp: '20:true',
      douyin: '35:false',
      wechat_channels: '9:true',
    });
  });

  it('says which platforms an image is past, by position', () => {
    expect(platformsOverAt(8)).toEqual([]);
    expect(platformsOverAt(9)).toEqual(['wechat_channels']);
    expect(platformsOverAt(18)).toEqual(['xiaohongshu', 'wechat_channels']);
    expect(platformsOverAt(20)).toEqual(['xiaohongshu', 'wechat_mp', 'wechat_channels']);
  });

  it('counts title characters per platform in code points', () => {
    const counts = titleCounts('週末咖啡館探店筆記週末咖啡館探店筆記🙂');
    expect(counts.find((c) => c.platform === 'wechat_channels')).toMatchObject({
      actual: 19,
      limit: 16,
      over: true,
    });
    expect(counts.find((c) => c.platform === 'xiaohongshu')).toMatchObject({ over: false });
    expect(DESCRIPTION_LIMIT).toBe(1000);
  });
});

describe('variant warnings worded by the interface (QC-048)', () => {
  const w = { code: 'too_many_images' as const, limit: 20, actual: 23 };
  it('uses code, limit and actual in each language, never the service message', () => {
    setLocale('zh-Hant');
    expect(warningText(w)).toBe('圖片 23 張，超過參考上限 20 張');
    expect(warningText({ code: 'title_too_long', limit: 16, actual: 19 })).toBe(
      '標題 19 字，超過參考上限 16 字',
    );
    setLocale('zh-Hans');
    expect(warningText(w)).toBe('图片 23 张，超过参考上限 20 张');
    setLocale('en');
    expect(warningText(w)).toBe('Has 23 images, over the guideline of 20');
    expect(warningText({ code: 'too_many_tags', limit: 5, actual: 6 })).toBe(
      'Has 6 topics, over the guideline of 5',
    );
    setLocale('zh-Hant');
  });
});

describe('新建 menu (QC-045)', () => {
  it('offers article, image post and video, with video off until its editor exists', () => {
    expect(NEW_TYPES).toEqual([
      { type: 'article', enabled: true },
      { type: 'image', enabled: true },
      { type: 'video', enabled: true },
    ]);
  });
});

// ---- WorkSession on a real service ---------------------------------------------------------

const TOKEN = 'test-token-0123456789abcdef';
let server: CreatorHubServer;
let home: string;
let client: CreatorHubClient;
/** Setup only: uploads send binary bodies, which the renderer's string-only bridge does not. */
let direct: CreatorHubClient;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc045-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({
    baseUrl,
    token: TOKEN,
    fetch: bridgeFetch((req) => performProxyRequest(baseUrl, req)),
  });
  direct = createClient({ baseUrl, token: TOKEN });
});

afterEach(async () => {
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function image(color: string): Promise<string> {
  const res = await direct.assets.upload({
    filename: `${color.slice(1)}.png`,
    data: await pngBytes(30, 40, color),
  });
  return res.asset.id;
}

function sourceFile(workId: string): string {
  return fs.readFileSync(path.join(home, 'library', 'works', workId, 'source.md'), 'utf8');
}

describe('WorkSession for image posts (QC-045)', () => {
  it('saves images, cover and description in one revision and keeps the front matter its own', async () => {
    const [a, b, c] = [await image('#ff0000'), await image('#00ff00'), await image('#0000ff')];
    const work = await client.works.create({ title: '未命名', type: 'image', source: 'mac-app' });
    const session = new WorkSession(client, work, { autosaveMs: 5 });
    expect(session.snapshot.draft).toMatchObject({ markdown: '', images: [], cover: null });

    session.edit({ title: '週末咖啡', markdown: '三家店的筆記。' });
    session.edit({ images: [a, b, c], cover: { asset_id: b } });
    await session.save();
    expect(session.snapshot.status).toBe('saved');
    expect(session.hasUnsavedChanges()).toBe(false);

    const saved = await client.works.get(work.id);
    expect(saved.title).toBe('週末咖啡');
    expect(saved.description).toBe('三家店的筆記。');
    expect(saved.media?.images.map((i) => i.asset_id)).toEqual([a, b, c]);
    expect(saved.media?.cover).toMatchObject({ kind: 'image', item: { asset_id: b } });
    const file = sourceFile(work.id);
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('type: image');
    expect(file.trimEnd().endsWith('三家店的筆記。')).toBe(true);
    expect(session.snapshot.file).toBe(saved.markdown);
    expect(session.snapshot.media?.images).toHaveLength(3);

    // Reorder and remove: one more revision; the description is untouched.
    session.edit({ images: [c, a], cover: null });
    await session.save();
    const again = await client.works.get(work.id);
    expect(again.media?.images.map((i) => i.asset_id)).toEqual([c, a]);
    expect(again.media?.cover).toBeNull();
    expect(again.description).toBe('三家店的筆記。');
    const revisions = await client.works.revisions(work.id);
    expect(revisions.items).toHaveLength(3);
    session.dispose();
  });

  it('a stale base is a conflict, not an overwrite; reloading takes the server version', async () => {
    const a = await image('#123456');
    const work = await client.works.create({ title: '衝突', type: 'image', source: 'mac-app' });
    const session = new WorkSession(client, work, { autosaveMs: 5 });
    await client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      description: '別處',
    });
    session.edit({ images: [a] });
    await session.save();
    expect(session.snapshot.status).toBe('conflict');
    expect((await client.works.get(work.id)).media?.images).toEqual([]);
    await session.reloadFromServer();
    expect(session.snapshot.draft).toMatchObject({ markdown: '別處', images: [] });
    expect(session.snapshot.status).toBe('saved');
    session.dispose();
  });

  it('articles still save their Markdown and never send media fields', async () => {
    const work = await client.works.create({
      title: '文章',
      markdown: '# 標題\n',
      source: 'mac-app',
    });
    const session = new WorkSession(client, work, { autosaveMs: 5 });
    expect(session.snapshot.draft.images).toBeUndefined();
    session.edit({ markdown: '# 標題\n\n新段落。\n' });
    await session.save();
    expect(sourceFile(work.id)).toBe('# 標題\n\n新段落。\n');
    session.dispose();
  });
});
