import {
  CreateTokenRequestSchema,
  CreateTokenResponseSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  ImportJobRecordSchema,
  ImportUrlRequestSchema,
  JobIdParamsSchema,
  ListJobsQuerySchema,
  ListJobsResponseSchema,
  ListTokensResponseSchema,
  ApiTokenSchema,
  ListTokenActivityQuerySchema,
  ListTokenActivityResponseSchema,
  TokenIdParamsSchema,
  UpdateTokenRequestSchema,
} from '@qiu-creator/contracts';
import type { ActivityService } from '../auth/activity-service.js';
import { requirePrincipal, type TokenService } from '../auth/token-service.js';
import { notFound } from '../errors.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';
import type { ImportService } from '../imports/import-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

export function registerImportRoutes(
  app: App,
  imports: ImportService,
  idempotency: IdempotencyService,
): void {
  app.post(
    '/api/v1/imports/urls',
    {
      schema: {
        description:
          'Queue a download of `url` into the asset library and return the import job (202). Only public http(s) addresses are fetched; every redirect is re-checked. Send an `Idempotency-Key` header (required for agent tokens): a repeated key returns the original job instead of downloading again.',
        body: ImportUrlRequestSchema,
        response: {
          202: ImportJobRecordSchema,
          422: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const principal = requirePrincipal(req.principal);
      const rawKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      const key = typeof rawKey === 'string' && rawKey.trim() !== '' ? rawKey.trim() : undefined;
      const result = idempotency.run(
        principal,
        'POST /api/v1/imports/urls',
        rawKey,
        req.body,
        () => ({
          statusCode: 202,
          body: imports.createUrlImport(principal, req.body, key),
        }),
      );
      reply.code(result.statusCode);
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      // A replay returns the job's current state, not the stale snapshot.
      return imports.get(ImportJobRecordSchema.parse(result.body).id);
    },
  );

  app.get(
    '/api/v1/jobs',
    {
      schema: {
        description: 'Import jobs, newest first.',
        querystring: ListJobsQuerySchema,
        response: { 200: ListJobsResponseSchema, ...errorResponses },
      },
    },
    (req) => {
      const principal = requirePrincipal(req.principal);
      const page = imports.list(req.query);
      // QC-089: a token limited to projects sees only the jobs it started.
      if (principal.kind !== 'agent' || principal.projectIds === null) return page;
      const items = page.items.filter((j) => j.created_by === principal.id);
      return { ...page, items, total: items.length };
    },
  );

  app.get(
    '/api/v1/jobs/:id',
    {
      schema: {
        params: JobIdParamsSchema,
        response: { 200: ImportJobRecordSchema, ...errorResponses },
      },
    },
    (req) => {
      const job = imports.get(req.params.id);
      const principal = requirePrincipal(req.principal);
      // Import-only agents may follow their own jobs; others' jobs look absent.
      // So do tokens limited to projects (QC-089).
      const ownOnly =
        !principal.scopes.includes('read') ||
        (principal.kind === 'agent' && principal.projectIds !== null);
      if (ownOnly && job.created_by !== principal.id) throw notFound('job');
      return job;
    },
  );

  app.post(
    '/api/v1/jobs/:id/retry',
    {
      schema: {
        description: 'Re-queue a failed import job (409 for jobs that are not failed).',
        params: JobIdParamsSchema,
        response: { 202: ImportJobRecordSchema, 409: ErrorResponseSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(202);
      return imports.retry(req.params.id);
    },
  );
}

export function registerTokenRoutes(
  app: App,
  tokens: TokenService,
  activity: ActivityService,
): void {
  app.post(
    '/api/v1/tokens',
    {
      schema: {
        description:
          'Create a revocable agent token (owner token only). The secret is returned once; only its hash is stored.',
        body: CreateTokenRequestSchema,
        response: { 201: CreateTokenResponseSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(201);
      return tokens.create(req.body);
    },
  );

  app.get(
    '/api/v1/tokens',
    { schema: { response: { 200: ListTokensResponseSchema, ...errorResponses } } },
    () => ({ items: tokens.list() }),
  );

  app.delete(
    '/api/v1/tokens/:id',
    {
      schema: {
        description: 'Revoke an agent token; it stops working immediately.',
        params: TokenIdParamsSchema,
        response: { 200: ApiTokenSchema, ...errorResponses },
      },
    },
    (req) => tokens.revoke(req.params.id),
  );

  app.patch(
    '/api/v1/tokens/:id',
    {
      schema: {
        description:
          'Change an agent token (owner token only, QC-089): name, scopes, `allow_direct_body_edit` (let it change works’ text directly; default off) and `project_ids` (limit it to these projects; null for all). Every change is written to the token’s activity.',
        params: TokenIdParamsSchema,
        body: UpdateTokenRequestSchema,
        response: { 200: ApiTokenSchema, ...errorResponses },
      },
    },
    (req) => tokens.update(req.params.id, req.body),
  );

  app.get(
    '/api/v1/tokens/:id/activity',
    {
      schema: {
        description:
          'What an agent token did, newest first (owner token only, QC-089): its changes and every refused request (with the error code), plus the owner’s changes to the token. Page with `before`.',
        params: TokenIdParamsSchema,
        querystring: ListTokenActivityQuerySchema,
        response: { 200: ListTokenActivityResponseSchema, ...errorResponses },
      },
    },
    (req) => {
      tokens.get(req.params.id);
      return activity.list(req.params.id, req.query);
    },
  );
}
