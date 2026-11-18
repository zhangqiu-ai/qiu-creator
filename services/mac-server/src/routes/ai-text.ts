import {
  AcceptRewriteRequestSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  PlatformSuggestionsRequestSchema,
  RevisionConflictResponseSchema,
  RewriteRequestSchema,
  WorkAiJobParamsSchema,
  WorkAiJobResponseSchema,
  WorkDetailSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { revisionEtag } from '@qiu-creator/domain';
import { z } from 'zod';
import type { AiService } from '../ai/ai-service.js';
import type { TextAiService } from '../ai/text-tasks.js';
import { requirePrincipal, type Principal } from '../auth/token-service.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};
const submitResponses = {
  202: WorkAiJobResponseSchema,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  422: ErrorResponseSchema,
  ...errorResponses,
};

const DEDUPE_NOTE =
  ' An identical request (same work, parameters and `source_revision`) already queued or running returns that job with `in_progress: true`; nothing is sent or charged again. Supports `Idempotency-Key`: the same key and body return the original job as it is now (`Idempotent-Replayed: true`), the same key with a different body is 422.';

/**
 * Text AI on a work (QC-022), owner token only. Both endpoints queue an AI
 * job and return it at once; poll `GET /api/v1/ai/jobs/:id` or follow the
 * `ai_job.*` SSE events. Stop = `POST /api/v1/ai/jobs/:id/cancel`, retry =
 * `POST /api/v1/ai/jobs/:id/retry`.
 */
export function registerAiTextRoutes(
  app: App,
  text: TextAiService,
  ai: AiService,
  idempotency: IdempotencyService,
): void {
  /** Idempotency-Key handling; a replay returns the job as it is now. */
  const once = (
    principal: Principal | null,
    endpoint: string,
    key: string | string[] | undefined,
    request: unknown,
    create: () => unknown,
    reply: { header: (name: string, value: string) => unknown },
  ): z.infer<typeof WorkAiJobResponseSchema> => {
    const result = idempotency.run(requirePrincipal(principal), endpoint, key, request, () => ({
      statusCode: 202,
      body: create(),
    }));
    const body = WorkAiJobResponseSchema.parse(result.body);
    if (!result.replayed) return body;
    reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return { ...body, job: ai.get(body.job.id) };
  };

  app.post(
    '/api/v1/works/:id/ai/suggestions',
    {
      schema: {
        description:
          'Queue title / summary / tag candidates for each platform, written to fit `PLATFORM_LIMITS`. The result (`PlatformSuggestionsResult`) carries limit warnings per candidate. Nothing is written: apply a candidate with `PATCH /api/v1/works/:id/variants/:platform` and its `base_revision`.' +
          DEDUPE_NOTE,
        params: WorkIdParamsSchema,
        body: PlatformSuggestionsRequestSchema,
        response: submitResponses,
      },
    },
    (req, reply) => {
      reply.code(202);
      return once(
        req.principal,
        'POST /api/v1/works/:id/ai/suggestions',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        { work_id: req.params.id, body: req.body },
        () => text.suggest(req.params.id, req.body),
        reply,
      );
    },
  );

  app.post(
    '/api/v1/works/:id/ai/rewrite',
    {
      schema: {
        description:
          'Queue a rewrite candidate (polish / shorten / expand / tone / custom) of the whole text or a selection of the current revision, which becomes the job’s `source_revision`. Nothing is written until accepted.' +
          DEDUPE_NOTE,
        params: WorkIdParamsSchema,
        body: RewriteRequestSchema,
        response: submitResponses,
      },
    },
    (req, reply) => {
      reply.code(202);
      return once(
        req.principal,
        'POST /api/v1/works/:id/ai/rewrite',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        { work_id: req.params.id, body: req.body },
        () => text.rewrite(req.params.id, req.body),
        reply,
      );
    },
  );

  app.post(
    '/api/v1/works/:id/ai/jobs/:jobId/accept',
    {
      schema: {
        description:
          'Accept a rewrite: send the final full Markdown the user composed (all, part or edited; the server never merges). It is written as an `ai_accepted` revision with `base_revision = source_revision`; if the work changed since the candidate was made, 409 and nothing is written. Restorable from history like any revision.',
        params: WorkAiJobParamsSchema,
        body: AcceptRewriteRequestSchema,
        response: {
          200: WorkDetailSchema,
          409: z.union([RevisionConflictResponseSchema, ErrorResponseSchema]),
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const work = text.accept(req.params.id, req.params.jobId, req.body);
      reply.header('etag', revisionEtag(work.current_revision_id));
      return work;
    },
  );
}
