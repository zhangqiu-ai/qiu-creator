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
  'forbidden',
  'url_rejected',
  'idempotency_key_reused',
  'job_not_retryable',
  'source_missing',
  'mount_rejected',
  /** The provider's first-use notice has not been confirmed (or a newer version exists). */
  'ai_consent_required',
  /** No API key stored in the Keychain for this provider. */
  'ai_key_missing',
  /** Another update to the New API credential pair is still being saved. */
  'ai_credentials_busy',
  /** The job already finished, failed or was cancelled. */
  'job_not_cancellable',
  /** The AI job is not a succeeded rewrite of this work, so there is nothing to accept. */
  'ai_job_not_acceptable',
  /** The backup failed its integrity check or comes from a newer version (QC-030). */
  'backup_not_restorable',
  /** A restore was already accepted; the service is about to reload (QC-030). */
  'restore_in_progress',
  /** Writes are refused while the service switches to a restored database; retry shortly (503). */
  'restoring',
  /**
   * A backup could not be made (QC-030). On restore (409): the safety backup of
   * the current state failed, so nothing was restored and nothing changed.
   * On a manual backup (500): no copy was made. `details.reason` is a
   * `BackupFailureReason`, `details.detail` the untranslated technical text.
   */
  'backup_failed',
  /** The asset is used by works or platform variants; resend with `confirm: true` (409, QC-037). `details.references`. */
  'asset_in_use',
  /** The asset is in 最近刪除; restore it first (409, QC-037). */
  'asset_in_trash',
  /** The external file is not at its path any more (e.g. still in the macOS Trash); put it back first (409, QC-037). */
  'asset_file_missing',
  /** The original could not be moved to the macOS Trash; nothing changed (500, QC-037). */
  'trash_failed',
  /**
   * attach (QC-039): an external (mounted) work cannot take a copied-in file;
   * the app never writes into the user's own folders.
   */
  'attach_external_unsupported',
  /**
   * The work's front matter is not valid YAML, so the service will not rewrite
   * the file; fix it in the file first (409, QC-045/046).
   */
  'front_matter_invalid',
  /** The work is in 最近刪除; restore it before editing (409, QC-051). */
  'work_in_trash',
  /** No card image to serve: `details.reason` none/missing/needs_frame/decode_failed (404, QC-061). */
  'thumbnail_unavailable',
  /** The uploaded frame is for a video or time the work no longer uses as its card; reload (409, QC-061). */
  'thumbnail_frame_stale',
  /** The New API relay refused the stored key (401/403) while listing models (502, QC-054). */
  'ai_key_invalid',
  /** The relay could not be reached: `details.reason` timeout/dns/tls/connection/unavailable (502, QC-054). */
  'ai_gateway_unreachable',
  /** The relay answered, but not with a model list: `details.reason` (502, QC-054). */
  'ai_gateway_bad_response',
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
  /**
   * Git commit the build was made from; null when running from source (QC-030).
   * Absent from servers before QC-030, so clients still accept their answer.
   */
  commit: z.string().nullable().optional(),
  /** When the build artifact was made; null when running from source, absent before QC-030. */
  built_at: z.string().nullable().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MarkdownSchema = z.string().max(MAX_MARKDOWN_BYTES);

/** Longest description of an image or video work (QC-045/046), in characters. */
export const WORK_DESCRIPTION_MAX_CHARS = 20_000;
export const WorkDescriptionSchema = z.string().max(WORK_DESCRIPTION_MAX_CHARS);

export const CreateWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  /**
   * Articles: the Markdown. Image and video works: the whole file, front matter
   * included, if given; otherwise the service writes the front matter itself.
   */
  markdown: MarkdownSchema.default(''),
  /** Image and video works only (QC-045/046): the description below the front matter. */
  description: WorkDescriptionSchema.optional(),
  type: WorkTypeSchema.default('article'),
  status: WorkStatusSchema.default('drafting'),
  tags: TagsSchema.default([]),
  source: z.string().trim().min(1).max(200).default('api'),
});
export type CreateWorkRequest = z.input<typeof CreateWorkRequestSchema>;

// ---- Image-post and video works (QC-045/046) ----------------------------------------

/**
 * One image or video file of a work, as named in its front matter. `path` is
 * relative to the Markdown file; `asset_id` is the library asset it came from
 * (copied in through QC-039 attach) or, for external works, the asset indexing
 * the file in place; null when no asset matches.
 */
