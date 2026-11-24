import {
  ThumbnailFrameResponseSchema,
  type ThumbnailFrameResponse,
  AssetRecordSchema,
  AssetReferencesSchema,
  AssetWorkListResponseSchema,
  BatchAssetsRequestSchema,
  BatchAssetsResponseSchema,
  DeleteAssetRequestSchema,
  DeleteAssetResponseSchema,
  EmptyTrashRequestSchema,
  EmptyTrashResponseSchema,
  PurgeAssetResponseSchema,
  UpdateAssetRequestSchema,
  ChangeEventSchema,
  DIRECT_UPLOAD_MAX_BYTES,
  ErrorResponseSchema,
  EVENTS_PATH,
  ListAssetsResponseSchema,
  TUS_UPLOAD_PATH,
  UploadAssetResponseSchema,
  WorkAssetListResponseSchema,
  type AssetRecord,
  type AssetReferences,
  type AssetWorkListResponse,
  type BatchAssetsRequest,
  type BatchAssetsResponse,
  type DeleteAssetRequest,
  type DeleteAssetResponse,
  type EmptyTrashResponse,
  type PurgeAssetResponse,
  type UpdateAssetRequest,
  type ChangeEvent,
  type LinkWorkAssetRequest,
  type ListAssetsQuery,
  type ListAssetsResponse,
  type ReorderWorkAssetsRequest,
  type UploadAssetResponse,
  type WorkAssetListResponse,
  type WorkAssetRole,
} from '@qiu-creator/contracts';
import type { z } from 'zod';
import { ApiError, type CreatorHubClientOptions, type FetchLike } from './index.js';

export interface UploadInput {
  data: Uint8Array;
  filename: string;
  signal?: AbortSignal;
}

