import {
  CreateWorkRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListWorksResponseSchema,
  WorkFacetsResponseSchema,
  WorkRefsResponseSchema,
  RevisionDetailSchema,
  RevisionListResponseSchema,
  SignedAssetUrlsRequestSchema,
  SignedAssetUrlsResponseSchema,
  WorkDetailSchema,
  WorkMediaResponseSchema,
  AttachWorkMediaRequestSchema,
  AttachWorkMediaResponseSchema,
  BatchWorksRequestSchema,
  BatchWorksResponseSchema,
  DeleteWorkRequestSchema,
  DeleteWorkResponseSchema,
  EmptyWorkTrashResponseSchema,
  PurgedWorkSchema,
  RestoreWorkRequestSchema,
  type AttachWorkMediaResponse,
  type BatchWorksRequest,
  type BatchWorksResponse,
  type DeleteWorkRequest,
  type DeleteWorkResponse,
  type EmptyWorkTrashResponse,
  type PurgedWork,
  type RestoreWorkRequest,
  type CreateWorkRequest,
  type ErrorResponse,
  type HealthResponse,
  type ListWorksQuery,
  type ListWorksResponse,
  type WorkFacetsQuery,
  type WorkFacetsResponse,
  type WorkRefsQuery,
  type WorkRefsResponse,
  type PatchWorkRequest,
  type RestoreRevisionRequest,
  type RevisionDetail,
  type RevisionListResponse,
  type SignedAssetUrlsRequest,
  type SignedAssetUrlsResponse,
  type WorkDetail,
  type WorkMediaResponse,
} from '@qiu-creator/contracts';
import type { z } from 'zod';
import {
  createAssetsApi,
  createEventsApi,
  createTrashApi,
  createWorkAssetsApi,
  createWorkThumbnailsApi,
  type CreatorHubAssetsApi,
  type CreatorHubEventsApi,
  type CreatorHubTrashApi,
  type CreatorHubWorkAssetsApi,
  type CreatorHubWorkThumbnailsApi,
} from './assets.js';
import {
  createImportsApi,
  createJobsApi,
  createTokensApi,
  idempotencyHeaders,
  type CreatorHubImportsApi,
  type CreatorHubJobsApi,
  type CreatorHubTokensApi,
  type IdempotencyOptions,
} from './imports.js';

import { createMountsApi, type CreatorHubMountsApi } from './mounts.js';
import { createProjectsApi, type CreatorHubProjectsApi } from './projects.js';
export type { CreatorHubProjectsApi } from './projects.js';
import { createVariantsApi, type CreatorHubVariantsApi } from './variants.js';
import { createAiApi, type CreatorHubAiApi } from './ai.js';
import { createBackupsApi, type CreatorHubBackupsApi } from './backups.js';
export type { CreatorHubBackupsApi } from './backups.js';
export {
  imageResultOf,
  promptSuggestionOf,
  rewriteOf,
  suggestionsOf,
  videoUnderstandingOf,
  type CreatorHubAiApi,
} from './ai.js';
export type { CreatorHubVariantsApi, VariantWriteOptions } from './variants.js';
export type { CreatorHubMountsApi } from './mounts.js';

export {
  type CreatorHubImportsApi,
  type CreatorHubJobsApi,
  type CreatorHubTokensApi,
  type IdempotencyOptions,
  type WaitOptions,
} from './imports.js';

export {
  base64Utf8,
  parseSseChunk,
  ResumableUploadError,
  type CreatorHubAssetsApi,
  type CreatorHubEventsApi,
  type CreatorHubTrashApi,
  type CreatorHubWorkAssetsApi,
  type ResumableUploadInput,
  type SubscribeOptions,
  type UploadInput,
} from './assets.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreatorHubClientOptions {
  /** e.g. `http://127.0.0.1:7420` */
  baseUrl: string;
  /** Bearer token for the Mac service. */
  token: string;
  /** Override for tests or non-global fetch environments. */
  fetch?: FetchLike;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorResponse | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return this.body?.error.code;
  }

  /** A platform variant's current revision (an integer) after a 409 on a variant write. */
  get currentVariantRevision(): number | undefined {
    const value = this.body?.error.details?.['current_revision'];
    return typeof value === 'number' ? value : undefined;
  }

  /** The server's current revision when the request lost a revision race (409). */
  get currentRevision(): string | undefined {
    const value = this.body?.error.details?.['current_revision'];
    return typeof value === 'string' ? value : undefined;
  }
}

export interface PatchWorkOptions {
  /** Sent as `If-Match` in addition to (or instead of) `base_revision`. */
  ifMatch?: string;
}

