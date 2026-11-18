import {
  AiEstimateResponseSchema,
  AiJobRecordSchema,
  AiProviderListResponseSchema,
  AiProviderStatusSchema,
  AiSettingsSchema,
  AiUsageResponseSchema,
  CreateAiJobRequestSchema,
  CreateAiJobResponseSchema,
  ListAiJobsResponseSchema,
  PlatformSuggestionsRequestSchema,
  VideoEstimateSchema,
  VideoUnderstandingRequestSchema,
  VideoUnderstandingResponseSchema,
  VideoUnderstandingResultSchema,
  type VideoEstimate,
  type VideoUnderstandingRequest,
  type VideoUnderstandingResponse,
  type VideoUnderstandingResult,
  PlatformSuggestionsResultSchema,
  RewriteRequestSchema,
  RewriteResultSchema,
  WorkDetailSchema,
  type AcceptRewriteRequest,
  type PlatformSuggestionsRequest,
  type PlatformSuggestionsResult,
  type RewriteRequest,
  type RewriteResult,
  type WorkDetail,
  type AiEstimateResponse,
  type AiJobRecord,
  type AiProvider,
  type AiProviderListResponse,
  type AiProviderStatus,
  type AiSettings,
  type AiUsageResponse,
  type CreateAiJobRequest,
  type CreateAiJobResponse,
  type ListAiJobsQuery,
  type ListAiJobsResponse,
  type PatchAiProviderRequest,
  type PatchAiSettingsRequest,
} from '@qiu-creator/contracts';
import { call, idempotencyHeaders, type Ctx, type IdempotencyOptions } from './imports.js';

/**
 * AI providers, keys, consent, jobs and usage (QC-021). Owner token only.
 * Keys are write-only: `setKey` stores one in the Mac's Keychain and nothing returns it.
 */
export interface CreatorHubAiApi {
  providers(): Promise<AiProviderListResponse>;
  patchProvider(provider: AiProvider, input: PatchAiProviderRequest): Promise<AiProviderStatus>;
  setKey(provider: AiProvider, apiKey: string): Promise<AiProviderStatus>;
  deleteKey(provider: AiProvider): Promise<AiProviderStatus>;
  /** Confirm the first-use notice; pass the `notice.version` that was shown. */
  consent(provider: AiProvider, noticeVersion: number): Promise<AiProviderStatus>;
  withdrawConsent(provider: AiProvider): Promise<AiProviderStatus>;
  settings(): Promise<AiSettings>;
  patchSettings(input: PatchAiSettingsRequest): Promise<AiSettings>;
  estimate(input: CreateAiJobRequest): Promise<AiEstimateResponse>;
  submit(input: CreateAiJobRequest, options?: IdempotencyOptions): Promise<CreateAiJobResponse>;
  jobs(query?: ListAiJobsQuery): Promise<ListAiJobsResponse>;
  job(id: string): Promise<AiJobRecord>;
  cancel(id: string): Promise<AiJobRecord>;
  retry(id: string): Promise<AiJobRecord>;
  usage(month?: string): Promise<AiUsageResponse>;

  // ---- Text AI on a work (QC-022) ----
  /** Queue per-platform title / summary / tag candidates. Apply one via `variants.patch`. */
  suggest(workId: string, input: PlatformSuggestionsRequest): Promise<CreateAiJobResponse>;
  /** Queue a rewrite candidate of the whole text or a selection. */
  rewrite(workId: string, input: RewriteRequest): Promise<CreateAiJobResponse>;
  /** Write the composed full text as an `ai_accepted` revision; 409 if the work changed since. */
  accept(workId: string, jobId: string, input: AcceptRewriteRequest): Promise<WorkDetail>;
  /** "停止生成": same as `cancel`. */
  stop(jobId: string): Promise<AiJobRecord>;

  // ---- Gemini video understanding (QC-023) ----
  /** Limits check and cost estimate before sending; also reports a reusable earlier result. */
  estimateVideo(assetId: string, input?: VideoUnderstandingRequest): Promise<VideoEstimate>;
  /**
   * Analyse a library video. `cached: true` returns an earlier result (free);
   * pass `reanalyze: true` to analyse and pay again.
   */
  analyzeVideo(
    assetId: string,
    input?: VideoUnderstandingRequest,
  ): Promise<VideoUnderstandingResponse>;
}

/** Typed result of a succeeded video-understanding job, or null. */
export function videoUnderstandingOf(job: AiJobRecord): VideoUnderstandingResult | null {
  const parsed = VideoUnderstandingResultSchema.safeParse(job.result?.json);
  return parsed.success ? parsed.data : null;
}

