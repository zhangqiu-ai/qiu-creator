import { z } from 'zod';
import {
  IdSchema,
  ImportJobSchema,
  ImportMethodSchema,
  JobStatusSchema,
  TimestampSchema,
  WorkAssetRoleSchema,
} from './entities.js';

/** Header carrying the client's idempotency key on POST /works and POST /imports/urls. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to `true` on responses replayed from an earlier request with the same key. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces');

/** Why a URL import failed; `error` holds the human-readable detail. */
export const ImportErrorCodeSchema = z.enum([
  'url_rejected',
  'blocked_address',
  'too_many_redirects',
  'http_error',
  'unsupported_content_type',
  'payload_too_large',
  'unsupported_media_type',
  'timeout',
  'network_error',
  'internal_error',
]);
export type ImportErrorCode = z.infer<typeof ImportErrorCodeSchema>;

export const ImportUrlRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(4096),
  /** File name to store; defaults to Content-Disposition or the URL path. */
  filename: z.string().trim().min(1).max(255).optional(),
  /**
   * Optionally link the imported asset to this work. For image and video works
   * the file also goes into the front matter, which needs the `write` scope
   * (QC-102).
   */
  work_id: IdSchema.optional(),
  role: WorkAssetRoleSchema.optional(),
});
export type ImportUrlRequest = z.input<typeof ImportUrlRequestSchema>;

/** Import job as returned by the API: the section-3 entity plus URL-import fields. */
export const ImportJobRecordSchema = ImportJobSchema.extend({
  url: z.string().nullable(),
  filename: z.string().nullable(),
  error_code: ImportErrorCodeSchema.nullable(),
  result_asset_id: IdSchema.nullable(),
  result_work_id: IdSchema.nullable(),
  link_work_id: IdSchema.nullable(),
  link_role: WorkAssetRoleSchema.nullable(),
  /** `owner` for the main token, otherwise the agent token id that created the job. */
  created_by: z.string().nullable(),
});
export type ImportJobRecord = z.infer<typeof ImportJobRecordSchema>;

export const JobIdParamsSchema = z.object({ id: IdSchema });