/** Query string for the works list routes; `ids` travels as one comma-separated value (QC-045/046). */
function worksQuery(query: ListWorksQuery | WorkFacetsQuery | WorkRefsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query) as [
    string,
    string | number | string[] | undefined,
  ][]) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface CreatorHubClient {
  health(): Promise<HealthResponse>;
  works: {
    /** `options.idempotencyKey` is required when using an agent token. */
    create(input: CreateWorkRequest, options?: IdempotencyOptions): Promise<WorkDetail>;
    /** One page; pass the page's `next_cursor` as `cursor` for the next (QC-067). */
    list(query?: ListWorksQuery): Promise<ListWorksResponse>;
    /** Counts by type and status under the list filters, for filter chips (QC-067). */
    facets(query?: WorkFacetsQuery): Promise<WorkFacetsResponse>;
    /** Every work matching the filters, light fields only; 413 above `WORK_REFS_MAX` (QC-067). */
    refs(query?: WorkRefsQuery): Promise<WorkRefsResponse>;
    get(id: string): Promise<WorkDetail>;
    patch(id: string, input: PatchWorkRequest, options?: PatchWorkOptions): Promise<WorkDetail>;
    revisions(id: string): Promise<RevisionListResponse>;
    /** One historical revision with its Markdown. */
    revision(id: string, revisionId: string): Promise<RevisionDetail>;
    /**
     * Restore `revisionId` as a new `restore` revision. Pass `base_revision`
     * (or `options.ifMatch`); a stale base throws `ApiError` 409.
     */
    restore(
      id: string,
      revisionId: string,
      input: RestoreRevisionRequest,
      options?: PatchWorkOptions,
    ): Promise<WorkDetail>;
    /** Resolve media referenced from the work's Markdown, with signed URLs (relative; see `mediaUrl`). */
    media(id: string): Promise<WorkMediaResponse>;
    /**
     * Copy an asset into a managed work's `assets/` and link it (QC-039); returns the
     * `src` to insert. External works answer 409 `attach_external_unsupported`.
     */
    attachMedia(id: string, assetId: string): Promise<AttachWorkMediaResponse>;
    /**
     * Move to 回收站 (QC-051). Pass `base_revision` or `options.ifMatch`.
     * External works are only unindexed unless `move_original_to_trash` (owner only).
     */
    trash(
      id: string,
      input?: DeleteWorkRequest,
      options?: PatchWorkOptions,
    ): Promise<DeleteWorkResponse>;
    /** Back from 回收站 with the same revision (QC-051). */
    restoreFromTrash(
      id: string,
      input?: RestoreWorkRequest,
      options?: PatchWorkOptions,
    ): Promise<WorkDetail>;
    /** Delete one work in 回收站 permanently (owner only). List them with `list({ scope: 'trash' })`. */
    purge(id: string): Promise<PurgedWork>;
    /** Delete every work in 回收站 permanently (owner only). */
    emptyTrash(): Promise<EmptyWorkTrashResponse>;
    /**
     * Delete, restore, set status, or add/remove tags on many works (QC-051).
     * Each item fails on its own; check `results[].ok`. Send `options.idempotencyKey`
     * (required for agent tokens) so a retry does not apply the change twice.
     */
    batch(input: BatchWorksRequest, options?: IdempotencyOptions): Promise<BatchWorksResponse>;
  };
  /** Signed, header-less URLs for `<img>`/`<video>` (QC-010). */
  media: {
    signedAssetUrls(input: SignedAssetUrlsRequest): Promise<SignedAssetUrlsResponse>;
    /** Absolute URL for a relative signed `url` returned by the server. */
    absoluteUrl(relative: string): string;
  };
  /** Asset library and uploads (QC-005). */
  assets: CreatorHubAssetsApi;
  /** Work ↔ asset links: cover, body, video, with ordering. */
  workAssets: CreatorHubWorkAssetsApi;
  /** Library card images (QC-061). */
  workThumbnails: CreatorHubWorkThumbnailsApi;
  /** SSE change events. */
  events: CreatorHubEventsApi;
  /** URL imports (QC-006). */
  imports: CreatorHubImportsApi;
  /** Import jobs: status, list, retry, wait. */
  jobs: CreatorHubJobsApi;
  /** Agent token management (owner token only). */
  tokens: CreatorHubTokensApi;
  /** External folder mounts (QC-007). */
  mounts: CreatorHubMountsApi;
  /** Projects grouping works (QC-062). */
  projects: CreatorHubProjectsApi;
  /** Platform variants: 小紅書, 公眾號, 抖音, 視頻號 (QC-009). */
  variants: CreatorHubVariantsApi;
  /** AI providers, Keychain keys, consent, jobs and usage (QC-021). Owner token only. */
  ai: CreatorHubAiApi;
  /** SQLite backups: list, back up now, restore (QC-030). Owner token only. */
  backups: CreatorHubBackupsApi;
  /** 回收站: permanent delete and empty (QC-037). Owner token only. */
  trash: CreatorHubTrashApi;
}

