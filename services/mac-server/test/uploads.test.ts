import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ApiError, ResumableUploadError, type FetchLike } from '@qiu-creator/api-client';
import { createClient } from '@qiu-creator/api-client';
import { TUS_UPLOAD_PATH } from '@qiu-creator/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { mp4Bytes, pngBytes, zipBytes } from './fixtures.js';
import {
  authHeaders,
  startTestServer,
  TEST_TOKEN,
  type StartOptions,
  type TestServer,
} from './helpers.js';

let s: TestServer | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});
async function start(options: StartOptions = {}): Promise<TestServer> {
  s = await startTestServer(options);
  return s;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function directUpload(
  srv: TestServer,
  data: Uint8Array,
  filename: string,
  token = TEST_TOKEN,
): Promise<Response> {
  return fetch(`${srv.baseUrl}/api/v1/assets/uploads?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: data,
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('direct upload', () => {
  it('stores an image under library/assets, identified by content, and builds a thumbnail', async () => {
    const srv = await start();
    const png = await pngBytes(1200, 800);
    const { asset, deduplicated } = await srv.client.assets.upload({
      data: png,
      filename: '封面 圖.png',
    });

    expect(deduplicated).toBe(false);
    expect(asset).toMatchObject({
      kind: 'image',
      mime_type: 'image/png',
      bytes: png.length,
      sha256: sha(png),
      origin: 'upload',
      original_name: '封面 圖.png',
      thumbnail_status: 'pending',
    });
    expect(asset.path).toBe(path.join('library', 'assets', asset.id, '封面 圖.png'));
    expect(fs.readFileSync(path.join(srv.home, asset.path)).equals(png)).toBe(true);
    expect(fs.readdirSync(srv.layout.incomingDir)).toEqual([]);

    await srv.jobs.drain();
    const ready = await srv.client.assets.get(asset.id);
    expect(ready).toMatchObject({ thumbnail_status: 'ready', width: 1200, height: 800 });
    const thumb = await srv.client.assets.thumbnail(asset.id);
    expect(Buffer.from(thumb.subarray(8, 12)).toString('latin1')).toBe('WEBP');
  });

  it('rebuilds the thumbnail after cache/ is deleted', async () => {
    const srv = await start();
    const { asset } = await srv.client.assets.upload({ data: await pngBytes(), filename: 'a.png' });
    await srv.jobs.drain();
    const thumbFile = path.join(srv.home, 'cache', 'thumbnails', `${asset.id}.webp`);
    expect(fs.existsSync(thumbFile)).toBe(true);

    fs.rmSync(path.join(srv.home, 'cache'), { recursive: true, force: true });
    const rebuilt = await srv.client.assets.thumbnail(asset.id);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(fs.existsSync(thumbFile)).toBe(true);
  });

  it('deduplicates by sha256 and returns the original asset', async () => {
    const srv = await start();
    const png = await pngBytes(10, 10, '#00ff00');
    const first = await srv.client.assets.upload({ data: png, filename: 'one.png' });
    const res = await directUpload(srv, png, 'two.png');
    expect(res.status).toBe(200);
    const second = (await res.json()) as { asset: { id: string }; deduplicated: boolean };
    expect(second).toMatchObject({ deduplicated: true, asset: { id: first.asset.id } });
    expect((await srv.client.assets.list()).total).toBe(1);
    expect(fs.readdirSync(path.join(srv.home, 'library', 'assets'))).toEqual([first.asset.id]);
  });

  it('ignores the extension: a PNG named .mp4 is stored as a PNG', async () => {
    const srv = await start();
    const { asset } = await srv.client.assets.upload({
      data: await pngBytes(),
      filename: 'clip.mp4',
    });
    expect(asset).toMatchObject({ kind: 'image', mime_type: 'image/png' });
    expect(asset.path.endsWith('clip.png')).toBe(true);
  });

  it.each([
    ['a ZIP named photo.jpg', zipBytes(), 'photo.jpg'],
    ['plain text named photo.png', Buffer.from('not really an image'), 'photo.png'],
    ['binary data named notes.md', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'notes.md'],
  ])('rejects %s with 415 and keeps nothing', async (_label, data, filename) => {
    const srv = await start();
    const res = await directUpload(srv, data, filename);
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe('unsupported_media_type');
    expect((await srv.client.assets.list()).total).toBe(0);
    expect(fs.readdirSync(srv.layout.incomingDir)).toEqual([]);
    expect(fs.readdirSync(path.join(srv.home, 'library', 'assets'))).toEqual([]);
  });

  it('accepts UTF-8 Markdown by name and content', async () => {
    const srv = await start();
    const { asset } = await srv.client.assets.upload({
      data: new TextEncoder().encode('# 標題\n\n內容\n'),
      filename: '筆記.md',
    });
    expect(asset).toMatchObject({
      kind: 'markdown',
      thumbnail_status: 'none',
      metadata_status: 'none',
    });
  });

  it('rejects files over the per-kind size limit with 413', async () => {
    const srv = await start({ limits: { image: 1000 } });
    const res = await directUpload(srv, await pngBytes(400, 400), 'big.png');
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('payload_too_large');
    expect((await srv.client.assets.list()).total).toBe(0);
  });

  it('requires the bearer token', async () => {
    const srv = await start();
    const res = await directUpload(srv, await pngBytes(), 'a.png', 'wrong-token-xxxxxxxxxx');
    expect(res.status).toBe(401);
  });
});

describe('resumable (tus) upload', () => {
  /** Send `bytes` as the first part of a PATCH, then cut the connection. */
  function patchThenDisconnect(
    srv: TestServer,
    uploadPath: string,
    bytes: Buffer,
    declared: number,
  ): Promise<void> {
    const url = new URL(uploadPath, srv.baseUrl);
    return new Promise((resolve) => {
      const req = http.request(url, {
        method: 'PATCH',
        headers: {
          ...authHeaders(),
          'tus-resumable': '1.0.0',
          'upload-offset': '0',
          'content-type': 'application/offset+octet-stream',
          'content-length': String(declared),
        },
      });
      req.on('error', () => {
        resolve();
      });
      req.write(bytes, () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 200);
      });
    });
  }

  async function headOffset(srv: TestServer, uploadPath: string): Promise<number> {
    const res = await fetch(new URL(uploadPath, srv.baseUrl), {
      method: 'HEAD',
      headers: { ...authHeaders(), 'tus-resumable': '1.0.0' },
    });
    expect(res.status).toBe(200);
    return Number(res.headers.get('upload-offset'));
  }

  it('resumes from the stored offset after the connection drops mid-transfer', async () => {
    const srv = await start();
    const video = mp4Bytes(3 * 1024 * 1024);
    const create = await fetch(`${srv.baseUrl}${TUS_UPLOAD_PATH}`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'tus-resumable': '1.0.0',
        'upload-length': String(video.length),
        'upload-metadata': `filename ${Buffer.from('旅行.mp4').toString('base64')}`,
      },
    });
    expect(create.status).toBe(201);
    const location = create.headers.get('location') ?? '';
    expect(location.startsWith(`${TUS_UPLOAD_PATH}/`)).toBe(true);

    await patchThenDisconnect(srv, location, video.subarray(0, 1024 * 1024), video.length);
    let offset = 0;
    for (let i = 0; i < 50 && offset === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      offset = await headOffset(srv, location);
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(video.length);

    const finish = await fetch(new URL(location, srv.baseUrl), {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      body: video.subarray(offset),
    });
    expect(finish.status).toBe(200);
    const { asset } = (await finish.json()) as {
      asset: { id: string; path: string; sha256: string; kind: string };
    };
    expect(asset.kind).toBe('video');
    expect(asset.sha256).toBe(sha(video));
    expect(fs.readFileSync(path.join(srv.home, asset.path)).equals(video)).toBe(true);
    expect(fs.readdirSync(srv.layout.uploadsDir)).toEqual([]);
  });

  it('api-client resumes with the uploadUrl from ResumableUploadError', async () => {
    const srv = await start();
    const video = mp4Bytes(2 * 1024 * 1024 + 123);
    let patches = 0;
    const flaky: FetchLike = (input, init) => {
      if (init?.method === 'PATCH' && ++patches === 2)
        return Promise.reject(new TypeError('network down'));
      return fetch(input, init);
    };
    const client = createClient({ baseUrl: srv.baseUrl, token: TEST_TOKEN, fetch: flaky });

    const err: unknown = await client.assets
      .uploadResumable({ data: video, filename: 'v.mp4', chunkSize: 512 * 1024 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumableUploadError);
    const { uploadUrl, offset } = err as ResumableUploadError;
    expect(offset).toBe(512 * 1024);

    const done = await client.assets.uploadResumable({
      data: video,
      filename: 'v.mp4',
      chunkSize: 512 * 1024,
      uploadUrl,
    });
    expect(done.asset.sha256).toBe(sha(video));
    expect(done.asset.bytes).toBe(video.length);
  });

  it('rejects disguised content at the end of a resumable upload', async () => {
    const srv = await start();
    const err: unknown = await srv.client.assets
      .uploadResumable({ data: zipBytes(), filename: 'movie.mp4' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(415);
    expect((await srv.client.assets.list()).total).toBe(0);
    expect(fs.readdirSync(srv.layout.uploadsDir)).toEqual([]);
  });

  it('refuses to create an upload larger than every limit', async () => {
    const srv = await start({ limits: { image: 1000, video: 2000, audio: 1000, markdown: 1000 } });
    const res = await fetch(`${srv.baseUrl}${TUS_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'tus-resumable': '1.0.0', 'upload-length': '5000' },
    });
    expect(res.status).toBe(413);
  });

  it('requires the bearer token', async () => {
    const srv = await start();
    const res = await fetch(`${srv.baseUrl}${TUS_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' },
    });
    expect(res.status).toBe(401);
  });
});
