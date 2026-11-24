import {
  ApiTokenSchema,
  CreateTokenResponseSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  ImportJobRecordSchema,
  ListJobsResponseSchema,
  ListTokenActivityResponseSchema,
  ListTokensResponseSchema,
  type ApiToken,
  type ListTokenActivityQuery,
  type ListTokenActivityResponse,
  type UpdateTokenRequest,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type ImportJobRecord,
  type ImportUrlRequest,
  type ListJobsQuery,
  type ListJobsResponse,
  type ListTokensResponse,
} from '@qiu-creator/contracts';
import type { z } from 'zod';
import { ApiError, type CreatorHubClientOptions, type FetchLike } from './index.js';

export interface IdempotencyOptions {
  /** Sent as `Idempotency-Key`; repeating a request with the same key returns the original result. */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Poll interval (default 1000 ms). */
  intervalMs?: number;
  /** Give up after this long (default 10 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CreatorHubImportsApi {
  /** Queue a URL download into the asset library; resolves with the queued job. */
  url(input: ImportUrlRequest, options?: IdempotencyOptions): Promise<ImportJobRecord>;
}

export interface CreatorHubJobsApi {
  get(id: string): Promise<ImportJobRecord>;
  list(query?: ListJobsQuery): Promise<ListJobsResponse>;
  retry(id: string): Promise<ImportJobRecord>;
  /** Poll until the job is `succeeded` or `failed`. */
  wait(id: string, options?: WaitOptions): Promise<ImportJobRecord>;
}

export interface CreatorHubTokensApi {
  create(input: CreateTokenRequest): Promise<CreateTokenResponse>;
  list(): Promise<ListTokensResponse>;
  revoke(id: string): Promise<ApiToken>;
  /** Scopes, direct-edit switch, project limit or name (QC-089, owner only). */
  update(id: string, input: UpdateTokenRequest): Promise<ApiToken>;
  /** What the token did, newest first (QC-089, owner only); page with `before`. */
  activity(id: string, query?: ListTokenActivityQuery): Promise<ListTokenActivityResponse>;
}

export interface Ctx {
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

export async function call<S extends z.ZodType>(
  ctx: Ctx,
  schema: S,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.options.token}`,
    accept: 'application/json',
    ...extraHeaders,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await ctx.doFetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = safeJson(await res.text());
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(json);
    const err = parsed.success ? parsed.data : null;
    throw new ApiError(res.status, err, err?.error.message ?? `HTTP ${res.status}`);
  }
  return schema.parse(json);
}

export function idempotencyHeaders(
  options: IdempotencyOptions | undefined,
): Record<string, string> {
  return options?.idempotencyKey === undefined
    ? {}
    : { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey };
}

export function createImportsApi(ctx: Ctx): CreatorHubImportsApi {
  return {
    url: (input, options) =>
      call(
        ctx,
        ImportJobRecordSchema,
        'POST',
        '/api/v1/imports/urls',
        input,
        idempotencyHeaders(options),
      ),
  };
}

export function createJobsApi(ctx: Ctx): CreatorHubJobsApi {
  const get = (id: string): Promise<ImportJobRecord> =>
    call(ctx, ImportJobRecordSchema, 'GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
  return {
    get,
    list: (query = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query) as [string, string | number | undefined][]) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      return call(ctx, ListJobsResponseSchema, 'GET', `/api/v1/jobs${s === '' ? '' : `?${s}`}`);
    },
    retry: (id) =>
      call(ctx, ImportJobRecordSchema, 'POST', `/api/v1/jobs/${encodeURIComponent(id)}/retry`),
    wait: async (id, options = {}) => {
      const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
      for (;;) {
        const job = await get(id);
        if (job.status === 'succeeded' || job.status === 'failed') return job;
        if (options.signal?.aborted === true || Date.now() > deadline) {
          throw new Error(`job ${id} still ${job.status}`);
        }
        await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
      }
    },
  };
}

export function createTokensApi(ctx: Ctx): CreatorHubTokensApi {
  return {
    create: (input) => call(ctx, CreateTokenResponseSchema, 'POST', '/api/v1/tokens', input),
    list: () => call(ctx, ListTokensResponseSchema, 'GET', '/api/v1/tokens'),
    revoke: (id) => call(ctx, ApiTokenSchema, 'DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`),
    update: (id, input) =>
      call(ctx, ApiTokenSchema, 'PATCH', `/api/v1/tokens/${encodeURIComponent(id)}`, input),
    activity: (id, q = {}) => {
      const params = new URLSearchParams();
      if (q.limit !== undefined) params.set('limit', String(q.limit));
      if (q.before !== undefined) params.set('before', String(q.before));
      const qs = params.toString();
      return call(
        ctx,
        ListTokenActivityResponseSchema,
        'GET',
        `/api/v1/tokens/${encodeURIComponent(id)}/activity${qs === '' ? '' : `?${qs}`}`,
      );
    },
  };
}
