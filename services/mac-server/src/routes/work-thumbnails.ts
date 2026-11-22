import fs from 'node:fs';
import {
  ErrorResponseSchema,
  ThumbnailFrameQuerySchema,
  ThumbnailFrameResponseSchema,
  WorkIdParamsSchema,
  WorkThumbnailQuerySchema,
} from '@qiu-creator/contracts';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';
import { THUMBNAIL_MIME } from '../media/thumbnails.js';
import type { WorkService } from '../works/work-service.js';

const FRAME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/**
 * Library card images (QC-061). GET needs `read`; uploading a frame is the
 * owner's (the Mac app), like other cache-only writes.
 */
export async function registerWorkThumbnailRoutes(app: App, works: WorkService): Promise<void> {
  app.get(
    '/api/v1/works/:id/thumbnail',
    {
      schema: {
        description:
          'Card image of a work as WebP (longest edge 512), from its image cover, first image, video frame, or for articles the front-matter cover or first local Markdown image (QC-061). `ETag` is the card `version`; with `v` equal to it the answer is cacheable for a year. 404 `thumbnail_unavailable` with `details.reason` none/missing/needs_frame/decode_failed.',
        params: WorkIdParamsSchema,
        querystring: WorkThumbnailQuerySchema,
      },
    },
    async (req, reply) => {
      const { file, version } = await works.cardImageFile(req.params.id);
      const etag = `"${version}"`;
      reply
        .header('etag', etag)
        .header(
          'cache-control',
          req.query.v === version ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        );
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type(THUMBNAIL_MIME).send(fs.readFileSync(file));
    },
  );

  // Raw image bodies only for the frame upload.
  await app.register((scope, _opts, done) => {
    scope.addContentTypeParser(FRAME_TYPES, { parseAs: 'buffer' }, (_req, body, next) => {
      next(null, body);
    });
    scope.addContentTypeParser('*', (_req, _payload, next) => {
      next(
        new ServiceError(
          415,
          'unsupported_media_type',
          `send the frame as ${FRAME_TYPES.join(', ')}`,
        ),
      );
    });
    scope.withTypeProvider<ZodTypeProvider>().put(
      '/api/v1/works/:id/thumbnail-frame',
      {
        schema: {
          description:
            'Upload the frame the app captured for a video card with `needs_frame` (QC-061): raw JPEG, PNG or WebP up to 2 MiB, for `source` and `time_seconds` from `card_image.frame_source`. Stored as WebP in the rebuildable cache; the video is never touched. 409 `thumbnail_frame_stale` when the work no longer uses that frame; 413; 415.',
          params: WorkIdParamsSchema,
          querystring: ThumbnailFrameQuerySchema,
          response: {
            200: ThumbnailFrameResponseSchema,
            409: ErrorResponseSchema,
            413: ErrorResponseSchema,
            415: ErrorResponseSchema,
            ...errors,
          },
        },
      },
      async (req) => {
        const body: unknown = req.body;
        if (!Buffer.isBuffer(body)) {
          throw new ServiceError(415, 'unsupported_media_type', 'the frame body is missing');
        }
        const cardImage = await works.putCardFrame(req.params.id, {
          version: req.query.version,
          source: req.query.source,
          timeSeconds: req.query.time_seconds,
          bytes: body,
        });
        return { card_image: cardImage };
      },
    );
    done();
  });
}