export function createClient(options: CreatorHubClientOptions): CreatorHubClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
      ...init.headers,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await doFetch(`${baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    const json: unknown = text === '' ? null : safeJson(text);
    if (!res.ok) {
      const parsed = ErrorResponseSchema.safeParse(json);
      const errBody = parsed.success ? parsed.data : null;
      const message = errBody?.error.message ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, errBody, message);
    }
    return schema.parse(json);
  }

  const ctx = { baseUrl, options, doFetch };
  return {
    assets: createAssetsApi(ctx),
    workAssets: createWorkAssetsApi(ctx),
    workThumbnails: createWorkThumbnailsApi(ctx),
    events: createEventsApi(ctx),
    imports: createImportsApi(ctx),
    jobs: createJobsApi(ctx),
    tokens: createTokensApi(ctx),
    mounts: createMountsApi(ctx),
    projects: createProjectsApi(ctx),
    variants: createVariantsApi(ctx),
    ai: createAiApi(ctx),
    backups: createBackupsApi(ctx),
    trash: createTrashApi(ctx),
    health: () => request(HealthResponseSchema, 'GET', '/health'),
    works: {
      create: (input, createOptions) =>
        request(WorkDetailSchema, 'POST', '/api/v1/works', {
          body: CreateWorkRequestSchema.parse(input),
          headers: idempotencyHeaders(createOptions),
        }),
      list: (query = {}) =>
        request(ListWorksResponseSchema, 'GET', `/api/v1/works${worksQuery(query)}`),
      facets: (query = {}) =>
        request(WorkFacetsResponseSchema, 'GET', `/api/v1/works/facets${worksQuery(query)}`),
      refs: (query = {}) =>
        request(WorkRefsResponseSchema, 'GET', `/api/v1/works/refs${worksQuery(query)}`),
      get: (id) => request(WorkDetailSchema, 'GET', `/api/v1/works/${encodeURIComponent(id)}`),
      patch: (id, input, patchOptions = {}) =>
        request(WorkDetailSchema, 'PATCH', `/api/v1/works/${encodeURIComponent(id)}`, {
          body: input,
          headers:
            patchOptions.ifMatch === undefined ? {} : { 'if-match': `"${patchOptions.ifMatch}"` },
        }),
      revisions: (id) =>
        request(
          RevisionListResponseSchema,
          'GET',
          `/api/v1/works/${encodeURIComponent(id)}/revisions`,
        ),
      revision: (id, revisionId) =>
        request(
          RevisionDetailSchema,
          'GET',
          `/api/v1/works/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`,
        ),
      restore: (id, revisionId, input, restoreOptions = {}) =>
        request(
          WorkDetailSchema,
          'POST',
          `/api/v1/works/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          {
            body: input,
            headers:
              restoreOptions.ifMatch === undefined
                ? {}
                : { 'if-match': `"${restoreOptions.ifMatch}"` },
          },
        ),
      media: (id) =>
        request(WorkMediaResponseSchema, 'GET', `/api/v1/works/${encodeURIComponent(id)}/media`),
      attachMedia: (id, assetId) =>
        request(
          AttachWorkMediaResponseSchema,
          'POST',
          `/api/v1/works/${encodeURIComponent(id)}/media/attach`,
          { body: AttachWorkMediaRequestSchema.parse({ asset_id: assetId }) },
        ),
      trash: (id, input = {}, trashOptions = {}) =>
        request(DeleteWorkResponseSchema, 'DELETE', `/api/v1/works/${encodeURIComponent(id)}`, {
          body: DeleteWorkRequestSchema.parse(input),
          headers:
            trashOptions.ifMatch === undefined ? {} : { 'if-match': `"${trashOptions.ifMatch}"` },
        }),
      restoreFromTrash: (id, input = {}, restoreOptions = {}) =>
        request(WorkDetailSchema, 'POST', `/api/v1/works/${encodeURIComponent(id)}/restore`, {
          body: RestoreWorkRequestSchema.parse(input),
          headers:
            restoreOptions.ifMatch === undefined
              ? {}
              : { 'if-match': `"${restoreOptions.ifMatch}"` },
        }),
      purge: (id) =>
        request(PurgedWorkSchema, 'DELETE', `/api/v1/trash/works/${encodeURIComponent(id)}`),
      emptyTrash: () =>
        request(EmptyWorkTrashResponseSchema, 'DELETE', '/api/v1/trash/works', {
          body: { confirm: true },
        }),
      batch: (input, batchOptions) =>
        request(BatchWorksResponseSchema, 'POST', '/api/v1/works/batch', {
          body: BatchWorksRequestSchema.parse(input),
          headers: idempotencyHeaders(batchOptions),
        }),
    },
    media: {
      signedAssetUrls: (input) =>
        request(SignedAssetUrlsResponseSchema, 'POST', '/api/v1/media/signed-urls', {
          body: SignedAssetUrlsRequestSchema.parse(input),
        }),
      absoluteUrl: (relative) => `${baseUrl}${relative.startsWith('/') ? '' : '/'}${relative}`,
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
