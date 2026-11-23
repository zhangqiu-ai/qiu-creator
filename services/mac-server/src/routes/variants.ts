import {
  ErrorResponseSchema,
  GenerateVariantsRequestSchema,
  GenerateVariantViewsResponseSchema,
  PatchVariantOverridesRequestSchema,
  RedraftVariantRequestSchema,
  VariantOverrideRevisionListResponseSchema,
  VariantOverrideRevisionSchema,
  VariantParamsSchema,
  VariantRevisionParamsSchema,
  VariantViewListResponseSchema,
  VariantViewSchema,
  WorkIdParamsSchema,
  type Platform,
} from '@qiu-creator/contracts';
import { resolveBaseRevision } from '@qiu-creator/domain';
import { z } from 'zod';
import type { App } from '../http/app-type.js';
import type { VariantService } from '../variants/variant-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};
const writeErrors = { ...errorResponses, 409: ErrorResponseSchema, 428: ErrorResponseSchema };

/** Variant revisions are integers; the ETag is the number in quotes (`"3"`). */
const etag = (revision: number): string => `"${String(revision)}"`;

const DEPRECATED =
  'Deprecated (QC-084): variants are overrides and the body follows the work, so nothing needs generating. Kept for older clients.';

export function registerVariantRoutes(app: App, variants: VariantService): void {
  /** Effective base from body and If-Match, compared as strings against the current revision. */
  const base = (
    workId: string,
    platform: Platform,
    bodyBase: number | undefined,
    ifMatch: string | undefined,
  ): string | null =>
    resolveBaseRevision(
      bodyBase === undefined ? undefined : String(bodyBase),
      ifMatch,
      String(variants.currentRevision(workId, platform)),
    );

  app.get(
    '/api/v1/works/:id/variants',
    {
      schema: {
        description:
          'All four platforms of a work (小紅書, 公眾號, 抖音, 視頻號) as they would publish: overrides applied to the work, the body derived from the work, each field with its `*_source`, over-limit `warnings` (reference limits; never blocking) and the revision.',
        params: WorkIdParamsSchema,
        response: { 200: VariantViewListResponseSchema, ...errorResponses },
      },
    },
    async (req) => ({ items: await variants.list(req.params.id) }),
  );

  app.post(
    '/api/v1/works/:id/variants',
    {
      schema: {
        description: `${DEPRECATED} Gives the given platforms (default: all four) a row with no overrides; platforms that have one are listed in \`skipped\`.`,
        deprecated: true,
        params: WorkIdParamsSchema,
        body: GenerateVariantsRequestSchema,
        response: { 200: GenerateVariantViewsResponseSchema, ...errorResponses },
      },
    },
    (req) => variants.generate(req.params.id, req.body.platforms),
  );

  app.get(
    '/api/v1/works/:id/variants/:platform',
    {
      schema: {
        description:
          'One platform resolved (QC-084): title, cover, images and tags with `*_source` (`work` or `override`), the body derived from the saved work (`body_source` `legacy_override` for a body edited before QC-084), `warnings` (`body_too_long` with `cut_at` and `source_offset`) and `revision` (0 before the first override; also the ETag).',
        params: VariantParamsSchema,
        response: { 200: VariantViewSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const v = await variants.get(req.params.id, req.params.platform);
      reply.header('etag', etag(v.revision));
      return v;
    },
  );

  app.patch(
    '/api/v1/works/:id/variants/:platform',
    {
      schema: {
        description:
          'Change overrides of one platform: `title`, `cover`, `images` (shown ids in order), `tags`, each a value or null to follow the work again. Requires `base_revision` or `If-Match: "<revision>"` (0 before the first override); a stale base returns 409 with `details.current_revision` and nothing is written. `body` only takes null (drops a legacy body override); a string returns 400 `body_not_editable`. A patch that changes nothing keeps the revision. Other platforms are never touched.',
        params: VariantParamsSchema,
        body: PatchVariantOverridesRequestSchema,
        response: { 200: VariantViewSchema, ...writeErrors },
      },
    },
    async (req, reply) => {
      const { id, platform } = req.params;
      const { base_revision: bodyBase, ...change } = req.body;
      const v = await variants.patch(
        id,
        platform,
        base(id, platform, bodyBase, req.headers['if-match']),
        change,
      );
      reply.header('etag', etag(v.revision));
      return v;
    },
  );

  app.post(
    '/api/v1/works/:id/variants/:platform/draft',
    {
      schema: {
        description: `${DEPRECATED} Follow the work again in every field. Creates a row (201) when there is none; otherwise requires \`base_revision\` or \`If-Match\` (200).`,
        deprecated: true,
        params: VariantParamsSchema,
        body: RedraftVariantRequestSchema,
        response: { 200: VariantViewSchema, 201: VariantViewSchema, ...writeErrors },
      },
    },
    async (req, reply) => {
      const { id, platform } = req.params;
      const result = await variants.redraft(
        id,
        platform,
        base(id, platform, req.body.base_revision, req.headers['if-match']),
      );
      reply.code(result.created ? 201 : 200).header('etag', etag(result.variant.revision));
      return result.variant;
    },
  );

  app.delete(
    '/api/v1/works/:id/variants/:platform',
    {
      schema: {
        description:
          'Drop every override of one platform (the work is untouched). Requires `If-Match: "<revision>"`. The row becomes a tombstone that takes the next revision and keeps the history, so revisions never repeat and pre-delete revisions get 409.',
        params: VariantParamsSchema,
        response: { 204: z.null(), ...writeErrors },
      },
    },
    async (req, reply) => {
      const { id, platform } = req.params;
      await variants.delete(id, platform, base(id, platform, undefined, req.headers['if-match']));
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/api/v1/works/:id/variants/:platform/revisions',
    {
      schema: {
        description:
          'Override history of one platform, newest first. Revisions from before QC-084 carry their full content in `legacy`.',
        params: VariantParamsSchema,
        response: { 200: VariantOverrideRevisionListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: variants.revisions(req.params.id, req.params.platform) }),
  );

  app.get(
    '/api/v1/works/:id/variants/:platform/revisions/:revision',
    {
      schema: {
        params: VariantRevisionParamsSchema,
        response: { 200: VariantOverrideRevisionSchema, ...errorResponses },
      },
    },
    (req) => variants.revision(req.params.id, req.params.platform, req.params.revision),
  );
}
