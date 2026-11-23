import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import type { AssetRecord, WorkDetail } from '@qiu-creator/contracts';
import { parseWorkSource } from '@qiu-creator/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes } from './fixtures.js';
import { authHeaders, startTestServer, type StartOptions, type TestServer } from './helpers.js';

/**
 * QC-045/046: image-post and video works are Markdown with front matter; a
 * PATCH of their files and copy is one revisioned write; articles are as before.
 */

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

async function image(s: TestServer, name: string, color: string, w = 30, h = 40) {
  return (await s.client.assets.upload({ data: await pngBytes(w, h, color), filename: name }))
    .asset;
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

const sourceFile = (s: TestServer, w: WorkDetail) =>
  path.join(s.home, 'library/works', w.id, 'source.md');
const assetsDir = (s: TestServer, w: WorkDetail) =>
  path.join(s.home, 'library/works', w.id, 'assets');
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** Pretend thumbnails/ffprobe ran: give an asset its size (jobs are off in tests). */
function setSize(s: TestServer, a: AssetRecord, width: number, height: number, duration?: number) {
  s.db
    .prepare('UPDATE assets SET width = ?, height = ?, duration = ? WHERE id = ?')
    .run(width, height, duration ?? null, a.id);
}

describe('creating typed works', () => {
  it('starts an image work as front matter plus its description', async () => {
    const s = await start();
    const w = await s.client.works.create({
      title: '京都秋天',
      type: 'image',
      tags: ['旅行'],
      description: '紅葉季。',
    });
    expect(w.markdown).toBe(
      '---\ntype: image\ntitle: 京都秋天\nimages: []\ntags:\n  - 旅行\n---\n紅葉季。',
    );
    expect(w).toMatchObject({
      type: 'image',
      description: '紅葉季。',
      media: { images: [], cover: null, video: null, front_matter_invalid: false, warnings: [] },
    });
    const v = await s.client.works.create({ title: '雨天', type: 'video' });
    expect(v.markdown).toBe('---\ntype: video\ntitle: 雨天\ntags: []\n---\n');
    expect(v.description).toBe('');
  });

  it('refuses a description on an article', async () => {
    const s = await start();
    const err = await apiError(s.client.works.create({ title: 'x', description: 'y' }));
    expect(err.status).toBe(400);
  });
});

describe('PATCH of an image work', () => {
  it('writes images, cover, copy and tags in one revision, copying files into assets/', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '京都秋天', type: 'image' });
    const a = await image(s, 'kyoto 1.png', '#ff0000');
    const b = await image(s, 'kyoto-2.png', '#00ff00');
    setSize(s, b, 30, 40);

    const res = await fetch(`${s.baseUrl}/api/v1/works/${w.id}`, {
      method: 'PATCH',
      headers: authHeaders({
        'content-type': 'application/json',
        'if-match': `"${w.current_revision_id}"`,
      }),
      body: JSON.stringify({
        title: '京都紅葉',
        description: '第一天去了嵐山。\n\n第二天清水寺。',
        tags: ['旅行', '京都', '旅行'],
        images: [b.id, a.id],
        cover: { asset_id: b.id },
      }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as WorkDetail;
    expect(res.headers.get('etag')).toBe(`"${updated.current_revision_id}"`);
    expect(files(assetsDir(s, w))).toEqual(['kyoto-1.png', 'kyoto-2.png']);
    const disk = fs.readFileSync(sourceFile(s, w), 'utf8');
    expect(disk).toBe(updated.markdown);
    expect(parseWorkSource(disk)).toEqual({
      frontMatter: {
        type: 'image',
        title: '京都紅葉',
        images: ['assets/kyoto-2.png', 'assets/kyoto-1.png'],
        cover: { path: 'assets/kyoto-2.png' },
        video: null,
        tags: ['旅行', '京都'],
      },
      body: '第一天去了嵐山。\n\n第二天清水寺。',
      invalid: false,
      warnings: [],
    });
    expect(updated).toMatchObject({
      title: '京都紅葉',
      tags: ['旅行', '京都'],
      description: '第一天去了嵐山。\n\n第二天清水寺。',
      media: {
        images: [
          { path: 'assets/kyoto-2.png', asset_id: b.id, status: 'present', width: 30, height: 40 },
          { path: 'assets/kyoto-1.png', asset_id: a.id, status: 'present' },
        ],
        cover: { kind: 'image', item: { path: 'assets/kyoto-2.png', asset_id: b.id } },
      },
    });
    const revisions = await s.client.works.revisions(w.id);
    expect(revisions.items.map((r) => r.source)).toEqual(['edit', 'create']);
    // The previous version is still a snapshot in history.
    const first = await s.client.works.revision(w.id, w.current_revision_id);
    expect(first.markdown).toBe(w.markdown);
    // QC-037: the work now uses both library assets.
    expect((await s.client.assets.references(a.id)).works.map((x) => x.work_id)).toEqual([w.id]);

    // Reorder and drop one: the front matter follows, files stay on disk.
    const again = await s.client.works.patch(w.id, {
      base_revision: updated.current_revision_id,
      images: [a.id],
    });
    expect(again.media?.images.map((i) => i.path)).toEqual(['assets/kyoto-1.png']);
    expect(again.media?.cover).toMatchObject({
      kind: 'image',
      item: { path: 'assets/kyoto-2.png' },
    });
    expect(files(assetsDir(s, w))).toEqual(['kyoto-1.png', 'kyoto-2.png']);
  });

  it('needs a base (428), refuses a stale one (409) and leaves no copied files behind', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '貼圖', type: 'image' });
    const a = await image(s, 'a.png', '#123456');
    expect((await apiError(s.client.works.patch(w.id, { images: [a.id] }))).status).toBe(428);

    const moved = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      description: '新的描述',
    });
    const before = fs.readFileSync(sourceFile(s, w), 'utf8');
    const stale = await apiError(
      s.client.works.patch(w.id, { base_revision: w.current_revision_id, images: [a.id] }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body?.error).toMatchObject({
      code: 'revision_conflict',
      details: { current_revision: moved.current_revision_id },
    });
    expect(fs.readFileSync(sourceFile(s, w), 'utf8')).toBe(before);
    expect(files(assetsDir(s, w))).toEqual([]);
  });

  it('two writes from the same base: one wins, the loser leaves nothing on disk', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '並發', type: 'image' });
    const a = await image(s, 'a.png', '#aa0000');
    const b = await image(s, 'b.png', '#00aa00');
    const results = await Promise.allSettled([
      s.client.works.patch(w.id, { base_revision: w.current_revision_id, images: [a.id] }),
      s.client.works.patch(w.id, { base_revision: w.current_revision_id, images: [b.id] }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (await s.client.works.get(w.id)).media?.images.map((i) => i.path) ?? [];
    expect(files(assetsDir(s, w))).toEqual(winner.map((p) => path.basename(p)));
  });

  it('keeps unknown front-matter keys and comments when the app writes', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '手寫', type: 'image' });
    const hand =
      '---\n# 我的筆記\ntype: image\ntitle: 手寫\nlocation: 京都\nimages: []\n---\n描述\n';
    const written = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      markdown: hand,
    });
    const a = await image(s, 'a.png', '#333333');
    const next = await s.client.works.patch(w.id, {
      base_revision: written.current_revision_id,
      images: [a.id],
      tags: ['京都'],
    });
    expect(next.markdown).toBe(
      '---\n# 我的筆記\ntype: image\ntitle: 手寫\nlocation: 京都\nimages:\n  - assets/a.png\ntags:\n  - 京都\n---\n描述\n',
    );
  });

  it('refuses to rewrite invalid front matter and says so', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '壞掉', type: 'image' });
    const broken = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      markdown: '---\ntitle: [unclosed\n---\n描述\n',
    });
    expect(broken.media).toMatchObject({ front_matter_invalid: true, images: [] });
    const err = await apiError(
      s.client.works.patch(w.id, { base_revision: broken.current_revision_id, description: 'x' }),
    );
    expect(err.status).toBe(409);
    expect(err.body?.error.code).toBe('front_matter_invalid');
    expect(fs.readFileSync(sourceFile(s, w), 'utf8')).toBe('---\ntitle: [unclosed\n---\n描述\n');
  });

  it('checks asset kinds and which fields fit which type', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '貼圖', type: 'image' });
    const v = (await s.client.assets.upload({ data: mp4Bytes(), filename: 'v.mp4' })).asset;
    const base = { base_revision: w.current_revision_id };
    expect((await apiError(s.client.works.patch(w.id, { ...base, images: [v.id] }))).status).toBe(
      400,
    );
    expect(
      (await apiError(s.client.works.patch(w.id, { ...base, video_asset_id: v.id }))).status,
    ).toBe(400);
    expect(
      (await apiError(s.client.works.patch(w.id, { ...base, cover: { time_seconds: 2 } }))).status,
    ).toBe(400);
    const missing = randomUUID();
    expect(
      (await apiError(s.client.works.patch(w.id, { ...base, images: [missing] }))).status,
    ).toBe(404);
    expect(fs.readFileSync(sourceFile(s, w), 'utf8')).toBe(w.markdown);
  });
});

