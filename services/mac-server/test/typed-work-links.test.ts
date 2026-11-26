import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { AssetRecord, WorkAssetItem, WorkDetail } from '@qiu-creator/contracts';
import { parseWorkSource } from '@qiu-creator/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes } from './fixtures.js';
import { startTestServer, type StartOptions, type TestServer } from './helpers.js';
import { serve, startUpstream, type Upstream } from './upstream.js';

/**
 * QC-102: image and video works show the files named in their front matter, so
 * every way of putting an asset on such a work (link, attach, URL import,
 * unlink, reorder) must write it there.
 */

const servers: TestServer[] = [];
const upstreams: Upstream[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const u of upstreams.splice(0)) await u.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(options: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({ jobs: { start: false }, ...options });
  servers.push(s);
  return s;
}

async function image(s: TestServer, name: string, color: string): Promise<AssetRecord> {
  const data = await pngBytes(30, 40, color);
  return (await s.client.assets.upload({ data, filename: name })).asset;
}

async function video(s: TestServer, name = 'clip.mp4'): Promise<AssetRecord> {
  return (await s.client.assets.upload({ data: mp4Bytes(), filename: name })).asset;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

const rows = (items: WorkAssetItem[]) => items.map((i) => [i.role, i.position, i.asset.id]);
const imageIds = (w: WorkDetail) => w.media?.images.map((i) => i.asset_id);
const coverId = (w: WorkDetail) =>
  w.media?.cover?.kind === 'image' ? w.media.cover.item.asset_id : null;
const sourceFile = (s: TestServer, id: string) =>
  path.join(s.home, 'library/works', id, 'source.md');
const front = (s: TestServer, id: string) =>
  parseWorkSource(fs.readFileSync(sourceFile(s, id), 'utf8')).frontMatter;
const card = async (s: TestServer, id: string) =>
  (await s.client.works.list()).items.find((w) => w.id === id);

describe('linking assets to an image work', () => {
  it('shows body images in order, and a cover, in the work, its card and the platforms', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '京都', type: 'image', description: '紅葉。' });
    const a = await image(s, 'a.png', '#ff0000');
    const b = await image(s, 'b.png', '#00ff00');
    const c = await image(s, 'c.png', '#0000ff');

    await s.client.workAssets.link(w.id, { asset_id: a.id, role: 'body' });
    await s.client.workAssets.link(w.id, { asset_id: b.id, role: 'body' });
    const inserted = await s.client.workAssets.link(w.id, {
      asset_id: c.id,
      role: 'body',
      position: 0,
    });
    expect(rows(inserted.items)).toEqual([
      ['body', 0, c.id],
      ['body', 1, a.id],
      ['body', 2, b.id],
    ]);
    const linked = await s.client.workAssets.link(w.id, { asset_id: b.id, role: 'cover' });
    expect(rows(linked.items)).toContainEqual(['cover', 0, b.id]);

    const after = await s.client.works.get(w.id);
    expect(imageIds(after)).toEqual([c.id, a.id, b.id]);
    expect(after.media?.images.map((i) => i.status)).toEqual(['present', 'present', 'present']);
    expect(coverId(after)).toBe(b.id);
    expect(after.description).toBe('紅葉。');
    expect(front(s, w.id)).toMatchObject({
      type: 'image',
      images: ['assets/c.png', 'assets/a.png', 'assets/b.png'],
      cover: { path: 'assets/b.png' },
    });

    expect(await card(s, w.id)).toMatchObject({ image_count: 3, thumbnail: { asset_id: b.id } });
    const variant = await s.client.variants.get(w.id, 'xiaohongshu');
    expect(variant.images).toEqual([c.id, a.id, b.id]);
    expect(variant.cover).toEqual({ asset_id: b.id });

    // Every change is a revision the user can go back to.
    const history = await s.client.works.revisions(w.id);
    expect(history.items).toHaveLength(5);
  });

  it('moves a re-linked image, writes nothing when it already is there, and keeps concurrent links', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'x', type: 'image' });
    const files = [
      await image(s, 'a.png', '#ff0000'),
      await image(s, 'b.png', '#00ff00'),
      await image(s, 'c.png', '#0000ff'),
    ];
    await Promise.all(
      files.map((f) => s.client.workAssets.link(w.id, { asset_id: f.id, role: 'body' })),
    );
    const all = await s.client.works.get(w.id);
    expect([...(imageIds(all) ?? [])].sort()).toEqual(files.map((f) => f.id).sort());

    const [a, b, c] = files as [AssetRecord, AssetRecord, AssetRecord];
    await s.client.workAssets.link(w.id, { asset_id: a.id, role: 'body', position: 0 });
    await s.client.workAssets.link(w.id, { asset_id: b.id, role: 'body', position: 1 });
    await s.client.workAssets.link(w.id, { asset_id: c.id, role: 'body', position: 2 });
    const ordered = await s.client.works.get(w.id);
    expect(imageIds(ordered)).toEqual([a.id, b.id, c.id]);

    await s.client.workAssets.link(w.id, { asset_id: b.id, role: 'body', position: 1 });
    const again = await s.client.works.get(w.id);
    expect(again.current_revision_id).toBe(ordered.current_revision_id);
    expect(fs.readdirSync(path.join(s.home, 'library/works', w.id, 'assets')).sort()).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ]);
  });

  it('reorders and unlinks in the front matter; removing the cover image resets the cover', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'x', type: 'image' });
    const a = await image(s, 'a.png', '#ff0000');
    const b = await image(s, 'b.png', '#00ff00');
    // Set by the app's own editor (PATCH): detach and reorder must still work on it.
    await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      images: [a.id, b.id],
      cover: { asset_id: a.id },
    });

    const reordered = await s.client.workAssets.reorder(w.id, {
      role: 'body',
      asset_ids: [b.id, a.id],
    });
    expect(rows(reordered.items).filter((r) => r[0] === 'body')).toEqual([
      ['body', 0, b.id],
      ['body', 1, a.id],
    ]);
    expect(imageIds(await s.client.works.get(w.id))).toEqual([b.id, a.id]);
    const incomplete = await apiError(
      s.client.workAssets.reorder(w.id, { role: 'body', asset_ids: [a.id] }),
    );
    expect(incomplete).toMatchObject({ status: 400, code: 'validation_error' });

    await s.client.workAssets.unlink(w.id, a.id, 'cover');
    expect((await s.client.works.get(w.id)).media?.cover).toBeNull();

    await s.client.workAssets.link(w.id, { asset_id: a.id, role: 'cover' });
    const removed = await s.client.workAssets.unlink(w.id, a.id, 'body');
    expect(rows(removed.items)).toEqual([['body', 0, b.id]]);
    const after = await s.client.works.get(w.id);
    expect(imageIds(after)).toEqual([b.id]);
    expect(after.media?.cover).toBeNull();

    const missing = await apiError(s.client.workAssets.unlink(w.id, a.id, 'body'));
    expect(missing.status).toBe(404);
  });

  it('makes a media/attach visible too', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'x', type: 'image' });
    const a = await image(s, 'a.png', '#ff0000');
    const res = await s.client.works.attachMedia(w.id, a.id);
    expect(res).toMatchObject({ src: 'assets/a.png', copied: true });
    expect(imageIds(await s.client.works.get(w.id))).toEqual([a.id]);
  });

  it('refuses what the work cannot show, and writes nothing', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'x', type: 'image' });
    const a = await image(s, 'a.png', '#ff0000');
    const v = await video(s);

    const role = await apiError(s.client.workAssets.link(w.id, { asset_id: v.id, role: 'video' }));
    expect(role).toMatchObject({ status: 400, code: 'validation_error' });
    expect(role.body?.error.details).toMatchObject({ allowed: ['body', 'cover'] });
    const kind = await apiError(s.client.workAssets.link(w.id, { asset_id: v.id, role: 'body' }));
    expect(kind).toMatchObject({ status: 400, code: 'validation_error' });
    expect((await apiError(s.client.works.attachMedia(w.id, v.id))).status).toBe(400);

    await s.client.assets.trash(a.id);
    const trashed = await apiError(
      s.client.workAssets.link(w.id, { asset_id: a.id, role: 'body' }),
    );
    expect(trashed).toMatchObject({ status: 409, code: 'asset_in_trash' });

    const same = await s.client.works.get(w.id);
    expect(same.current_revision_id).toBe(w.current_revision_id);
    expect((await s.client.workAssets.list(w.id)).items).toEqual([]);
  });

  it('does not rewrite a file whose front matter is broken', async () => {
    const s = await start();
    const created = await s.client.works.create({ title: 'x', type: 'image' });
    const broken = '---\nimages: [\n---\n描述';
    await s.client.works.patch(created.id, {
      base_revision: created.current_revision_id,
      markdown: broken,
    });
    const a = await image(s, 'a.png', '#ff0000');
    const err = await apiError(
      s.client.workAssets.link(created.id, { asset_id: a.id, role: 'body' }),
    );
    expect(err).toMatchObject({ status: 409, code: 'front_matter_invalid' });
    expect(fs.readFileSync(sourceFile(s, created.id), 'utf8')).toBe(broken);
  });
});

