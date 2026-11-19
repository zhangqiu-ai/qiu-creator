import {
  AiConsentRequestSchema,
  AiEstimateResponseSchema,
  AiJobRecordSchema,
  AiProviderListResponseSchema,
  AiProviderParamsSchema,
  AiProviderStatusSchema,
  AiSettingsSchema,
  AiUsageQuerySchema,
  AiUsageResponseSchema,
  CreateAiJobRequestSchema,
  CreateAiJobResponseSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdSchema,
  ListAiJobsQuerySchema,
  ListAiJobsResponseSchema,
  PatchAiProviderRequestSchema,
  PatchAiSettingsRequestSchema,
  SetAiKeyRequestSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import type { AiService } from '../ai/ai-service.js';
import { requirePrincipal } from '../auth/token-service.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};
const conflict = { ...errorResponses, 409: ErrorResponseSchema };
const JobParamsSchema = z.object({ id: IdSchema });

/**
 * AI routes. All of `/api/v1/ai/*` is owner-only (see `auth/scopes.ts`):
 * agent tokens can neither manage keys nor spend money on AI calls.
 */
export function registerAiRoutes(app: App, ai: AiService, idempotency: IdempotencyService): void {
  app.get(
    '/api/v1/ai/providers',
    {
      schema: {
        description:
          'AI providers, configured models, key status and first-use consent. Credentials are write-only.',
        response: { 200: AiProviderListResponseSchema, ...errorResponses },
      },
    },
    () => ({ items: ai.listProviders() }),
  );

  app.patch(
    '/api/v1/ai/providers/:provider',
    {
      schema: {
        description: 'Set the text model (and, for Gemini, the video model).',
        params: AiProviderParamsSchema,
        body: PatchAiProviderRequestSchema,
        response: { 200: AiProviderStatusSchema, ...errorResponses },
      },
    },
    (req) => ai.patchProvider(req.params.provider, req.body),
  );

  app.put(
    '/api/v1/ai/providers/:provider/key',
    {
      schema: {
        description:
          "Store the provider's API key in the macOS Keychain. Write-only: no endpoint returns it, and it is never logged.",
        params: AiProviderParamsSchema,
        body: SetAiKeyRequestSchema,
        response: { 200: AiProviderStatusSchema, ...conflict },
      },
    },
    (req) => ai.setKey(req.params.provider, req.body.api_key, req.body.base_url),
  );

  app.delete(
    '/api/v1/ai/providers/:provider/key',
    {
      schema: {
        description: "Remove the provider's key from the Keychain.",
        params: AiProviderParamsSchema,
        response: { 200: AiProviderStatusSchema, ...conflict },
      },
    },
    (req) => ai.deleteKey(req.params.provider),
  );

  app.post(
    '/api/v1/ai/providers/:provider/consent',
    {
      schema: {
        description:
          'Record that the user read the first-use notice (what is sent to which company). `notice_version` must be the current one; jobs are refused until this is done.',
        params: AiProviderParamsSchema,
        body: AiConsentRequestSchema,
        response: { 200: AiProviderStatusSchema, ...conflict },
      },
    },
    (req) => ai.consent(req.params.provider, req.body.notice_version, req.body.credential_id),
  );

  app.delete(
    '/api/v1/ai/providers/:provider/consent',
    {
      schema: {
        description:
          'Withdraw the confirmation; queued jobs for this provider then fail instead of sending.',
        params: AiProviderParamsSchema,
        response: { 200: AiProviderStatusSchema, ...errorResponses },
      },
    },
    (req) => ai.withdrawConsent(req.params.provider),
  );

  app.get(
    '/api/v1/ai/settings',
    {
      schema: {
        description:
          'Monthly reminder amount and price overrides (reference prices are estimates).',
        response: { 200: AiSettingsSchema, ...errorResponses },
      },
    },
    () => ai.settings(),
  );

  app.patch(
    '/api/v1/ai/settings',
    {
      schema: {
        body: PatchAiSettingsRequestSchema,
        response: { 200: AiSettingsSchema, ...errorResponses },
      },
    },
    (req) => ai.patchSettings(req.body),
  );

  app.post(
    '/api/v1/ai/estimate',
    {
      schema: {
        description:
          'Estimated cost of a job before sending it, plus the month-to-date budget status. Sends nothing.',
        body: CreateAiJobRequestSchema,
        response: { 200: AiEstimateResponseSchema, ...errorResponses },
      },
    },
    (req) => {
      const estimate = ai.estimate(req.body);
      return { estimate, budget: ai.budget(undefined, estimate.max_cost_usd ?? 0) };
    },
  );

  app.post(
    '/api/v1/ai/jobs',
    {
      schema: {
        description:
          'Queue an AI job (202). Refused with 409 `ai_key_missing` / `ai_consent_required` until the provider has a key and a confirmed notice. Over the monthly reminder amount the job still runs and `budget.warning` says so. Supports `Idempotency-Key`.',
        body: CreateAiJobRequestSchema,
        response: {
          202: CreateAiJobResponseSchema,
          422: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...conflict,
        },
      },
    },
    (req, reply) => {
      const result = idempotency.run(
        requirePrincipal(req.principal),
        'POST /api/v1/ai/jobs',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        req.body,
        () => ({ statusCode: 202, body: ai.submit(req.body) }),
      );
      const body = CreateAiJobResponseSchema.parse(result.body);
      reply.code(result.statusCode);
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      // A replay returns the job as it is now, not as it was when first queued.
      return result.replayed ? { job: ai.get(body.job.id), budget: body.budget } : body;
    },
  );

  app.get(
    '/api/v1/ai/jobs',
    {
      schema: {
        querystring: ListAiJobsQuerySchema,
        response: { 200: ListAiJobsResponseSchema, ...errorResponses },
      },
    },
    (req) => ai.list(req.query),
  );

  app.get(
    '/api/v1/ai/jobs/:id',
    {
      schema: { params: JobParamsSchema, response: { 200: AiJobRecordSchema, ...errorResponses } },
    },
    (req) => ai.get(req.params.id),
  );

  app.post(
    '/api/v1/ai/jobs/:id/cancel',
    {
      schema: {
        description: 'Cancel a queued or running job (a running provider call is aborted).',
        params: JobParamsSchema,
        response: { 200: AiJobRecordSchema, ...conflict },
      },
    },
    (req) => ai.cancel(req.params.id),
  );

  app.post(
    '/api/v1/ai/jobs/:id/retry',
    {
      schema: {
        description: 'Re-queue a failed or cancelled job.',
        params: JobParamsSchema,
        response: { 200: AiJobRecordSchema, ...conflict },
      },
    },
    (req) => ai.retry(req.params.id),
  );

  app.get(
    '/api/v1/ai/usage',
    {
      schema: {
        description:
          'Tokens and estimated cost per provider for a local month (default: this month).',
        querystring: AiUsageQuerySchema,
        response: { 200: AiUsageResponseSchema, ...errorResponses },
      },
    },
    (req) => ai.usage(req.query.month),
  );
}
