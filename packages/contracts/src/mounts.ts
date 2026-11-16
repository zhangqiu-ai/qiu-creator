import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';

/**
 * - `active`: indexed and watched.
 * - `unavailable`: the folder could not be read (e.g. external drive unplugged); works stay, marked missing.
 * - `removed`: unmounted; works stay in the library with `external_state: "unmounted"`.
 */
export const MountStatusSchema = z.enum(['active', 'unavailable', 'removed']);
export type MountStatus = z.infer<typeof MountStatusSchema>;

/** State of an external work's file on disk. */
export const ExternalStateSchema = z.enum(['present', 'missing', 'unmounted']);
export type ExternalState = z.infer<typeof ExternalStateSchema>;

export const MountSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** Absolute real path of the mounted folder on the Mac. */
  root_path: z.string(),
  status: MountStatusSchema,
  /** Number of works indexed from this folder (any state). */
  work_count: z.number().int().nonnegative(),
  last_scan_at: TimestampSchema.nullable(),
  last_error: z.string().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Mount = z.infer<typeof MountSchema>;

export const CreateMountRequestSchema = z.object({
  /** Absolute path of an existing folder. Must not overlap CREATORHUB_HOME or another mount. */
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(200).optional(),
});
export type CreateMountRequest = z.input<typeof CreateMountRequestSchema>;

export const ListMountsResponseSchema = z.object({ items: z.array(MountSchema) });
export type ListMountsResponse = z.infer<typeof ListMountsResponseSchema>;

export const MountIdParamsSchema = z.object({ id: IdSchema });

/** Markdown files larger than this are not indexed from mounted folders. */
export const MOUNT_MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
