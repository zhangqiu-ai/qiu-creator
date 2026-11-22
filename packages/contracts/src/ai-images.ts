import { z } from 'zod';
import { AiBudgetStatusSchema, AiCostEstimateSchema } from './ai.js';
import { WorkDetailSchema } from './api.js';
import { PromptIdSchema } from './ai-prompts.js';
import { IdSchema, PlatformSchema, TimestampSchema } from './entities.js';

/**
 * AI image and cover generation (QC-070), New API only: `POST
 * {base_url}/images/generations` (OpenAI-compatible). Runs as an AI job on the
 * QC-021 runner (cancel and retry as usual; never retried automatically, so a
 * slow generation is not paid for twice). Results are candidates in a
 * temporary cache; nothing is written to the work until the user keeps one.
 */

/** Aspect ratios offered; 3:4 is 小紅書, 2.35:1 公眾號 頭條封面. */
export const AI_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '2.35:1',
  '6:7',
] as const;
export const AiImageAspectRatioSchema = z.enum(AI_IMAGE_ASPECT_RATIOS);
export type AiImageAspectRatio = z.infer<typeof AiImageAspectRatioSchema>;

/** Cover ratio of each platform (QC-076): 小紅書 3:4, 公眾號 2.35:1, 抖音 3:4, 視頻號 6:7. */
export const PLATFORM_COVER_RATIOS = {
  xiaohongshu: '3:4',
  wechat_mp: '2.35:1',
  douyin: '3:4',
  wechat_channels: '6:7',
} as const satisfies Record<string, AiImageAspectRatio>;

/** Most images one job asks for. */
export const AI_IMAGE_MAX_COUNT = 4;
/** Largest image accepted from the relay, decoded (base64) or downloaded (URL). */
export const AI_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** How long an unkept candidate stays in the temporary cache. */
export const AI_IMAGE_CANDIDATE_TTL_HOURS = 24;

export const AiImageRequestSchema = z
  .object({
    provider: z.literal('new-api'),
    /** An image model from `GET /api/v1/ai/providers/new-api/models` (`kind: image`). */
    model: z.string().trim().min(1).max(100),
    /**
     * `image`: an image from `prompt` (e.g. the selected text).
     * `cover`: a cover from the work's title and text; `prompt` adds to it.
     */
    purpose: z.enum(['image', 'cover']),
    prompt: z.string().trim().min(1).max(4000).optional(),
    /** Style words, e.g. 「水彩」「扁平插畫」. */
    style: z.string().trim().min(1).max(200).optional(),
    /** Omitted: the platform's cover ratio with `platform`, else 1:1. */
    aspect_ratio: AiImageAspectRatioSchema.optional(),
    /**
     * A cover for this platform's version (QC-076): its cover ratio and name
     * (`{平台}`) go into the request. Keep it with `placement: library`, then
     * set it as the variant's cover with `PATCH /works/:id/variants/:platform`.
     */
    platform: PlatformSchema.optional(),
    n: z.number().int().min(1).max(AI_IMAGE_MAX_COUNT).default(1),
    /** The revision the prompt was taken from; defaults to the current one. */
    source_revision: IdSchema.optional(),
    /**
     * An `image` prompt-library entry (QC-075): its expanded body is the
     * prompt (`cover`: added to the cover request); `prompt` then adds to it.
     */
    prompt_id: PromptIdSchema.optional(),
  })
  .refine((r) => r.purpose !== 'image' || r.prompt !== undefined || r.prompt_id !== undefined, {
    message: 'image generation needs a prompt',
    path: ['prompt'],
  });
export type AiImageRequest = z.input<typeof AiImageRequestSchema>;

export const AiImageEstimateResponseSchema = z.object({
  /** `max_cost_usd` is null when the model has no `per_image_usd` price (「無法預估」). */
  estimate: AiCostEstimateSchema,
  budget: AiBudgetStatusSchema,
});
export type AiImageEstimateResponse = z.infer<typeof AiImageEstimateResponseSchema>;

export const AiImageCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.enum(['image/png', 'image/jpeg']),
  bytes: z.number().int().positive(),
  /**
   * True once the candidate left the temporary cache (kept, discarded, or
   * older than `AI_IMAGE_CANDIDATE_TTL_HOURS`); `url` is then null.
   */
  expired: z.boolean(),
  /**
   * Signed, server-relative URL for `<img src>` (use `media.absoluteUrl`); no
   * Authorization header needed. Signed afresh on every read of the job.
   */
  url: z.string().nullable(),
  expires_at: TimestampSchema.nullable(),
});
export type AiImageCandidate = z.infer<typeof AiImageCandidateSchema>;

/** `result.json` of a succeeded image job. */
export const AiImageResultSchema = z.object({
  type: z.literal('image_generation'),
  source_revision: IdSchema,
  purpose: z.enum(['image', 'cover']),
  aspect_ratio: AiImageAspectRatioSchema,
  candidates: z.array(AiImageCandidateSchema),
});
export type AiImageResult = z.infer<typeof AiImageResultSchema>;

export const AiImagePlacementSchema = z.discriminatedUnion('type', [
  /**
   * A paragraph `![alt](assets/…)` at `offset` (UTF-16, in the Markdown of
   * `base_revision`); moved to the nearest line boundary.
   */
  z.object({
    type: z.literal('insert'),
    offset: z.number().int().nonnegative(),
    alt: z.string().trim().max(200).optional(),
  }),
  /** `cover: assets/…` in the front matter. */
  z.object({ type: z.literal('cover') }),
  /** Only into the library (素材庫); the work is not changed. */
  z.object({ type: z.literal('library') }),
]);
export type AiImagePlacement = z.infer<typeof AiImagePlacementSchema>;

/**
 * Keep a candidate: it is added to the library, copied into the work's
 * `assets/`, and (insert, cover) written as an `ai_accepted` revision on
 * `base_revision`; if the work changed since, 409 `revision_conflict` and
 * nothing is written. Several candidates of one job can be kept in turn.
 */
export const AiImageKeepRequestSchema = z.object({
  index: z.number().int().nonnegative(),
  base_revision: IdSchema,
  placement: AiImagePlacementSchema,
});
export type AiImageKeepRequest = z.input<typeof AiImageKeepRequestSchema>;

export const AiImageKeepResponseSchema = z.object({
  /** The work after the change (`library`: as it was). */
  work: WorkDetailSchema,
  asset_id: IdSchema,
  /** Path of the copy, relative to the work's Markdown file (`assets/…`). */
  src: z.string(),
});
export type AiImageKeepResponse = z.infer<typeof AiImageKeepResponseSchema>;

export const AiImageCandidateParamsSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  index: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(AI_IMAGE_MAX_COUNT - 1),
});
