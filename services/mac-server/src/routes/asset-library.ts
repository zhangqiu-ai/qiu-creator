import {
  AssetIdParamsSchema,
  AssetRecordSchema,
  AssetReferencesSchema,
  BatchAssetsRequestSchema,
  BatchAssetsResponseSchema,
  DeleteAssetRequestSchema,
  DeleteAssetResponseSchema,
  EmptyTrashRequestSchema,
  EmptyTrashResponseSchema,
  ErrorResponseSchema,
  PurgeAssetResponseSchema,
  TrashItemParamsSchema,
  UpdateAssetRequestSchema,
} from '@qiu-creator/contracts';
import type { AssetLibrary } from '../assets/asset-library.js';
import type { App } from '../http/app-type.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

const etag = (revision: number | undefined): string => `"${String(revision ?? 1)}"`;

/** Asset edit, delete, 最近刪除 and batch (QC-037). Owner-only (not listed in the agent scopes). */
export function registerAssetLibraryRoutes(app: App, library: AssetLibrary): void {
  app.patch(
    '/api/v1/assets/:id',
    {
      schema: {
        description:
          'Edit display name, tags, alt text or note (the file on disk keeps its name). Requires `base_revision` or `If-Match`: 428 without, 409 `revision_conflict` when stale. 409 `asset_in_trash` for assets in 最近刪除.',
        params: AssetIdParamsSchema,
        body: UpdateAssetRequestSchema,
        response: { 200: AssetRecordSchema, 428: ErrorResponseSchema, ...errors },
      },
    },
    (req, reply) => {
      const asset = library.update(req.params.id, req.body, req.headers['if-match']);
      reply.header('etag', etag(asset.revision));
      return asset;
    },
  );

  app.delete(
    '/api/v1/assets/:id',
    {
      schema: {
        description:
          'Move to 最近刪除. Managed files stay in place for 30 days; external files are only removed from the library unless `move_original_to_trash` is true (macOS Trash; 500 `trash_failed` leaves everything unchanged). Referenced assets need `confirm: true`, else 409 `asset_in_use` with `details.references`. References are kept and return on restore.',
        params: AssetIdParamsSchema,
        body: DeleteAssetRequestSchema,
        response: { 200: DeleteAssetResponseSchema, 500: ErrorResponseSchema, ...errors },
      },
    },
    (req) => library.trash(req.params.id, req.body),
  );

  app.get(
    '/api/v1/assets/:id/references',
    {
      schema: {
        description:
          'Works (links as cover/body/video) and platform variants (cover or image) that use the asset. Markdown links in a work are not included.',
        params: AssetIdParamsSchema,
        response: { 200: AssetReferencesSchema, ...errors },
      },
    },
    (req) => library.references(req.params.id),
  );

  app.post(
    '/api/v1/assets/:id/restore',
    {
      schema: {
        description:
          'Bring an asset back from 最近刪除 with its references. 409 `asset_file_missing` when its file is not at its path (e.g. the original is still in the macOS Trash). Restoring an active asset changes nothing.',
        params: AssetIdParamsSchema,
        response: { 200: AssetRecordSchema, ...errors },
      },
    },
    (req) => library.restore(req.params.id),
  );

  app.post(
    '/api/v1/assets/batch',
    {
      schema: {
        description:
          'Add or remove tags on, or move to 最近刪除, up to 200 assets. All or nothing: 404 for an unknown id, 409 `asset_in_trash`, or 409 `asset_in_use` (`details.assets`) without `confirm`. External assets are only removed from the library.',
        body: BatchAssetsRequestSchema,
        response: { 200: BatchAssetsResponseSchema, ...errors },
      },
    },
    (req) => ({ items: library.batch(req.body) }),
  );

  app.delete(
    '/api/v1/trash/:id',
    {
      schema: {
        description:
          'Delete one asset in 最近刪除 permanently (404 if it is not there). Managed files are deleted; external originals are never touched. `markdown_referrers` lists works whose Markdown still links to the file.',
        params: TrashItemParamsSchema,
        response: { 200: PurgeAssetResponseSchema, ...errors },
      },
    },
    (req) => library.purge(req.params.id),
  );

  app.delete(
    '/api/v1/trash',
    {
      schema: {
        description:
          'Empty 最近刪除: every asset in it is deleted permanently. Requires `confirm: true`.',
        body: EmptyTrashRequestSchema,
        response: { 200: EmptyTrashResponseSchema, ...errors },
      },
    },
    () => ({ purged: library.emptyTrash() }),
  );
}
