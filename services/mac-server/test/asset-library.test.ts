import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { TRASH_FAILED_MESSAGE } from '../src/assets/asset-library.js';
import { MacSystemTrash, type SystemTrash } from '../src/assets/system-trash.js';
import { pngBytes } from './fixtures.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  type StartOptions,
  type TestServer,
} from './helpers.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(options: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false }, ...options });
  servers.push(s);
  return s;
}

function tempDir(): string {
  const d = makeTempHome();
  dirs.push(d);
  return d;
}

/** Records what would go to the Trash and moves it into a temp folder instead. */
class FakeTrash implements SystemTrash {
  readonly moved: string[] = [];
  fail: Error | null = null;
  constructor(readonly bin: string) {}
  moveToTrash(absPath: string): Promise<void> {
    if (this.fail !== null) return Promise.reject(this.fail);
    this.moved.push(absPath);
    fs.renameSync(absPath, path.join(this.bin, path.basename(absPath)));
    return Promise.resolve();
  }
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

async function upload(s: TestServer, name: string, size = 8): Promise<AssetRecord> {
  return (
    await s.client.assets.upload({ data: await pngBytes(size, size, '#336699'), filename: name })
  ).asset;
}

function events(s: TestServer, action: string): { entity_id: string; data: string }[] {
  return s.db
    .prepare<[string], { entity_id: string; data: string }>(
      'SELECT entity_id, data FROM change_log WHERE action = ? ORDER BY seq',
    )
    .all(action);
}

describe('asset edit (QC-037)', () => {
  it('edits name, tags, alt text and note with revisions; 428 without a base, 409 when stale', async () => {
    const s = await start();
    const a = await upload(s, 'photo.png');
    expect(a).toMatchObject({
      revision: 1,
      tags: [],
      display_name: null,
      deleted_at: null,
      removal: null,
    });
    const head = await fetch(`${s.baseUrl}/api/v1/assets/${a.id}`, { headers: authHeaders() });
    expect(head.headers.get('etag')).toBe('"1"');

    expect((await apiError(s.client.assets.update(a.id, { note: 'x' }))).status).toBe(428);

    const edited = await s.client.assets.update(a.id, {
      base_revision: 1,
      display_name: '京都封面',
      tags: ['旅行', '京都', '旅行'],
      alt_text: '紅葉與寺廟',
      note: '十一月拍',
    });
    expect(edited).toMatchObject({
      revision: 2,
      display_name: '京都封面',
      tags: ['旅行', '京都'],
      alt_text: '紅葉與寺廟',
      note: '十一月拍',
      original_name: 'photo.png',
      path: a.path,
    });
    expect(fs.existsSync(path.join(s.home, a.path))).toBe(true);

    const stale = await apiError(s.client.assets.update(a.id, { base_revision: 1, note: 'y' }));
    expect(stale.status).toBe(409);
    expect(stale.body?.error).toMatchObject({
      code: 'revision_conflict',
      details: { current_revision: 2 },
    });

    // If-Match works too, and null clears a field.
    const res = await fetch(`${s.baseUrl}/api/v1/assets/${a.id}`, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json', 'if-match': '"2"' }),
      body: JSON.stringify({ note: null }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await s.client.assets.get(a.id)).toMatchObject({ note: null, revision: 3 });

    expect(events(s, 'asset.updated').map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { fields: ['display_name', 'tags', 'alt_text', 'note'], revision: 2 },
      { fields: ['note'], revision: 3 },
    ]);

    // Search covers the display name; tags filter exactly.
    await upload(s, 'other.png', 9);
    expect((await s.client.assets.list({ q: '京都' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await s.client.assets.list({ tag: '旅行' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await s.client.assets.list({ tag: '旅' })).items).toEqual([]);
  });
});

describe('delete and 最近刪除 for managed assets (QC-037)', () => {
  it('moves an unreferenced asset to 最近刪除 without touching its file, and restores it', async () => {
    const s = await start();
    const a = await upload(s, 'a.png');
    const keep = await upload(s, 'b.png', 9);
    const file = path.join(s.home, a.path);

    const res = await s.client.assets.trash(a.id);
    expect(res.references).toEqual({
      works: [],
      variants: [],
      in_trash: { works: [], variants: [] },
    });
    expect(res.asset).toMatchObject({ removal: 'trashed' });
    const deletedAt = Date.parse(res.asset.deleted_at ?? '');
    expect(Date.parse(res.asset.purge_at ?? '') - deletedAt).toBe(30 * 24 * 60 * 60 * 1000);
    expect(fs.existsSync(file)).toBe(true);

    expect((await s.client.assets.list()).items.map((i) => i.id)).toEqual([keep.id]);
    const trash = await s.client.assets.list({ scope: 'trash' });
    expect(trash.items.map((i) => i.id)).toEqual([a.id]);
    // Still readable for the 最近刪除 preview.
    const stream = await fetch(`${s.baseUrl}/api/v1/assets/${a.id}/stream`, {
      headers: authHeaders(),
    });
    expect(stream.status).toBe(200);

    expect((await apiError(s.client.assets.trash(a.id))).body?.error.code).toBe('asset_in_trash');
    expect(
      (await apiError(s.client.assets.update(a.id, { base_revision: 1, note: 'x' }))).body?.error
        .code,
    ).toBe('asset_in_trash');

    const back = await s.client.assets.restore(a.id);
    expect(back).toMatchObject({ deleted_at: null, removal: null, purge_at: null });
    expect((await s.client.assets.list()).total).toBe(2);
    // Restoring an active asset changes nothing.
    expect(await s.client.assets.restore(a.id)).toEqual(back);

    expect(
      events(s, 'asset.trashed').map((e) => [e.entity_id, JSON.parse(e.data) as unknown]),
    ).toEqual([[a.id, { removal: 'trashed' }]]);
    expect(events(s, 'asset.restored').map((e) => e.entity_id)).toEqual([a.id]);
  });

  it('needs confirm for a referenced asset; references are kept and come back on restore', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '京都秋天', markdown: '# 京都秋天\n\n正文' });
    const cover = await upload(s, 'cover.png');
    const body = await upload(s, 'body.png', 9);
    const other = await upload(s, 'other.png', 10);
    await s.client.workAssets.link(work.id, { asset_id: cover.id, role: 'cover' });
    for (const id of [body.id, cover.id, other.id]) {
      await s.client.workAssets.link(work.id, { asset_id: id, role: 'body' });
    }
    await s.client.variants.patch(work.id, 'xiaohongshu', {
      base_revision: 0,
      cover: { asset_id: cover.id },
      images: [cover.id, body.id],
    });

    expect(await s.client.assets.references(cover.id)).toEqual({
      works: [
        // Linked directly (not an attach copy): deleting the asset really removes it (QC-039).
        { work_id: work.id, title: '京都秋天', role: 'body', position: 1, independent_copy: false },
        {
          work_id: work.id,
          title: '京都秋天',
          role: 'cover',
          position: 0,
          independent_copy: false,
        },
      ],
      variants: [
        { work_id: work.id, title: '京都秋天', platform: 'xiaohongshu', usage: 'cover' },
        { work_id: work.id, title: '京都秋天', platform: 'xiaohongshu', usage: 'image' },
      ],
      in_trash: { works: [], variants: [] },
    });
    expect((await s.client.assets.list({ scope: 'unreferenced' })).items).toEqual([]);

    const refused = await apiError(s.client.assets.trash(cover.id));
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toMatchObject({
      code: 'asset_in_use',
      details: { references: await s.client.assets.references(cover.id) },
    });
    expect((await s.client.assets.get(cover.id)).deleted_at).toBeNull();

    const before = await s.client.variants.get(work.id, 'xiaohongshu');
    await s.client.assets.trash(cover.id, { confirm: true });
    const listed = (await s.client.workAssets.list(work.id)).items.map((i) => [i.role, i.asset.id]);
    expect(listed).toEqual([
      ['body', body.id],
      ['body', other.id],
    ]);
    // Reordering only needs the assets the client can see.
    await s.client.workAssets.reorder(work.id, { role: 'body', asset_ids: [other.id, body.id] });
    expect((await s.client.assets.list({ scope: 'unreferenced' })).items).toEqual([]);
    expect(
      (await apiError(s.client.workAssets.link(work.id, { asset_id: cover.id, role: 'cover' })))
        .body?.error.code,
    ).toBe('asset_in_trash');
    // The variant's overrides are unchanged and keep their references; while
    // the asset is in 回收站 the platform does not show it among its images.
    expect(await s.client.variants.get(work.id, 'xiaohongshu')).toEqual({
      ...before,
      images: before.images.filter((id) => id !== cover.id),
    });

    await s.client.assets.restore(cover.id);
    const after = (await s.client.workAssets.list(work.id)).items.map((i) => [i.role, i.asset.id]);
    expect(after).toEqual([
      ['body', other.id],
      ['body', body.id],
      ['body', cover.id],
      ['cover', cover.id],
    ]);
    expect((await s.client.assets.references(cover.id)).variants).toHaveLength(2);
    expect(await s.client.variants.get(work.id, 'xiaohongshu')).toEqual(before);
    const changes = events(s, 'work.assets_changed')
      .map((e) => JSON.parse(e.data) as { change: string; asset_id?: string })
      .filter((d) => d.asset_id === cover.id)
      .map((d) => d.change);
    expect(changes.slice(-2)).toEqual(['trashed', 'restored']);
  });

  it('a repeated upload of the same content brings the asset back from 最近刪除', async () => {
    const s = await start();
    const data = await pngBytes(12, 12, '#abcdef');
    const a = (await s.client.assets.upload({ data, filename: 'x.png' })).asset;
    await s.client.assets.trash(a.id);
    const again = await s.client.assets.upload({ data, filename: 'x-again.png' });
    expect(again).toMatchObject({ deduplicated: true, asset: { id: a.id, deleted_at: null } });
    expect(events(s, 'asset.restored').map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { reason: 'reuploaded' },
    ]);
  });
});

describe('permanent deletion (QC-037)', () => {
  it('deletes the file, drops references, and reports Markdown that still links to it', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '圖文', markdown: '# 圖文\n' });
    // A managed file inside the work folder that its Markdown links to.
    const src = path.join(tempDir(), 'inline.png');
    fs.writeFileSync(src, await pngBytes(7, 7));
    const inline = s.assets.registerFromFile(work.id, src, { role: 'body' }).id;
    const inlineRec = await s.client.assets.get(inline);
    const current = await s.client.works.get(work.id);
    await s.client.works.patch(work.id, {
      base_revision: current.current_revision_id,
      markdown: `# 圖文\n\n![](assets/${path.basename(inlineRec.path)})\n`,
    });
    const lib = await upload(s, 'lib.png', 9);
    await s.client.workAssets.link(work.id, { asset_id: lib.id, role: 'cover' });
    const v = await s.client.variants.patch(work.id, 'douyin', {
      base_revision: 0,
      cover: { asset_id: lib.id },
      images: [inline],
    });
    const thumb = path.join(s.home, 'cache/thumbnails', `${lib.id}.webp`);
    fs.mkdirSync(path.dirname(thumb), { recursive: true });
    fs.writeFileSync(thumb, 'x');

    // Only assets in 最近刪除 can be purged.
    expect((await apiError(s.client.trash.purge(lib.id))).status).toBe(404);

    await s.client.assets.trash(lib.id, { confirm: true });
    await s.client.assets.trash(inline, { confirm: true });
    const libDir = path.dirname(path.join(s.home, lib.path));
    expect(await s.client.trash.purge(lib.id)).toEqual({
      id: lib.id,
      removal: 'trashed',
      markdown_referrers: [],
    });
    expect(fs.existsSync(libDir)).toBe(false);
    expect(fs.existsSync(thumb)).toBe(false);
    expect((await apiError(s.client.assets.get(lib.id))).status).toBe(404);
    const variant = await s.client.variants.get(work.id, 'douyin');
    // The cover override is dropped with the asset: the cover follows the work again.
    expect(variant).toMatchObject({
      cover: { asset_id: inline },
      cover_source: 'work',
      images: [inline],
    });
    expect(variant.revision).toBe(v.revision); // no new revision from the purge

    const purged = await s.client.trash.purge(inline);
    expect(purged.markdown_referrers).toEqual([{ work_id: work.id, title: '圖文' }]);
    expect(fs.existsSync(path.join(s.home, inlineRec.path))).toBe(false);
    // The work folder itself and its source stay.
    expect(fs.existsSync(path.join(s.home, 'library/works', work.id, 'source.md'))).toBe(true);
    expect((await s.client.variants.get(work.id, 'douyin')).images).toEqual([]);

    expect(
      events(s, 'asset.deleted').map((e) => [e.entity_id, JSON.parse(e.data) as unknown]),
    ).toEqual([
      [lib.id, { removal: 'trashed', reason: 'manual' }],
      [inline, { removal: 'trashed', reason: 'manual' }],
    ]);
  });

  it('empties 最近刪除 only with confirm', async () => {
    const s = await start();
    const a = await upload(s, 'a.png');
    const b = await upload(s, 'b.png', 9);
    const c = await upload(s, 'c.png', 10);
    await s.client.assets.trash(a.id);
    await s.client.assets.trash(b.id);

    const res = await fetch(`${s.baseUrl}/api/v1/trash`, {
      method: 'DELETE',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await s.client.assets.list({ scope: 'trash' })).total).toBe(2);

    const emptied = await s.client.trash.empty();
    expect(emptied.purged.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect((await s.client.assets.list({ scope: 'trash' })).total).toBe(0);
    expect((await s.client.assets.list()).items.map((i) => i.id)).toEqual([c.id]);
    expect(events(s, 'asset.deleted').map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { removal: 'trashed', reason: 'empty' },
      { removal: 'trashed', reason: 'empty' },
    ]);
  });

  it('purges assets 30 days after deletion', async () => {
    let now = new Date('2026-11-01T00:00:00.000Z');
    const s = await start({ assetLibrary: { now: () => now } });
    const old = await upload(s, 'old.png');
    const recent = await upload(s, 'recent.png', 9);
    await s.client.assets.trash(old.id);
    now = new Date('2026-11-20T00:00:00.000Z');
    await s.client.assets.trash(recent.id);

    now = new Date('2026-11-30T23:59:59.000Z');
    expect(s.assetLibrary.purgeExpired()).toEqual([]);
    now = new Date('2026-12-01T00:00:00.000Z');
    expect(s.assetLibrary.purgeExpired().map((p) => p.id)).toEqual([old.id]);
    expect(fs.existsSync(path.join(s.home, old.path))).toBe(false);
    expect((await s.client.assets.list({ scope: 'trash' })).items.map((i) => i.id)).toEqual([
      recent.id,
    ]);
    expect(events(s, 'asset.deleted').map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { removal: 'trashed', reason: 'expired' },
    ]);
  });

  it('runs the purge on a timer', async () => {
    let now = new Date('2026-11-01T00:00:00.000Z');
    const s = await start({ assetLibrary: { now: () => now, purgeCheckMs: 20 } });
    const a = await upload(s, 'a.png');
    await s.client.assets.trash(a.id);
    now = new Date('2026-12-02T00:00:00.000Z');
    const deadline = Date.now() + 5000;
    while ((await s.client.assets.list({ scope: 'trash' })).total > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await s.client.assets.list({ scope: 'trash' })).total).toBe(0);
  });
});