export interface ResumableUploadInput extends UploadInput {
  /** Bytes per PATCH request (default 8 MiB). */
  chunkSize?: number;
  /** Resume an earlier upload: the `uploadUrl` from `onCreated` or from a `ResumableUploadError`. */
  uploadUrl?: string;
  /** Called once the server has created the upload; persist it to resume after a crash. */
  onCreated?: (uploadUrl: string) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

/**
 * Bytes to upload, read a chunk at a time (QC-088), so a large local file
 * never has to be held in memory: `read(start, end)` returns bytes
 * `[start, end)`.
 */
export interface UploadSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** `uploadResumable` from an `UploadSource` instead of an in-memory buffer. */
export type ResumableSourceUploadInput = Omit<ResumableUploadInput, 'data'> & {
  source: UploadSource;
};

/** Thrown when a resumable upload stops part-way; call `uploadResumable` again with `uploadUrl`. */
export class ResumableUploadError extends Error {
  constructor(
    readonly uploadUrl: string,
    readonly offset: number,
    override readonly cause: unknown,
  ) {
    super(`upload interrupted at byte ${offset}`);
    this.name = 'ResumableUploadError';
  }
}

export interface CreatorHubAssetsApi {
  /** Upload a file: single request up to 32 MiB, resumable tus above that. */
  upload(input: UploadInput): Promise<UploadAssetResponse>;
  /** Single-request upload (`application/octet-stream`). */
  uploadDirect(input: UploadInput): Promise<UploadAssetResponse>;
  /** tus 1.0.0 resumable upload. */
  uploadResumable(
    input: ResumableUploadInput | ResumableSourceUploadInput,
  ): Promise<UploadAssetResponse>;
  list(query?: ListAssetsQuery): Promise<ListAssetsResponse>;
  get(id: string): Promise<AssetRecord>;
  /** Works that use this asset (title, role, position). */
  works(id: string): Promise<AssetWorkListResponse>;
  /** WebP thumbnail bytes (images only). */
  thumbnail(id: string): Promise<Uint8Array>;
  /**
   * Edit display name, tags, alt text or note (QC-037). Pass `base_revision`
   * (the asset's `revision`); a stale one is 409 `revision_conflict`.
   */
  update(id: string, input: UpdateAssetRequest): Promise<AssetRecord>;
  /**
   * Move to 回收站 (QC-037). Referenced assets need `confirm: true` (else 409
   * `asset_in_use` with `details.references`). External files stay untouched
   * unless `move_original_to_trash` (macOS Trash).
   */
  trash(id: string, input?: DeleteAssetRequest): Promise<DeleteAssetResponse>;
  /** Back from 回收站 with its references; 409 `asset_file_missing` if the file is gone. */
  restore(id: string): Promise<AssetRecord>;
  /** Works and platform variants that use the asset. */
  references(id: string): Promise<AssetReferences>;
  /** Batch add/remove tags or move to 回收站; all or nothing. */
  batch(input: BatchAssetsRequest): Promise<BatchAssetsResponse>;
}

/** 回收站 (QC-037). List it with `assets.list({ scope: 'trash' })`. Owner token only. */
export interface CreatorHubTrashApi {
  /** Delete one trashed asset permanently; `markdown_referrers` lists works whose Markdown links to it. */
  purge(id: string): Promise<PurgeAssetResponse>;
  /** Delete everything in 回收站 permanently. */
  empty(): Promise<EmptyTrashResponse>;
}

export function createTrashApi(ctx: Ctx): CreatorHubTrashApi {
  return {
    purge: (id) =>
      call(ctx, PurgeAssetResponseSchema, 'DELETE', `/api/v1/trash/${encodeURIComponent(id)}`),
    empty: () =>
      call(
        ctx,
        EmptyTrashResponseSchema,
        'DELETE',
        '/api/v1/trash',
        EmptyTrashRequestSchema.parse({ confirm: true }),
      ),
  };
}

export interface CreatorHubWorkAssetsApi {
  list(workId: string): Promise<WorkAssetListResponse>;
  link(workId: string, input: LinkWorkAssetRequest): Promise<WorkAssetListResponse>;
  unlink(workId: string, assetId: string, role: WorkAssetRole): Promise<WorkAssetListResponse>;
  reorder(workId: string, input: ReorderWorkAssetsRequest): Promise<WorkAssetListResponse>;
}

export interface SubscribeOptions {
  /** Resume after this seq (sent as `Last-Event-ID`). */
  lastEventId?: number;
  signal?: AbortSignal;
}

export interface CreatorHubEventsApi {
  /**
   * Read the SSE change stream until it ends or `signal` aborts. Uses fetch
   * (not `EventSource`) so the bearer token travels in a header. No automatic
   * reconnect: on return, reconnect with the last `seq` you processed.
   */
  subscribe(onEvent: (event: ChangeEvent) => void, options?: SubscribeOptions): Promise<void>;
}

const TEXT = new TextEncoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 → base64 without relying on Buffer/btoa (works in Node, Electron and React Native). */
export function base64Utf8(value: string): string {
  const bytes = TEXT.encode(value);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64.charAt(a >> 2);
    out += B64.charAt(((a & 3) << 4) | ((b ?? 0) >> 4));
    out += b === undefined ? '=' : B64.charAt(((b & 15) << 2) | ((c ?? 0) >> 6));
    out += c === undefined ? '=' : B64.charAt(c & 63);
  }
  return out;
}

/** Incremental `text/event-stream` parser; returns complete events and keeps the remainder. */
export function parseSseChunk(buffer: string): {
  events: { id?: string; event?: string; data: string }[];
  rest: string;
} {
  const events: { id?: string; event?: string; data: string }[] = [];
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ id, event, data: data.join('\n') });
  }
  return { events, rest };
}

interface Ctx {
  baseUrl: string;
  options: CreatorHubClientOptions;
  doFetch: FetchLike;
}

function safeJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text();
  const parsed = ErrorResponseSchema.safeParse(safeJson(text));
  const body = parsed.success ? parsed.data : null;
  return new ApiError(res.status, body, body?.error.message ?? `HTTP ${res.status}`);
}

async function call<S extends z.ZodType>(
  ctx: Ctx,
  schema: S,
  method: string,
  path: string,
  body?: unknown,
): Promise<z.infer<S>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.options.token}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await ctx.doFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return schema.parse(await res.json());
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * A fetch body view of `bytes`. DOM typings only accept ArrayBuffer-backed
 * views as `BodyInit`; this reuses the same memory unless the bytes live in a
 * SharedArrayBuffer, which is copied.
 */
function asBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

