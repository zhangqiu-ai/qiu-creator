import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '@qiu-creator/api-client';
import type { WorkListItem } from '@qiu-creator/contracts';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { workExcerpt } from '../src/works/card-images.js';
import { pngBytes } from './fixtures.js';
import {
  authHeaders,
  makeTempHome,
  startTestServer,
  type StartOptions,
  type TestServer,
} from './helpers.js';

/**
 * QC-061: library card images and excerpts. Temporary CREATORHUB_HOME; video
 * files are fake bytes and ffmpeg is a fake script (or absent), so no real
 * decoder is needed. Originals are checked byte for byte.
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

function tempDir(): string {
  const d = makeTempHome();
  dirs.push(d);
  return d;
}

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A managed work with this Markdown, and files written into its own folder. */
function work(
  s: TestServer,
  type: 'article' | 'image' | 'video',
  markdown: string,
  files: Record<string, Buffer> = {},
): ReturnType<TestServer['works']['create']> {
  const w = s.works.create({ title: '卡片', type, markdown });
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(s.home, 'library/works', w.id, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return w;
}

async function card(s: TestServer, id: string): Promise<WorkListItem> {
  const item = (await s.client.works.list({ ids: [id] })).items[0];
  if (item === undefined) throw new Error('work not listed');
  return item;
}

async function getThumb(s: TestServer, id: string, v?: string, extra: Record<string, string> = {}) {
  return fetch(`${s.baseUrl}${s.client.workThumbnails.path(id, v)}`, {
    headers: authHeaders(extra),
  });
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
  return err;
}

/** Card image of an item with its version checked separately (16 hex characters). */
function cardWithoutVersion(
  item: WorkListItem,
): Omit<NonNullable<WorkListItem['card_image']>, 'version' | 'url'> {
  const image = item.card_image;
  if (image == null) throw new Error('no card image');
  expect(image.version).toMatch(/^[0-9a-f]{16}$/);
  return {
    needs_frame: image.needs_frame,
    ...(image.frame_source === undefined ? {} : { frame_source: image.frame_source }),
  };
}

const FAKE_VIDEO = Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42'), Buffer.alloc(64)]);

describe('image cards (QC-061)', () => {
  it('serves a cached WebP of the first image, by path, even without a library asset', async () => {
    const s = await start();
    const big = await pngBytes(1200, 900, '#cc3344');
    const w = work(
      s,
      'image',
      '---\ntype: image\ntitle: 卡片\nimages:\n  - assets/a.png\n---\n秋天的京都。',
      {
        'assets/a.png': big,
      },
    );
    const original = path.join(s.home, 'library/works', w.id, 'assets/a.png');
    const before = sha(original);

    const item = await card(s, w.id);
    expect(item.thumbnail).toMatchObject({ asset_id: null, path: 'assets/a.png', kind: 'image' });
    expect(cardWithoutVersion(item)).toEqual({ needs_frame: false });
    expect(item.excerpt).toBe('秋天的京都。');
    const version = item.card_image?.version ?? '';

    const res = await getThumb(s, w.id, version);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('etag')).toBe(`"${version}"`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 384 });

    expect((await getThumb(s, w.id)).headers.get('cache-control')).toBe('private, no-cache');
    expect((await getThumb(s, w.id, version, { 'if-none-match': `"${version}"` })).status).toBe(
      304,
    );
    expect(
      fs.existsSync(path.join(s.home, 'cache/work-thumbnails', `${w.id}-${version}.webp`)),
    ).toBe(true);
    expect(sha(original)).toBe(before);
  });

  it('prefers the image cover, changes version when the source changes, and keeps one cached file', async () => {
    const s = await start();
    const w = work(
      s,
      'image',
      '---\ntype: image\ntitle: 卡片\nimages:\n  - assets/a.png\n  - assets/b.png\ncover: assets/b.png\n---\n',
      {
        'assets/a.png': await pngBytes(10, 10, '#000000'),
        'assets/b.png': await pngBytes(20, 10, '#ffffff'),
      },
    );
    const first = await card(s, w.id);
    expect(first.thumbnail?.path).toBe('assets/b.png');
    const v1 = first.card_image?.version ?? '';
    expect((await getThumb(s, w.id, v1)).status).toBe(200);

    // The cover file is replaced on disk: new fingerprint, old cache file dropped.
    fs.writeFileSync(
      path.join(s.home, 'library/works', w.id, 'assets/b.png'),
      await pngBytes(30, 10, '#00ff00'),
    );
    const v2 = (await card(s, w.id)).card_image?.version ?? '';
    expect(v2).not.toBe(v1);
    expect((await getThumb(s, w.id, v2)).status).toBe(200);
    expect(
      fs.readdirSync(path.join(s.home, 'cache/work-thumbnails')).filter((f) => f.startsWith(w.id)),
    ).toEqual([`${w.id}-${v2}.webp`]);
  });

  it('reports a missing source as no card image and 404 missing; no source as 404 none', async () => {
    const s = await start();
    const missing = work(
      s,
      'image',
      '---\ntype: image\ntitle: 卡片\nimages:\n  - assets/gone.png\n---\n',
    );
    expect((await card(s, missing.id)).card_image).toBeNull();
    const err = await apiError(s.client.workThumbnails.get(missing.id));
    expect(err.status).toBe(404);
    expect(err.body?.error).toMatchObject({
      code: 'thumbnail_unavailable',
      details: { reason: 'missing' },
    });

    const empty = work(s, 'image', '---\ntype: image\ntitle: 卡片\nimages: []\n---\n');
    expect((await card(s, empty.id)).card_image).toBeNull();
    expect((await apiError(s.client.workThumbnails.get(empty.id))).body?.error.details).toEqual({
      reason: 'none',
    });

    const broken = work(
      s,
      'image',
      '---\ntype: image\ntitle: 卡片\nimages:\n  - assets/x.png\n---\n',
      {
        'assets/x.png': Buffer.from('not really a png'),
      },
    );
    expect((await apiError(s.client.workThumbnails.get(broken.id))).body?.error.details).toEqual({
      reason: 'decode_failed',
    });
  });
});

