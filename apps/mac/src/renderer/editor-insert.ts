import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { imageMarkdown } from '@qiu-creator/markdown-editor-web';
import type { CreatorHubBridge, UploadItem } from '../shared/bridge.js';
import { t } from './i18n.js';

/**
 * Inserting assets into the editor (QC-039, PT-20261119-001 「v2 · 編輯器：插入
 * 素材」). Every route — the 插入 menu, `/`, the asset drawer, Finder drops
 * and ⌘V — ends the same way: the service copies the asset into the work
 * (`works.attachMedia`), then the editor inserts `![alt](src)` as its own block
 * and the work is saved through the usual revision path. Files that are not
 * in the library yet are uploaded first by the main process; they show as
 * pending cards (uploading → done, or failed with 重試／移除) meanwhile.
 */

/** Where a block goes: after the caret's block, before a visual-mode block, or at the end. */
export type InsertWhere = 'caret' | 'end' | { beforeBlock: number };

export type PendingState = 'uploading' | 'attaching' | 'failed';

export interface PendingInsert {
  key: string;
  /** Main-process upload id; null once uploaded (or for library assets). */
  uploadId: string | null;
  name: string;
  /** `blob:` preview of a pasted or dropped image, revoked when the card goes. */
  preview: string | null;
  state: PendingState;
  /** 0–100 while uploading; null when unknown. */
  progress: number | null;
  error: string | null;
  where: InsertWhere;
  /** Set once uploaded (a failure after that retries the attach only). */
  asset: AssetRecord | null;
}

export interface InsertState {
  pending: PendingInsert[];
  notice: string | null;
}

export type InsertBridge = Pick<
  CreatorHubBridge,
  'insertFiles' | 'insertBytes' | 'onUploads' | 'retryUpload' | 'cancelUpload' | 'dismissUpload'
>;

export interface InsertSessionOptions {
  client: Pick<CreatorHubClient, 'works'>;
  workId: string;
  /** Put a block into the editor (MarkdownEditorHandle.insertBlock). */
  insert: (markdown: string, where: InsertWhere) => void;
  /**
   * Image posts (QC-045): what to do with an asset once it is in the library,
   * instead of attaching it and inserting `![](src)`. `{ beforeBlock: n }`
   * there means before the n-th image; `end`/`caret` append. Rejects with the
   * same errors as an attach.
   */
  place?: (asset: AssetRecord, where: InsertWhere) => Promise<void>;
  bridge: InsertBridge | null;
  /** Object URLs for previews (injectable for tests). */
  createPreview?: (blob: Blob) => string | null;
  revokePreview?: (url: string) => void;
}

/** Why an attach failed, in the user's words. */
export function attachErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return t('common.serviceDown');
  switch (err.code) {
    case 'attach_external_unsupported':
      return t('editor.attachExternalUnsupported');
    case 'asset_in_trash':
      return t('errors.asset_in_trash');
    case 'asset_file_missing':
      return t('errors.asset_file_missing');
    case 'not_found':
      return t('editor.attachNotFound');
    case 'restoring':
      return t('errors.restoring');
    default:
      return t('editor.attachFailed');
  }
}

/**
 * Why an upload failed, in the user's words. QC-042: an unknown code is
 * worded generically rather than showing the service's own English message.
 */
export function uploadErrorText(item: Pick<UploadItem, 'error' | 'errorCode'>): string {
  switch (item.errorCode) {
    case 'unsupported_media_type':
      return t('errors.unsupported_media_type');
    case 'payload_too_large':
      return t('errors.payload_too_large');
    case 'restoring':
      return t('errors.restoring');
    case null:
      return t('common.serviceDown');
    default:
      return t('editor.uploadFailed');
  }
}

/** 「貼上的圖片 14.32.png」: a readable name for a pasted image. */
export function pastedName(type: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ext =
    type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/g, '');
  return t('editor.pastedImageName', {
    time: `${pad(now.getHours())}.${pad(now.getMinutes())}`,
    ext: ext === '' ? 'png' : ext,
  });
}

/** The image files in a paste or drop (the rest is left to the editor). */
export function imageFiles(files: readonly File[]): File[] {
  return files.filter((f) => f.type.startsWith('image/'));
}

let keySeq = 0;

export class InsertSession {
  private state: InsertState = { pending: [], notice: null };
  private readonly listeners = new Set<() => void>();
  private readonly offUploads: () => void;
  private disposed = false;

  constructor(private readonly options: InsertSessionOptions) {
    this.offUploads =
      options.bridge?.onUploads((items) => {
        this.onUploads(items);
      }) ?? (() => undefined);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): InsertState => this.state;