describe('video works', () => {
  it('stores the video and a frame cover; adopting AI suggestions is an ai_accepted revision', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '雨天散步', type: 'video' });
    const v = (await s.client.assets.upload({ data: mp4Bytes(), filename: 'walk.mp4' })).asset;
    setSize(s, v, 1080, 1920, 42.5);
    const res = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      video_asset_id: v.id,
      cover: { time_seconds: 3.5 },
      description: '雨後的街道。',
    });
    expect(parseWorkSource(res.markdown).frontMatter).toMatchObject({
      video: 'assets/walk.mp4',
      cover: { time_seconds: 3.5 },
    });
    expect(res.media).toMatchObject({
      video: { path: 'assets/walk.mp4', asset_id: v.id, kind: 'video', duration_seconds: 42.5 },
      cover: { kind: 'frame', time_seconds: 3.5 },
    });
    const card = (await s.client.works.list({ type: 'video' })).items[0];
    expect(card).toMatchObject({
      thumbnail: { asset_id: v.id, path: 'assets/walk.mp4', kind: 'video', time_seconds: 3.5 },
      image_count: null,
      duration_seconds: 42.5,
      orientation: 'portrait',
      missing_media: 0,
    });

    // A succeeded video-understanding job for this work's video.
    const job = randomUUID();
    const now = new Date().toISOString();
    s.db
      .prepare(
        `INSERT INTO ai_jobs (id, work_id, model, action, status, created_at, updated_at, task)
         VALUES (?, NULL, 'gemini', 'video_understanding', 'succeeded', ?, ?, ?)`,
      )
      .run(job, now, now, JSON.stringify({ type: 'video_understanding', asset_id: v.id }));
    const adopted = await s.client.works.patch(w.id, {
      base_revision: res.current_revision_id,
      title: '雨後的城市',
      description: 'AI 建議的簡介。',
      ai_job_id: job,
    });
    const revs = await s.client.works.revisions(w.id);
    expect(revs.items[0]).toMatchObject({ source: 'ai_accepted', ai_job_id: job });
    expect(adopted.title).toBe('雨後的城市');

    const other = randomUUID();
    s.db
      .prepare(
        `INSERT INTO ai_jobs (id, work_id, model, action, status, created_at, updated_at, task)
         VALUES (?, NULL, 'gemini', 'video_understanding', 'failed', ?, ?, NULL)`,
      )
      .run(other, now, now);
    const refused = await apiError(
      s.client.works.patch(w.id, {
        base_revision: adopted.current_revision_id,
        title: 'x',
        ai_job_id: other,
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body?.error.code).toBe('ai_job_not_acceptable');
  });
});

