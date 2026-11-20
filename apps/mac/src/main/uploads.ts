import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DIRECT_UPLOAD_MAX_BYTES,
  ErrorResponseSchema,
  TUS_UPLOAD_PATH,
  UploadAssetResponseSchema,
  type UploadAssetResponse,
} from '@qiu-creator/contracts';
import type { UploadItem } from '../shared/bridge.js';

export type UploadFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface UploadConnection {
  baseUrl: string;
  token: string;
}

export interface UploadManagerOptions {
  connection: () => UploadConnection | null;
  onChange: (items: UploadItem[]) => void;
  fetch?: UploadFetch;
  /** tus chunk size (default 8 MiB). */
  chunkSize?: number;
  /** Files at or below this size use the single-request endpoint. */
  directMaxBytes?: number;
  concurrency?: number;
  now?: () => Date;
}

interface Entry {
  item: UploadItem;
  filePath: string;
  /** tus upload URL once created, so a retry resumes instead of starting over. */
  uploadUrl: string | null;
  controller: AbortController | null;
}

class UploadFailed extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** False when the service rejected the file itself; retrying the same bytes will not help. */
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = 'UploadFailed';
  }
}

function base64Utf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function errorFrom(res: Response): Promise<UploadFailed> {
  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    json = null;
  }
  const parsed = ErrorResponseSchema.safeParse(json);
  const code = parsed.success ? parsed.data.error.code : null;
  const message = parsed.success ? parsed.data.error.message : `HTTP ${res.status}`;
  return new UploadFailed(message, code, res.status >= 500 || res.status === 409);
}

/**
 * Uploads run in the main process and read from disk chunk by chunk, so a
 * multi-gigabyte video never has to fit in memory or cross into the
 * renderer. State lives in memory for this app session; the service keeps
 * unfinished tus uploads for 7 days, so a retry after a dropped connection
 * resumes from the last acknowledged offset.
 */
export class UploadManager {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private active = 0;
  private readonly doFetch: UploadFetch;
  private readonly chunkSize: number;
  private readonly directMax: number;
  private readonly concurrency: number;
  private readonly now: () => Date;

  constructor(private readonly options: UploadManagerOptions) {
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.chunkSize = options.chunkSize ?? 8 * 1024 * 1024;
    this.directMax = options.directMaxBytes ?? DIRECT_UPLOAD_MAX_BYTES;
    this.concurrency = options.concurrency ?? 2;
    this.now = options.now ?? (() => new Date());
  }

  list(): UploadItem[] {
    return this.order
      .map((id) => this.entries.get(id)?.item)
      .filter((item): item is UploadItem => item !== undefined)
      .map((item) => ({ ...item }));
  }

  /** Queue files by absolute path. Directories and unreadable paths are skipped. */
  async add(filePaths: readonly string[]): Promise<number> {
    return (await this.addWithIds(filePaths)).length;
  }

