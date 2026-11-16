import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { UnsafePathError } from '@qiu-creator/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRealPathInside } from '../src/fs/safe-path.js';
import { authHeaders, makeTempHome, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let video: Buffer;
let assetId: string;
const cleanup: string[] = [];

beforeEach(async () => {
  s = await startTestServer();
  video = randomBytes(10_000);
  const src = path.join(s.home, 'fixture.mp4');
  fs.writeFileSync(src, video);
  const work = await s.client.works.create({ title: 'video work', type: 'video' });
  assetId = s.assets.registerFromFile(work.id, src).id;
});
afterEach(async () => {
  await s.close();
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

const stream = (id: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${s.baseUrl}/api/v1/assets/${id}/stream`, { headers: authHeaders(headers) });

describe('GET /api/v1/assets/:id/stream', () => {
  it('serves the whole file with Accept-Ranges when no Range is sent', async () => {
    const res = await stream(assetId);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('10000');
    expect(Buffer.from(await res.arrayBuffer()).equals(video)).toBe(true);
  });

  it('returns 206 with the exact bytes for a bounded range', async () => {
    const res = await stream(assetId, { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/10000');
    expect(res.headers.get('content-length')).toBe('100');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.equals(video.subarray(100, 200))).toBe(true);
  });

  it('supports open-ended and suffix ranges', async () => {
    const open = await stream(assetId, { range: 'bytes=9990-' });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).equals(video.subarray(9990))).toBe(true);

    const suffix = await stream(assetId, { range: 'bytes=-10' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 9990-9999/10000');
  });

  it('returns 416 with Content-Range */size for an out-of-bounds range', async () => {
    const res = await stream(assetId, { range: 'bytes=10000-10010' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10000');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'range_not_satisfiable',
    );
  });

  it('requires the bearer token', async () => {
    const res = await fetch(`${s.baseUrl}/api/v1/assets/${assetId}/stream`);
    expect(res.status).toBe(401);
  });

  it('refuses an asset row whose path escapes the home with ..', async () => {
    const id = randomUUID();
    s.db
      .prepare(
        `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, origin, created_at)
         VALUES (?, 'other', '../../../../etc/hosts', ?, 'text/plain', 1, 'manual', ?)`,
      )
      .run(id, '0'.repeat(64), new Date().toISOString());
    const res = await stream(id);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('path_rejected');
  });

  it('refuses an asset that is a symlink pointing outside the home', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-outside-'));
    cleanup.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.mkdirSync(path.join(s.home, 'library', 'links'), { recursive: true });
    fs.symlinkSync(
      path.join(outside, 'secret.txt'),
      path.join(s.home, 'library', 'links', 'evil.mp4'),
    );
    const id = randomUUID();
    s.db
      .prepare(
        `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, origin, created_at)
         VALUES (?, 'video', 'library/links/evil.mp4', ?, 'video/mp4', 6, 'manual', ?)`,
      )
      .run(id, '0'.repeat(64), new Date().toISOString());

    const res = await stream(id);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('resolveRealPathInside', () => {
  it('follows symlinks that stay inside and rejects ones that leave', () => {
    const root = makeTempHome();
    const outside = makeTempHome();
    cleanup.push(root, outside);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'inside-link'));
    fs.symlinkSync(outside, path.join(root, 'dir-link'));
    fs.writeFileSync(path.join(outside, 'b.txt'), 'b');

    expect(resolveRealPathInside(root, 'inside-link')).toBe(
      fs.realpathSync(path.join(root, 'a.txt')),
    );
    expect(() => resolveRealPathInside(root, 'dir-link/b.txt')).toThrow(UnsafePathError);
    expect(() => resolveRealPathInside(root, '../x')).toThrow(UnsafePathError);
  });
});