describe('library list (QC-045/046)', () => {
  it('adds thumbnail, image count, orientation and missing media; ids fetches in order', async () => {
    const s = await start();
    const article = await s.client.works.create({ title: '文章', markdown: '# 文章\n' });
    const w = await s.client.works.create({ title: '貼圖', type: 'image' });
    const a = await image(s, 'a.png', '#111111');
    const b = await image(s, 'b.png', '#222222');
    setSize(s, a, 400, 300);
    const done = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      images: [a.id, b.id],
    });
    const list = await s.client.works.list();
    const card = list.items.find((i) => i.id === w.id);
    expect(card).toMatchObject({
      thumbnail: { asset_id: a.id, path: 'assets/a.png', kind: 'image' },
      image_count: 2,
      duration_seconds: null,
      orientation: 'landscape',
      missing_media: 0,
    });
    const plain = list.items.find((i) => i.id === article.id);
    expect(plain?.thumbnail).toBeUndefined();

    fs.rmSync(path.join(assetsDir(s, w), 'b.png'));
    expect((await s.client.works.list()).items.find((i) => i.id === w.id)?.missing_media).toBe(1);
    expect((await s.client.works.get(w.id)).media?.images[1]).toMatchObject({
      path: 'assets/b.png',
      status: 'missing',
    });
    expect(done.media?.images).toHaveLength(2);

    const gone = randomUUID();
    const byIds = await s.client.works.list({ ids: [w.id, gone, article.id] });
    expect(byIds.items.map((i) => i.id)).toEqual([w.id, article.id]);
    expect(byIds.missing_ids).toEqual([gone]);
  });
});

