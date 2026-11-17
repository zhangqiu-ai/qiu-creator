import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type CreatorHubClient } from '@qiu-creator/api-client';
import { buildServer, type CreatorHubServer } from '@qiu-creator/mac-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadManager, type UploadFetch } from '../src/main/uploads.js';
import type { UploadItem } from '../src/shared/bridge.js';

/**
 * Integration: the main-process upload manager against a real mac-server on
 * a random port with a throwaway CREATORHUB_HOME. Files are read from a temp
 * folder, never from the user's disk.
 */
const TOKEN = 'test-token-0123456789abcdef';

// 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** ISO-BMFF header the service sniffs as video/mp4, padded with deterministic bytes. */
function mp4(size: number): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const body = Buffer.alloc(size - ftyp.length);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([ftyp, body]);
}

let server: CreatorHubServer;
let home: string;
let files: string;
let baseUrl: string;
let client: CreatorHubClient;
let snapshots: UploadItem[][];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-up-'));
  files = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mac-files-'));
  server = await buildServer({ config: { home, token: TOKEN } });
  baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  client = createClient({ baseUrl, token: TOKEN });
  snapshots = [];
});

afterEach(async () => {
  await server.app.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(files, { recursive: true, force: true });
});

function write(name: string, data: Buffer): string {
  const file = path.join(files, name);
  fs.writeFileSync(file, data);
  return file;
}

function manager(options: { fetch?: UploadFetch; directMaxBytes?: number } = {}): UploadManager {
  return new UploadManager({
    connection: () => ({ baseUrl, token: TOKEN }),
    onChange: (items) => snapshots.push(items),
    chunkSize: 64 * 1024,
    ...options,
  });
}

describe('UploadManager', () => {
  it('uploads a small file in one request and reports the asset', async () => {
    const m = manager();
    expect(await m.add([write('dot.png', PNG)])).toBe(1);
    await m.idle();
    const [item] = m.list();
    expect(item?.state).toBe('succeeded');
    expect(item?.transport).toBe('direct');
    expect(item?.result?.asset.kind).toBe('image');
    expect(item?.result?.asset.original_name).toBe('dot.png');
    const listed = await client.assets.list();
    expect(listed.items.map((a) => a.id)).toEqual([item?.result?.asset.id]);
  });

  it('uses tus for large files, reading in chunks and reporting progress', async () => {
    const data = mp4(300 * 1024);
    const m = manager({ directMaxBytes: 100 * 1024 });
    await m.add([write('clip.mp4', data)]);
    await m.idle();
    const [item] = m.list();
    expect(item?.transport).toBe('tus');
    expect(item?.state).toBe('succeeded');
    expect(item?.result?.asset.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    const progress = snapshots
      .map((s) => s[0]?.sentBytes ?? 0)
      .filter((n, i, all) => i === 0 || n !== all[i - 1]);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('resumes an interrupted tus upload from the acknowledged offset on retry', async () => {
    const data = mp4(400 * 1024);
    let patches = 0;
    let failOnce = true;
    const sentOffsets: string[] = [];
    const flaky: UploadFetch = (input, init) => {
      if (init.method === 'PATCH') {
        patches += 1;
        sentOffsets.push(new Headers(init.headers).get('upload-offset') ?? '');
        if (patches === 3 && failOnce) {
          failOnce = false;
          return Promise.reject(new TypeError('fetch failed'));
        }
      }
      return fetch(input, init);
    };
    const m = manager({ fetch: flaky, directMaxBytes: 100 * 1024 });
    await m.add([write('long.mp4', data)]);
    await m.idle();
    let [item] = m.list();
    expect(item?.state).toBe('failed');
    expect(item?.errorCode).toBe('network_error');
    const sentBeforeFailure = item?.sentBytes ?? 0;
    expect(sentBeforeFailure).toBe(2 * 64 * 1024);

    m.retry(item?.id ?? '');
    await m.idle();
    [item] = m.list();
    expect(item?.state).toBe('succeeded');
    expect(item?.result?.asset.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    // The retry continued at the acknowledged offset instead of starting over.
    expect(sentOffsets.filter((o) => o === '0')).toHaveLength(1);
    expect(sentOffsets).toContain(String(sentBeforeFailure));
  });

  it('cancels an upload and continues it later', async () => {
    const data = mp4(400 * 1024);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let patches = 0;
    const slow: UploadFetch = async (input, init) => {
      if (init.method === 'PATCH') {
        patches += 1;
        if (patches === 2) await gate;
      }
      return fetch(input, init);
    };
    const m = manager({ fetch: slow, directMaxBytes: 100 * 1024 });
    await m.add([write('c.mp4', data)]);
    const id = m.list()[0]?.id ?? '';
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (patches >= 2) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    m.cancel(id);
    release?.();
    await m.idle();
    expect(m.list()[0]?.state).toBe('cancelled');

    m.retry(id);
    await m.idle();
    expect(m.list()[0]?.state).toBe('succeeded');
    expect((await client.assets.list()).total).toBe(1);
  });

  it('marks identical content as reused instead of storing it twice', async () => {
    const m = manager();
    await m.add([write('a.png', PNG)]);
    await m.idle();
    await m.add([write('copy-of-a.png', PNG)]);
    await m.idle();
    const [second, first] = m.list();
    expect(first?.result?.deduplicated).toBe(false);
    expect(second?.result?.deduplicated).toBe(true);
    expect(second?.result?.asset.id).toBe(first?.result?.asset.id);
    expect((await client.assets.list()).total).toBe(1);
  });

  it('reports a file type the service refuses', async () => {
    const m = manager();
    await m.add([
      write(
        'archive.png',
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]),
      ),
    ]);
    await m.idle();
    const [item] = m.list();
    expect(item?.state).toBe('failed');
    expect(item?.errorCode).toBe('unsupported_media_type');
  });

  it('skips folders and missing paths, and dismisses finished rows', async () => {
    const m = manager();
    expect(await m.add([files, path.join(files, 'missing.png')])).toBe(0);
    await m.add([write('d.png', PNG)]);
    await m.idle();
    const id = m.list()[0]?.id ?? '';
    m.dismiss(id);
    expect(m.list()).toEqual([]);
  });

  it('fails without contacting anything when the service has no token yet', async () => {
    const m = new UploadManager({ connection: () => null, onChange: () => undefined });
    await m.add([write('e.png', PNG)]);
    await m.idle();
    expect(m.list()[0]?.state).toBe('failed');
  });
});
