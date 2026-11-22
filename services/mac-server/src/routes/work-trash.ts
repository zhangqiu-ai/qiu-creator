import {
  BatchWorksRequestSchema,
  BatchWorksResponseSchema,
  DeleteWorkRequestSchema,
  DeleteWorkResponseSchema,
  EmptyWorkTrashRequestSchema,
  EmptyWorkTrashResponseSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  PurgedWorkSchema,
  RestoreWorkRequestSchema,
  WorkDetailSchema,
  WorkIdParamsSchema,
} from '@qiu-creator/contracts';
import { resolveBaseRevision, revisionEtag } from '@qiu-creator/domain';
import { requirePrincipal } from '../auth/token-service.js';
import { ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';
import type { WorkService } from '../works/work-service.js';
import type { WorkTrash } from '../works/work-trash.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

/**
 * Work delete, 最近刪除 and batch edits (QC-051). Delete, restore and batch
 * need `write`; permanent deletion and moving a file to the macOS Trash are
 * the owner's alone.
 */
export function registerWorkTrashRoutes(
  app: App,
  trash: WorkTrash,
  works: WorkService,
  idempotency: IdempotencyService,
): void {
  /** Body `base_revision`, else `If-Match`; null when neither was sent (428). */
  const base = (id: string, body: string | undefined, ifMatch: string | undefined) =>
    resolveBaseRevision(body, ifMatch, works.get(id).current_revision_id);

  app.delete(
    '/api/v1/works/:id',
    {
      schema: {
        description:
          'Move to 最近刪除 for 30 days; the revision and history do not change. Requires `base_revision` or `If-Match` (428 without, 409 `revision_conflict` when stale). Managed works stay in CreatorHub; external works are only removed from the library unless `move_original_to_trash` (owner only) moves the file to the macOS Trash (500 `trash_failed` changes nothing). 409 `work_in_trash` when already deleted.',
        params: WorkIdParamsSchema,
        body: DeleteWorkRequestSchema.optional(),
        response: {
          200: DeleteWorkResponseSchema,
          428: ErrorResponseSchema,
          500: ErrorResponseSchema,
          ...errors,
        },
      },
    },
    async (req) => {
      const body = req.body ?? {};
      if (
        body.move_original_to_trash === true &&
        requirePrincipal(req.principal).kind !== 'owner'
      ) {
        throw new ServiceError(
          403,
          'forbidden',
          'only the owner token can move a file to the macOS Trash',
        );
      }
      return trash.trash(
        req.params.id,
        base(req.params.id, body.base_revision, req.headers['if-match']),
        body,
      );
    },
  );

  app.post(
    '/api/v1/works/:id/restore',
    {
      schema: {
        description:
          'Bring a work back from 最近刪除 with the same revision, history, links and platform variants. Requires `base_revision` or `If-Match`. 409 `source_missing` while an external file moved to the Trash has not been put back. Restoring an active work changes nothing.',
        params: WorkIdParamsSchema,
        body: RestoreWorkRequestSchema.optional(),
        response: { 200: WorkDetailSchema, 428: ErrorResponseSchema, ...errors },
      },
    },
    (req, reply) => {
      const work = trash.restore(
        req.params.id,
        base(req.params.id, req.body?.base_revision, req.headers['if-match']),
      );
      reply.header('etag', revisionEtag(work.current_revision_id));
      return work;
    },
  );

  app.post(
    '/api/v1/works/batch',
    {
      schema: {
        description:
          'Delete, restore, set the status of, or add or remove tags on up to 200 works. Each item carries its `base_revision`. Items are handled in order and each succeeds or fails on its own (`results[].error`: `not_found`, `revision_conflict`, `work_in_trash`, …); the response is 200 either way. Status and tag changes are new revisions, like PATCH. Deleting only unindexes external works. Send an `Idempotency-Key` header (required for agent tokens): the same key replays the first response with `Idempotent-Replayed: true`.',
        body: BatchWorksRequestSchema,
        response: {
          200: BatchWorksResponseSchema,
          422: ErrorResponseSchema,
          428: ErrorResponseSchema,
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const result = await idempotency.runAsync(
        requirePrincipal(req.principal),
        'POST /api/v1/works/batch',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        req.body,
        async () => ({ statusCode: 200, body: await trash.batch(req.body) }),
      );
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return BatchWorksResponseSchema.parse(result.body);
    },
  );

  app.delete(
    '/api/v1/trash/works/:id',
    {
      schema: {
        description:
          'Delete one work in 最近刪除 permanently: its record, history and platform variants, and for managed works its folder (library assets stored there move to the asset library first). External files are never touched and are not indexed again. 404 if it is not in 最近刪除.',
        params: WorkIdParamsSchema,
        response: { 200: PurgedWorkSchema, ...errors },
      },
    },
    (req) => trash.purge(req.params.id),
  );

  app.delete(
    '/api/v1/trash/works',
    {
      schema: {
        description:
          'Empty the works in 最近刪除 (assets are emptied by `DELETE /api/v1/trash`). Requires `confirm: true`.',
        body: EmptyWorkTrashRequestSchema,
        response: { 200: EmptyWorkTrashResponseSchema, ...errors },
      },
    },
    () => ({ purged: trash.emptyTrash() }),
  );
}
