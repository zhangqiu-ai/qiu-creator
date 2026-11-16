import { z } from 'zod';

/**
 * Core entities from plan section 3. Field names are snake_case to match the
 * HTTP wire format and the SQLite columns.
 */

export const IdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');

export const WorkTypeSchema = z.enum(['article', 'image', 'video', 'mixed']);
export type WorkType = z.infer<typeof WorkTypeSchema>;

/** 創作中 / 待審核 / 待發布 / 已發布 */
export const WorkStatusSchema = z.enum(['drafting', 'in_review', 'ready', 'published']);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

/** managed = lives under `library/`; external = indexed in a mounted folder, never moved. */
export const StorageModeSchema = z.enum(['managed', 'external']);
export type StorageMode = z.infer<typeof StorageModeSchema>;

export const PlatformSchema = z.enum(['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels']);
export type Platform = z.infer<typeof PlatformSchema>;

export const TagSchema = z.string().trim().min(1).max(64);
export const TagsSchema = z.array(TagSchema).max(64);

export const WorkSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(500),
  type: WorkTypeSchema,
  status: WorkStatusSchema,
  tags: TagsSchema,
  /** Free-form origin label, e.g. `api:agent-name`, `cli`, `mac-app`. */
  source: z.string().min(1).max(200),
  storage_mode: StorageModeSchema,
  current_revision_id: IdSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Work = z.infer<typeof WorkSchema>;

export const AssetKindSchema = z.enum(['image', 'video', 'audio', 'markdown', 'other']);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetOriginSchema = z.enum(['upload', 'url', 'folder', 'api', 'manual']);
export type AssetOrigin = z.infer<typeof AssetOriginSchema>;

export const AssetSchema = z.object({
  id: IdSchema,
  kind: AssetKindSchema,
  /** Path relative to `CREATORHUB_HOME` for managed assets; never exposed to clients as a file URL. */
  path: z.string().min(1),
  sha256: Sha256Schema,
  mime_type: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  duration: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  origin: AssetOriginSchema,
  created_at: TimestampSchema,
});
export type Asset = z.infer<typeof AssetSchema>;

export const WorkAssetRoleSchema = z.enum(['cover', 'body', 'video']);
export type WorkAssetRole = z.infer<typeof WorkAssetRoleSchema>;

export const WorkAssetSchema = z.object({
  work_id: IdSchema,
  asset_id: IdSchema,
  role: WorkAssetRoleSchema,
  position: z.number().int().nonnegative(),
});
export type WorkAsset = z.infer<typeof WorkAssetSchema>;

export const PlatformVariantSchema = z.object({
  id: IdSchema,
  work_id: IdSchema,
  platform: PlatformSchema,
  title: z.string().max(500),
  body: z.string(),
  cover_asset_id: IdSchema.nullable(),
  tags: TagsSchema,
  revision: z.number().int().positive(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type PlatformVariant = z.infer<typeof PlatformVariantSchema>;

export const RevisionSourceSchema = z.enum([
  'create',
  'edit',
  'external',
  'restore',
  'ai_accepted',
]);
export type RevisionSource = z.infer<typeof RevisionSourceSchema>;

export const RevisionSchema = z.object({
  work_id: IdSchema,
  revision_id: IdSchema,
  parent_revision_id: IdSchema.nullable(),
  content_hash: Sha256Schema,
  created_at: TimestampSchema,
  source: RevisionSourceSchema,
});
export type Revision = z.infer<typeof RevisionSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ImportMethodSchema = z.enum(['markdown', 'upload', 'url', 'folder']);
export type ImportMethod = z.infer<typeof ImportMethodSchema>;

export const ImportJobSchema = z.object({
  id: IdSchema,
  method: ImportMethodSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(1),
  retry_count: z.number().int().nonnegative(),
  error: z.string().nullable(),
  idempotency_key: z.string().min(1).max(200).nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

export const AIActionSchema = z.enum([
  'suggest_title',
  'suggest_summary',
  'suggest_tags',
  'rewrite',
  'platform_variant',
  'video_understanding',
]);
export type AIAction = z.infer<typeof AIActionSchema>;

export const AIJobSchema = z.object({
  id: IdSchema,
  work_id: IdSchema.nullable(),
  model: z.string().min(1),
  action: AIActionSchema,
  source_revision: IdSchema.nullable(),
  status: JobStatusSchema,
  result: z.unknown().nullable(),
  usage: z.record(z.string(), z.number()).nullable(),
  cost_estimate: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type AIJob = z.infer<typeof AIJobSchema>;
