import { z } from 'zod';
import { ErrorCodeSchema, WorkListItemSchema } from './api.js';
import { ASSET_TRASH_RETENTION_DAYS } from './assets.js';
import { IdSchema, TagSchema, WorkSchema, WorkStatusSchema } from './entities.js';
import { ScriptConversionSchema } from './text-script.js';

/**
 * Works in 回收站 (QC-051), like assets (QC-037):
 * - `trashed`: a managed work; its folder stays in CreatorHub until it is purged.
 * - `unindexed`: an external (mounted) work removed from the library only; the
 *   file is untouched.
 * - `original_trashed`: an external work whose file was moved to the macOS
 *   Trash on request. Put it back in Finder before restoring.
 */
export const WorkRemovalSchema = WorkSchema.shape.removal.unwrap().unwrap();
export type WorkRemoval = z.infer<typeof WorkRemovalSchema>;

/** Days a work stays in 回收站 before it is deleted permanently. */
export const WORK_TRASH_RETENTION_DAYS = ASSET_TRASH_RETENTION_DAYS;

/**
 * `DELETE /api/v1/works/:id`: move to 回收站. `base_revision` (or `If-Match`)
 * is required. The revision does not change, and restoring keeps it.
 */
export const DeleteWorkRequestSchema = z.object({
  base_revision: IdSchema.optional(),
  /**
   * External works only, owner token only: also move the file to the macOS
   * Trash. Without it the file is never touched.
   */
  move_original_to_trash: z.boolean().optional(),
});
export type DeleteWorkRequest = z.input<typeof DeleteWorkRequestSchema>;

export const DeleteWorkResponseSchema = z.object({ work: WorkListItemSchema });
export type DeleteWorkResponse = z.infer<typeof DeleteWorkResponseSchema>;

/** `POST /api/v1/works/:id/restore`: back from 回收站 (`base_revision` or `If-Match`). */
export const RestoreWorkRequestSchema = z.object({ base_revision: IdSchema.optional() });
export type RestoreWorkRequest = z.input<typeof RestoreWorkRequestSchema>;

export const PurgedWorkSchema = z.object({ id: IdSchema, removal: WorkRemovalSchema });
export type PurgedWork = z.infer<typeof PurgedWorkSchema>;

export const EmptyWorkTrashRequestSchema = z.object({ confirm: z.literal(true) });
export type EmptyWorkTrashRequest = z.input<typeof EmptyWorkTrashRequestSchema>;

export const EmptyWorkTrashResponseSchema = z.object({ purged: z.array(PurgedWorkSchema) });
export type EmptyWorkTrashResponse = z.infer<typeof EmptyWorkTrashResponseSchema>;

/** Most works one `POST /api/v1/works/batch` takes. */
export const WORKS_BATCH_MAX = 200;

export const BatchWorkItemSchema = z.object({
  id: IdSchema,
  /** The revision the client saw; a stale one fails that item with `revision_conflict`. */
  base_revision: IdSchema,
});
export type BatchWorkItem = z.infer<typeof BatchWorkItemSchema>;

const BatchItemsSchema = z
  .array(BatchWorkItemSchema)
  .min(1)
  .max(WORKS_BATCH_MAX)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'ids must not repeat');

const BatchTagsSchema = z.array(TagSchema).min(1).max(64);

/**
 * `POST /api/v1/works/batch` (QC-051). Send an `Idempotency-Key` header
 * (required for agent tokens). Items are handled one by one in order; one
 * failing does not undo the others. Deleting in a batch only unindexes
 * external works (their files are never touched).
 */
export const BatchWorksRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('trash'), items: BatchItemsSchema }),
  z.object({ action: z.literal('restore'), items: BatchItemsSchema }),
  z.object({ action: z.literal('set_status'), status: WorkStatusSchema, items: BatchItemsSchema }),
  z.object({ action: z.literal('add_tags'), tags: BatchTagsSchema, items: BatchItemsSchema }),
  z.object({ action: z.literal('remove_tags'), tags: BatchTagsSchema, items: BatchItemsSchema }),
]);
export type BatchWorksRequest = z.input<typeof BatchWorksRequestSchema>;
export type BatchWorksAction = BatchWorksRequest['action'];

export const BatchWorkResultSchema = z.discriminatedUnion('ok', [
  /** Status and tag changes are new revisions, like PATCH; take `current_revision_id` from `work`. */
  z.object({
    id: IdSchema,
    ok: z.literal(true),
    work: WorkListItemSchema,
    /** `add_tags` by an agent token whose tags were converted to the work's script (QC-103). */
    script_conversion: ScriptConversionSchema.optional(),
  }),
  z.object({
    id: IdSchema,
    ok: z.literal(false),
    /** Same shape as an error response body's `error`: `not_found`, `revision_conflict`, `work_in_trash`, … */
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
export type BatchWorkResult = z.infer<typeof BatchWorkResultSchema>;

export const BatchWorksResponseSchema = z.object({
  /** One per item, in request order. */
  results: z.array(BatchWorkResultSchema),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BatchWorksResponse = z.infer<typeof BatchWorksResponseSchema>;
