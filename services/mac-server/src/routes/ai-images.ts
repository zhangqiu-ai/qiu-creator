import fs from 'node:fs';
import {
  AiImageCandidateParamsSchema,
  AiImageEstimateResponseSchema,
  AiImageKeepRequestSchema,
  AiImageKeepResponseSchema,
  AiImageRequestSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdSchema,
  RevisionConflictResponseSchema,
  WorkAiJobParamsSchema,
  WorkAiJobResponseSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { revisionEtag } from '@qiu-creator/domain';
import { z } from 'zod';
import type { AiService } from '../ai/ai-service.js';
import { aiImageMediaPath, type ImageAiService } from '../ai/image-tasks.js';
import { requirePrincipal, type TokenService } from '../auth/token-service.js';
import { ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';
import type { MediaUrlSigner } from '../media/url-signer.js';
import { SignedQuerySchema, signedHeaders } from './media.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/**
 * AI images on an article (QC-070), owner token only. Generating queues an AI
 * job (cancel / retry with `POST /api/v1/ai/jobs/:id/cancel|retry`, progress
 * through `ai_job.*` events); its candidates wait in a temporary cache until
 * kept or discarded.
 */
export function registerAiImageRoutes(
  app: App,
  images: ImageAiService,
  ai: AiService,
  idempotency: IdempotencyService,
  signer: MediaUrlSigner,
  tokens: TokenService,
): void {
  app.post(
    '/api/v1/works/:id/ai/images/estimate',
    {
      schema: {
        description:
          'What generating would cost: `max_cost_usd` = images × `per_image_usd` of the model’s price override, or null when there is none (「無法預估」). Sends nothing.',
        params: WorkIdParamsSchema,
        body: AiImageRequestSchema,
        response: {
          200: AiImageEstimateResponseSchema,
          409: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req) => images.estimate(req.params.id, req.body),
  );

  app.post(
    '/api/v1/works/:id/ai/images',
    {
      schema: {
        description:
          'Queue image generation through New API (`images/generations`): `image` from `prompt`, `cover` from the title and text. Needs the relay’s notice confirmed. Never retried automatically. An identical request already queued or running returns that job with `in_progress: true`. Supports `Idempotency-Key`.',
        params: WorkIdParamsSchema,
        body: AiImageRequestSchema,
        response: {
          202: WorkAiJobResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      reply.code(202);
      const result = idempotency.run(
        requirePrincipal(req.principal),
        'POST /api/v1/works/:id/ai/images',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        { work_id: req.params.id, body: req.body },
        () => ({ statusCode: 202, body: images.create(req.params.id, req.body) }),
      );
      const body = WorkAiJobResponseSchema.parse(result.body);
      if (!result.replayed) return body;
      reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return { ...body, job: ai.get(body.job.id) };
    },
  );

  app.post(
    '/api/v1/works/:id/ai/images/:jobId/keep',
    {
      schema: {
        description:
          'Keep a candidate: added to the library, copied into the work’s `assets/`, and with `insert` or `cover` written as an `ai_accepted` revision on `base_revision` (409 `revision_conflict` when the work changed; nothing is written). `library` leaves the work as it is.',
        params: WorkAiJobParamsSchema,
        body: AiImageKeepRequestSchema,
        response: {
          200: AiImageKeepResponseSchema,
          409: z.union([RevisionConflictResponseSchema, ErrorResponseSchema]),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const kept = await images.keep(req.params.id, req.params.jobId, req.body);
      reply.header('etag', revisionEtag(kept.work.current_revision_id));
      return kept;
    },
  );

  app.delete(
    '/api/v1/works/:id/ai/images/:jobId/candidates/:index',
    {
      schema: {
        description: 'Discard a candidate: its temporary file is deleted.',
        params: AiImageCandidateParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    (req, reply) => {
      images.discard(req.params.id, req.params.jobId, req.params.index);
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/api/v1/works/:id/ai/images/:jobId/candidates/:index',
    {
      schema: {
        description: 'A candidate image (PNG or JPEG) with a Bearer token; 404 once it is gone.',
        params: AiImageCandidateParamsSchema,
      },
    },
    (req, reply) => {
      const { file, mime } = images.candidateFile(
        req.params.jobId,
        req.params.index,
        req.params.id,
      );
      const body = fs.readFileSync(file);
      return reply
        .header('content-type', mime)
        .header('cache-control', 'private, no-store')
        .header('content-length', body.length)
        .send(body);
    },
  );

  app.get(
    '/media/v1/image-candidates/:jobId/:index',
    {
      schema: {
        description:
          'Signed candidate image (QC-070), from `candidates[].url` of an image job. 404 once it is gone.',
        security: [],
        params: z.object({
          jobId: IdSchema,
          index: AiImageCandidateParamsSchema.shape.index,
        }),
        querystring: SignedQuerySchema,
      },
    },
    (req, reply) => {
      const { principalId, secondsLeft } = signer.verify(
        aiImageMediaPath(req.params.jobId, req.params.index),
        req.query,
      );
      if (tokens.readerById(principalId) === null) {
        throw new ServiceError(403, 'forbidden', 'media link is invalid or expired');
      }
      const { file, mime } = images.candidateFile(req.params.jobId, req.params.index);
      const body = fs.readFileSync(file);
      signedHeaders(reply, secondsLeft);
      return reply.header('content-type', mime).header('content-length', body.length).send(body);
    },
  );
}