export function createAssetsApi(ctx: Ctx): CreatorHubAssetsApi {
  const auth = { authorization: `Bearer ${ctx.options.token}` };
  const tusHeaders = { ...auth, 'tus-resumable': '1.0.0' };
  const absolute = (location: string): string =>
    /^https?:\/\//.test(location) ? location : `${ctx.baseUrl}${location}`;

  const uploadDirect = async ({
    data,
    filename,
    signal,
  }: UploadInput): Promise<UploadAssetResponse> => {
    const res = await ctx.doFetch(`${ctx.baseUrl}/api/v1/assets/uploads${query({ filename })}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream', accept: 'application/json' },
      body: asBody(data),
      signal,
    });
    if (!res.ok) throw await toApiError(res);
    return UploadAssetResponseSchema.parse(await res.json());
  };

  const uploadResumable = async (
    input: ResumableUploadInput | ResumableSourceUploadInput,
  ): Promise<UploadAssetResponse> => {
    const { filename, signal } = input;
    const size = 'source' in input ? input.source.size : input.data.length;
    const chunk = (start: number, end: number): Promise<Uint8Array> =>
      'source' in input
        ? input.source.read(start, end)
        : Promise.resolve(input.data.subarray(start, end));
    const chunkSize = input.chunkSize ?? 8 * 1024 * 1024;
    let uploadUrl = input.uploadUrl;
    let offset = 0;

    if (uploadUrl === undefined) {
      const res = await ctx.doFetch(`${ctx.baseUrl}${TUS_UPLOAD_PATH}`, {
        method: 'POST',
        headers: {
          ...tusHeaders,
          'upload-length': String(size),
          'upload-metadata': `filename ${base64Utf8(filename)}`,
        },
        signal,
      });
      const location = res.headers.get('location');
      if (res.status !== 201 || location === null) throw await toApiError(res);
      uploadUrl = absolute(location);
      input.onCreated?.(uploadUrl);
    } else {
      const res = await ctx.doFetch(uploadUrl, { method: 'HEAD', headers: tusHeaders, signal });
      if (!res.ok)
        throw new ApiError(res.status, null, `cannot resume upload (HTTP ${res.status})`);
      offset = Number(res.headers.get('upload-offset') ?? '0');
    }

    for (;;) {
      const end = Math.min(offset + chunkSize, size);
      const body = await chunk(offset, end);
      let res: Response;
      try {
        res = await ctx.doFetch(uploadUrl, {
          method: 'PATCH',
          headers: {
            ...tusHeaders,
            'upload-offset': String(offset),
            'content-type': 'application/offset+octet-stream',
            accept: 'application/json',
          },
          body: asBody(body),
          signal,
        });
      } catch (err) {
        throw new ResumableUploadError(uploadUrl, offset, err);
      }
      if (res.status === 200 && end === size) {
        // Final chunk: the server validated and stored the asset.
        return UploadAssetResponseSchema.parse(await res.json());
      }
      if (res.status !== 204) {
        if (res.status === 409)
          throw new ResumableUploadError(uploadUrl, offset, await toApiError(res));
        throw await toApiError(res);
      }
      offset = Number(res.headers.get('upload-offset') ?? String(end));
      input.onProgress?.(offset, size);
    }
  };

  return {
    upload: (input) =>
      input.data.length <= DIRECT_UPLOAD_MAX_BYTES ? uploadDirect(input) : uploadResumable(input),
    uploadDirect,
    uploadResumable,
    list: (q = {}) => call(ctx, ListAssetsResponseSchema, 'GET', `/api/v1/assets${query(q)}`),
    get: (id) => call(ctx, AssetRecordSchema, 'GET', `/api/v1/assets/${encodeURIComponent(id)}`),
    update: (id, input) =>
      call(
        ctx,
        AssetRecordSchema,
        'PATCH',
        `/api/v1/assets/${encodeURIComponent(id)}`,
        UpdateAssetRequestSchema.parse(input),
      ),
    trash: (id, input = {}) =>
      call(
        ctx,
        DeleteAssetResponseSchema,
        'DELETE',
        `/api/v1/assets/${encodeURIComponent(id)}`,
        DeleteAssetRequestSchema.parse(input),
      ),
    restore: (id) =>
      call(ctx, AssetRecordSchema, 'POST', `/api/v1/assets/${encodeURIComponent(id)}/restore`, {}),
    references: (id) =>
      call(
        ctx,
        AssetReferencesSchema,
        'GET',
        `/api/v1/assets/${encodeURIComponent(id)}/references`,
      ),
    batch: (input) =>
      call(
        ctx,
        BatchAssetsResponseSchema,
        'POST',
        '/api/v1/assets/batch',
        BatchAssetsRequestSchema.parse(input),
      ),
    works: (id) =>
      call(
        ctx,
        AssetWorkListResponseSchema,
        'GET',
        `/api/v1/assets/${encodeURIComponent(id)}/works`,
      ),
    thumbnail: async (id) => {
      const res = await ctx.doFetch(
        `${ctx.baseUrl}/api/v1/assets/${encodeURIComponent(id)}/thumbnail`,
        {
          headers: auth,
        },
      );
      if (!res.ok) throw await toApiError(res);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export function createWorkAssetsApi(ctx: Ctx): CreatorHubWorkAssetsApi {
  const base = (workId: string): string => `/api/v1/works/${encodeURIComponent(workId)}/assets`;
  return {
    list: (workId) => call(ctx, WorkAssetListResponseSchema, 'GET', base(workId)),
    link: (workId, input) => call(ctx, WorkAssetListResponseSchema, 'POST', base(workId), input),
    unlink: (workId, assetId, role) =>
      call(
        ctx,
        WorkAssetListResponseSchema,
        'DELETE',
        `${base(workId)}/${encodeURIComponent(assetId)}${query({ role })}`,
      ),
    reorder: (workId, input) =>
      call(ctx, WorkAssetListResponseSchema, 'PUT', `${base(workId)}/order`, input),
  };
}

export function createEventsApi(ctx: Ctx): CreatorHubEventsApi {
  return {
    subscribe: async (onEvent, options = {}) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${ctx.options.token}`,
        accept: 'text/event-stream',
      };
      if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
      const res = await ctx.doFetch(`${ctx.baseUrl}${EVENTS_PATH}`, {
        headers,
        signal: options.signal,
      });
      if (!res.ok) throw await toApiError(res);
      if (!res.body) return;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          for (const e of parsed.events) onEvent(ChangeEventSchema.parse(JSON.parse(e.data)));
        }
      } catch (err) {
        if (options.signal?.aborted) return;
        throw err;
      }
    },
  };
}

