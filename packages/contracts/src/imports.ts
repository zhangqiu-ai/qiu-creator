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
  /** Optionally link the imported asset to this work. */
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
export const TokenScopeSchema = z.enum(['read', 'import', 'write']);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

/**
 * `GET /api/v1/session` (QC-087): who the bearer token is and what it may do,
 * so an agent can tell which tools will work before calling them.
 */
export const SessionResponseSchema = z.object({
  kind: z.enum(['owner', 'agent']),
  /** Agent token name; null for the owner token. */
  name: z.string().nullable(),
  scopes: z.array(TokenScopeSchema),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const CreateTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(TokenScopeSchema).min(1),
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
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const CreateTokenResponseSchema = z.object({
  token: ApiTokenSchema,
  /** The full secret. Returned once, at creation. */
  secret: z.string(),
});
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

export const ListTokensResponseSchema = z.object({ items: z.array(ApiTokenSchema) });
export type ListTokensResponse = z.infer<typeof ListTokensResponseSchema>;

export const TokenIdParamsSchema = z.object({ id: IdSchema });
