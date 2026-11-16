import {
  CreateMountRequestSchema,
  ErrorResponseSchema,
  ListMountsResponseSchema,
  MountIdParamsSchema,
  MountSchema,
} from '@qiu-creator/contracts';
import type { App } from '../http/app-type.js';
import type { MountService } from '../mounts/mount-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

/**
 * External folder mounts (owner token only, except GET which needs `read`).
 * Mounted Markdown files are indexed in place and never moved or deleted.
 */
export function registerMountRoutes(app: App, mounts: MountService): void {
  app.post(
    '/api/v1/mounts',
    {
      schema: {
        description:
          'Mount an existing folder of Markdown files: index in place (never moved or deleted) and watch for changes. Rejects relative paths, `/`, the home folder itself, folders overlapping the CreatorHub data folder or another mount. Indexing runs as a background job.',
        body: CreateMountRequestSchema,
        response: { 201: MountSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(201);
      return mounts.create(req.body);
    },
  );

  app.get(
    '/api/v1/mounts',
    { schema: { response: { 200: ListMountsResponseSchema, ...errorResponses } } },
    () => ({ items: mounts.list() }),
  );

  app.get(
    '/api/v1/mounts/:id',
    { schema: { params: MountIdParamsSchema, response: { 200: MountSchema, ...errorResponses } } },
    (req) => mounts.get(req.params.id),
  );

  app.post(
    '/api/v1/mounts/:id/rescan',
    {
      schema: {
        description: 'Queue a full rescan (new, changed, missing files).',
        params: MountIdParamsSchema,
        response: { 202: MountSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(202);
      return mounts.rescan(req.params.id);
    },
  );

  app.delete(
    '/api/v1/mounts/:id',
    {
      schema: {
        description:
          'Unmount: stop watching. Files on disk are untouched; the works and their history stay in the library marked `unmounted`. Mounting the same folder again reconnects them.',
        params: MountIdParamsSchema,
        response: { 200: MountSchema, ...errorResponses },
      },
    },
    (req) => mounts.remove(req.params.id),
  );
}