export const ListJobsQuerySchema = z.object({
  status: JobStatusSchema.optional(),
  method: ImportMethodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListJobsQuery = Partial<z.output<typeof ListJobsQuerySchema>>;

export const ListJobsResponseSchema = z.object({
  items: z.array(ImportJobRecordSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

// ---- Agent tokens -----------------------------------------------------------

/**
 * - `read`: every GET (works, assets, jobs, events)
 * - `import`: create works, upload assets, import URLs, retry import jobs
 * - `write`: edit works and work–asset links
 * Token management itself is reserved for the main (owner) token.
 */
/**
 * Agent token permissions. `propose` (QC-089): suggest changes to a work's
 * text as proposals the user accepts or discards.
 */
export const TokenScopeSchema = z.enum(['read', 'import', 'write', 'propose']);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

/**
 * How to start the `creatorhub` CLI on the Mac (QC-094): the MCP config is
 * `command` with `[...args, 'mcp']` and `CREATORHUB_URL` = `server_url`.
 * `installed` is the CLI shipped with the installed service; `source` is the
 * repository's CLI (running from source, development only).
 */
export const SessionCliSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  source: z.enum(['installed', 'source']),
  server_url: z.string(),
});
export type SessionCli = z.infer<typeof SessionCliSchema>;

/**
 * `GET /api/v1/session` (QC-087): who the bearer token is and what it may do,
 * so an agent can tell which tools will work before calling them.
 */
export const SessionResponseSchema = z.object({
  kind: z.enum(['owner', 'agent']),
  /** Agent token name; null for the owner token. */
  name: z.string().nullable(),
  scopes: z.array(TokenScopeSchema),
  /** QC-089: this agent may change a work's text directly (always false for the owner, who needs no flag). */
  allow_direct_body_edit: z.boolean().default(false),
  /** QC-089: projects this agent is limited to; null = all. */
  project_ids: z.array(IdSchema).nullable().default(null),
  /** QC-094: the CLI on this Mac; owner token only (null for agents, or when not found). */
  cli: SessionCliSchema.nullable().default(null),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Most projects one token can be limited to. */
export const TOKEN_PROJECTS_MAX = 100;

const TokenProjectIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(TOKEN_PROJECTS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'project_ids must not repeat');

export const CreateTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(TokenScopeSchema).min(1),
  /** QC-089: default false; only the owner can turn it on. */
  allow_direct_body_edit: z.boolean().default(false),
  /** QC-089: limit the token to these projects; omit or null for all. */
  project_ids: TokenProjectIdsSchema.nullable().default(null),
});
export type CreateTokenRequest = z.input<typeof CreateTokenRequestSchema>;

export const ApiTokenSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** First characters of the token, for recognizing it; the secret is never shown again. */
  prefix: z.string(),
  scopes: z.array(TokenScopeSchema),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  /**
   * QC-089: the token may change a work's text directly (a snapshot is kept
   * and the revision names the agent). Always sent since QC-089; absent
   * from older servers (treat as false).
   */
  allow_direct_body_edit: z.boolean().optional(),
  /** QC-089: projects the token is limited to; null = all. Absent from older servers (all). */
  project_ids: z.array(IdSchema).nullable().optional(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

/**
 * `PATCH /api/v1/tokens/:id` (QC-089, owner only). Absent fields stay;
 * `project_ids: null` lifts the project limit. Turning
 * `allow_direct_body_edit` on or off is recorded in the token's activity.
 */
export const UpdateTokenRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    scopes: z.array(TokenScopeSchema).min(1).optional(),
    allow_direct_body_edit: z.boolean().optional(),
    project_ids: TokenProjectIdsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.scopes !== undefined ||
      v.allow_direct_body_edit !== undefined ||
      v.project_ids !== undefined,
    { message: 'at least one of name, scopes, allow_direct_body_edit or project_ids is required' },
  );
export type UpdateTokenRequest = z.input<typeof UpdateTokenRequestSchema>;

/**
 * One thing an agent token did or tried (QC-089): every request that
 * changes something, and every request refused (4xx/5xx), plus changes the
 * owner made to the token.
 */
export const TokenActivitySchema = z.object({
  id: z.number().int().positive(),
  at: TimestampSchema,
  /** `request` (the agent's own call) or `token_updated` (the owner changed this token). */
  kind: z.enum(['request', 'token_updated']),
  method: z.string(),
  /** Route pattern, e.g. `/api/v1/works/:id`. */
  route: z.string(),
  /** `work`, `project`, `proposal`, `asset`, `job`, `token` or null. */
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  status: z.number().int(),
  result: z.enum(['ok', 'rejected', 'error']),
  /** Error code when refused (`forbidden`, `revision_conflict`, …). */
  code: z.string().nullable(),
  /** Error message, or what the owner changed. */
  reason: z.string().nullable(),
  /** Revision the call produced (from its ETag), if any. */
  revision: z.string().nullable(),
});
export type TokenActivity = z.infer<typeof TokenActivitySchema>;

export const TOKEN_ACTIVITY_PAGE_MAX = 200;

export const ListTokenActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TOKEN_ACTIVITY_PAGE_MAX).default(50),
  /** Activity ids below this (the previous page's `next_before`). */
  before: z.coerce.number().int().positive().optional(),
});
export interface ListTokenActivityQuery {
  limit?: number;
  before?: number;
}

export const ListTokenActivityResponseSchema = z.object({
  items: z.array(TokenActivitySchema),
  /** Pass as `before` for older entries; null when there are none. */
  next_before: z.number().int().positive().nullable(),
});
export type ListTokenActivityResponse = z.infer<typeof ListTokenActivityResponseSchema>;

export const CreateTokenResponseSchema = z.object({
  token: ApiTokenSchema,
  /** The full secret. Returned once, at creation. */
  secret: z.string(),
});
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

export const ListTokensResponseSchema = z.object({ items: z.array(ApiTokenSchema) });
export type ListTokensResponse = z.infer<typeof ListTokensResponseSchema>;

export const TokenIdParamsSchema = z.object({ id: IdSchema });
