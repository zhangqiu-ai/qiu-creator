import { ApiError } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from './fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * QC-053: works in 最近刪除 no longer count as using an asset, and cannot be
 * the target of a URL import. Temporary CREATORHUB_HOME; no network.
 */

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false } });
  servers.push(s);
  return s;
}

async function upload(s: TestServer, name: string, size = 8): Promise<AssetRecord> {
  return (
    await s.client.assets.upload({ data: await pngBytes(size, size, '#336699'), filename: name })
  ).asset;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

/** A work using `asset` as cover and in a 小紅書 variant, then moved to 最近刪除. */
async function trashedUser(s: TestServer, asset: AssetRecord, title: string) {
  const work = await s.client.works.create({ title });
  await s.client.workAssets.link(work.id, { asset_id: asset.id, role: 'cover' });
  await s.client.variants.patch(work.id, 'xiaohongshu', {
    base_revision: 0,
    cover: { asset_id: asset.id },
  });
  const current = await s.client.works.get(work.id);
  await s.client.works.trash(work.id, { base_revision: current.current_revision_id });
  return work;
}

describe('asset references and works in 最近刪除 (QC-053)', () => {
  it('lists them apart in in_trash; only active works make the asset in use', async () => {
    const s = await start();
    const a = await upload(s, 'shared.png');
    const active = await s.client.works.create({ title: '還在的作品' });
    await s.client.workAssets.link(active.id, { asset_id: a.id, role: 'body' });
    const gone = await trashedUser(s, a, '刪掉的作品');

    const refs = await s.client.assets.references(a.id);
    expect(refs.works.map((w) => w.work_id)).toEqual([active.id]);
    expect(refs.variants).toEqual([]);
    expect(refs.in_trash).toEqual({
      works: [
        {
          work_id: gone.id,
          title: '刪掉的作品',
          role: 'cover',
          position: 0,
          independent_copy: false,
        },
      ],
      variants: [
        { work_id: gone.id, title: '刪掉的作品', platform: 'xiaohongshu', usage: 'cover' },
      ],
    });
    expect((await s.client.assets.works(a.id)).items.map((w) => w.work_id)).toEqual([active.id]);

    // Still in use through the active work.
    const inUse = await apiError(s.client.assets.trash(a.id));
    expect(inUse.body?.error.code).toBe('asset_in_use');
  });

  it('deletes an asset used only by works in 最近刪除 without confirm; restoring brings everything back', async () => {
    const s = await start();
    const a = await upload(s, 'only-trashed.png');
    const gone = await trashedUser(s, a, '只有它用');

    const res = await s.client.assets.trash(a.id);
    expect(res.asset.removal).toBe('trashed');
    expect(res.references.works).toEqual([]);
    expect(res.references.in_trash?.works.map((w) => w.work_id)).toEqual([gone.id]);

    // The batch delete follows the same rule.
    const b = await upload(s, 'batch.png', 9);
    await trashedUser(s, b, '批量');
    expect((await s.client.assets.batch({ action: 'trash', ids: [b.id] })).items[0]?.removal).toBe(
      'trashed',
    );

    // Asset and work both come back with their links.
    await s.client.assets.restore(a.id);
    const w = await s.client.works.get(gone.id);
    await s.client.works.restoreFromTrash(gone.id, { base_revision: w.current_revision_id });
    expect((await s.client.workAssets.list(gone.id)).items.map((i) => i.asset.id)).toEqual([a.id]);
    expect(await s.client.variants.get(gone.id, 'xiaohongshu')).toMatchObject({
      cover: { asset_id: a.id },
      cover_source: 'override',
    });
    expect((await s.client.assets.references(a.id)).works.map((r) => r.work_id)).toEqual([gone.id]);
  });

  it('purging the asset removes the links of works in 最近刪除 too', async () => {
    const s = await start();
    const a = await upload(s, 'purged.png');
    const gone = await trashedUser(s, a, '之後才還原');
    await s.client.assets.trash(a.id);
    await s.client.trash.purge(a.id);

    const w = await s.client.works.get(gone.id);
    await s.client.works.restoreFromTrash(gone.id, { base_revision: w.current_revision_id });
    expect((await s.client.workAssets.list(gone.id)).items).toEqual([]);
    // The cover override is dropped with the asset; the work has no cover left.
    expect(await s.client.variants.get(gone.id, 'xiaohongshu')).toMatchObject({
      cover: null,
      cover_source: 'work',
    });
  });
});

describe('URL imports and works in 最近刪除 (QC-053)', () => {
  it('refuses a work in 最近刪除 as work_id with 409 work_in_trash; no job is created', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '已刪除' });
    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });

    const err = await apiError(
      s.client.imports.url({ url: 'http://cdn.example.com/a.png', work_id: w.id }),
    );
    expect(err.status).toBe(409);
    expect(err.body?.error).toMatchObject({
      code: 'work_in_trash',
      details: { work_id: w.id },
    });
    expect(s.db.prepare('SELECT count(*) AS n FROM import_jobs').get()).toEqual({ n: 0 });

    // After restoring, the same import is accepted.
    await s.client.works.restoreFromTrash(w.id, { base_revision: w.current_revision_id });
    const job = await s.client.imports.url({ url: 'http://cdn.example.com/a.png', work_id: w.id });
    expect(job.status).toBe('queued');
  });
});