describe('articles are unchanged (QC-045/046)', () => {
  it('never get front matter written and refuse media fields', async () => {
    const s = await start();
    const md = '---\ntitle: 看起來像 front matter\n---\n# 文章\n\n正文\n';
    const w = await s.client.works.create({ title: '文章', markdown: md });
    expect(w).not.toHaveProperty('media');
    const renamed = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      title: '新標題',
      tags: ['x'],
    });
    expect(renamed.markdown).toBe(md);
    expect(fs.readFileSync(sourceFile(s, w), 'utf8')).toBe(md);
    expect(renamed).not.toHaveProperty('description');
    const a = await image(s, 'a.png', '#444444');
    const err = await apiError(
      s.client.works.patch(w.id, { base_revision: renamed.current_revision_id, images: [a.id] }),
    );
    expect(err.status).toBe(400);
  });
});

describe('external typed works (QC-045/046)', () => {
  async function mounted() {
    const s = await start({
      jobs: { pollMs: 5 },
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    });
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-mount-')));
    dirs.push(folder);
    fs.mkdirSync(path.join(folder, 'pics'));
    fs.writeFileSync(path.join(folder, 'pics', 'p1.png'), await pngBytes(10, 10, '#ff00ff'));
    fs.writeFileSync(
      path.join(folder, 'post.md'),
      '---\ntype: image\ntitle: 外部貼圖\nimages:\n  - pics/p1.png\n  - pics/gone.png\ntags: [外部]\n---\n外部描述\n',
    );
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items[0];
    if (work === undefined) throw new Error('no external work');
    return { s, folder, work };
  }

  it('reads type, title and files from the front matter, in place', async () => {
    const { s, work } = await mounted();
    expect(work).toMatchObject({
      type: 'image',
      title: '外部貼圖',
      tags: ['外部'],
      storage_mode: 'external',
      image_count: 2,
      missing_media: 1,
    });
    const detail = await s.client.works.get(work.id);
    expect(detail.description).toBe('外部描述\n');
    expect(detail.media?.images.map((i) => [i.path, i.status])).toEqual([
      ['pics/p1.png', 'present'],
      ['pics/gone.png', 'missing'],
    ]);
  });

  it('never copies library files in; text edits write only its own Markdown', async () => {
    const { s, folder, work } = await mounted();
    const before = fs.readdirSync(folder, { recursive: true }).map(String).sort();
    const a = await image(s, 'lib.png', '#0000ff');
    const refused = await apiError(
      s.client.works.patch(work.id, { base_revision: work.current_revision_id, images: [a.id] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body?.error.code).toBe('attach_external_unsupported');
    const saved = await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      description: '改過的描述\n',
    });
    expect(fs.readdirSync(folder, { recursive: true }).map(String).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(folder, 'post.md'), 'utf8')).toBe(saved.markdown);
    expect(parseWorkSource(saved.markdown).frontMatter?.images).toEqual([
      'pics/p1.png',
      'pics/gone.png',
    ]);
    expect(fs.existsSync(path.join(s.home, 'library/works', work.id, 'assets'))).toBe(false);
  });
});