export const WorkMediaItemSchema = z.object({
  path: z.string(),
  asset_id: IdSchema.nullable(),
  kind: z.enum(['image', 'video']),
  /** `missing`: no readable file at `path` (deleted, moved, or its folder is not mounted). */
  status: z.enum(['present', 'missing']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  duration_seconds: z.number().nonnegative().nullable(),
});
export type WorkMediaItem = z.infer<typeof WorkMediaItemSchema>;

/** The cover: one image file, or a frame of the video. */
export const WorkMediaCoverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), item: WorkMediaItemSchema }),
  z.object({ kind: z.literal('frame'), time_seconds: z.number().nonnegative() }),
]);
export type WorkMediaCover = z.infer<typeof WorkMediaCoverSchema>;

export const WorkMediaSchema = z.object({
  /** In order. */
  images: z.array(WorkMediaItemSchema),
  cover: WorkMediaCoverSchema.nullable(),
  video: WorkMediaItemSchema.nullable(),
  /** The front matter is not valid YAML: nothing was read and the file will not be rewritten. */
  front_matter_invalid: z.boolean(),
  /** Front-matter fields with an unusable shape, read as empty (e.g. `images`). */
  warnings: z.array(z.string()),
});
export type WorkMedia = z.infer<typeof WorkMediaSchema>;

