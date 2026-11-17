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
    usage: (month) =>
      call(
        ctx,
        AiUsageResponseSchema,
        'GET',
        `/api/v1/ai/usage${month === undefined ? '' : `?month=${encodeURIComponent(month)}`}`,
      ),
  };
}
