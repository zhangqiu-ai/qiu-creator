import { z } from 'zod';
import { IdSchema, TagSchema, TimestampSchema } from './entities.js';

/**
 * Project rules and automatic assignment (QC-092, docs/mcp-plan.md §7).
 * Works are scored against each project's rules by fixed, explainable rules
 * (no AI): ≥ 0.8 is assigned automatically where asked (`auto_assign`),
 * 0.5–0.8 is only suggested. See `@qiu-creator/domain/project-rules` for
 * the weights.
 */

export const AUTO_ASSIGN_THRESHOLD = 0.8;
export const SUGGEST_THRESHOLD = 0.5;
export const PROJECT_DESCRIPTION_MAX_CHARS = 2000;

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;

/** What puts a work into a project. Empty lists match nothing. */
export const ProjectRulesSchema = z.object({
  /** Words in the title (strong) or body (weaker); matched after case and 繁簡 folding. */
  keywords: z
    .array(z.string().trim().min(1).max(40))
    .max(50)
    .refine(unique, 'keywords must not repeat')
    .default([]),
  tags: z.array(TagSchema).max(50).refine(unique, 'tags must not repeat').default([]),
  /** Mount ids, or absolute folder paths, that external works live in. */
  folders: z
    .array(z.string().trim().min(1).max(1024))
    .max(20)
    .refine(unique, 'folders must not repeat')
    .default([]),
  /** Host names of the work's source URL or its links; subdomains match too. */
  domains: z
    .array(z.string().trim().toLowerCase().regex(HOSTNAME_RE, 'a host name like example.com'))
    .max(20)
    .refine(unique, 'domains must not repeat')
    .default([]),
});
export type ProjectRules = z.output<typeof ProjectRulesSchema>;
export type ProjectRulesInput = z.input<typeof ProjectRulesSchema>;

export const RuleReasonSchema = z.object({
  kind: z.enum(['folder', 'domain', 'keyword_title', 'tag', 'keyword_body']),
  /** The keyword, tag, folder or domain that matched. */
  value: z.string(),
  weight: z.number().min(0).max(1),
  /** A sentence for people (Traditional Chinese); the app builds its own from kind and value. */
  text: z.string(),
});
export type RuleReason = z.infer<typeof RuleReasonSchema>;

export const RuleOutcomeSchema = z.enum(['auto', 'suggest', 'none']);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;

/** How well a work fits one project. */
export const ProjectMatchSchema = z.object({
  project_id: IdSchema,
  project_name: z.string(),
  /** 0–1. */
  score: z.number().min(0).max(1),
  /** `auto` (≥ 0.8), `suggest` (0.5–0.8) or `none`. */
  outcome: RuleOutcomeSchema,
  reasons: z.array(RuleReasonSchema),
});
export type ProjectMatch = z.infer<typeof ProjectMatchSchema>;

/** What `auto_assign` did on create: assigned (≥ 0.8) and only suggested (0.5–0.8). */
export const AutoAssignmentSchema = z.object({
  assigned: z.array(ProjectMatchSchema),
  suggested: z.array(ProjectMatchSchema),
});
export type AutoAssignment = z.infer<typeof AutoAssignmentSchema>;

/** Who put a work into a project, and why (QC-092). */
export const MembershipAddedBySchema = z.object({
  /** `user` (the owner, by hand), `agent` (an agent token's explicit choice) or `rule` (auto_assign). */
  kind: z.enum(['user', 'agent', 'rule']),
  /** The agent token behind `agent` and `rule` assignments, if any. */
  token_id: z.string().nullable(),
  token_name: z.string().nullable(),
  /** `rule` only. */
  score: z.number().min(0).max(1).nullable(),
  reasons: z.array(RuleReasonSchema),
  at: TimestampSchema,
});
export type MembershipAddedBy = z.infer<typeof MembershipAddedBySchema>;

export const WorkProjectMembershipSchema = z.object({
  project_id: IdSchema,
  project_name: z.string(),
  added_by: MembershipAddedBySchema,
});
export type WorkProjectMembership = z.infer<typeof WorkProjectMembershipSchema>;

export const WorkProjectsResponseSchema = z.object({ items: z.array(WorkProjectMembershipSchema) });
export type WorkProjectsResponse = z.infer<typeof WorkProjectsResponseSchema>;

/** Candidates for a work, best first; projects without rules are left out. */
export const ProjectSuggestionsResponseSchema = z.object({ items: z.array(ProjectMatchSchema) });
export type ProjectSuggestionsResponse = z.infer<typeof ProjectSuggestionsResponseSchema>;

/** `POST /api/v1/projects/suggestions`: score content that is not saved yet. */
export const SuggestProjectsRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  markdown: z
    .string()
    .max(5 * 1024 * 1024)
    .default(''),
  tags: z.array(TagSchema).max(64).default([]),
  /** A source URL to match against domains. */
  source: z.string().max(2000).optional(),
});
export type SuggestProjectsRequest = z.input<typeof SuggestProjectsRequestSchema>;

export const RULES_PREVIEW_MAX = 50;

/** `POST /api/v1/projects/:id/rules/preview`: try rules on recent works without saving them. */
export const RulesPreviewRequestSchema = z.object({
  rules: ProjectRulesSchema,
  /** Most recently updated works to try (default 20). */
  limit: z.number().int().min(1).max(RULES_PREVIEW_MAX).default(20),
});
export type RulesPreviewRequest = z.input<typeof RulesPreviewRequestSchema>;

export const RulesPreviewItemSchema = z.object({
  work_id: IdSchema,
  title: z.string(),
  updated_at: TimestampSchema,
  score: z.number().min(0).max(1),
  outcome: RuleOutcomeSchema,
  reasons: z.array(RuleReasonSchema),
  /** Already in the project. */
  member: z.boolean(),
});
export type RulesPreviewItem = z.infer<typeof RulesPreviewItemSchema>;

export const RulesPreviewResponseSchema = z.object({ items: z.array(RulesPreviewItemSchema) });
export type RulesPreviewResponse = z.infer<typeof RulesPreviewResponseSchema>;

export const WorkProjectParamsSchema = z.object({ id: IdSchema, projectId: IdSchema });
