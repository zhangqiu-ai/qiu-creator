import { z } from 'zod';
import {
  IdSchema,
  PlatformSchema,
  TagsSchema,
  TimestampSchema,
  type Platform,
} from './entities.js';

// ---- Per-platform limits ------------------------------------------------------

/**
 * Per-platform content limits.
 *
 * **參考值、可調。** These are reference values from public creator guidance
 * at the time of writing, not scraped from or verified against the platforms,
 * and the platforms change them. They only produce warnings: an over-limit
 * variant is still saved. Adjust here; both the server and the UI read this.
 *
 * Lengths count Unicode code points (a Chinese character, a letter and an
 * emoji each count as 1). `null` = no limit checked for that field.
 */
export interface PlatformLimits {
  titleMaxChars: number | null;
  bodyMaxChars: number | null;
  imagesMax: number | null;
  tagsMax: number | null;
  /** Whether the body is shown as rendered Markdown (articles) or plain text (posts, captions). */
  bodyFormat: 'markdown' | 'plain';
  /**
   * Images in an image post when it differs from `imagesMax` (QC-045): 公眾號
   * articles take any number, but its 貼圖 posts take 20. Reference value,
   * warnings only.
   */
  imagePostImagesMax?: number | null;
}

/** Images allowed for a platform: the image-post limit for image works, else `imagesMax`. */
export function imagesLimit(platform: Platform, workType: string): number | null {
  const l = PLATFORM_LIMITS[platform];
  return workType === 'image' && l.imagePostImagesMax !== undefined
    ? l.imagePostImagesMax
    : l.imagesMax;
}

export const PLATFORM_LIMITS: Readonly<Record<Platform, PlatformLimits>> = {
  // 小紅書：標題 20 字、正文 1000 字、最多 18 張圖、話題建議不超過 10 個。
  xiaohongshu: {
    titleMaxChars: 20,
    bodyMaxChars: 1000,
    imagesMax: 18,
    tagsMax: 10,
    bodyFormat: 'plain',
  },
  // 微信公眾號：標題 64 字、正文 20000 字；文章圖片數不設限。
  // 貼圖（圖片消息）暫用 20 張，只提示（QC-045，原型 PT-20261121-001 的決定）。
  wechat_mp: {
    titleMaxChars: 64,
    bodyMaxChars: 20000,
    imagesMax: null,
    imagePostImagesMax: 20,
    tagsMax: null,
    bodyFormat: 'markdown',
  },
  // 抖音：作品標題 30 字、作品描述 1000 字、圖文最多 35 張、話題 5 個。
  douyin: {
    titleMaxChars: 30,
    bodyMaxChars: 1000,
    imagesMax: 35,
    tagsMax: 5,
    bodyFormat: 'plain',
  },
  // 微信視頻號：短標題 16 字、描述 1000 字、圖片最多 9 張。
  wechat_channels: {
    titleMaxChars: 16,
    bodyMaxChars: 1000,
    imagesMax: 9,
    tagsMax: null,
    bodyFormat: 'plain',
  },
};

export const VariantWarningCodeSchema = z.enum([
  'title_too_long',
  'body_too_long',
  'too_many_images',
  'too_many_tags',
]);
export type VariantWarningCode = z.infer<typeof VariantWarningCodeSchema>;

export const VariantWarningSchema = z.object({
  code: VariantWarningCodeSchema,
  field: z.enum(['title', 'body', 'image_asset_ids', 'tags']),
  limit: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
  message: z.string(),
});
export type VariantWarning = z.infer<typeof VariantWarningSchema>;

/** Length in Unicode code points, the unit used by every limit. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Over-limit warnings for a variant. Pure, so the UI can show the same
 * warnings live while the user types. Never blocks a save.
 */
export function checkVariantLimits(
  platform: Platform,
  v: { title: string; body: string; image_asset_ids: readonly string[]; tags: readonly string[] },
  limits: Readonly<Record<Platform, PlatformLimits>> = PLATFORM_LIMITS,
  /** The work's type: image posts use `imagePostImagesMax` where a platform has one (QC-045). */
  workType?: string,
): VariantWarning[] {
  const l = limits[platform];
  const imagesMax =
    workType === 'image' && l.imagePostImagesMax !== undefined ? l.imagePostImagesMax : l.imagesMax;
  const out: VariantWarning[] = [];
  const check = (
    code: VariantWarningCode,
    field: VariantWarning['field'],
    limit: number | null,
    actual: number,
    what: string,
    unit: string,
  ): void => {
    if (limit !== null && actual > limit) {
      out.push({
        code,
        field,
        limit,
        actual,
        message: `${what}共 ${String(actual)} ${unit}，超過參考上限 ${String(limit)} ${unit}`,
      });
    }
  };
  check('title_too_long', 'title', l.titleMaxChars, charCount(v.title), '標題', '字');
  check('body_too_long', 'body', l.bodyMaxChars, charCount(v.body), '正文', '字');
  check('too_many_images', 'image_asset_ids', imagesMax, v.image_asset_ids.length, '圖片', '張');
  check('too_many_tags', 'tags', l.tagsMax, v.tags.length, '標籤', '個');
  return out;
}

// ---- Variants -----------------------------------------------------------------

/** Same ceiling as a work's Markdown, so a draft copied from any original always fits. */
export const VARIANT_BODY_MAX_CHARS = 5 * 1024 * 1024;
export const VARIANT_IMAGES_MAX = 100;

export const VariantRevisionSourceSchema = z.enum(['draft', 'edit']);
export type VariantRevisionSource = z.infer<typeof VariantRevisionSourceSchema>;

