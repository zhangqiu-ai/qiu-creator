import { z } from 'zod';
import {
  AssetKindSchema,
  AssetSchema,
  IdSchema,
  PlatformSchema,
  TagSchema,
  TagsSchema,
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

/**
 * How an asset left the library:
 * - `trashed`: a managed file (under CREATORHUB_HOME); the file stays where it
 *   is until the asset is purged.
 * - `unindexed`: an external (mounted) file removed from the library only; the
 *   original is untouched.
 * - `original_trashed`: an external file whose original was moved to the macOS
 *   Trash on request. Put it back in Finder before restoring.
 */
export const AssetRemovalSchema = z.enum(['trashed', 'unindexed', 'original_trashed']);
export type AssetRemoval = z.infer<typeof AssetRemovalSchema>;

/** Asset as returned by the API: the section-3 entity plus upload/processing fields. */
export const AssetRecordSchema = AssetSchema.extend({
  original_name: z.string().nullable(),
  codec: z.string().nullable(),
  metadata_status: AssetMetadataStatusSchema,
  thumbnail_status: AssetThumbnailStatusSchema,
  updated_at: TimestampSchema,
  /**
   * External assets only (QC-010): the mount whose folder holds the file; `path`
   * is then relative to the mount root. Indexed in place, never moved or copied.
   */
  mount_id: IdSchema.nullable().optional(),
  /** Name shown in the app (QC-037); null = use `original_name`. The file on disk keeps its name. */
  display_name: z.string().nullable().optional(),
  tags: TagsSchema.optional(),
  /** Alternative text for images (accessibility, platform alt fields). */
  alt_text: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  /** Bumped by every metadata edit; send it back as `base_revision` or `If-Match` (QC-037). */
  revision: z.number().int().positive().optional(),
  /** Set while the asset is in 最近刪除 (QC-037); null when active. */
  deleted_at: TimestampSchema.nullable().optional(),
  /** When a trashed asset is permanently deleted automatically. */
  purge_at: TimestampSchema.nullable().optional(),
  /** How it was removed; null when active. See `AssetRemovalSchema`. */
  removal: AssetRemovalSchema.nullable().optional(),
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

/**
 * Which assets a listing returns (QC-037). `active` (default): not deleted.
 * `unreferenced`: active and not used by any work or platform variant.
 * `trash`: in 最近刪除, most recently deleted first.
 */
export const AssetScopeSchema = z.enum(['active', 'unreferenced', 'trash']);
export type AssetScope = z.infer<typeof AssetScopeSchema>;

export const ListAssetsQuerySchema = z.object({
  kind: AssetKindSchema.optional(),
  /** Substring match on the display name or the original file name. */
  q: z.string().trim().min(1).max(200).optional(),
  scope: AssetScopeSchema.default('active'),
  /** Only assets carrying this tag (exact match). */
  tag: TagSchema.optional(),
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

/** One work that uses an asset (reverse lookup of `work_assets`). */
export const AssetWorkItemSchema = z.object({
  work_id: IdSchema,
  title: z.string(),
  role: WorkAssetRoleSchema,
  position: z.number().int().nonnegative(),
  updated_at: TimestampSchema,
});
export type AssetWorkItem = z.infer<typeof AssetWorkItemSchema>;

export const AssetWorkListResponseSchema = z.object({ items: z.array(AssetWorkItemSchema) });
export type AssetWorkListResponse = z.infer<typeof AssetWorkListResponseSchema>;

export const WorkAssetParamsSchema = z.object({ id: IdSchema, assetId: IdSchema });
export const WorkAssetRoleQuerySchema = z.object({ role: WorkAssetRoleSchema });

// ---- Edit, delete and 最近刪除 (QC-037) ------------------------------------------

/** Days a trashed asset stays in 最近刪除 before it is deleted permanently. */
export const ASSET_TRASH_RETENTION_DAYS = 30;

/** At least one field; omitted fields stay as they are, `null` clears a text field. */
export const UpdateAssetRequestSchema = z
  .object({
    display_name: z.string().trim().min(1).max(255).nullable().optional(),
    tags: TagsSchema.optional(),
    alt_text: z.string().max(2000).nullable().optional(),
    note: z.string().max(10_000).nullable().optional(),
    /** Revision the edit is based on; or send `If-Match: "<revision>"`. One of the two is required. */
    base_revision: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      v.display_name !== undefined ||
      v.tags !== undefined ||
      v.alt_text !== undefined ||
      v.note !== undefined,
    { message: 'nothing to change' },
  );
export type UpdateAssetRequest = z.input<typeof UpdateAssetRequestSchema>;

/** Where an asset is used. Markdown links are not tracked here (see the purge response). */
export const AssetWorkReferenceSchema = z.object({
  work_id: IdSchema,
  title: z.string(),
  role: WorkAssetRoleSchema,
  position: z.number().int().nonnegative(),
  /**
   * QC-039: the work's own `assets/` holds an independent copy of this file
   * (made by `POST /works/:id/media/attach`), so the images in its text keep
   * working when the library asset is deleted. Only the work's asset list loses
   * the entry. False for covers, videos and links that point at the asset itself.
   */
  independent_copy: z.boolean().optional(),
});
export type AssetWorkReference = z.infer<typeof AssetWorkReferenceSchema>;

export const AssetVariantReferenceSchema = z.object({
  work_id: IdSchema,
  title: z.string(),
  platform: PlatformSchema,
  usage: z.enum(['cover', 'image']),
});
export type AssetVariantReference = z.infer<typeof AssetVariantReferenceSchema>;

export const AssetReferencesSchema = z.object({
  works: z.array(AssetWorkReferenceSchema),
  variants: z.array(AssetVariantReferenceSchema),
});
export type AssetReferences = z.infer<typeof AssetReferencesSchema>;

export const DeleteAssetRequestSchema = z
  .object({
    /** Required when the asset is referenced; without it the answer is 409 `asset_in_use` with the references. */
    confirm: z.boolean().optional(),
    /** External assets only: also move the original file to the macOS Trash. Never implied. */
    move_original_to_trash: z.boolean().optional(),
  })
  .default({});
export type DeleteAssetRequest = z.input<typeof DeleteAssetRequestSchema>;

export const DeleteAssetResponseSchema = z.object({
  asset: AssetRecordSchema,
  /** The references it had; they are kept and come back on restore. */
  references: AssetReferencesSchema,
});
export type DeleteAssetResponse = z.infer<typeof DeleteAssetResponseSchema>;

/** A work whose current Markdown links to the file of a purged asset (it will show as missing). */
export const MarkdownReferrerSchema = z.object({ work_id: IdSchema, title: z.string() });
export type MarkdownReferrer = z.infer<typeof MarkdownReferrerSchema>;

export const PurgedAssetSchema = z.object({
  id: IdSchema,
  removal: AssetRemovalSchema,
  /** Informational only: the purge went ahead. */
  markdown_referrers: z.array(MarkdownReferrerSchema),
});
export type PurgedAsset = z.infer<typeof PurgedAssetSchema>;

export const PurgeAssetResponseSchema = PurgedAssetSchema;
export type PurgeAssetResponse = PurgedAsset;

export const EmptyTrashRequestSchema = z.object({ confirm: z.literal(true) });
export type EmptyTrashRequest = z.input<typeof EmptyTrashRequestSchema>;

export const EmptyTrashResponseSchema = z.object({ purged: z.array(PurgedAssetSchema) });
export type EmptyTrashResponse = z.infer<typeof EmptyTrashResponseSchema>;

export const TrashItemParamsSchema = z.object({ id: IdSchema });

export const BATCH_ASSET_MAX = 200;

export const BatchAssetsRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['add_tags', 'remove_tags']),
    ids: z.array(IdSchema).min(1).max(BATCH_ASSET_MAX),
    tags: z.array(TagSchema).min(1).max(64),
  }),
  z.object({
    /** Managed assets go to 最近刪除, external ones are removed from the library only. */
    action: z.literal('trash'),
    ids: z.array(IdSchema).min(1).max(BATCH_ASSET_MAX),
    /** Required when any of them is referenced (409 `asset_in_use` lists which). */
    confirm: z.boolean().optional(),
  }),
]);
export type BatchAssetsRequest = z.input<typeof BatchAssetsRequestSchema>;

/** All or nothing: either every asset was changed or none was. */
export const BatchAssetsResponseSchema = z.object({ items: z.array(AssetRecordSchema) });
export type BatchAssetsResponse = z.infer<typeof BatchAssetsResponseSchema>;