describe('linking assets to a video work', () => {
  it('shows the video and its cover on the work, its card and 抖音／視頻號', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '雨天', type: 'video' });
    const v = await video(s);
    const cover = await image(s, 'cover.png', '#ff0000');

    await s.client.workAssets.link(w.id, { asset_id: v.id, role: 'video' });
    const linked = await s.client.workAssets.link(w.id, { asset_id: cover.id, role: 'cover' });
    expect(rows(linked.items)).toEqual([
      ['cover', 0, cover.id],
      ['video', 0, v.id],
    ]);

    const after = await s.client.works.get(w.id);
    expect(after.media?.video).toMatchObject({ asset_id: v.id, status: 'present' });
    expect(coverId(after)).toBe(cover.id);
    expect(await card(s, w.id)).toMatchObject({ thumbnail: { asset_id: cover.id } });
    for (const platform of ['douyin', 'wechat_channels'] as const) {
      expect((await s.client.variants.get(w.id, platform)).cover).toEqual({ asset_id: cover.id });
    }
  });

  it('replaces the single video and removes what is unlinked', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: 'x', type: 'video' });
    const first = await video(s);
    const second = (
      await s.client.assets.upload({
        data: Buffer.concat([mp4Bytes(), Buffer.from([1, 2, 3])]),
        filename: 'second.mp4',
      })
    ).asset;
    await s.client.workAssets.link(w.id, { asset_id: first.id, role: 'video' });
    const replaced = await s.client.workAssets.link(w.id, { asset_id: second.id, role: 'video' });
    expect(rows(replaced.items)).toEqual([['video', 0, second.id]]);
    expect((await s.client.works.get(w.id)).media?.video?.asset_id).toBe(second.id);

    await s.client.workAssets.unlink(w.id, second.id, 'video');
    expect((await s.client.works.get(w.id)).media?.video).toBeNull();

    const body = await image(s, 'a.png', '#ff0000');
    const err = await apiError(s.client.workAssets.link(w.id, { asset_id: body.id, role: 'body' }));
    expect(err.body?.error.details).toMatchObject({ allowed: ['video', 'cover'] });
  });
});