/** Library card images (QC-061). */
export interface CreatorHubWorkThumbnailsApi {
  /** Server-relative path of a card image, for `<img>` through an authenticating proxy. */
  path(workId: string, version?: string): string;
  /** The card image (WebP). 404 `thumbnail_unavailable` with `details.reason` when there is none. */
  get(workId: string, version?: string): Promise<Uint8Array>;
  /**
   * Upload the frame the app captured for a card with `needs_frame`; `source`
   * and `timeSeconds` come from `card_image.frame_source`. 409 `thumbnail_frame_stale` when outdated.
   */
  putFrame(
    workId: string,
    bytes: Uint8Array,
    frame: {
      /** `card_image.version` the frame was captured for. */
      version: string;
      source: string;
      timeSeconds: number;
      contentType: 'image/jpeg' | 'image/png' | 'image/webp';
    },
  ): Promise<ThumbnailFrameResponse>;
}

export function createWorkThumbnailsApi(ctx: Ctx): CreatorHubWorkThumbnailsApi {
  const path = (workId: string, version?: string): string =>
    `/api/v1/works/${encodeURIComponent(workId)}/thumbnail${query({ v: version })}`;
  return {
    path,
    get: async (workId, version) => {
      const res = await ctx.doFetch(`${ctx.baseUrl}${path(workId, version)}`, {
        headers: { authorization: `Bearer ${ctx.options.token}` },
      });
      if (!res.ok) throw await toApiError(res);
      return new Uint8Array(await res.arrayBuffer());
    },
    putFrame: async (workId, bytes, frame) => {
      const url = `${ctx.baseUrl}/api/v1/works/${encodeURIComponent(workId)}/thumbnail-frame${query(
        {
          version: frame.version,
          source: frame.source,
          time_seconds: frame.timeSeconds,
        },
      )}`;
      const res = await ctx.doFetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.options.token}`,
          'content-type': frame.contentType,
          accept: 'application/json',
        },
        body: asBody(bytes),
      });
      if (!res.ok) throw await toApiError(res);
      return ThumbnailFrameResponseSchema.parse(await res.json());
    },
  };
}