const VariantFieldsShape = {
  title: z.string().max(500),
  body: z.string().max(VARIANT_BODY_MAX_CHARS),
  cover_asset_id: IdSchema.nullable(),
  /** Ordered images of the post; duplicates are not allowed. */
  image_asset_ids: z
    .array(IdSchema)
    .max(VARIANT_IMAGES_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'image_asset_ids must not repeat'),
  tags: TagsSchema,
};

/** A variant's cover: an image asset, or a frame of the work's video (QC-046). */
export const VariantCoverSchema = z.union([
  z.object({ asset_id: IdSchema }).strict(),
  z
    .object({
      time_seconds: z
        .number()
        .nonnegative()
        .max(24 * 60 * 60),
    })
    .strict(),
]);
export type VariantCover = z.infer<typeof VariantCoverSchema>;

/** One platform version of a work, with its own revision counter. */
export const PlatformVariantRecordSchema = z.object({
  id: IdSchema,
  work_id: IdSchema,
  platform: PlatformSchema,
  ...VariantFieldsShape,
  /**
   * Follows the work's shared copy (QC-045/046): `title`, `body` and `tags`
   * shown here are the work's title, description (image and video works) and
   * tags, not the variant's own saved text, which is kept for when it stops
   * inheriting. Absent from older servers.
   */
  inherit: z.boolean().optional(),
  /** `cover_asset_id` as an object, or a video frame; null when there is none. */
  cover: VariantCoverSchema.nullable().optional(),
  /** Starts at 1 and increases by one per change; also the ETag (`"3"`). */
  revision: z.number().int().positive(),
  /** Work revision the latest draft was generated from (null if never drafted). */
  source_work_revision_id: IdSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  /** Over-limit warnings against `PLATFORM_LIMITS`; informational only. */
  warnings: z.array(VariantWarningSchema),
});
export type PlatformVariantRecord = z.infer<typeof PlatformVariantRecordSchema>;

export const VariantListResponseSchema = z.object({ items: z.array(PlatformVariantRecordSchema) });
export type VariantListResponse = z.infer<typeof VariantListResponseSchema>;

export const VariantParamsSchema = z.object({ id: IdSchema, platform: PlatformSchema });
export const VariantRevisionParamsSchema = VariantParamsSchema.extend({
  revision: z.coerce.number().int().positive(),
});

/**
 * Edit a variant. Requires `base_revision` or `If-Match: "<revision>"`; a
 * stale base returns 409 and nothing is written. Limits never block a save.
 */
export const PatchVariantRequestSchema = z
  .object({
    base_revision: z.number().int().positive().optional(),
    title: VariantFieldsShape.title.optional(),
    body: VariantFieldsShape.body.optional(),
    cover_asset_id: VariantFieldsShape.cover_asset_id.optional(),
    image_asset_ids: VariantFieldsShape.image_asset_ids.optional(),
    tags: VariantFieldsShape.tags.optional(),
    /** Same as `image_asset_ids` (QC-045/046 naming); send one of the two. */
    images: VariantFieldsShape.image_asset_ids.optional(),
    /** An image asset or a video frame; null removes it. Replaces `cover_asset_id`. */
    cover: VariantCoverSchema.nullable().optional(),
    /** Follow the work's shared title, description and tags (see the record). */
    inherit: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.cover_asset_id !== undefined ||
      v.image_asset_ids !== undefined ||
      v.tags !== undefined ||
      v.images !== undefined ||
      v.cover !== undefined ||
      v.inherit !== undefined,
    { message: 'at least one editable field is required' },
  )
  .refine((v) => v.images === undefined || v.image_asset_ids === undefined, {
    message: 'send images or image_asset_ids, not both',
  })
  .refine((v) => v.cover === undefined || v.cover_asset_id === undefined, {
    message: 'send cover or cover_asset_id, not both',
  });
export type PatchVariantRequest = z.input<typeof PatchVariantRequestSchema>;

/**
 * Generate drafts from the work's current original by fixed rules (no AI).
 * Platforms that already have a variant are left untouched and reported in
 * `skipped`; regenerate one with `POST …/variants/:platform/draft`.
 */
export const GenerateVariantsRequestSchema = z.object({
  platforms: z
    .array(PlatformSchema)
    .min(1)
    .default(['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels']),
});
export type GenerateVariantsRequest = z.input<typeof GenerateVariantsRequestSchema>;

export const GenerateVariantsResponseSchema = z.object({
  created: z.array(PlatformVariantRecordSchema),
  skipped: z.array(PlatformSchema),
});
export type GenerateVariantsResponse = z.infer<typeof GenerateVariantsResponseSchema>;

/**
 * Regenerate one platform's draft from the original. Creates the variant if
 * it does not exist (no base needed); otherwise needs `base_revision` or
 * `If-Match` and writes a new `draft` revision (history is kept).
 */
export const RedraftVariantRequestSchema = z.object({
  base_revision: z.number().int().positive().optional(),
});
export type RedraftVariantRequest = z.input<typeof RedraftVariantRequestSchema>;

export const VariantRevisionSchema = z.object({
  variant_id: IdSchema,
  platform: PlatformSchema,
  revision: z.number().int().positive(),
  source: VariantRevisionSourceSchema,
  ...VariantFieldsShape,
  /** Whether this revision followed the work's shared copy (QC-045/046). */
  inherit: z.boolean().optional(),
  cover: VariantCoverSchema.nullable().optional(),
  created_at: TimestampSchema,
});
export type VariantRevision = z.infer<typeof VariantRevisionSchema>;

export const VariantRevisionListResponseSchema = z.object({
  items: z.array(VariantRevisionSchema),
});
export type VariantRevisionListResponse = z.infer<typeof VariantRevisionListResponseSchema>;