/** Cover in a write: an image (copied into the work like the images) or a video frame. */
export const WorkCoverRequestSchema = z.union([
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
export type WorkCoverRequest = z.input<typeof WorkCoverRequestSchema>;

/** Work plus its current Markdown body. */
export const WorkDetailSchema = WorkSchema.extend({
  /** The whole source file; for image and video works this includes the front matter. */
  markdown: z.string(),
  /** Image and video works: the text below the front matter; null for articles (QC-045/046). */
  description: z.string().nullable().optional(),
  /** Image and video works: their files from the front matter; null for articles (QC-045/046). */
  media: WorkMediaSchema.nullable().optional(),
});
export type WorkDetail = z.infer<typeof WorkDetailSchema>;

/** Most works `GET /api/v1/works?ids=` returns in one call (restoring editor tabs). */
export const WORKS_BY_IDS_MAX = 200;

export const ListWorksQuerySchema = z.object({
  /**
   * Comma-separated work ids (QC-045/046, restoring tabs): only these works, in
   * this order; `limit`/`offset` do not apply. Unknown ids are listed in `missing_ids`.
   */
  ids: z
    .string()
    .trim()
    .min(1)
    .transform((v) => [
      ...new Set(
        v
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== ''),
      ),
    ])
    .pipe(z.array(IdSchema).min(1).max(WORKS_BY_IDS_MAX))
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
  type: WorkTypeSchema.optional(),
  status: WorkStatusSchema.optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  /**
   * `active` (default): works not in 最近刪除. `trash`: only works in 最近刪除,
   * newest deletion first (QC-051). `ids` follows the scope too: works outside
   * it are listed in `missing_ids`.
   */
  scope: z.enum(['active', 'trash']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
/** Client-side query shape: every field optional, numbers as numbers; `ids` as a list. */
export type ListWorksQuery = Partial<Omit<z.output<typeof ListWorksQuerySchema>, 'ids'>> & {
  ids?: string[];
};

/** What a library card shows (QC-045/046). */
export const WorkThumbnailSchema = z.object({
  /** Library asset of the file, when one matches; otherwise use `path` with the work-files route. */
  asset_id: IdSchema.nullable(),
  /** Relative to the work's Markdown file. */
  path: z.string(),
  kind: z.enum(['image', 'video']),
  /** For a video frame cover. */
  time_seconds: z.number().nonnegative().optional(),
});
export type WorkThumbnail = z.infer<typeof WorkThumbnailSchema>;

/** Longest `excerpt` on a library card, in characters (QC-061). */
export const WORK_EXCERPT_MAX_CHARS = 120;
/** Largest frame the app may upload for a video card (QC-061). */
export const THUMBNAIL_FRAME_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The image a library card shows (QC-061), served as WebP by
 * `GET /api/v1/works/:id/thumbnail?v=<version>`.
 */
export const WorkCardImageSchema = z.object({
  /** Fingerprint of the source (file, size, mtime, frame time); changes whenever the image would. */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  /**
   * A video work without an image cover whose frame the server cannot take
   * (no ffmpeg, or ffmpeg could not decode it): the app captures the frame at
   * `frame_source` and uploads it with `PUT /works/:id/thumbnail-frame`. Until
   * then GET answers 404 `thumbnail_unavailable` (`needs_frame`).
   */
  needs_frame: z.boolean(),
  /**
   * Signed, server-relative URL of the image for `<img src>` (use
   * `media.absoluteUrl`); no Authorization header needed. Null while
   * `needs_frame`. Valid until at least an hour after the list was served,
   * and the same for every list served within the same hour (cacheable).
   */
  url: z.string().nullable(),
  frame_source: z
    .object({
      /** Library asset of the video when known; otherwise use `path` (as in `works.media`). */
      asset_id: IdSchema.nullable(),
      /** Relative to the work's Markdown file, as in front matter and `works.media` items. */
      path: z.string(),
      /** The cover time, or 0 without one. */
      time_seconds: z.number().nonnegative(),
    })
    .optional(),
});
export type WorkCardImage = z.infer<typeof WorkCardImageSchema>;

export const WorkListItemSchema = WorkSchema.extend({
  /** Cover, else the first image, else the video; null for articles and empty works. */
  thumbnail: WorkThumbnailSchema.nullable().optional(),
  /** Image works: number of images; null otherwise. */
  image_count: z.number().int().nonnegative().nullable().optional(),
  /** Video works: length of the video when known; null otherwise. */
  duration_seconds: z.number().nonnegative().nullable().optional(),
  /** From the video, else the cover or first image; null when the size is unknown. */
  orientation: z.enum(['portrait', 'landscape', 'square']).nullable().optional(),
  /** How many image or video files named in the front matter are missing. */
  missing_media: z.number().int().nonnegative().optional(),
  /**
   * The card image (QC-061): image cover, first image, video frame, or for
   * articles the front-matter cover or first local Markdown image. Null when
   * there is none or its file is missing (show the type icon).
   */
  card_image: WorkCardImageSchema.nullable().optional(),
  /**
   * Plain-text preview for text cards (QC-061), at most `WORK_EXCERPT_MAX_CHARS`:
   * articles without front matter, the first H1, images and Markdown syntax;
   * image and video works use their description. Null when there is no text.
   */
  excerpt: z.string().nullable().optional(),
});
export type WorkListItem = z.infer<typeof WorkListItemSchema>;

export const ListWorksResponseSchema = z.object({
  items: z.array(WorkListItemSchema),
  /** With `ids`: the requested ids that do not exist (or are outside `scope`). */
  missing_ids: z.array(IdSchema).optional(),
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
    /** Image and video works (QC-045/046): the text below the front matter. */
    description: WorkDescriptionSchema.optional(),
    /**
     * Image works: the complete ordered list of images as library asset ids.
     * Files not yet in the work are copied into its `assets/` (QC-039 attach).
     */
    images: z
      .array(IdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'images must not repeat')
      .optional(),
    /** Image or video frame; null removes the cover. */
    cover: WorkCoverRequestSchema.nullable().optional(),
    /** Video works: the video's library asset; null removes it. */
    video_asset_id: IdSchema.nullable().optional(),
    /**
     * Adopting AI suggestions (QC-046): the succeeded AI job they came from; the
     * write becomes an `ai_accepted` revision instead of `edit`.
     */
    ai_job_id: IdSchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.markdown !== undefined ||
      v.type !== undefined ||
      v.status !== undefined ||
      v.tags !== undefined ||
      v.description !== undefined ||
      v.images !== undefined ||
      v.cover !== undefined ||
      v.video_asset_id !== undefined,
    { message: 'at least one editable field is required' },
  )
  .refine((v) => v.markdown === undefined || v.description === undefined, {
    message: 'send markdown or description, not both',
  });
export type PatchWorkRequest = z.input<typeof PatchWorkRequestSchema>;

export const RevisionListResponseSchema = z.object({ items: z.array(RevisionSchema) });
export type RevisionListResponse = z.infer<typeof RevisionListResponseSchema>;

export const AssetIdParamsSchema = z.object({ id: IdSchema });

/** `GET /api/v1/works/:id/thumbnail` (QC-061); `v` is the card's `version`, for caching. */
export const WorkThumbnailQuerySchema = z.object({
  v: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

/** `PUT /api/v1/works/:id/thumbnail-frame` query (QC-061): which frame the body is. */
export const ThumbnailFrameQuerySchema = z.object({
  /**
   * `card_image.version` the frame was captured for. A frame captured before
   * the video or cover changed is refused (409), never stored over the new one.
   */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  /** `card_image.frame_source.path`. */
  source: z.string().min(1).max(1024),
  /** `card_image.frame_source.time_seconds`. */
  time_seconds: z.coerce.number().nonnegative().max(86_400),
});
export type ThumbnailFrameQuery = z.input<typeof ThumbnailFrameQuerySchema>;

export const ThumbnailFrameResponseSchema = z.object({ card_image: WorkCardImageSchema });
export type ThumbnailFrameResponse = z.infer<typeof ThumbnailFrameResponseSchema>;