/** Typed suggestions of a succeeded `platform_suggestions` job, or null. */
export function suggestionsOf(job: AiJobRecord): PlatformSuggestionsResult | null {
  const parsed = PlatformSuggestionsResultSchema.safeParse(job.result?.json);
  return parsed.success ? parsed.data : null;
}

/** Typed candidate of a succeeded `rewrite` job, or null. */
export function rewriteOf(job: AiJobRecord): RewriteResult | null {
  const parsed = RewriteResultSchema.safeParse(job.result?.json);
  return parsed.success ? parsed.data : null;
}

export function createAiApi(ctx: Ctx): CreatorHubAiApi {
  const p = (provider: AiProvider): string =>
    `/api/v1/ai/providers/${encodeURIComponent(provider)}`;
  const j = (id: string): string => `/api/v1/ai/jobs/${encodeURIComponent(id)}`;
  return {
    providers: () => call(ctx, AiProviderListResponseSchema, 'GET', '/api/v1/ai/providers'),
    patchProvider: (provider, input) =>
      call(ctx, AiProviderStatusSchema, 'PATCH', p(provider), input),
    setKey: (provider, apiKey) =>
      call(ctx, AiProviderStatusSchema, 'PUT', `${p(provider)}/key`, { api_key: apiKey }),
    deleteKey: (provider) => call(ctx, AiProviderStatusSchema, 'DELETE', `${p(provider)}/key`),
    consent: (provider, noticeVersion) =>
      call(ctx, AiProviderStatusSchema, 'POST', `${p(provider)}/consent`, {
        notice_version: noticeVersion,
      }),
    withdrawConsent: (provider) =>
      call(ctx, AiProviderStatusSchema, 'DELETE', `${p(provider)}/consent`),
    settings: () => call(ctx, AiSettingsSchema, 'GET', '/api/v1/ai/settings'),
    patchSettings: (input) => call(ctx, AiSettingsSchema, 'PATCH', '/api/v1/ai/settings', input),
    estimate: (input) =>
      call(
        ctx,
        AiEstimateResponseSchema,
        'POST',
        '/api/v1/ai/estimate',
        CreateAiJobRequestSchema.parse(input),
      ),
    submit: (input, options) =>
      call(
        ctx,
        CreateAiJobResponseSchema,
        'POST',
        '/api/v1/ai/jobs',
        CreateAiJobRequestSchema.parse(input),
        idempotencyHeaders(options),
      ),
    jobs: (query = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query) as [string, string | number | undefined][]) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      return call(ctx, ListAiJobsResponseSchema, 'GET', `/api/v1/ai/jobs${qs ? `?${qs}` : ''}`);
    },
    job: (id) => call(ctx, AiJobRecordSchema, 'GET', j(id)),
    cancel: (id) => call(ctx, AiJobRecordSchema, 'POST', `${j(id)}/cancel`),
    retry: (id) => call(ctx, AiJobRecordSchema, 'POST', `${j(id)}/retry`),
    suggest: (workId, input) =>
      call(
        ctx,
        CreateAiJobResponseSchema,
        'POST',
        `/api/v1/works/${encodeURIComponent(workId)}/ai/suggestions`,
        PlatformSuggestionsRequestSchema.parse(input),
      ),
    rewrite: (workId, input) =>
      call(
        ctx,
        CreateAiJobResponseSchema,
        'POST',
        `/api/v1/works/${encodeURIComponent(workId)}/ai/rewrite`,
        RewriteRequestSchema.parse(input),
      ),
    accept: (workId, jobId, input) =>
      call(
        ctx,
        WorkDetailSchema,
        'POST',
        `/api/v1/works/${encodeURIComponent(workId)}/ai/jobs/${encodeURIComponent(jobId)}/accept`,
        input,
      ),
    estimateVideo: (assetId, input = {}) =>
      call(
        ctx,
        VideoEstimateSchema,
        'POST',
        `/api/v1/assets/${encodeURIComponent(assetId)}/ai/video-understanding/estimate`,
        VideoUnderstandingRequestSchema.parse(input),
      ),
    analyzeVideo: (assetId, input = {}) =>
      call(
        ctx,
        VideoUnderstandingResponseSchema,
        'POST',
        `/api/v1/assets/${encodeURIComponent(assetId)}/ai/video-understanding`,
        VideoUnderstandingRequestSchema.parse(input),
      ),
    stop: (jobId) => call(ctx, AiJobRecordSchema, 'POST', `${j(jobId)}/cancel`),
    usage: (month) =>
      call(
        ctx,
        AiUsageResponseSchema,
        'GET',
        `/api/v1/ai/usage${month === undefined ? '' : `?month=${encodeURIComponent(month)}`}`,
      ),
  };
}