  private set(patch: Partial<InsertState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private update(key: string, patch: Partial<PendingInsert>): void {
    this.set({
      pending: this.state.pending.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  /** A library asset: attach, then insert. Resolves true when it was inserted. */
  async insertAsset(asset: AssetRecord, where: InsertWhere): Promise<boolean> {
    try {
      await this.placeAsset(asset, where);
      return true;
    } catch (err) {
      this.set({ notice: attachErrorText(err) });
      return false;
    }
  }

  /** Dropped or picked files with a path on disk. */
  async insertFiles(files: readonly File[], where: InsertWhere): Promise<void> {
    const bridge = this.options.bridge;
    if (bridge === null || files.length === 0) return;
    const ids = await bridge.insertFiles(files);
    const pending = ids.map((uploadId, i) => {
      const file = files[i];
      return this.newPending(uploadId, file?.name ?? t('editor.fileFallback'), file ?? null, where);
    });
    this.set({ pending: [...this.state.pending, ...pending] });
  }

  /** A pasted image (no file on disk): the main process keeps the bytes until uploaded. */
  async pasteImage(blob: Blob, where: InsertWhere, now: Date = new Date()): Promise<void> {
    const bridge = this.options.bridge;
    if (bridge === null) return;
    const name =
      blob instanceof File && blob.name !== '' && blob.name !== 'image.png'
        ? blob.name
        : pastedName(blob.type, now);
    const data = new Uint8Array(await blob.arrayBuffer());
    const key = `p${String(++keySeq)}`;
    const preview = this.options.createPreview?.(blob) ?? null;
    this.set({
      pending: [
        ...this.state.pending,
        {
          key,
          uploadId: null,
          name,
          preview,
          state: 'uploading',
          progress: 0,
          error: null,
          where,
          asset: null,
        },
      ],
    });
    try {
      const uploadId = await bridge.insertBytes(name, data);
      this.update(key, { uploadId });
    } catch {
      this.update(key, {
        state: 'failed',
        error: t('editor.pasteCacheFailed'),
        progress: null,
      });
    }
  }

  private newPending(
    uploadId: string,
    name: string,
    file: Blob | null,
    where: InsertWhere,
  ): PendingInsert {
    return {
      key: `p${String(++keySeq)}`,
      uploadId,
      name,
      preview:
        file !== null && file.type.startsWith('image/')
          ? (this.options.createPreview?.(file) ?? null)
          : null,
      state: 'uploading',
      progress: 0,
      error: null,
      where,
      asset: null,
    };
  }

  /** Follow the main process's upload list. */
  onUploads(items: readonly UploadItem[]): void {
    for (const p of this.state.pending) {
      if (p.uploadId === null || p.state !== 'uploading') continue;
      const item = items.find((i) => i.id === p.uploadId);
      if (item === undefined) continue;
      if (item.state === 'failed' || item.state === 'cancelled') {
        this.update(p.key, { state: 'failed', error: uploadErrorText(item), progress: null });
      } else if (item.state === 'succeeded' && item.result !== null) {
        const asset = item.result.asset;
        this.update(p.key, { state: 'attaching', asset, progress: 100 });
        void this.attachPending(p.key, asset);
      } else {
        const progress = item.bytes > 0 ? Math.round((item.sentBytes / item.bytes) * 100) : null;
        if (progress !== p.progress) this.update(p.key, { progress });
      }
    }
  }

  private async attachPending(key: string, asset: AssetRecord): Promise<void> {
    const p = this.state.pending.find((x) => x.key === key);
    if (p === undefined) return;
    try {
      await this.placeAsset(asset, p.where);
      this.finish(key);
    } catch (err) {
      this.update(key, { state: 'failed', error: attachErrorText(err) });
    }
  }

  private async placeAsset(asset: AssetRecord, where: InsertWhere): Promise<void> {
    if (this.options.place !== undefined) {
      await this.options.place(asset, where);
      return;
    }
    const res = await this.options.client.works.attachMedia(this.options.workId, asset.id);
    this.options.insert(imageMarkdown(res.src, asset.alt_text ?? ''), where);
  }

  /** 重試: upload again, or only the attach if the file already reached the library. */
  retry(key: string): void {
    const p = this.state.pending.find((x) => x.key === key);
    if (p === undefined || p.state !== 'failed') return;
    if (p.asset !== null) {
      this.update(key, { state: 'attaching', error: null });
      void this.attachPending(key, p.asset);
    } else if (p.uploadId !== null) {
      this.update(key, { state: 'uploading', error: null, progress: 0 });
      void this.options.bridge?.retryUpload(p.uploadId);
    }
  }

  /** 取消 / 移除: stop the upload if it is still running and drop the card. */
  remove(key: string): void {
    const p = this.state.pending.find((x) => x.key === key);
    if (p === undefined) return;
    if (p.uploadId !== null) {
      const bridge = this.options.bridge;
      if (p.state === 'uploading') void bridge?.cancelUpload(p.uploadId);
      else void bridge?.dismissUpload(p.uploadId);
    }
    this.finish(key);
  }

  private finish(key: string): void {
    const p = this.state.pending.find((x) => x.key === key);
    if (p?.preview != null) this.options.revokePreview?.(p.preview);
    this.set({ pending: this.state.pending.filter((x) => x.key !== key) });
  }

  dispose(): void {
    this.offUploads();
    for (const p of this.state.pending) {
      if (p.preview !== null) this.options.revokePreview?.(p.preview);
    }
    this.disposed = true;
    this.listeners.clear();
  }
}
