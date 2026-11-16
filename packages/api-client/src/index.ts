import {
  CreateWorkRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListWorksResponseSchema,
  RevisionListResponseSchema,
  WorkDetailSchema,
  type CreateWorkRequest,
  type ErrorResponse,
  type HealthResponse,
  type ListWorksQuery,
  type ListWorksResponse,
  type PatchWorkRequest,
  type RevisionListResponse,
  type WorkDetail,
} from '@qiu-creator/contracts';
import type { z } from 'zod';
import {
  createAssetsApi,
  createEventsApi,
  createWorkAssetsApi,
  type CreatorHubAssetsApi,
  type CreatorHubEventsApi,
  type CreatorHubWorkAssetsApi,
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

export interface CreatorHubClient {
  health(): Promise<HealthResponse>;
  works: {
    /** `options.idempotencyKey` is required when using an agent token. */
    create(input: CreateWorkRequest, options?: IdempotencyOptions): Promise<WorkDetail>;
    list(query?: ListWorksQuery): Promise<ListWorksResponse>;
    get(id: string): Promise<WorkDetail>;
    patch(id: string, input: PatchWorkRequest, options?: PatchWorkOptions): Promise<WorkDetail>;
    revisions(id: string): Promise<RevisionListResponse>;
  };
  /** Asset library and uploads (QC-005). */
  assets: CreatorHubAssetsApi;
  /** Work ↔ asset links: cover, body, video, with ordering. */
  workAssets: CreatorHubWorkAssetsApi;
  /** SSE change events. */
  events: CreatorHubEventsApi;
  /** URL imports (QC-006). */
  imports: CreatorHubImportsApi;
  /** Import jobs: status, list, retry, wait. */
  jobs: CreatorHubJobsApi;
  /** Agent token management (owner token only). */
  tokens: CreatorHubTokensApi;
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
    events: createEventsApi(ctx),
    imports: createImportsApi(ctx),
    jobs: createJobsApi(ctx),
    tokens: createTokensApi(ctx),
    health: () => request(HealthResponseSchema, 'GET', '/health'),
    works: {
      create: (input, createOptions) =>
        request(WorkDetailSchema, 'POST', '/api/v1/works', {
          body: CreateWorkRequestSchema.parse(input),
          headers: idempotencyHeaders(createOptions),
        }),
      list: (query = {}) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query) as [
          string,
          string | number | undefined,
        ][]) {
          if (value !== undefined) params.set(key, String(value));
        }
        const qs = params.toString();
        return request(ListWorksResponseSchema, 'GET', `/api/v1/works${qs ? `?${qs}` : ''}`);
      },
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
