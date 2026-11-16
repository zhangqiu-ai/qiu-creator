import { z } from 'zod';
import { TimestampSchema } from './entities.js';

export const ChangeEntitySchema = z.enum(['work', 'asset', 'job']);
export type ChangeEntity = z.infer<typeof ChangeEntitySchema>;

/**
 * Change actions published on `GET /api/v1/events` (SSE event name) and
 * stored in the change log. New actions may be added; clients should ignore
 * ones they do not know.
 */
export const ChangeActionSchema = z.enum([
  'work.created',
  'work.updated',
  /** `source.md` was edited outside the app and recorded as an `external` revision. */
  'work.external_revision',
  'work.assets_changed',
  /** An external work's file disappeared (deleted, moved out, or the mount became unavailable). */
  'work.source_missing',
  /** An external work's file reappeared or was found at a new path (rename/move). */
  'work.source_restored',
  'asset.created',
  'asset.updated',
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
