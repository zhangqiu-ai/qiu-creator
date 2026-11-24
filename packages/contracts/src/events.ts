import { z } from 'zod';
import { TimestampSchema } from './entities.js';

/** `system`: service-wide events (backups, QC-030); `entity_id` is `database`. */
export const ChangeEntitySchema = z.enum(['work', 'asset', 'job', 'system', 'project']);
export type ChangeEntity = z.infer<typeof ChangeEntitySchema>;

/**
 * Change actions published on `GET /api/v1/events` (SSE event name) and
 * stored in the change log. New actions may be added; clients should ignore
 * ones they do not know.
 */
export const ChangeActionSchema = z.enum([
  'work.created',
  /** Content or metadata changed; `data.revision_id`, `data.source` (`edit`/`restore`), `data.fields`. */
  'work.updated',
  /** `source.md` was edited outside the app and recorded as an `external` revision. */
  'work.external_revision',
  'work.assets_changed',
  /** An external work's file disappeared (deleted, moved out, or the mount became unavailable). */
  'work.source_missing',
  /** An external work's file reappeared or was found at a new path (rename/move). */
  'work.source_restored',
  /** A platform variant was created; `data.platform`, `data.revision`, `data.source`. */
  'work.variant_created',
  /** A platform variant got a new revision (edit or redraft); same data as above. */
  'work.variant_updated',
  /** A platform variant (and its history) was deleted; `data.platform`. */
  'work.variant_deleted',
  /**
   * A platform's overrides changed (QC-084); `data.platform`, `data.revision`,
   * `data.fields` (changed field names). Not sent for body changes: previews
   * re-derive on `work.updated`.
   */
  'work.variant_changed',
  /** Moved to 回收站 or removed from the library (QC-051); `data.removal`. */
  'work.trashed',
  /** Back from 回收站; revision and history unchanged (QC-051). */
  'work.restored',
  /** The work joined or left projects (QC-062); `data.added`, `data.removed` (project ids). */
  'work.projects_changed',
  /** Project events (entity `project`, QC-062). `data.fields` for updates. */
  'project.created',
  'project.updated',
  /** Soft-deleted (restorable for 30 days), or `data.purged: true` when removed for good. */
  'project.deleted',
  'project.restored',
  /** `PUT /projects/order`; entity id is `order`. */
  'project.reordered',
  /** Deleted permanently, by hand or after 30 days (QC-051); `data.removal`, `data.reason` (`manual`/`empty`/`expired`). */
  'work.deleted',
  'asset.created',
  /** Metadata or file details changed; `data.fields` for edits (QC-037). */
  'asset.updated',
  /** Moved to 回收站 or removed from the library (QC-037); `data.removal`. */
  'asset.trashed',
  /** Back from 回收站 with its references (QC-037). */
  'asset.restored',
  /** Deleted permanently, by hand or after 30 days (QC-037); `data.removal`, `data.reason` (`manual`/`empty`/`expired`). */
  'asset.deleted',
  /** AI jobs (entity `job`); `data.status`, `data.provider`. No content or keys. */
  'ai_job.queued',
  'ai_job.running',
  'ai_job.succeeded',
  'ai_job.failed',
  'ai_job.cancelled',
  /** Progress of a multi-step AI job; `data.phase`, `data.uploaded_bytes`, `data.total_bytes` (QC-023). */
  'ai_job.progress',
  /**
   * The prompt library changed (QC-075; entity `system`, id `prompts`):
   * `data.action` is created, updated, deleted, reordered or imported, `data.ids`.
   */
  'prompts.changed',
  /** Output language or remembered models changed (QC-075; entity `system`, id `ai_preferences`). */
  'ai_preferences.changed',
  /** A backup was made (entity `system`); `data.backup_id`, `data.kind`. */
  'backup.created',
  /** An automatic backup failed; `data.kind`, `data.error`. */
  'backup.failed',
  /**
   * A restore is about to replace the database (`data.backup_id`,
   * `data.safety_backup_id`). The service reloads next: expect the stream to drop.
   */
  'backup.restore_started',
  /**
   * The service now runs on the restored database. Same data as above. Every
   * cached work, asset, job and setting may be different: refetch everything.
   * Sequence numbers continue after the ones seen before the restore.
   */
  'backup.restored',
  'job.queued',
  'job.running',
  'job.succeeded',
  'job.failed',
]);
export type ChangeAction = z.infer<typeof ChangeActionSchema>;

export const ChangeEventSchema = z.object({
  /** Monotonic sequence; also the SSE `id`, so `Last-Event-ID` resumes after it. */
  seq: z.number().int().positive(),
  entity: ChangeEntitySchema,
  entity_id: z.string(),
  action: ChangeActionSchema,
  /** Small hints (e.g. `revision_id`, `kind`, `status`); clients refetch the entity for details. */
  data: z.record(z.string(), z.unknown()),
  created_at: TimestampSchema,
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

export const EVENTS_PATH = '/api/v1/events';

// ---- Change list (QC-087) -------------------------------------------------------

/** Most change events one `GET /api/v1/changes` returns. */
export const CHANGES_PAGE_MAX = 500;

/**
 * `GET /api/v1/changes`: the same change log as the SSE stream, as a bounded
 * JSON page for clients that poll (MCP `changes_since`). Without `since` it
 * starts from the beginning of the log.
 */
export const ListChangesQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(CHANGES_PAGE_MAX).default(100),
});
export interface ListChangesQuery {
  since?: number;
  limit?: number;
}

export const ListChangesResponseSchema = z.object({
  items: z.array(ChangeEventSchema),
  /** Pass as `since` for the next page; equals `since` when there was nothing new. */
  next_since: z.number().int().nonnegative(),
  /** More events after this page. */
  has_more: z.boolean(),
  /** Newest seq in the log right now. */
  latest_seq: z.number().int().nonnegative(),
});
export type ListChangesResponse = z.infer<typeof ListChangesResponseSchema>;
