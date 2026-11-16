import { z } from 'zod';
import {
  IdSchema,
  RevisionSchema,
  TagsSchema,
  WorkSchema,
  WorkStatusSchema,
  WorkTypeSchema,
} from './entities.js';

/** Uniform error body for every non-2xx response. */
export const ErrorCodeSchema = z.enum([
  'unauthorized',
  'not_found',
  'validation_error',
  'revision_conflict',
  'precondition_required',
  'range_not_satisfiable',
  'path_rejected',
  'internal_error',
  'unsupported_media_type',
  'payload_too_large',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Body of a 409 response: the client must rebase onto `current_revision`. */
export const RevisionConflictResponseSchema = z.object({
  error: z.object({
    code: z.literal('revision_conflict'),
    message: z.string(),
    details: z.object({
      current_revision: IdSchema,
      base_revision: z.string().nullable(),
    }),
  }),
});
export type RevisionConflictResponse = z.infer<typeof RevisionConflictResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('creatorhub-mac-server'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MarkdownSchema = z.string().max(MAX_MARKDOWN_BYTES);

export const CreateWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  markdown: MarkdownSchema.default(''),
  type: WorkTypeSchema.default('article'),
  status: WorkStatusSchema.default('drafting'),
  tags: TagsSchema.default([]),
  source: z.string().trim().min(1).max(200).default('api'),
});
export type CreateWorkRequest = z.input<typeof CreateWorkRequestSchema>;

/** Work plus its current Markdown body. */
export const WorkDetailSchema = WorkSchema.extend({
  markdown: z.string(),
});
export type WorkDetail = z.infer<typeof WorkDetailSchema>;

export const ListWorksQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  type: WorkTypeSchema.optional(),
  status: WorkStatusSchema.optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
/** Client-side query shape: every field optional, numbers as numbers. */
export type ListWorksQuery = Partial<z.output<typeof ListWorksQuerySchema>>;

export const ListWorksResponseSchema = z.object({
  items: z.array(WorkSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListWorksResponse = z.infer<typeof ListWorksResponseSchema>;

export const WorkIdParamsSchema = z.object({ id: IdSchema });

/**
 * Edit a work. `base_revision` is required unless the request carries an
 * `If-Match` header; a stale base returns 409 and nothing is written.
 */
export const PatchWorkRequestSchema = z
  .object({
    base_revision: IdSchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    markdown: MarkdownSchema.optional(),
    type: WorkTypeSchema.optional(),
    status: WorkStatusSchema.optional(),
    tags: TagsSchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.markdown !== undefined ||
      v.type !== undefined ||
      v.status !== undefined ||
      v.tags !== undefined,
    { message: 'at least one editable field is required' },
  );
export type PatchWorkRequest = z.input<typeof PatchWorkRequestSchema>;

export const RevisionListResponseSchema = z.object({ items: z.array(RevisionSchema) });
export type RevisionListResponse = z.infer<typeof RevisionListResponseSchema>;

export const AssetIdParamsSchema = z.object({ id: IdSchema });
