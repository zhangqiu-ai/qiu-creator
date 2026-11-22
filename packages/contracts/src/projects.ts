import { z } from 'zod';
import { ErrorCodeSchema, WorkListItemSchema } from './api.js';
import { IdSchema, TimestampSchema, WorkStatusSchema } from './entities.js';

/**
 * Projects group works in the library (QC-062). A work may be in several
 * projects. Membership lives only in the database, never in a work's
 * Markdown, so external (mounted) works and their files are never touched.
 */

/** Longest project name, in characters (CJK characters count as one). */
export const PROJECT_NAME_MAX_CHARS = 60;
/** Colors are an index into the app's fixed palette of 8. */
export const PROJECT_COLOR_COUNT = 8;
/** Days a deleted project can be restored before it is removed for good. */
export const PROJECT_TRASH_RETENTION_DAYS = 30;

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => Array.from(v).length <= PROJECT_NAME_MAX_CHARS, {
    message: `at most ${String(PROJECT_NAME_MAX_CHARS)} characters`,
  });
export const ProjectColorSchema = z
  .number()
  .int()
  .min(0)
  .max(PROJECT_COLOR_COUNT - 1);

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  color: ProjectColorSchema,
  /** Position in the sidebar, ascending. */
  sort_order: z.number().int(),
  /** Bumped by every change; send it back as `base_revision` or `If-Match`. */
  revision: z.number().int().positive(),
  archived: z.boolean(),
  archived_at: TimestampSchema.nullable(),
  /** Set while the project is deleted (restorable for 30 days); deleted projects are not listed. */
  deleted_at: TimestampSchema.nullable(),
  /** Works in the project, not counting works in 最近刪除. */
  work_count: z.number().int().nonnegative(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectListResponseSchema = z.object({ items: z.array(ProjectSchema) });
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

export const ProjectIdParamsSchema = z.object({ id: IdSchema });

/** New projects go to the end of the list. */
export const CreateProjectRequestSchema = z.object({
  name: ProjectNameSchema,
  color: ProjectColorSchema.default(0),
});
export type CreateProjectRequest = z.input<typeof CreateProjectRequestSchema>;

export const PatchProjectRequestSchema = z
  .object({
    /** Required unless the request carries `If-Match: "<revision>"`. */
    base_revision: z.number().int().positive().optional(),
    name: ProjectNameSchema.optional(),
    color: ProjectColorSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined || v.archived !== undefined, {
    message: 'at least one of name, color or archived is required',
  });
export type PatchProjectRequest = z.input<typeof PatchProjectRequestSchema>;

/** The full new order of every project that is not deleted (archived ones included). */
export const ReorderProjectsRequestSchema = z.object({
  ids: z
    .array(IdSchema)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, 'ids must not repeat'),
});
export type ReorderProjectsRequest = z.input<typeof ReorderProjectsRequestSchema>;

export const ProjectSummarySchema = z.object({
  project: ProjectSchema,
  /** Works in the project by status, not counting works in 最近刪除. */
  by_status: z.record(WorkStatusSchema, z.number().int().nonnegative()),
  /** Most recent `updated_at` of the project's works; null when it has none. */
  last_updated_at: TimestampSchema.nullable(),
  /** Library assets the project's works use (see `GET /api/v1/assets?project_id=`). */
  asset_count: z.number().int().nonnegative(),
  /**
   * Works (not in 最近刪除) in this project and in no other live project,
   * archived ones counting as other projects: those that become 未分類 when
   * the project is deleted (QC-067).
   */
  sole_count: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** Most works one `POST /api/v1/works/batch/projects` takes. */
export const WORK_PROJECTS_BATCH_MAX = 200;

/**
 * Add works to and remove them from projects (QC-062). Membership is not part
 * of a work's content, so no revision is needed and works keep their revision.
 */
export const BatchWorkProjectsRequestSchema = z
  .object({
    work_ids: z
      .array(IdSchema)
      .min(1)
      .max(WORK_PROJECTS_BATCH_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'work_ids must not repeat'),
    add: z.array(IdSchema).max(100).default([]),
    remove: z.array(IdSchema).max(100).default([]),
  })
  .refine((v) => v.add.length + v.remove.length > 0, 'add or remove at least one project')
  .refine(
    (v) => !v.add.some((id) => v.remove.includes(id)),
    'a project cannot be in add and remove',
  );
export type BatchWorkProjectsRequest = z.input<typeof BatchWorkProjectsRequestSchema>;

export const BatchWorkProjectsResultSchema = z.discriminatedUnion('ok', [
  z.object({ id: IdSchema, ok: z.literal(true), work: WorkListItemSchema }),
  z.object({
    id: IdSchema,
    ok: z.literal(false),
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
export type BatchWorkProjectsResult = z.infer<typeof BatchWorkProjectsResultSchema>;

export const BatchWorkProjectsResponseSchema = z.object({
  results: z.array(BatchWorkProjectsResultSchema),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BatchWorkProjectsResponse = z.infer<typeof BatchWorkProjectsResponseSchema>;
