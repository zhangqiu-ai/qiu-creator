import { z } from 'zod';
import { AssetKindSchema, IdSchema, RevisionSchema, TimestampSchema } from './entities.js';

// ---- Revisions: read one, restore (QC-010) ----------------------------------

export const RevisionParamsSchema = z.object({ id: IdSchema, rid: IdSchema });

/** One historical revision with its full Markdown snapshot. */
export const RevisionDetailSchema = RevisionSchema.extend({
  /** Work title at the time of this revision. */
  title: z.string(),
  markdown: z.string(),
});
export type RevisionDetail = z.infer<typeof RevisionDetailSchema>;

/**
 * Restore an old revision. Requires `base_revision` (the revision the client
 * is looking at as current) or an `If-Match` header; a stale base returns 409.
 * Restoring never rewrites history: it appends a new `restore` revision whose
 * Markdown and title are copied from the chosen one.
 */
export const RestoreRevisionRequestSchema = z.object({
  base_revision: IdSchema.optional(),
});
export type RestoreRevisionRequest = z.input<typeof RestoreRevisionRequestSchema>;

// ---- Markdown media references (QC-010) -------------------------------------

/**
 * How one image/media reference in a work's Markdown resolved:
 * - `resolved`: a local file inside the work (managed: `assets/…`) or its mount; `url` streams it.
 * - `missing`: the path is allowed but no such file exists.
 * - `rejected`: the path escapes the work/mount root, crosses a symlink, or is not allowed.
 * - `unsupported`: the file exists but is not an allowed image/video/audio type (SVG, HTML, …).
 * - `remote`: an `http(s)://` URL; not fetched (use URL import to bring it in).
 * - `inline`: a `data:` URI; nothing to resolve.
 */
export const MediaRefStatusSchema = z.enum([
  'resolved',
  'missing',
  'rejected',
  'unsupported',
  'remote',
  'inline',
]);
export type MediaRefStatus = z.infer<typeof MediaRefStatusSchema>;

export const MediaRefSchema = z.object({
  /** The reference exactly as written in the Markdown (`![](src)` or `<img src>`). */
  src: z.string(),
  status: MediaRefStatusSchema,
  /**
   * Normalized path relative to the work folder (managed) or the mount root
   * (external), for `resolved` / `missing` / `unsupported`. Null otherwise.
   */
  path: z.string().nullable(),
  /** Registered asset for this file (external works are indexed in place, never moved). */
  asset_id: IdSchema.nullable(),
  kind: AssetKindSchema.nullable(),
  mime_type: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  /**
   * Short-lived signed URL, relative to the server base URL, usable without an
   * Authorization header (e.g. `<img src>` in the Electron renderer). Supports Range.
   */
  url: z.string().nullable(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

export const WorkMediaResponseSchema = z.object({
  work_id: IdSchema,
  /** Revision whose Markdown was scanned. */
  revision_id: IdSchema,
  items: z.array(MediaRefSchema),
  /** When the signed URLs in `items` stop working; call again to refresh. */
  expires_at: TimestampSchema,
});
export type WorkMediaResponse = z.infer<typeof WorkMediaResponseSchema>;

// ---- Signed media URLs ------------------------------------------------------

/** Unauthenticated (signature-checked) media routes live under this prefix. */
export const SIGNED_MEDIA_PREFIX = '/media/v1';

export const SignedAssetUrlsRequestSchema = z.object({
  asset_ids: z.array(IdSchema).min(1).max(200),
  variant: z.enum(['stream', 'thumbnail']).default('stream'),
});
export type SignedAssetUrlsRequest = z.input<typeof SignedAssetUrlsRequestSchema>;

export const SignedAssetUrlsResponseSchema = z.object({
  items: z.array(z.object({ asset_id: IdSchema, url: z.string() })),
  expires_at: TimestampSchema,
});
export type SignedAssetUrlsResponse = z.infer<typeof SignedAssetUrlsResponseSchema>;
