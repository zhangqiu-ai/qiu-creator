import {
  AssetIdParamsSchema,
  ErrorResponseSchema,
  VideoEstimateSchema,
  VideoUnderstandingRequestSchema,
  VideoUnderstandingResponseSchema,
} from '@qiu-creator/contracts';
import type { VideoAiService } from '../ai/video-tasks.js';
import type { App } from '../http/app-type.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  415: ErrorResponseSchema,
};

/**
 * Gemini video understanding of a library video (QC-023), owner token only.
 * Only assets are accepted (managed or in a mounted folder), never paths.
 */
export function registerAiVideoRoutes(app: App, video: VideoAiService): void {
  app.post(
    '/api/v1/assets/:id/ai/video-understanding/estimate',
    {
      schema: {
        description:
          'Check the video against Gemini limits and estimate the cost before sending (from the duration, or from the file size when the duration is unknown). Also says whether an earlier result can be reused for free. Sends nothing.',
        params: AssetIdParamsSchema,
        body: VideoUnderstandingRequestSchema,
        response: { 200: VideoEstimateSchema, ...errorResponses },
      },
    },
    (req) => video.estimate(req.params.id, req.body),
  );

  app.post(
    '/api/v1/assets/:id/ai/video-understanding',
    {
      schema: {
        description:
          'Analyse a video with Gemini (upload through the Files API, wait until processed, structured summary / moments / suggestions). An earlier result for the same file + model settings is returned with `cached: true` (200, nothing sent or charged) unless `reanalyze` is set; an identical running job is returned with `in_progress: true`. Otherwise 202 with the queued job. Progress arrives as `ai_job.progress` events; stop with `POST /api/v1/ai/jobs/:id/cancel`.',
        params: AssetIdParamsSchema,
        body: VideoUnderstandingRequestSchema,
        response: {
          200: VideoUnderstandingResponseSchema,
          202: VideoUnderstandingResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const result = video.analyze(req.params.id, req.body);
      reply.code(result.cached || result.in_progress ? 200 : 202);
      return result;
    },
  );
}
