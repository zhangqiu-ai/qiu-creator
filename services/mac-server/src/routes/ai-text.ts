import {
  AcceptRewriteRequestSchema,
  CreateAiJobResponseSchema,
  ErrorResponseSchema,
  PlatformSuggestionsRequestSchema,
  RevisionConflictResponseSchema,
  RewriteRequestSchema,
  WorkAiJobParamsSchema,
  WorkDetailSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { revisionEtag } from '@qiu-creator/domain';
import { z } from 'zod';
import type { TextAiService } from '../ai/text-tasks.js';
import type { App } from '../http/app-type.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};
const submitResponses = {
  202: CreateAiJobResponseSchema,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  ...errorResponses,
};

/**
 * Text AI on a work (QC-022), owner token only. Both endpoints queue an AI
 * job and return it at once; poll `GET /api/v1/ai/jobs/:id` or follow the
 * `ai_job.*` SSE events. Stop = `POST /api/v1/ai/jobs/:id/cancel`, retry =
 * `POST /api/v1/ai/jobs/:id/retry`.
 */
export function registerAiTextRoutes(app: App, text: TextAiService): void {
  app.post(
    '/api/v1/works/:id/ai/suggestions',
    {
      schema: {
        description:
          'Queue title / summary / tag candidates for each platform, written to fit `PLATFORM_LIMITS`. The result (`PlatformSuggestionsResult`) carries limit warnings per candidate. Nothing is written: apply a candidate with `PATCH /api/v1/works/:id/variants/:platform` and its `base_revision`.',
        params: WorkIdParamsSchema,
        body: PlatformSuggestionsRequestSchema,
        response: submitResponses,
      },
    },
    (req, reply) => {
      reply.code(202);
      return text.suggest(req.params.id, req.body);
    },
  );

  app.post(
    '/api/v1/works/:id/ai/rewrite',
    {
      schema: {
        description:
          'Queue a rewrite candidate (polish / shorten / expand / tone / custom) of the whole text or a selection of the current revision, which becomes the job’s `source_revision`. Nothing is written until accepted.',
        params: WorkIdParamsSchema,
        body: RewriteRequestSchema,
        response: submitResponses,
      },
    },
    (req, reply) => {
      reply.code(202);
      return text.rewrite(req.params.id, req.body);
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