describe('article cards (QC-061)', () => {
  it('uses the first local Markdown image and gives an excerpt without the title', async () => {
    const s = await start();
    const w = work(
      s,
      'article',
      '# 京都秋天\n\n![外部](https://example.com/x.png)\n\n![](assets/a.png)\n\n楓葉 **正紅**，[清水寺](https://example.com)人很多。\n',
      { 'assets/a.png': await pngBytes(40, 40, '#aa5500') },
    );
    const item = await card(s, w.id);
    expect(item.thumbnail).toEqual({ asset_id: null, path: 'assets/a.png', kind: 'image' });
    expect(item.card_image?.needs_frame).toBe(false);
    expect(item.excerpt).toBe('楓葉 正紅，清水寺人很多。');
    expect((await getThumb(s, w.id, item.card_image?.version)).status).toBe(200);

    const plain = work(s, 'article', '# 只有字\n\n第一段。\n\n第二段。\n');
    const p = await card(s, plain.id);
    expect(p).toMatchObject({ card_image: null, excerpt: '第一段。 第二段。' });
    // Articles without an image keep the old shape: no `thumbnail` field.
    expect(p.thumbnail).toBeUndefined();

    // Managed articles only reach their own assets/ folder.
    const outside = work(s, 'article', '![](../other/secret.png)\n');
    expect((await card(s, outside.id)).card_image).toBeNull();
  });

  it('works for articles in a mounted folder without touching the files', async () => {
    const s = await start({
      jobs: { pollMs: 5 },
      mounts: { stabilityMs: 100, writePollMs: 50, backend: 'polling', pollIntervalMs: 50 },
    });
    const folder = tempDir();
    fs.mkdirSync(path.join(folder, 'notes', 'img'), { recursive: true });
    const image = path.join(folder, 'notes', 'img', 'a.png');
    fs.writeFileSync(image, await pngBytes(600, 300, '#336699'));
    fs.writeFileSync(
      path.join(folder, 'notes', 'trip.md'),
      '# 旅行\n\n![](img/a.png)\n\n外部筆記。\n',
    );
    fs.writeFileSync(path.join(folder, 'escape.md'), '![](../../etc/x.png)\n');
    const before = sha(image);
    const mount = await s.client.mounts.create({ path: folder });
    await s.jobs.drain();
    await s.mounts.ready(mount.id);
    const items = (await s.client.works.list()).items;
    const trip = items.find((i) => i.external_path === path.join('notes', 'trip.md'));
    const escape = items.find((i) => i.external_path === 'escape.md');
    expect(trip).toMatchObject({
      thumbnail: { asset_id: null, path: 'img/a.png', kind: 'image' },
      card_image: { needs_frame: false },
      excerpt: '外部筆記。',
    });
    expect(escape?.card_image).toBeNull();
    const res = await getThumb(s, trip?.id ?? '', trip?.card_image?.version);
    expect(res.status).toBe(200);
    expect(sha(image)).toBe(before);
    expect(fs.readdirSync(folder).sort()).toEqual(['escape.md', 'notes']);
  });

  it('cuts excerpts at 120 characters, counting CJK characters as one', () => {
    const long = '字'.repeat(200);
    const cut = workExcerpt('article', `# 標題\n\n${long}`);
    expect(Array.from(cut ?? '')).toHaveLength(120);
    expect(cut?.endsWith('…')).toBe(true);
    expect(workExcerpt('article', '# 只有標題\n')).toBeNull();
    expect(workExcerpt('article', '```js\ncode()\n```\n\n- 第一點\n- 第二點\n> 引言')).toBe(
      '第一點 第二點 引言',
    );
    expect(workExcerpt('image', '---\ntype: image\n---\n# 描述的標題\n內容')).toBe(
      '描述的標題 內容',
    );
  });
});

