import { ApiError } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { UploadItem } from '../src/shared/bridge.js';
import {
  attachErrorText,
  imageFiles,
  InsertSession,
  pastedName,
  uploadErrorText,
  type InsertBridge,
  type InsertWhere,
} from '../src/renderer/editor-insert.js';
import { dropScrollStep } from '../src/renderer/InsertUI.js';

function asset(patch: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'image',
    path: 'library/assets/x/kyoto.png',
    original_name: 'kyoto.png',
    mime_type: 'image/png',
    bytes: 10,
    sha256: 'a'.repeat(64),
    width: 1,
    height: 1,
    duration: null,
    codec: null,
    origin: 'upload',
    created_at: '2026-11-19T00:00:00.000Z',
    updated_at: '2026-11-19T00:00:00.000Z',
    thumbnail_status: 'ready',
    metadata_status: 'ready',
    ...patch,
  };
}

function apiError(status: number, code: string): ApiError {
  return new ApiError(
    status,
    { error: { code, message: code } } as unknown as ConstructorParameters<typeof ApiError>[1],
    code,
  );
}

function upload(patch: Partial<UploadItem>): UploadItem {
  return {
    id: 'u1',
    filename: 'a.png',
    bytes: 100,
    sentBytes: 0,
    state: 'uploading',
    transport: 'direct',
    error: null,
    errorCode: null,
    result: null,
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

function harness(attach: (assetId: string) => Promise<{ src: string }>) {
  const inserted: { markdown: string; where: InsertWhere }[] = [];
  let push: (items: UploadItem[]) => void = () => undefined;
  const bridge = {
    insertFiles: vi.fn((files: readonly File[]) =>
      Promise.resolve(files.map((_, i) => `u${String(i + 1)}`)),
    ),
    insertBytes: vi.fn(() => Promise.resolve('u1')),
    onUploads: (l: (items: UploadItem[]) => void) => {
      push = l;
      return () => undefined;
    },
    retryUpload: vi.fn(() => Promise.resolve()),
    cancelUpload: vi.fn(() => Promise.resolve()),
    dismissUpload: vi.fn(() => Promise.resolve()),
  } satisfies InsertBridge;
  const client = {
    works: { attachMedia: vi.fn((_w: string, id: string) => attach(id)) },
  } as unknown as ConstructorParameters<typeof InsertSession>[0]['client'];
  const revoked: string[] = [];
  const session = new InsertSession({
    client,
    workId: 'w1',
    insert: (markdown, where) => inserted.push({ markdown, where }),
    bridge,
    createPreview: () => 'blob:preview',
    revokePreview: (u) => revoked.push(u),
  });
  return {
    session,
    bridge,
    client,
    inserted,
    revoked,
    push: (i: UploadItem[]) => {
      push(i);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('insert helpers (QC-039)', () => {
  it('names pasted images and keeps only images', () => {
    const at = new Date(2026, 10, 19, 14, 32);
    expect(pastedName('image/png', at)).toBe('貼上的圖片 14.32.png');
    expect(pastedName('image/jpeg', at)).toBe('貼上的圖片 14.32.jpg');
    const files = [
      new File(['x'], 'a.png', { type: 'image/png' }),
      new File(['x'], 'b.pdf', { type: 'application/pdf' }),
    ];
    expect(imageFiles(files).map((f) => f.name)).toEqual(['a.png']);
  });

  it('words attach and upload failures', () => {
    expect(attachErrorText(apiError(409, 'attach_external_unsupported'))).toContain('外部掛載');
    expect(attachErrorText(apiError(409, 'asset_in_trash'))).toContain('回收站');
    expect(attachErrorText(new TypeError('fetch failed'))).toBe('本機服務未回應');
    expect(uploadErrorText({ error: null, errorCode: null })).toBe('本機服務未回應');
    expect(uploadErrorText({ error: 'x', errorCode: 'unsupported_media_type' })).toBe(
      '不支援這種檔案',
    );
  });
});

describe('InsertSession', () => {
  it('inserts a library asset after attaching it', async () => {
    const h = harness(() => Promise.resolve({ src: 'assets/kyoto.png' }));
    const ok = await h.session.insertAsset(asset({ alt_text: '清晨竹林' }), 'caret');
    expect(ok).toBe(true);
    expect(h.inserted).toEqual([{ markdown: '![清晨竹林](assets/kyoto.png)', where: 'caret' }]);
    // The picture is in the text: nothing to announce (QC-115).
    expect(h.session.getSnapshot().notice).toBeNull();
  });

  it('inserts nothing and explains when the work is external', async () => {
    const h = harness(() => Promise.reject(apiError(409, 'attach_external_unsupported')));
    expect(await h.session.insertAsset(asset(), 'caret')).toBe(false);
    expect(h.inserted).toEqual([]);
    expect(h.session.getSnapshot().notice).toContain('外部掛載');
  });

  it('pasted image: uploading with progress, then attached and inserted where asked', async () => {
    const h = harness(() => Promise.resolve({ src: 'assets/p.png' }));
    const blob = new Blob(['png'], { type: 'image/png' });
    await h.session.pasteImage(blob, { beforeBlock: 2 }, new Date(2026, 10, 19, 9, 5));
    expect(h.bridge.insertBytes).toHaveBeenCalledWith(
      '貼上的圖片 09.05.png',
      expect.any(Uint8Array),
    );
    expect(h.session.getSnapshot().pending[0]).toMatchObject({
      name: '貼上的圖片 09.05.png',
      state: 'uploading',
      uploadId: 'u1',
      preview: 'blob:preview',
    });
    h.push([upload({ sentBytes: 40 })]);
    expect(h.session.getSnapshot().pending[0]?.progress).toBe(40);
    h.push([
      upload({
        state: 'succeeded',
        sentBytes: 100,
        result: { asset: asset(), deduplicated: false },
      }),
    ]);
    await flush();
    expect(h.inserted).toEqual([{ markdown: '![](assets/p.png)', where: { beforeBlock: 2 } }]);
    expect(h.session.getSnapshot().pending).toEqual([]);
    expect(h.revoked).toEqual(['blob:preview']);
    // The picture is where it was put: nothing to announce (QC-115).
    expect(h.session.getSnapshot().notice).toBeNull();
  });

  it('failed upload keeps the card with 重試 that uploads again, 移除 dismisses', async () => {
    const h = harness(() => Promise.resolve({ src: 'assets/p.png' }));
    await h.session.pasteImage(new Blob(['x'], { type: 'image/png' }), 'caret');
    h.push([upload({ state: 'failed', error: 'offline', errorCode: null })]);
    const card = h.session.getSnapshot().pending[0];
    expect(card).toMatchObject({ state: 'failed', error: '本機服務未回應' });
    h.session.retry(card?.key ?? '');
    expect(h.bridge.retryUpload).toHaveBeenCalledWith('u1');
    expect(h.session.getSnapshot().pending[0]?.state).toBe('uploading');
    h.push([upload({ state: 'failed', errorCode: 'unsupported_media_type', error: 'x' })]);
    h.session.remove(card?.key ?? '');
    expect(h.bridge.dismissUpload).toHaveBeenCalledWith('u1');
    expect(h.session.getSnapshot().pending).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it('an attach failure after upload retries only the attach', async () => {
    let fail = true;
    const h = harness(() =>
      fail
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve({ src: 'assets/p.png' }),
    );
    await h.session.insertFiles([new File(['x'], 'drop.png', { type: 'image/png' })], 'end');
    h.push([upload({ state: 'succeeded', result: { asset: asset(), deduplicated: false } })]);
    await flush();
    const card = h.session.getSnapshot().pending[0];
    expect(card).toMatchObject({ state: 'failed', error: '本機服務未回應', name: 'drop.png' });
    fail = false;
    h.session.retry(card?.key ?? '');
    await flush();
    expect(h.bridge.retryUpload).not.toHaveBeenCalled();
    expect(h.inserted).toEqual([{ markdown: '![](assets/p.png)', where: 'end' }]);
  });

  it('取消 while uploading cancels the upload', async () => {
    const h = harness(() => Promise.resolve({ src: 'x' }));
    await h.session.insertFiles([new File(['x'], 'a.png', { type: 'image/png' })], 'caret');
    h.session.remove(h.session.getSnapshot().pending[0]?.key ?? '');
    expect(h.bridge.cancelUpload).toHaveBeenCalledWith('u1');
  });
});

describe('drop frame auto-scroll (QC-039 review)', () => {
  it('scrolls up near the top edge, down near the bottom, not in between', () => {
    expect(dropScrollStep(105, 100, 800)).toBeLessThan(0);
    expect(dropScrollStep(795, 100, 800)).toBeGreaterThan(0);
    expect(dropScrollStep(450, 100, 800)).toBe(0);
    // Faster closer to the edge.
    expect(dropScrollStep(799, 100, 800)).toBeGreaterThan(dropScrollStep(770, 100, 800));
    expect(Math.abs(dropScrollStep(100, 100, 800))).toBe(24);
  });
});