describe('articles', () => {
  it('are linked as before: the text is not written', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '圖文', markdown: '# 圖文\n' });
    const a = await image(s, 'a.png', '#ff0000');
    await s.client.workAssets.link(w.id, { asset_id: a.id, role: 'body' });
    await s.client.workAssets.link(w.id, { asset_id: a.id, role: 'cover' });
    const after = await s.client.works.get(w.id);
    expect(after.current_revision_id).toBe(w.current_revision_id);
    expect(after.markdown).toBe('# 圖文\n');
  });
});

describe('URL import into an image or video work', () => {
  async function withUpstream() {
    const up = await startUpstream();
    upstreams.push(up);
    up.routes.set('/a.png', serve(await pngBytes(12, 16, '#ff0000'), 'image/png'));
    up.routes.set('/b.png', serve(await pngBytes(12, 16, '#00ff00'), 'image/png'));
    up.routes.set('/v.mp4', serve(mp4Bytes(), 'video/mp4'));
    const s = await start({ download: up.download(), jobs: { retryBaseMs: 1, pollMs: 5 } });
    const run = async (
      client: TestServer['client'],
      file: string,
      workId: string,
      role?: 'cover' | 'body' | 'video',
    ) => {
      const job = await client.imports.url(
        {
          url: `http://cdn.example.com/${file}`,
          work_id: workId,
          ...(role === undefined ? {} : { role }),
        },
        { idempotencyKey: `qc102-${workId}-${file}` },
      );
      return client.jobs.wait(job.id, { intervalMs: 10, timeoutMs: 5000 });
    };
    return { s, run };
  }

  it('puts the file on the work, as the agent that asked', async () => {
    const { s, run } = await withUpstream();
    const w = await s.client.works.create({ title: '雨天', type: 'video' });
    const token = s.tokens.create({ name: 'Gemini', scopes: ['read', 'import', 'write'] });
    const agent = createClient({ baseUrl: s.baseUrl, token: token.secret });

    expect(await run(agent, 'v.mp4', w.id)).toMatchObject({ status: 'succeeded' });
    // Without a role an image can only be the cover, and only while there is none.
    expect(await run(agent, 'a.png', w.id)).toMatchObject({ status: 'succeeded' });
    const after = await s.client.works.get(w.id);
    expect(after.media?.video?.status).toBe('present');
    expect(after.media?.cover?.kind).toBe('image');

    const second = await run(agent, 'b.png', w.id);
    expect(second.status).toBe('failed');
    expect(second.error).toContain('role "cover"');
    expect(coverId(await s.client.works.get(w.id))).toBe(coverId(after));

    const history = await s.client.works.revisions(w.id);
    expect(history.items[0]).toMatchObject({ agent: { name: 'Gemini', via: 'direct' } });
  });

  it('needs the write permission, and a role the work can show', async () => {
    const { s } = await withUpstream();
    const w = await s.client.works.create({ title: '貼圖', type: 'image' });
    const token = s.tokens.create({ name: 'importer', scopes: ['read', 'import'] });
    const importer = createClient({ baseUrl: s.baseUrl, token: token.secret });
    const refused = await apiError(
      importer.imports.url(
        { url: 'http://cdn.example.com/a.png', work_id: w.id },
        { idempotencyKey: 'import-only-0001' },
      ),
    );
    expect(refused).toMatchObject({ status: 403, code: 'forbidden' });
    expect(refused.body?.error.details).toMatchObject({ required: 'write' });

    const role = await apiError(
      s.client.imports.url({ url: 'http://cdn.example.com/v.mp4', work_id: w.id, role: 'video' }),
    );
    expect(role).toMatchObject({ status: 400, code: 'validation_error' });
    expect((await s.client.jobs.list()).total).toBe(0);

    // Articles are linked as before, with the import permission alone.
    const article = await s.client.works.create({ title: '文章' });
    const job = await importer.imports.url(
      { url: 'http://cdn.example.com/a.png', work_id: article.id },
      { idempotencyKey: 'import-only-0002' },
    );
    expect(await s.client.jobs.wait(job.id, { intervalMs: 10, timeoutMs: 5000 })).toMatchObject({
      status: 'succeeded',
    });
  });
});

