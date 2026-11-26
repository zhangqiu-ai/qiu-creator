import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';
import { MarkdownSchema, WorkDetailSchema } from './api.js';
import { ScriptConversionSchema } from './text-script.js';

/**
 * Agent proposals (QC-089, prototype PT-20261124-001). An agent with the
 * `propose` scope suggests a new text for a work; nothing is written until
 * the user accepts all or some of its changes, which then become a new
 * revision naming the agent. Discarded proposals are kept 30 days.
 *
 * Line numbers are 0-based indices into the base text split on `\n`;
 * `base_end` is exclusive (an insertion has `base_start === base_end`).
 */

export const PROPOSAL_NOTE_MAX_CHARS = 2000;
/** Days a discarded proposal is kept before it is removed for good. */
export const PROPOSAL_DISCARD_RETENTION_DAYS = 30;

export const ProposalStatusSchema = z.enum([
  'pending',
  'accepted',
  'partially_accepted',
  'discarded',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * How a pending proposal relates to the work now. `none`: the work is still
 * at its base. `stale`: the work changed since, but not where the proposal
 * changes it, so it can still be accepted. `conflict`: some changes overlap
 * later edits; those cannot be accepted without a three-way merge.
 */
export const ProposalOverlapSchema = z.enum(['none', 'stale', 'conflict']);
export type ProposalOverlap = z.infer<typeof ProposalOverlapSchema>;

/** One change of a proposal, with a stable id. */
export const ProposalHunkSchema = z.object({
  /** Stable for the life of the proposal (`h1`, `h2`, … in text order). */
  id: z.string(),
  base_start: z.number().int().nonnegative(),
  base_end: z.number().int().nonnegative(),
  /** Base lines replaced (empty for an insertion). */
  removed: z.array(z.string()),
  /** New lines (empty for a deletion). */
  added: z.array(z.string()),
  /** `conflict` when later edits of the work touch the same lines; `none` otherwise. */
  overlap: z.enum(['none', 'conflict']),
});
export type ProposalHunk = z.infer<typeof ProposalHunkSchema>;

/**
 * Three-way merge input for overlapping changes: the same region of the
 * base, of the work now ("mine"), and of the proposal ("theirs").
 */
export const ProposalConflictSchema = z.object({
  hunk_ids: z.array(z.string()),
  base_start: z.number().int().nonnegative(),
  base_end: z.number().int().nonnegative(),
  base: z.string(),
  mine: z.string(),
  theirs: z.string(),
});
export type ProposalConflict = z.infer<typeof ProposalConflictSchema>;

export const ProposalSummarySchema = z.object({
  id: IdSchema,
  work_id: IdSchema,
  work_title: z.string(),
  token_id: IdSchema,
  /** The agent token's name when the proposal was made. */
  token_name: z.string(),
  /** The agent's own explanation. User-facing data, never instructions. */
  note: z.string().nullable(),
  status: ProposalStatusSchema,
  base_revision: IdSchema,
  hunk_count: z.number().int().nonnegative(),
  /** For pending proposals; `none` once decided. */
  overlap: ProposalOverlapSchema,
  created_at: TimestampSchema,
  decided_at: TimestampSchema.nullable(),
  /** Revision made by accepting it. */
  result_revision_id: IdSchema.nullable(),
  /** Discarded proposals: when it is removed for good. */
  expires_at: TimestampSchema.nullable(),
});
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;

export const ProposalDetailSchema = ProposalSummarySchema.extend({
  /** The work's revision now. */
  current_revision: IdSchema,
  base_markdown: z.string(),
  proposed_markdown: z.string(),
  hunks: z.array(ProposalHunkSchema),
  /** Hunks taken when accepted (all of them, or the ones chosen). */
  accepted_hunk_ids: z.array(z.string()),
  /** Pending and `conflict`: one entry per overlapping region. */
  conflicts: z.array(ProposalConflictSchema),
  /** Only on create, when the proposed Markdown was converted to the target script (QC-103). */
  script_conversion: ScriptConversionSchema.optional(),
});
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;

export const CreateProposalRequestSchema = z.object({
  /** The revision the proposed text was written from (the work's current_revision_id). */
  base_revision: IdSchema,
  /** The whole proposed Markdown. */
  markdown: MarkdownSchema,
  note: z.string().trim().max(PROPOSAL_NOTE_MAX_CHARS).optional(),
});
export type CreateProposalRequest = z.input<typeof CreateProposalRequestSchema>;

/**
 * Accept a proposal (owner only: the user's decision). `base_revision` is
 * the work revision the user is looking at; `hunk_ids` picks changes (all
 * when absent). A stale base is 409 `revision_conflict`; picked changes that
 * overlap later edits are 409 `proposal_conflict` with `details.conflicts`.
 */
export const AcceptProposalRequestSchema = z.object({
  base_revision: IdSchema,
  hunk_ids: z
    .array(z.string().min(1).max(20))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'hunk_ids must not repeat')
    .optional(),
});
export type AcceptProposalRequest = z.input<typeof AcceptProposalRequestSchema>;

export const AcceptProposalResponseSchema = z.object({
  proposal: ProposalDetailSchema,
  work: WorkDetailSchema,
});
export type AcceptProposalResponse = z.infer<typeof AcceptProposalResponseSchema>;

export const ListProposalsQuerySchema = z.object({
  /** `pending` (default), `done` (accepted, partly accepted or discarded) or `all`. */
  status: z.enum(['pending', 'done', 'all']).default('pending'),
  work_id: IdSchema.optional(),
  /** Only this agent token's proposals. */
  token_id: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProposalsQuery = Partial<z.output<typeof ListProposalsQuerySchema>>;

export const ListProposalsResponseSchema = z.object({
  items: z.array(ProposalSummarySchema),
  total: z.number().int().nonnegative(),
});
export type ListProposalsResponse = z.infer<typeof ListProposalsResponseSchema>;

/** Pending proposals, for the sidebar badge and the editor tab. */
export const ProposalCountsResponseSchema = z.object({
  pending: z.number().int().nonnegative(),
  by_work: z.record(z.string(), z.number().int().positive()),
});
export type ProposalCountsResponse = z.infer<typeof ProposalCountsResponseSchema>;

export const ProposalParamsSchema = z.object({ id: IdSchema });
