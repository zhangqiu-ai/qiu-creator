import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';

/**
 * Groups inside a project (QC-113, prototype PT-20261126-002, option A).
 *
 * - A group belongs to one project; there is one level (no nesting).
 * - In one project a work is in at most one group; works in no group are
 *   未分組. A work in several projects can be in a group in each.
 * - `ordered` makes the group a series (系列): its works have episode numbers
 *   1..n in `work_ids` order, renumbered on every change so there are no gaps.
 * - New works, works an agent adds without a group and works added by project
 *   rules all start in 未分組.
 * - Deleting a group puts its works back in 未分組. Groups follow their
 *   project: hidden while it is deleted, back when it is restored, removed
 *   when it is purged.
 */

/** Longest group name, in characters (CJK characters count as one). */
export const PROJECT_GROUP_NAME_MAX_CHARS = 60;
/** Most groups one project can have. */
export const PROJECT_GROUPS_MAX = 100;
/** Most works one `POST /projects/:id/groups/assign` takes. */
export const PROJECT_GROUP_ASSIGN_MAX = 200;

export const ProjectGroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => Array.from(v).length <= PROJECT_GROUP_NAME_MAX_CHARS, {
    message: `at most ${String(PROJECT_GROUP_NAME_MAX_CHARS)} characters`,
  });

/** Who made the group: the owner in the app, or an agent token (shown with the QC-091 Agent mark). */
export const ProjectGroupCreatedBySchema = z.object({
  kind: z.enum(['user', 'agent']),
  /** The agent token; null for the owner. */
  token_id: IdSchema.nullable(),
  /** The token's name when the group was made; null for the owner. */
  token_name: z.string().nullable(),
});
export type ProjectGroupCreatedBy = z.infer<typeof ProjectGroupCreatedBySchema>;

export const ProjectGroupSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  name: z.string(),
  /** A series (系列): works are numbered 1..n in `work_ids` order. */
  ordered: z.boolean(),
  /** Position among the project's groups, 0-based, ascending; 未分組 is always first and is not a group. */
  sort_order: z.number().int().nonnegative(),
  /** Bumped by every change to the group itself; send it back as `base_revision` or `If-Match`. */
  revision: z.number().int().positive(),
  created_by: ProjectGroupCreatedBySchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  /** Works in the group, not counting works in 回收站. */
  work_count: z.number().int().nonnegative(),
  /**
   * The group's works (not in 回收站) in their stored order. For a series this
   * is episode order: the work at index i is episode i + 1.
   */
  work_ids: z.array(IdSchema),
});
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>;

export const ProjectGroupParamsSchema = z.object({ id: IdSchema, groupId: IdSchema });

/** New groups go after the project's other groups. */
export const CreateProjectGroupRequestSchema = z.object({
  name: ProjectGroupNameSchema,
  ordered: z.boolean().default(false),
});
export type CreateProjectGroupRequest = z.input<typeof CreateProjectGroupRequestSchema>;

export const PatchProjectGroupRequestSchema = z
  .object({
    /** Required unless the request carries `If-Match: "<revision>"`. */
    base_revision: z.number().int().positive().optional(),
    name: ProjectGroupNameSchema.optional(),
    ordered: z.boolean().optional(),
    /**
     * Move the group to this 0-based place among the project's groups (上移／下移);
     * the others shift. Past the end means last.
     */
    sort_order: z.number().int().nonnegative().optional(),
  })
  .refine((v) => v.name !== undefined || v.ordered !== undefined || v.sort_order !== undefined, {
    message: 'at least one of name, ordered or sort_order is required',
  });
export type PatchProjectGroupRequest = z.input<typeof PatchProjectGroupRequestSchema>;

/**
 * Put works of the project into a group, or back in 未分組 (`group_id: null`).
 * Every work must already be in the project. Works keep their revision;
 * nothing is written to their files.
 *
 * `position` (1-based) places the works there, in the order given, and the
 * works after them move down; without it they go to the end. Works already in
 * the group move (this is how a series is reordered). Episode numbers are
 * renumbered 1..n afterwards, so there are never gaps.
 */
export const AssignProjectGroupRequestSchema = z.object({
  work_ids: z
    .array(IdSchema)
    .min(1)
    .max(PROJECT_GROUP_ASSIGN_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'work_ids must not repeat'),
  group_id: IdSchema.nullable(),
  position: z.number().int().positive().optional(),
});
export type AssignProjectGroupRequest = z.input<typeof AssignProjectGroupRequestSchema>;