describe('external (mounted) image works', () => {
  it('use files of their own folder only, writing the note’s front matter', async () => {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qc102-mount-')));
    dirs.push(folder);
    fs.writeFileSync(path.join(folder, 'one.png'), await pngBytes(10, 10, '#ff0000'));
    fs.writeFileSync(path.join(folder, 'two.png'), await pngBytes(10, 10, '#00ff00'));
    fs.writeFileSync(path.join(folder, 'ref.md'), '![](two.png)\n');
    const note = path.join(folder, 'post.md');
    fs.writeFileSync(
      note,
      '---\ntype: image\ntitle: 外部\nimages:\n  - one.png\nmy: keep\n---\n文\n',
    );
    const s = await start({
      jobs: { pollMs: 5 },
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    });
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const works = (await s.client.works.list()).items;
    const id = works.find((w) => w.type === 'image')?.id ?? '';
    // A file of the mount is in the library once an article's text refers to it.
    await s.client.works.media(works.find((w) => w.type === 'article')?.id ?? '');

    const library = await image(s, 'library.png', '#0000ff');
    const outside = await apiError(
      s.client.workAssets.link(id, { asset_id: library.id, role: 'body' }),
    );
    expect(outside).toMatchObject({ status: 409, code: 'attach_external_unsupported' });
    expect(fs.readFileSync(note, 'utf8')).toContain('  - one.png\nmy: keep');

    const two = (await s.client.assets.list({ q: 'two' })).items[0]?.id ?? '';
    const linked = await s.client.workAssets.link(id, { asset_id: two, role: 'body' });
    expect(linked.items.map((i) => i.asset.id)).toEqual([two]);
    expect(fs.readFileSync(note, 'utf8')).toContain('  - one.png\n  - two.png\nmy: keep');
    expect(fs.existsSync(path.join(s.home, 'library/works', id, 'assets'))).toBe(false);
  });
});