describe('video cards (QC-061)', () => {
  const videoMd = (cover = '') =>
    `---\ntype: video\ntitle: 卡片\nvideo: assets/clip.mp4\n${cover}---\n一段影片。`;

  it('without ffmpeg asks the app for the frame, then serves the uploaded one', async () => {
    const s = await start();
    const w = work(s, 'video', videoMd('cover:\n  time_seconds: 3.5\n'), {
      'assets/clip.mp4': FAKE_VIDEO,
    });
    const original = path.join(s.home, 'library/works', w.id, 'assets/clip.mp4');
    const item = await card(s, w.id);
    expect(cardWithoutVersion(item)).toEqual({
      needs_frame: true,
      frame_source: { asset_id: null, path: 'assets/clip.mp4', time_seconds: 3.5 },
    });
    expect((await apiError(s.client.workThumbnails.get(w.id))).body?.error.details).toEqual({
      reason: 'needs_frame',
    });

    const frame = await pngBytes(720, 1280, '#123456');
    // Wrong video, wrong time: stale.
    for (const f of [
      { source: 'assets/other.mp4', timeSeconds: 3.5 },
      { source: 'assets/clip.mp4', timeSeconds: 0 },
    ]) {
      const err = await apiError(
        s.client.workThumbnails.putFrame(w.id, frame, {
          ...f,
          version: item.card_image?.version ?? '',
          contentType: 'image/png',
        }),
      );
      expect(err.status).toBe(409);
      expect(err.body?.error.code).toBe('thumbnail_frame_stale');
    }

    const saved = await s.client.workThumbnails.putFrame(w.id, frame, {
      version: item.card_image?.version ?? '',
      source: 'assets/clip.mp4',
      timeSeconds: 3.5,
      contentType: 'image/png',
    });
    expect(saved.card_image).toEqual({
      version: item.card_image?.version,
      needs_frame: false,
      url: null,
    });
    const after = await card(s, w.id);
    expect(after.card_image).toMatchObject({
      version: saved.card_image.version,
      needs_frame: false,
    });
    expect(after.card_image?.url).toMatch(/^\/media\/v1\/works\/[0-9a-f-]+\/thumbnail\?exp=/);
    const res = await getThumb(s, w.id, saved.card_image.version);
    expect(res.status).toBe(200);
    expect(await sharp(Buffer.from(await res.arrayBuffer())).metadata()).toMatchObject({
      width: 288,
      height: 512,
    });
    expect(fs.readFileSync(original).equals(FAKE_VIDEO)).toBe(true);
  });

  it('refuses frames that are not images, too large, or for works with an image cover or in 最近刪除', async () => {
    const s = await start();
    const w = work(s, 'video', videoMd(), { 'assets/clip.mp4': FAKE_VIDEO });
    const version = (await card(s, w.id)).card_image?.version ?? '';
    const put = (body: Buffer | string, contentType: string) =>
      fetch(
        `${s.baseUrl}/api/v1/works/${w.id}/thumbnail-frame?version=${version}&source=assets%2Fclip.mp4&time_seconds=0`,
        { method: 'PUT', headers: authHeaders({ 'content-type': contentType }), body },
      );
    const text = await put('hello', 'text/plain');
    expect(text.status).toBe(415);
    expect(((await text.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_media_type',
    );
    expect((await put(Buffer.from('not a png'), 'image/png')).status).toBe(415);
    const tooBig = await put(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png');
    expect(tooBig.status).toBe(413);

    const withCover = work(
      s,
      'video',
      `---\ntype: video\ntitle: 卡片\nvideo: assets/clip.mp4\ncover: assets/c.png\n---\n`,
      { 'assets/clip.mp4': FAKE_VIDEO, 'assets/c.png': await pngBytes(8, 8) },
    );
    expect((await card(s, withCover.id)).card_image?.needs_frame).toBe(false);
    const stale = await apiError(
      s.client.workThumbnails.putFrame(withCover.id, await pngBytes(8, 8), {
        version: (await card(s, withCover.id)).card_image?.version ?? '',
        source: 'assets/clip.mp4',
        timeSeconds: 0,
        contentType: 'image/png',
      }),
    );
    expect(stale.body?.error.code).toBe('thumbnail_frame_stale');

    await s.client.works.trash(w.id, { base_revision: w.current_revision_id });
    const trashed = await apiError(
      s.client.workThumbnails.putFrame(w.id, await pngBytes(8, 8), {
        version,
        source: 'assets/clip.mp4',
        timeSeconds: 0,
        contentType: 'image/png',
      }),
    );
    expect(trashed.body?.error.code).toBe('work_in_trash');
  });

  it('with ffmpeg takes the cover frame on the server; if ffmpeg fails, falls back to the app', async () => {
    const bin = tempDir();
    const fixture = path.join(bin, 'frame.png');
    fs.writeFileSync(fixture, await pngBytes(1280, 720, '#445566'));
    const args = path.join(bin, 'args.log');
    const ok = path.join(bin, 'ffmpeg-ok');
    fs.writeFileSync(
      ok,
      `#!/bin/sh\necho "$@" >> '${args}'\nfor last; do :; done\ncp '${fixture}' "$last"\n`,
      { mode: 0o755 },
    );
    const s = await start({ ffmpeg: ok });
    const w = work(s, 'video', videoMd('cover:\n  time_seconds: 2\n'), {
      'assets/clip.mp4': FAKE_VIDEO,
    });
    const item = await card(s, w.id);
    expect(cardWithoutVersion(item)).toEqual({ needs_frame: false });
    const res = await getThumb(s, w.id, item.card_image?.version);
    expect(res.status).toBe(200);
    expect(await sharp(Buffer.from(await res.arrayBuffer())).metadata()).toMatchObject({
      width: 512,
      height: 288,
    });
    const logged = fs.readFileSync(args, 'utf8');
    expect(logged).toContain('-ss 2 -i');
    expect(logged).toContain(path.join('assets', 'clip.mp4'));
    // No temporary frames are left in the cache.
    expect(fs.readdirSync(path.join(s.home, 'cache/work-thumbnails'))).toEqual([
      `${w.id}-${item.card_image?.version ?? ''}.webp`,
    ]);

    const failing = path.join(bin, 'ffmpeg-fail');
    fs.writeFileSync(failing, '#!/bin/sh\necho "Invalid data" >&2\nexit 1\n', { mode: 0o755 });
    const s2 = await start({ ffmpeg: failing });
    const w2 = work(s2, 'video', videoMd(), { 'assets/clip.mp4': FAKE_VIDEO });
    expect((await card(s2, w2.id)).card_image?.needs_frame).toBe(false);
    expect((await apiError(s2.client.workThumbnails.get(w2.id))).body?.error.details).toEqual({
      reason: 'needs_frame',
    });
    expect((await card(s2, w2.id)).card_image).toMatchObject({
      needs_frame: true,
      frame_source: { path: 'assets/clip.mp4', time_seconds: 0 },
    });
  });
});

describe('signed card URLs, fingerprint and permissions (QC-061)', () => {
  it('signs a stable URL valid for at least an hour; it works without a token and refuses tampering', async () => {
    let now = Date.parse('2026-11-21T10:20:00.000Z');
    const s = await start({ signedUrls: { now: () => now } });
    const w = work(s, 'image', '---\ntype: image\ntitle: 卡片\nimages:\n  - assets/a.png\n---\n', {
      'assets/a.png': await pngBytes(64, 64),
    });
    const first = (await card(s, w.id)).card_image;
    const url = first?.url ?? '';
    const parsed = new URL(url, 'http://x');
    expect(parsed.pathname).toBe(`/media/v1/works/${w.id}/thumbnail`);
    expect(parsed.searchParams.get('v')).toBe(first?.version);
    const exp = Number(parsed.searchParams.get('exp')) * 1000;
    // Next whole hour plus one: 12:00, at least 60 minutes away.
    expect(new Date(exp).toISOString()).toBe('2026-11-21T12:00:00.000Z');
    expect(url).not.toContain('test-token');

    now = Date.parse('2026-11-21T10:55:00.000Z');
    expect((await card(s, w.id)).card_image?.url).toBe(url);

    const res = await fetch(s.client.media.absoluteUrl(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const tampered = await fetch(s.client.media.absoluteUrl(url.replace(/sig=[^&]+/, 'sig=AAAA')));
    expect(tampered.status).toBe(403);
    const otherWork = await fetch(
      s.client.media.absoluteUrl(url.replace(w.id, '00000000-0000-4000-8000-000000000000')),
    );
    expect(otherWork.status).toBe(403);

    now = Date.parse('2026-11-21T12:00:01.000Z');
    expect((await fetch(s.client.media.absoluteUrl(url))).status).toBe(403);
  });

  it('gives no URL while the app must supply a frame, and refuses a frame of a replaced video', async () => {
    const s = await start();
    const w = work(s, 'video', '---\ntype: video\ntitle: 卡片\nvideo: assets/clip.mp4\n---\n', {
      'assets/clip.mp4': FAKE_VIDEO,
    });
    const before = (await card(s, w.id)).card_image;
    expect(before).toMatchObject({ needs_frame: true, url: null });

    // The video is replaced at the same path while the app was capturing.
    fs.writeFileSync(
      path.join(s.home, 'library/works', w.id, 'assets/clip.mp4'),
      Buffer.concat([FAKE_VIDEO, Buffer.alloc(16)]),
    );
    const stale = await apiError(
      s.client.workThumbnails.putFrame(w.id, await pngBytes(16, 16), {
        version: before?.version ?? '',
        source: 'assets/clip.mp4',
        timeSeconds: 0,
        contentType: 'image/png',
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body?.error).toMatchObject({
      code: 'thumbnail_frame_stale',
      details: { path: 'assets/clip.mp4', time_seconds: 0 },
    });
    expect(fs.existsSync(path.join(s.home, 'cache/work-thumbnails'))).toBe(false);
  });

  it('needs write to upload a frame and read to view; logs never hold the signature', async () => {
    const logs: string[] = [];
    const s = await start({ logger: true, logStream: { write: (l: string) => logs.push(l) } });
    const w = work(s, 'video', '---\ntype: video\ntitle: 卡片\nvideo: assets/clip.mp4\n---\n', {
      'assets/clip.mp4': FAKE_VIDEO,
    });
    const version = (await card(s, w.id)).card_image?.version ?? '';
    const frame = {
      version,
      source: 'assets/clip.mp4',
      timeSeconds: 0,
      contentType: 'image/png' as const,
    };
    const reader = createClient({
      baseUrl: s.baseUrl,
      token: s.tokens.create({ name: 'r', scopes: ['read'] }).secret,
    });
    const writer = createClient({
      baseUrl: s.baseUrl,
      token: s.tokens.create({ name: 'w', scopes: ['read', 'write'] }).secret,
    });
    expect(
      (await apiError(reader.workThumbnails.putFrame(w.id, await pngBytes(8, 8), frame))).status,
    ).toBe(403);
    const saved = await writer.workThumbnails.putFrame(w.id, await pngBytes(8, 8), frame);
    expect(saved.card_image.needs_frame).toBe(false);
    expect((await reader.workThumbnails.get(w.id, version)).length).toBeGreaterThan(0);

    const url = (await reader.works.list({ ids: [w.id] })).items[0]?.card_image?.url ?? '';
    expect((await fetch(s.client.media.absoluteUrl(url))).status).toBe(200);
    const sig = new URL(url, 'http://x').searchParams.get('sig') ?? '';
    expect(sig).not.toBe('');
    expect(logs.join('\n')).not.toContain(sig);
    expect(logs.join('\n')).toContain('sig=[REDACTED]');
  });
});
