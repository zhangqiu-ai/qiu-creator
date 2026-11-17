import {
  ErrorResponseSchema,
  GenerateVariantsRequestSchema,
  GenerateVariantsResponseSchema,
  PatchVariantRequestSchema,
  PlatformVariantRecordSchema,
  RedraftVariantRequestSchema,
  VariantListResponseSchema,
  VariantParamsSchema,
  VariantRevisionListResponseSchema,
  VariantRevisionParamsSchema,
  VariantRevisionSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { resolveBaseRevision } from '@qiu-creator/domain';
import { z } from 'zod';
import { requirePrincipal } from '../auth/token-service.js';
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

export function registerVariantRoutes(app: App, variants: VariantService): void {
  /** Effective base from body and If-Match, compared as strings against the current revision. */
  const base = (
    workId: string,
    platform: Parameters<VariantService['get']>[1],
    bodyBase: number | undefined,
    ifMatch: string | undefined,
  ): string | null => {
    const current = variants.get(workId, platform).revision;
    return resolveBaseRevision(
      bodyBase === undefined ? undefined : String(bodyBase),
      ifMatch,
      String(current),
    );
  };

  app.get(
    '/api/v1/works/:id/variants',
    {
      schema: {
        description:
          'Platform variants of a work (小紅書, 公眾號, 抖音, 視頻號), each with its own revision and over-limit `warnings` (reference limits; never blocking).',
        params: WorkIdParamsSchema,
        response: { 200: VariantListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: variants.list(req.params.id) }),
  );

  app.post(
    '/api/v1/works/:id/variants',
    {
      schema: {
        description:
          "Generate drafts from the work's current original by fixed rules (no AI) for the given platforms (default: all four). Platforms that already have a variant are left untouched and listed in `skipped`.",
        params: WorkIdParamsSchema,
        body: GenerateVariantsRequestSchema,
        response: { 200: GenerateVariantsResponseSchema, ...errorResponses },
      },
    },
    (req) =>
      variants.generate(req.params.id, req.body.platforms, requirePrincipal(req.principal).id),
  );

  app.get(
    '/api/v1/works/:id/variants/:platform',
    {
      schema: {
        params: VariantParamsSchema,
        response: { 200: PlatformVariantRecordSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      const v = variants.get(req.params.id, req.params.platform);
      reply.header('etag', etag(v.revision));
      return v;
    },
  );

  app.patch(
    '/api/v1/works/:id/variants/:platform',
    {
      schema: {
        description:
          'Edit one platform variant. Requires `base_revision` (integer) or `If-Match: "<revision>"`; a stale base returns 409 with `details.current_revision` and nothing is written. Other platforms are never touched. Over-limit content is saved and reported in `warnings`.',
        params: VariantParamsSchema,
        body: PatchVariantRequestSchema,
        response: { 200: PlatformVariantRecordSchema, ...writeErrors },
      },
    },
    (req, reply) => {
      const { id, platform } = req.params;
      const { base_revision: bodyBase, ...change } = req.body;
      const v = variants.patch(
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
        description:
          'Regenerate one platform variant from the current original by fixed rules (no AI). Creates it (201) when missing; otherwise requires `base_revision` or `If-Match` and appends a `draft` revision (200), keeping the history.',
        params: VariantParamsSchema,
        body: RedraftVariantRequestSchema,
        response: {
          200: PlatformVariantRecordSchema,
          201: PlatformVariantRecordSchema,
          ...writeErrors,
        },
      },
    },
    async (req, reply) => {
      const { id, platform } = req.params;
      const exists = variants.list(id).some((v) => v.platform === platform);
      const effective = exists
        ? base(id, platform, req.body.base_revision, req.headers['if-match'])
        : null;
      const result = await variants.redraft(
        id,
        platform,
        effective,
        requirePrincipal(req.principal).id,
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
          'Delete one platform variant and its history (the original is untouched). Requires `If-Match: "<revision>"`.',
        params: VariantParamsSchema,
        response: { 204: z.null(), ...writeErrors },
      },
    },
    (req, reply) => {
      const { id, platform } = req.params;
      variants.delete(id, platform, base(id, platform, undefined, req.headers['if-match']));
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/api/v1/works/:id/variants/:platform/revisions',
    {
      schema: {
        description: 'History of one platform variant, newest first, with full content.',
        params: VariantParamsSchema,
        response: { 200: VariantRevisionListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: variants.revisions(req.params.id, req.params.platform) }),
  );

  app.get(
    '/api/v1/works/:id/variants/:platform/revisions/:revision',
    {
      schema: {
        params: VariantRevisionParamsSchema,
        response: { 200: VariantRevisionSchema, ...errorResponses },
      },
    },
    (req) => variants.revision(req.params.id, req.params.platform, req.params.revision),
  );
}