  /** Like `add`, returning the new upload ids in order (QC-039 inserts follow them). */
  async addWithIds(filePaths: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    let added = 0;
    for (const filePath of filePaths) {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const at = this.now().toISOString();
      const item: UploadItem = {
        id: randomUUID(),
        filename: path.basename(filePath),
        bytes: stat.size,
        sentBytes: 0,
        state: 'queued',
        transport: stat.size <= this.directMax ? 'direct' : 'tus',
        error: null,
        errorCode: null,
        result: null,
        createdAt: at,
        updatedAt: at,
      };
      this.entries.set(item.id, { item, filePath, uploadUrl: null, controller: null });
      this.order.unshift(item.id);
      ids.push(item.id);
      added += 1;
    }
    if (added > 0) {
      this.emit();
      this.pump();
    }
    return ids;
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.item.state === 'queued' || entry.item.state === 'uploading') {
      entry.controller?.abort();
      this.update(entry, { state: 'cancelled', error: null, errorCode: null });
    }
  }

  retry(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.item.state !== 'failed' && entry.item.state !== 'cancelled') return;
    this.update(entry, { state: 'queued', error: null, errorCode: null });
    this.pump();
  }

  /** Remove a finished, failed or cancelled row from the list. */
  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.item.state === 'queued' || entry.item.state === 'uploading') return;
    this.entries.delete(id);
    const i = this.order.indexOf(id);
    if (i !== -1) this.order.splice(i, 1);
    this.emit();
  }

  /** Resolves when nothing is queued or uploading (tests). */
  async idle(): Promise<void> {
    while (this.list().some((i) => i.state === 'queued' || i.state === 'uploading')) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private emit(): void {
    this.options.onChange(this.list());
  }

  private update(entry: Entry, patch: Partial<UploadItem>): void {
    entry.item = { ...entry.item, ...patch, updatedAt: this.now().toISOString() };
    this.emit();
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      // Oldest queued first.
      const next = [...this.order]
        .reverse()
        .map((id) => this.entries.get(id))
        .find((e) => e?.item.state === 'queued');
      if (next === undefined) return;
      this.active += 1;
      void this.run(next).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(entry: Entry): Promise<void> {
    const conn = this.options.connection();
    if (conn === null) {
      this.update(entry, { state: 'failed', error: '本機服務未連線', errorCode: null });
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    this.update(entry, { state: 'uploading', error: null, errorCode: null });
    try {
      const result =
        entry.item.transport === 'direct'
          ? await this.direct(conn, entry, controller.signal)
          : await this.tus(conn, entry, controller.signal);
      if (controller.signal.aborted) return;
      this.update(entry, { state: 'succeeded', sentBytes: entry.item.bytes, result });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof UploadFailed) {
        if (!err.resumable) entry.uploadUrl = null;
        this.update(entry, { state: 'failed', error: err.message, errorCode: err.code });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.update(entry, { state: 'failed', error: message, errorCode: 'network_error' });
      }
    } finally {
      if (entry.controller === controller) entry.controller = null;
    }
  }

  private async direct(
    conn: UploadConnection,
    entry: Entry,
    signal: AbortSignal,
  ): Promise<UploadAssetResponse> {
    const data = await fs.readFile(entry.filePath);
    if (data.length !== entry.item.bytes) {
      throw new UploadFailed('檔案在上傳前被修改，請重試', 'file_changed', false);
    }
    const qs = new URLSearchParams({ filename: entry.item.filename }).toString();
    const res = await this.doFetch(`${conn.baseUrl}/api/v1/assets/uploads?${qs}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conn.token}`,
        'content-type': 'application/octet-stream',
        accept: 'application/json',
      },
      body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      redirect: 'error',
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    this.update(entry, { sentBytes: entry.item.bytes });
    return UploadAssetResponseSchema.parse(await res.json());
  }

  private async tus(
    conn: UploadConnection,
    entry: Entry,
    signal: AbortSignal,
  ): Promise<UploadAssetResponse> {
    const headers = { authorization: `Bearer ${conn.token}`, 'tus-resumable': '1.0.0' };
    const total = entry.item.bytes;
    let offset = 0;

    if (entry.uploadUrl !== null) {
      const head = await this.doFetch(entry.uploadUrl, {
        method: 'HEAD',
        headers,
        redirect: 'error',
        signal,
      });
      if (head.ok) {
        offset = Number(head.headers.get('upload-offset') ?? '0');
      } else {
        // Expired or unknown on the service: start a fresh upload.
        entry.uploadUrl = null;
      }
    }
    if (entry.uploadUrl === null) {
      const res = await this.doFetch(`${conn.baseUrl}${TUS_UPLOAD_PATH}`, {
        method: 'POST',
        headers: {
          ...headers,
          'upload-length': String(total),
          'upload-metadata': `filename ${base64Utf8(entry.item.filename)}`,
        },
        redirect: 'error',
        signal,
      });
      const location = res.headers.get('location');
      if (res.status !== 201 || location === null) throw await errorFrom(res);
      entry.uploadUrl = /^https?:\/\//.test(location)
        ? location
        : `${conn.baseUrl}${location.startsWith('/') ? '' : '/'}${location}`;
      if (new URL(entry.uploadUrl).origin !== new URL(conn.baseUrl).origin) {
        entry.uploadUrl = null;
        throw new UploadFailed('上傳位址不在本機服務', 'bad_location', false);
      }
    }
    this.update(entry, { sentBytes: offset });

    const handle = await fs.open(entry.filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size !== total) {
        entry.uploadUrl = null;
        throw new UploadFailed('檔案在上傳期間被修改，請重新上傳', 'file_changed', false);
      }
      for (;;) {
        const length = Math.min(this.chunkSize, total - offset);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, offset);
        if (bytesRead !== length) {
          entry.uploadUrl = null;
          throw new UploadFailed('讀取檔案失敗', 'file_changed', false);
        }
        const res = await this.doFetch(entry.uploadUrl, {
          method: 'PATCH',
          headers: {
            ...headers,
            'upload-offset': String(offset),
            'content-type': 'application/offset+octet-stream',
            accept: 'application/json',
          },
          body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          redirect: 'error',
          signal,
        });
        const end = offset + length;
        if (res.status === 200 && end === total) {
          return UploadAssetResponseSchema.parse(await res.json());
        }
        if (res.status !== 204) throw await errorFrom(res);
        offset = Number(res.headers.get('upload-offset') ?? String(end));
        this.update(entry, { sentBytes: offset });
        if (offset >= total) {
          throw new UploadFailed('服務沒有回傳結果', 'internal_error', false);
        }
      }
    } finally {
      await handle.close();
    }
  }
}
