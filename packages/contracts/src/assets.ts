import { z } from 'zod';
import {
  AssetKindSchema,
  AssetSchema,
  IdSchema,
  TimestampSchema,
  WorkAssetRoleSchema,
} from './entities.js';

/** Status of background metadata extraction (ffprobe for video/audio). */
export const AssetMetadataStatusSchema = z.enum([
  'none',
  'pending',
  'ready',
  'unavailable',
  'failed',
]);
export type AssetMetadataStatus = z.infer<typeof AssetMetadataStatusSchema>;

/** Status of the cached thumbnail (images). `cache/` is rebuildable at any time. */
export const AssetThumbnailStatusSchema = z.enum(['none', 'pending', 'ready', 'failed']);
export type AssetThumbnailStatus = z.infer<typeof AssetThumbnailStatusSchema>;

/** Asset as returned by the API: the section-3 entity plus upload/processing fields. */
export const AssetRecordSchema = AssetSchema.extend({
  original_name: z.string().nullable(),
  codec: z.string().nullable(),
  metadata_status: AssetMetadataStatusSchema,
  thumbnail_status: AssetThumbnailStatusSchema,
  updated_at: TimestampSchema,
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

/** Uploads at or below this size may use the single-request endpoint; larger ones must use tus. */
export const DIRECT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
/** tus 1.0.0 creation endpoint for resumable uploads (relative to the server base URL). */
export const TUS_UPLOAD_PATH = '/api/v1/assets/uploads/tus';

export const DirectUploadQuerySchema = z.object({
  filename: z.string().trim().min(1).max(255),
});

export const UploadAssetResponseSchema = z.object({
  asset: AssetRecordSchema,
  /** True when an asset with the same sha256 already existed and was returned instead. */
  deduplicated: z.boolean(),
});
export type UploadAssetResponse = z.infer<typeof UploadAssetResponseSchema>;

export const ListAssetsQuerySchema = z.object({
  kind: AssetKindSchema.optional(),
  /** Substring match on the original file name. */
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAssetsQuery = Partial<z.output<typeof ListAssetsQuerySchema>>;

export const ListAssetsResponseSchema = z.object({
  items: z.array(AssetRecordSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListAssetsResponse = z.infer<typeof ListAssetsResponseSchema>;

export const WorkAssetItemSchema = z.object({
  role: WorkAssetRoleSchema,
  position: z.number().int().nonnegative(),
  asset: AssetRecordSchema,
});
export type WorkAssetItem = z.infer<typeof WorkAssetItemSchema>;

export const WorkAssetListResponseSchema = z.object({ items: z.array(WorkAssetItemSchema) });
export type WorkAssetListResponse = z.infer<typeof WorkAssetListResponseSchema>;

export const LinkWorkAssetRequestSchema = z.object({
  asset_id: IdSchema,
  role: WorkAssetRoleSchema,
  /** Insert position within the role; defaults to the end. */
  position: z.number().int().nonnegative().optional(),
});
export type LinkWorkAssetRequest = z.input<typeof LinkWorkAssetRequestSchema>;

export const ReorderWorkAssetsRequestSchema = z.object({
  role: WorkAssetRoleSchema,
  /** Every asset currently linked with `role`, in the new order. */
  asset_ids: z.array(IdSchema).min(1),
});
export type ReorderWorkAssetsRequest = z.input<typeof ReorderWorkAssetsRequestSchema>;

export const WorkAssetParamsSchema = z.object({ id: IdSchema, assetId: IdSchema });
export const WorkAssetRoleQuerySchema = z.object({ role: WorkAssetRoleSchema });
