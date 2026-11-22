import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@qiu-creator/api-client';
import type { Mount } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { attachName } from '../src/media/attach.js';
import { pngBytes } from './fixtures.js';
import { startTestServer, type TestServer } from './helpers.js';

/* QC-039: POST /api/v1/works/:id/media/attach. */

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({
    jobs: { pollMs: 5 },
    mounts: { stabilityMs: 300, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
  });
  servers.push(s);
  return s;
}

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

/** Every file below `dir` with its sha256 (relative paths). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = sha(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

async function setup() {
  const s = await startTestServer({ jobs: { pollMs: 5 } });
  servers.push(s);
  const work = await s.client.works.create({ title: '書房改造', markdown: '正文\n' });
  const workDir = path.join(s.home, 'library', 'works', work.id);
  const assetsDir = path.join(workDir, 'assets');
  const upload = async (name: string, color = '#336699') => {
    const data = await pngBytes(16, 12, color);
    const res = await s.client.assets.upload({ data, filename: name });
    return { asset: res.asset, data };
  };
  return { s, work, workDir, assetsDir, upload };
}

describe('attach an asset to a managed work (QC-039)', () => {
  it('copies the file into the work, links it and leaves the Markdown alone', async () => {
    const { s, work, assetsDir, upload } = await setup();
    const { asset, data } = await upload('kyoto.png');
    const res = await s.client.works.attachMedia(work.id, asset.id);
    expect(res).toMatchObject({ src: 'assets/kyoto.png', copied: true, asset: { id: asset.id } });
    expect(sha(fs.readFileSync(path.join(assetsDir, 'kyoto.png')))).toBe(sha(data));
    // No temporary files left behind.
    expect(fs.readdirSync(assetsDir)).toEqual(['kyoto.png']);
    // Linked to the work, Markdown and revision untouched.
    const linked = await s.client.workAssets.list(work.id);
    expect(linked.items.map((i) => [i.asset.id, i.role])).toEqual([[asset.id, 'body']]);
    const after = await s.client.works.get(work.id);
    expect(after.markdown).toBe('正文\n');
    expect(after.current_revision_id).toBe(work.current_revision_id);
    // Once the editor saves `![](src)`, the image resolves.
    await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `正文\n\n![](${res.src})\n`,
    });
    const media = await s.client.works.media(work.id);
    expect(media.items).toEqual([
      expect.objectContaining({ src: 'assets/kyoto.png', status: 'resolved' }),
    ]);
  });

  it('is idempotent and makes the asset count as in use', async () => {
    const { s, work, assetsDir, upload } = await setup();
    const { asset } = await upload('desk.png');
    const first = await s.client.works.attachMedia(work.id, asset.id);
    const second = await s.client.works.attachMedia(work.id, asset.id);
    expect(second).toMatchObject({ src: first.src, copied: false });
    expect(fs.readdirSync(assetsDir)).toEqual(['desk.png']);
    expect((await s.client.workAssets.list(work.id)).items).toHaveLength(1);
    // QC-037 delete rules: referenced → 409 asset_in_use without confirm, and the
    // reference says the post holds an independent copy (its images survive).
    const err = await apiError(s.client.assets.trash(asset.id));
    expect(err.code).toBe('asset_in_use');
    expect(await s.client.assets.references(asset.id)).toEqual({
      works: [
        { work_id: work.id, title: '書房改造', role: 'body', position: 0, independent_copy: true },
      ],
      variants: [],
      in_trash: { works: [], variants: [] },
    });
  });

  it('marks direct links (cover, or a body link without a copy) as not independent', async () => {
    const { s, work, upload } = await setup();
    const { asset } = await upload('direct.png');
    await s.client.workAssets.link(work.id, { asset_id: asset.id, role: 'cover' });
    await s.client.workAssets.link(work.id, { asset_id: asset.id, role: 'body' });
    const refs = await s.client.assets.references(asset.id);
    expect(refs.works.map((r) => [r.role, r.independent_copy])).toEqual([
      ['body', false],
      ['cover', false],
    ]);
    // After attach the body image is a copy; the cover still points at the asset itself.
    await s.client.works.attachMedia(work.id, asset.id);
    const after = await s.client.assets.references(asset.id);
    expect(after.works.map((r) => [r.role, r.independent_copy])).toEqual([
      ['body', true],
      ['cover', false],
    ]);
  });

  it('reuses a file with the same content under another name instead of copying', async () => {
    const { s, work, assetsDir, upload } = await setup();
    const { asset, data } = await upload('original.png');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'already-here.png'), data);
    const res = await s.client.works.attachMedia(work.id, asset.id);
    expect(res).toMatchObject({ src: 'assets/already-here.png', copied: false });
    expect(fs.readdirSync(assetsDir)).toEqual(['already-here.png']);
  });

  it('never overwrites a different file with the same name', async () => {
    const { s, work, assetsDir, upload } = await setup();
    fs.mkdirSync(assetsDir, { recursive: true });
    const theirs = await pngBytes(8, 8, '#ff0000');
    fs.writeFileSync(path.join(assetsDir, 'cover.png'), theirs);
    fs.writeFileSync(path.join(assetsDir, 'cover-2.png'), await pngBytes(9, 9, '#00ff00'));
    const { asset, data } = await upload('cover.png');
    const res = await s.client.works.attachMedia(work.id, asset.id);
    expect(res).toMatchObject({ src: 'assets/cover-3.png', copied: true });
    expect(sha(fs.readFileSync(path.join(assetsDir, 'cover.png')))).toBe(sha(theirs));
    expect(sha(fs.readFileSync(path.join(assetsDir, 'cover-3.png')))).toBe(sha(data));
  });

  it('keeps unsafe names inside the work folder', async () => {
    const { s, work, workDir, upload } = await setup();
    const before = tree(path.join(s.home, 'library'));
    const { asset } = await upload('../../../evil (1)#[x].png');
    const res = await s.client.works.attachMedia(work.id, asset.id);
    expect(res.src).toMatch(/^assets\/[^/]+\.png$/);
    expect(res.src).not.toMatch(/[()[\]#\s]|\.\./);
    expect(fs.existsSync(path.join(workDir, res.src))).toBe(true);
    // Only the work's assets/ (and the uploaded asset) changed.
    const added = Object.keys(tree(path.join(s.home, 'library'))).filter((k) => !(k in before));
    expect(
      added.every((k) => k.startsWith('assets/') || k.startsWith(`works/${work.id}/assets/`)),
    ).toBe(true);
    expect(fs.existsSync(path.join(s.home, 'evil (1)#[x].png'))).toBe(false);
  });

  it('is an independent copy: trashing and purging the library asset keeps the post image', async () => {
    const { s, work, assetsDir, upload } = await setup();
    const { asset } = await upload('keep.png');
    const res = await s.client.works.attachMedia(work.id, asset.id);
    await s.client.works.patch(work.id, {
      base_revision: work.current_revision_id,
      markdown: `![](${res.src})\n`,
    });
    await s.client.assets.trash(asset.id, { confirm: true });
    await s.client.trash.purge(asset.id);
    expect(fs.existsSync(path.join(assetsDir, 'keep.png'))).toBe(true);
    const media = await s.client.works.media(work.id);
    expect(media.items[0]).toMatchObject({ src: 'assets/keep.png', status: 'resolved' });
  });

  it('refuses trashed assets, unknown assets and unknown works', async () => {
    const { s, work, upload } = await setup();
    const { asset } = await upload('gone.png');
    await s.client.assets.trash(asset.id);
    const trashed = await apiError(s.client.works.attachMedia(work.id, asset.id));
    expect([trashed.status, trashed.code]).toEqual([409, 'asset_in_trash']);
    const missing = await apiError(
      s.client.works.attachMedia(work.id, '00000000-0000-4000-8000-000000000123'),
    );
    expect([missing.status, missing.code]).toEqual([404, 'not_found']);
    const noWork = await apiError(
      s.client.works.attachMedia('00000000-0000-4000-8000-000000000456', asset.id),
    );
    expect(noWork.status).toBe(404);
  });

  it('serializes concurrent attaches of the same asset to one copy', async () => {
    const { s, work, assetsDir, upload } = await setup();
    const { asset } = await upload('race.png');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s.client.works.attachMedia(work.id, asset.id)),
    );
    expect(new Set(results.map((r) => r.src))).toEqual(new Set(['assets/race.png']));
    expect(fs.readdirSync(assetsDir)).toEqual(['race.png']);
  });
});

describe('attach and external works', () => {
  it('answers 409 attach_external_unsupported and never writes the mounted folder', async () => {
    const s = await start();
    const root = tempDir('qc039-mount-');
    fs.writeFileSync(path.join(root, 'post.md'), '# 外部\n');
    const before = tree(root);
    const mount: Mount = await s.client.mounts.create({ path: root });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const work = (await s.client.works.list()).items.find((w) => w.external_path === 'post.md');
    if (work === undefined) throw new Error('not indexed');
    const { asset } = await s.client.assets.upload({
      data: await pngBytes(8, 8, '#123456'),
      filename: 'x.png',
    });
    const err = await apiError(s.client.works.attachMedia(work.id, asset.id));
    expect([err.status, err.code]).toEqual([409, 'attach_external_unsupported']);
    expect(tree(root)).toEqual(before);
    expect((await s.client.workAssets.list(work.id)).items).toEqual([]);
  });

  it('copies an asset from a mounted folder into a managed work', async () => {
    const s = await start();
    const root = tempDir('qc039-src-');
    const data = await pngBytes(10, 10, '#abcdef');
    fs.writeFileSync(path.join(root, 'pic.png'), data);
    fs.writeFileSync(path.join(root, 'note.md'), '![](pic.png)\n');
    const mount: Mount = await s.client.mounts.create({ path: root });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const note = (await s.client.works.list()).items.find((w) => w.external_path === 'note.md');
    if (note === undefined) throw new Error('not indexed');
    await s.client.works.media(note.id);
    const external = (await s.client.assets.list({ limit: 50 })).items.find((a) => a.mount_id);
    if (external === undefined) throw new Error('external asset not indexed');
    const work = await s.client.works.create({ title: '託管', markdown: '' });
    const res = await s.client.works.attachMedia(work.id, external.id);
    expect(res).toMatchObject({ src: 'assets/pic.png', copied: true });
    const copy = path.join(s.home, 'library', 'works', work.id, 'assets', 'pic.png');
    expect(sha(fs.readFileSync(copy))).toBe(sha(data));
    // The original stays where it was.
    expect(fs.existsSync(path.join(root, 'pic.png'))).toBe(true);
  });
});

describe('attachName', () => {
  const base = { path: 'library/assets/x/y.png', mime_type: 'image/png' };
  it('keeps a plain name and cleans the rest', () => {
    expect(attachName({ ...base, original_name: '嵐山 竹林.png' })).toBe('嵐山-竹林.png');
    expect(attachName({ ...base, original_name: '../../a:b(c)[d]#e?.png' })).toBe('a-b-c-d-e-.png');
    expect(attachName({ ...base, original_name: '...png' })).toBe('png');
    expect(attachName({ ...base, original_name: null })).toBe('y.png');
    expect(attachName({ ...base, original_name: '.hidden' })).toBe('hidden');
    expect(attachName({ ...base, original_name: '---' })).toBe('image.png');
    const long = attachName({ ...base, original_name: `${'長'.repeat(300)}.png` });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.png')).toBe(true);
  });
});
