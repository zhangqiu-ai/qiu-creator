import { ApiError } from '@qiu-creator/api-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes } from './fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let workId: string;
let img: string[];
let video: string;

beforeEach(async () => {
  s = await startTestServer({ jobs: { start: false } });
  workId = (await s.client.works.create({ title: '圖文' })).id;
  img = [];
  for (const color of ['#ff0000', '#00ff00', '#0000ff']) {
    img.push(
      (
        await s.client.assets.upload({
          data: await pngBytes(20, 20, color),
          filename: `${color}.png`,
        })
      ).asset.id,
    );
  }
  video = (await s.client.assets.upload({ data: mp4Bytes(), filename: 'v.mp4' })).asset.id;
});
afterEach(async () => {
  await s.close();
});

const summary = (items: { role: string; position: number; asset: { id: string } }[]) =>
  items.map((i) => [i.role, i.position, i.asset.id]);

describe('work ↔ asset links', () => {
  it('links assets by role and keeps per-role order', async () => {
    await s.client.workAssets.link(workId, { asset_id: img[0] ?? '', role: 'cover' });
    await s.client.workAssets.link(workId, { asset_id: img[1] ?? '', role: 'body' });
    await s.client.workAssets.link(workId, { asset_id: img[2] ?? '', role: 'body' });
    await s.client.workAssets.link(workId, { asset_id: img[0] ?? '', role: 'body', position: 0 });
    const res = await s.client.workAssets.link(workId, { asset_id: video, role: 'video' });

    expect(summary(res.items)).toEqual([
      ['body', 0, img[0]],
      ['body', 1, img[1]],
      ['body', 2, img[2]],
      ['cover', 0, img[0]],
      ['video', 0, video],
    ]);
  });

  it('reorders a role and rejects an incomplete order', async () => {
    for (const id of img) await s.client.workAssets.link(workId, { asset_id: id, role: 'body' });
    const reordered = await s.client.workAssets.reorder(workId, {
      role: 'body',
      asset_ids: [img[2] ?? '', img[0] ?? '', img[1] ?? ''],
    });
    expect(summary(reordered.items).map((r) => r[2])).toEqual([img[2], img[0], img[1]]);

    const err: unknown = await s.client.workAssets
      .reorder(workId, { role: 'body', asset_ids: [img[0] ?? ''] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });

  it('unlinks and closes the gap; missing links and works are 404', async () => {
    for (const id of img) await s.client.workAssets.link(workId, { asset_id: id, role: 'body' });
    const after = await s.client.workAssets.unlink(workId, img[1] ?? '', 'body');
    expect(summary(after.items)).toEqual([
      ['body', 0, img[0]],
      ['body', 1, img[2]],
    ]);

    const missing: unknown = await s.client.workAssets
      .unlink(workId, img[1] ?? '', 'body')
      .catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
    const noWork: unknown = await s.client.workAssets
      .link(crypto.randomUUID(), { asset_id: video, role: 'video' })
      .catch((e: unknown) => e);
    expect((noWork as ApiError).status).toBe(404);
    const noAsset: unknown = await s.client.workAssets
      .link(workId, { asset_id: crypto.randomUUID(), role: 'video' })
      .catch((e: unknown) => e);
    expect((noAsset as ApiError).status).toBe(404);
  });

  it('lists and filters the asset library', async () => {
    expect((await s.client.assets.list()).total).toBe(4);
    expect((await s.client.assets.list({ kind: 'video' })).items.map((a) => a.id)).toEqual([video]);
    expect((await s.client.assets.list({ q: '00ff00' })).items.map((a) => a.id)).toEqual([img[1]]);
  });
});
