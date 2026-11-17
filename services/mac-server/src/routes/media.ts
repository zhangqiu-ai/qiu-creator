import fs from 'node:fs';
import {
  ErrorResponseSchema,
  IdSchema,
  SignedAssetUrlsRequestSchema,
  SignedAssetUrlsResponseSchema,
  SIGNED_MEDIA_PREFIX,
  WorkIdParamsSchema,
  WorkMediaResponseSchema,
} from '@qiu-creator/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AssetService } from '../assets/asset-service.js';
import { requirePrincipal, type TokenService } from '../auth/token-service.js';
import { ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';
import { sendRanged } from '../http/ranged.js';
import { THUMBNAIL_MIME } from '../media/thumbnails.js';
import type { MediaUrlSigner, SignedQuery } from '../media/url-signer.js';
import { assetMediaPath, workFilePath, type WorkMediaService } from '../media/work-media.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

const WorkFileParamsSchema = z.object({ id: IdSchema, '*': z.string().min(1).max(4096) });
const SignedQuerySchema = z.object({
  exp: z.string().max(16).optional(),
  p: z.string().max(64).optional(),
  sig: z.string().max(128).optional(),
});
const AssetVariantParamsSchema = z.object({
  id: IdSchema,
  variant: z.enum(['stream', 'thumbnail']),
});

/** Headers for media opened through a signed URL: no caching past expiry, no sniffing, no referrer. */
function signedHeaders(reply: FastifyReply, secondsLeft: number): void {
  reply
    .header('cache-control', `private, max-age=${String(Math.min(secondsLeft, 300))}`)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('content-security-policy', "default-src 'none'; sandbox");
}

export function registerMediaRoutes(
  app: App,
  media: WorkMediaService,
  assets: AssetService,
  signer: MediaUrlSigner,
  tokens: TokenService,
): void {
  /** Verify a signed request and that the principal that asked for it may still read. */
  const verify = (pathname: string, query: SignedQuery): number => {
    const { principalId, secondsLeft } = signer.verify(pathname, query);
    if (tokens.readerById(principalId) === null) {
      throw new ServiceError(403, 'forbidden', 'media link is invalid or expired');
    }
    return secondsLeft;
  };

  app.get(
    '/api/v1/works/:id/media',
    {
      schema: {
        description:
          "List the image/video/audio references in the work's current Markdown and resolve each one: managed works serve `assets/…` inside the work folder; external works resolve relative to the note and may point anywhere inside the mount, never outside it, and never through a symlink. Referenced external files are registered as assets in place (never moved) and linked to the work. Each resolved item carries a short-lived signed `url` that works without an Authorization header.",
        params: WorkIdParamsSchema,
        response: { 200: WorkMediaResponseSchema, ...errorResponses },
      },
    },
    (req) => media.resolve(req.params.id, requirePrincipal(req.principal).id),
  );

  app.get(
    '/api/v1/works/:id/files/*',
    {
      schema: {
        description:
          'Stream one media file of a work (path relative to the work folder, or to the mount root for external works) with Range support. Bearer-authenticated twin of the signed `/media/v1/works/:id/files/*`.',
        params: WorkFileParamsSchema,
      },
    },
    async (req, reply) => {
      const target = await media.openWorkFile(req.params.id, req.params['*']);
      reply.header('x-content-type-options', 'nosniff');
      return sendRanged(req, reply, target);
    },
  );

  app.post(
    '/api/v1/media/signed-urls',
    {
      schema: {
        description:
          'Short-lived signed URLs for asset files or thumbnails, for `<img>`/`<video>` elements that cannot send an Authorization header.',
        body: SignedAssetUrlsRequestSchema,
        response: { 200: SignedAssetUrlsResponseSchema, ...errorResponses },
      },
    },
    (req) => {
      const principal = requirePrincipal(req.principal);
      const expiresAt = signer.expiry();
      const items = req.body.asset_ids.map((assetId) => {
        assets.get(assetId); // 404 for unknown assets
        return {
          asset_id: assetId,
          url: signer.sign(assetMediaPath(assetId, req.body.variant), principal.id, expiresAt).url,
        };
      });
      return { items, expires_at: expiresAt.toISOString() };
    },
  );

  // ---- Signed routes: no bearer token; the signature is the credential. ----

  app.get(
    `${SIGNED_MEDIA_PREFIX}/works/:id/files/*`,
    {
      schema: {
        description:
          'Signed media file of a work (from `GET /api/v1/works/:id/media`). Needs `exp`, `p` and `sig` from the signed URL; supports Range.',
        security: [],
        params: WorkFileParamsSchema,
        querystring: SignedQuerySchema,
      },
    },
    async (req, reply) => {
      const secondsLeft = verify(workFilePath(req.params.id, req.params['*']), req.query);
      const target = await media.openWorkFile(req.params.id, req.params['*']);
      signedHeaders(reply, secondsLeft);
      return sendRanged(req, reply, target);
    },
  );

  app.get(
    `${SIGNED_MEDIA_PREFIX}/assets/:id/:variant`,
    {
      schema: {
        description:
          'Signed asset file (`stream`, with Range) or thumbnail (from `POST /api/v1/media/signed-urls`).',
        security: [],
        params: AssetVariantParamsSchema,
        querystring: SignedQuerySchema,
      },
    },
    async (req, reply) => {
      const { id, variant } = req.params;
      const secondsLeft = verify(assetMediaPath(id, variant), req.query);
      signedHeaders(reply, secondsLeft);
      if (variant === 'stream') return sendRanged(req, reply, assets.streamTarget(id));
      const body = fs.readFileSync(await assets.thumbnailFile(id));
      return reply
        .header('content-type', THUMBNAIL_MIME)
        .header('content-length', body.length)
        .send(body);
    },
  );
}