describe('external assets (QC-037)', () => {
  async function externalAsset(trash?: SystemTrash) {
    const s = await start({
      jobs: { pollMs: 5 },
      // Polling, as in mounts.test.ts: deterministic under load.
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
      ...(trash === undefined ? {} : { assetLibrary: { trash } }),
    });
    const folder = tempDir();
    const image = path.join(folder, 'photo.png');
    fs.writeFileSync(image, await pngBytes(6, 6));
    fs.writeFileSync(path.join(folder, 'note.md'), '# 筆記\n\n![](photo.png)\n');
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items[0];
    if (work === undefined) throw new Error('no external work');
    const media = await s.client.works.media(work.id);
    const assetId = media.items[0]?.asset_id;
    if (assetId == null) throw new Error('no external asset');
    return { s, folder, image, mount, work, assetId };
  }

  it('removes from the library only by default; the original stays and a rescan does not bring it back', async () => {
    const { s, image, mount, work, assetId } = await externalAsset();
    const before = fs.readFileSync(image);
    const refused = await apiError(s.client.assets.trash(assetId));
    expect(refused.body?.error.code).toBe('asset_in_use');

    const res = await s.client.assets.trash(assetId, { confirm: true });
    expect(res.asset).toMatchObject({ removal: 'unindexed' });
    expect(fs.readFileSync(image).equals(before)).toBe(true);

    await s.client.mounts.rescan(mount.id);
    await s.jobs.drain();
    await s.client.works.media(work.id);
    expect((await s.client.assets.get(assetId)).removal).toBe('unindexed');
    expect((await s.client.workAssets.list(work.id)).items).toEqual([]);

    await s.client.assets.restore(assetId);
    expect((await s.client.workAssets.list(work.id)).items.map((i) => i.asset.id)).toEqual([
      assetId,
    ]);

    // Purging an external entry deletes the record only, never the original.
    await s.client.assets.trash(assetId, { confirm: true });
    expect(await s.client.trash.purge(assetId)).toEqual({
      id: assetId,
      removal: 'unindexed',
      markdown_referrers: [],
    });
    expect(fs.readFileSync(image).equals(before)).toBe(true);
  });

  it('moves the original to the system Trash only when asked, and restores after Put Back', async () => {
    const bin = tempDir();
    const fake = new FakeTrash(bin);
    const { s, image, assetId } = await externalAsset(fake);
    const res = await s.client.assets.trash(assetId, {
      confirm: true,
      move_original_to_trash: true,
    });
    expect(res.asset.removal).toBe('original_trashed');
    expect(fake.moved).toEqual([fs.realpathSync(path.dirname(image)) + '/photo.png']);
    expect(fs.existsSync(image)).toBe(false);

    const missing = await apiError(s.client.assets.restore(assetId));
    expect(missing.status).toBe(409);
    expect(missing.body?.error.code).toBe('asset_file_missing');

    fs.renameSync(path.join(bin, 'photo.png'), image); // Finder: Put Back
    expect((await s.client.assets.restore(assetId)).deleted_at).toBeNull();
  });

  it('a Trash failure answers 500 trash_failed in Chinese and changes nothing', async () => {
    const fake = new FakeTrash(tempDir());
    fake.fail = new Error('boom');
    const { s, image, assetId } = await externalAsset(fake);
    const err = await apiError(
      s.client.assets.trash(assetId, { confirm: true, move_original_to_trash: true }),
    );
    expect(err.status).toBe(500);
    expect(err.body?.error).toMatchObject({ code: 'trash_failed', message: TRASH_FAILED_MESSAGE });
    expect(TRASH_FAILED_MESSAGE).toBe('無法移到系統垃圾桶，原檔未變動');
    expect(fs.existsSync(image)).toBe(true);
    expect((await s.client.assets.get(assetId)).deleted_at).toBeNull();
    expect(events(s, 'asset.trashed')).toEqual([]);
  });

  it('a missing trash binary is a failure, not a deletion', async () => {
    const file = path.join(tempDir(), 'keep.png');
    fs.writeFileSync(file, 'x');
    const trash = new MacSystemTrash(path.join(tempDir(), 'no-such-trash'));
    await expect(trash.moveToTrash(file)).rejects.toThrow(/failed/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses move_original_to_trash for managed assets', async () => {
    const s = await start({ assetLibrary: { trash: new FakeTrash(tempDir()) } });
    const a = await upload(s, 'a.png');
    const err = await apiError(s.client.assets.trash(a.id, { move_original_to_trash: true }));
    expect(err.status).toBe(400);
    expect((await s.client.assets.get(a.id)).deleted_at).toBeNull();
  });
});

describe('batch (QC-037)', () => {
  it('adds and removes tags, all or nothing', async () => {
    const s = await start();
    const a = await upload(s, 'a.png');
    const b = await upload(s, 'b.png', 9);
    await s.client.assets.update(a.id, { base_revision: 1, tags: ['舊'] });

    const added = await s.client.assets.batch({
      action: 'add_tags',
      ids: [a.id, b.id],
      tags: ['旅行', '舊'],
    });
    expect(added.items.map((i) => [i.id, i.tags, i.revision])).toEqual([
      [a.id, ['舊', '旅行'], 3],
      [b.id, ['旅行', '舊'], 2],
    ]);
    const removed = await s.client.assets.batch({
      action: 'remove_tags',
      ids: [a.id, b.id],
      tags: ['舊'],
    });
    expect(removed.items.map((i) => i.tags)).toEqual([['旅行'], ['旅行']]);

    const unknown = await apiError(
      s.client.assets.batch({
        action: 'add_tags',
        ids: [a.id, '00000000-0000-4000-8000-000000000000'],
        tags: ['x'],
      }),
    );
    expect(unknown.status).toBe(404);
    expect((await s.client.assets.get(a.id)).tags).toEqual(['旅行']);
  });

  it('moves several to 最近刪除; referenced ones need confirm and nothing changes without it', async () => {
    const s = await start();
    const work = await s.client.works.create({ title: '作品' });
    const a = await upload(s, 'a.png');
    const b = await upload(s, 'b.png', 9);
    await s.client.workAssets.link(work.id, { asset_id: b.id, role: 'body' });

    const refused = await apiError(s.client.assets.batch({ action: 'trash', ids: [a.id, b.id] }));
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toMatchObject({
      code: 'asset_in_use',
      details: {
        assets: [
          {
            id: b.id,
            references: {
              works: [{ work_id: work.id, title: '作品', role: 'body', position: 0 }],
              variants: [],
            },
          },
        ],
      },
    });
    expect((await s.client.assets.list({ scope: 'trash' })).total).toBe(0);

    const done = await s.client.assets.batch({ action: 'trash', ids: [a.id, b.id], confirm: true });
    expect(done.items.map((i) => i.removal)).toEqual(['trashed', 'trashed']);
    expect(
      (await apiError(s.client.assets.batch({ action: 'add_tags', ids: [a.id], tags: ['x'] }))).body
        ?.error.code,
    ).toBe('asset_in_trash');
  });
});

describe('access (QC-037)', () => {
  it('agent tokens may read references and 最近刪除 but never edit or delete', async () => {
    const s = await start();
    const a = await upload(s, 'a.png');
    const agent = s.tokens.create({ name: 'agent', scopes: ['read', 'import', 'write'] });
    const asAgent = createClient({ baseUrl: s.baseUrl, token: agent.secret });

    expect(await asAgent.assets.references(a.id)).toEqual({
      works: [],
      variants: [],
      in_trash: { works: [], variants: [] },
    });
    expect((await asAgent.assets.list({ scope: 'trash' })).total).toBe(0);
    for (const call of [
      () => asAgent.assets.update(a.id, { base_revision: 1, note: 'x' }),
      () => asAgent.assets.trash(a.id),
      () => asAgent.assets.restore(a.id),
      () => asAgent.assets.batch({ action: 'add_tags', ids: [a.id], tags: ['x'] }),
      () => asAgent.trash.purge(a.id),
      () => asAgent.trash.empty(),
    ]) {
      expect((await apiError(call())).status).toBe(403);
    }
    expect(await s.client.assets.get(a.id)).toMatchObject({ revision: 1, deleted_at: null });
  });
});
