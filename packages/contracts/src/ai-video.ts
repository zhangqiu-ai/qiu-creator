import { z } from 'zod';
import { AiBudgetStatusSchema, AiCostEstimateSchema, AiJobRecordSchema } from './ai.js';
import { IdSchema } from './entities.js';

/**
 * Gemini native video understanding (QC-023). Values checked against the
 * official Gemini API docs on 2026-11-17 (Files API, video understanding):
 * they change, so they live here as one adjustable table.
 */
export const GEMINI_VIDEO_LIMITS = {
  checkedAt: '2026-11-17',
  /** Files API per-file maximum. */
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  /** Uploaded files are deleted by Google after this long. */
  retentionHours: 48,
  /** 1M-context models: about 1 hour at default media resolution, 3 hours at low. */
  maxDurationSeconds: { default: 60 * 60, low: 3 * 60 * 60 },
  /** Approximate video+audio tokens per second (1 frame/s plus 32 audio tokens/s). */
  tokensPerSecond: { default: 300, low: 100 },
  /** MIME types the docs list for video understanding. */
  mimeTypes: [
    'video/mp4',
    'video/mpeg',
    'video/mov',
    'video/avi',
    'video/x-flv',
    'video/mpg',
    'video/webm',
    'video/wmv',
    'video/3gpp',
  ],
} as const;

export const VideoResolutionSchema = z.enum(['default', 'low']);
export type VideoResolution = z.infer<typeof VideoResolutionSchema>;

export const VideoUnderstandingRequestSchema = z.object({
  /** Gemini model; defaults to the provider's configured video model. */
  model: z.string().trim().min(1).max(100).optional(),
  /** `low` sends fewer tokens per frame: cheaper and allows up to ~3 h. */
  resolution: VideoResolutionSchema.default('default'),
  /**
   * Ignore an earlier result for the same file, task and model settings and
   * analyse (and pay) again. Without it a cached result is returned.
   */
  reanalyze: z.boolean().default(false),
  /** Optional work to file the job under. */
  work_id: IdSchema.optional(),
});
export type VideoUnderstandingRequest = z.input<typeof VideoUnderstandingRequestSchema>;

export const VideoEstimateSchema = z.object({
  estimate: AiCostEstimateSchema,
  budget: AiBudgetStatusSchema,
  size_bytes: z.number().int().nonnegative(),
  duration_seconds: z.number().nonnegative(),
  /** `metadata` = from ffprobe; `size_guess` = guessed from the file size (no duration known). */
  duration_source: z.enum(['metadata', 'size_guess']),
  model: z.string(),
  resolution: VideoResolutionSchema,
  /** A finished analysis with the same cache key, reusable for free. */
  cached_job_id: IdSchema.nullable(),
});
export type VideoEstimate = z.infer<typeof VideoEstimateSchema>;

export const VideoUnderstandingResponseSchema = z.object({
  /** True: `job` is an earlier finished analysis; nothing was sent or charged. */
  cached: z.boolean(),
  /** True: an identical analysis is already queued or running; `job` is that one. */
  in_progress: z.boolean(),
  job: AiJobRecordSchema,
  budget: AiBudgetStatusSchema.nullable(),
});
export type VideoUnderstandingResponse = z.infer<typeof VideoUnderstandingResponseSchema>;

const MomentSchema = z.object({
  /** Seconds from the start, as reported by the model. */
  time_seconds: z.number().nonnegative(),
  label: z.string(),
  description: z.string(),
  /** Always true: times and content come from the model and must be checked. */
  needs_verification: z.literal(true),
  /** False when the time lies beyond the video's duration; null when the duration is unknown. */
  within_duration: z.boolean().nullable(),
});

/** `result.json` of a succeeded video-understanding job. */
export const VideoUnderstandingResultSchema = z.object({
  type: z.literal('video_understanding'),
  disclaimer: z.string(),
  summary: z.string(),
  key_moments: z.array(MomentSchema),
  title_suggestions: z.array(z.string()),
  description_suggestions: z.array(z.string()),
  /** Cover frames as time points; the client grabs the frame itself. */
  cover_suggestions: z.array(MomentSchema),
});
export type VideoUnderstandingResult = z.infer<typeof VideoUnderstandingResultSchema>;