describe('platform variants of typed works (QC-045/046)', () => {
  it('follows the front matter and description; overrides are kept apart (QC-084)', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '雨天', type: 'video', tags: ['城市'] });
    const v = (await s.client.assets.upload({ data: mp4Bytes(), filename: 'walk.mp4' })).asset;
    const work = await s.client.works.patch(w.id, {
      base_revision: w.current_revision_id,
      video_asset_id: v.id,
      cover: { time_seconds: 7 },
      description: '共用的簡介',
    });
    expect(await s.client.variants.get(w.id, 'douyin')).toMatchObject({
      title: '雨天',
      body: '共用的簡介',
      tags: ['城市'],
      cover: { time_seconds: 7 },
      cover_source: 'work',
    });

    const own = await s.client.variants.patch(w.id, 'douyin', {
      base_revision: 0,
      title: '抖音專用標題',
      cover: { time_seconds: 3 },
    });
    expect(own).toMatchObject({ title: '抖音專用標題', cover: { time_seconds: 3 } });
    // The work changes: overridden fields stay, the others follow without a new revision.
    await s.client.works.patch(w.id, {
      base_revision: work.current_revision_id,
      title: '雨後',
      description: '新的簡介',
    });
    expect(await s.client.variants.get(w.id, 'douyin')).toMatchObject({
      title: '抖音專用標題',
      body: '新的簡介',
      revision: own.revision,
    });
    const back = await s.client.variants.patch(w.id, 'douyin', {
      base_revision: own.revision,
      title: null,
    });
    expect(back).toMatchObject({ title: '雨後', title_source: 'work' });
    const revs = await s.client.variants.revisions(w.id, 'douyin');
    expect(revs.items.map((r) => r.overrides?.title ?? null)).toEqual([null, '抖音專用標題']);
  });

  it('orders the images of an image work and takes an image cover', async () => {
    const s = await start();
    const w = await s.client.works.create({ title: '貼圖', type: 'image' });
    const a = await image(s, 'a.png', '#999999');
    const b = await image(s, 'b.png', '#888888');
    const withImages = await s.client.works.get(w.id);
    const saved = await s.client.works.patch(w.id, {
      base_revision: withImages.current_revision_id,
      images: [a.id, b.id],
    });
    const own = (saved.media?.images ?? []).map((i) => i.asset_id ?? '');
    expect(own).toHaveLength(2);
    const [ownA = '', ownB = ''] = own;
    const v = await s.client.variants.patch(w.id, 'xiaohongshu', {
      base_revision: 0,
      images: [ownB, ownA],
      cover: { asset_id: a.id },
    });
    expect(v).toMatchObject({
      images: [ownB, ownA],
      images_source: 'override',
      cover: { asset_id: a.id },
      cover_source: 'override',
    });
    const frame = await apiError(
      s.client.variants.patch(w.id, 'xiaohongshu', {
        base_revision: v.revision,
        cover: { time_seconds: 1 },
      }),
    );
    expect(frame.status).toBe(400);
  });
});
