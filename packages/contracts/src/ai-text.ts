import { z } from 'zod';
import {
  AiProviderSchema,
  CreateAiJobResponseSchema,
  RewriteModeSchema,
  SuggestionFieldSchema,
} from './ai.js';
import {
  AiConcreteLanguageSchema,
  AiLanguageRequestShape,
  AiLanguageSourceSchema,
  AiModelSourceSchema,
  PromptIdSchema,
} from './ai-prompts.js';

/** What a candidate says about how it was written (QC-075); absent on older jobs. */
const CandidateMarks = {
  /** The language the AI was told to write in (never `follow`). */
  language: AiConcreteLanguageSchema.optional(),
  /** `prompt` = 「prompt 指定」. */
  language_source: AiLanguageSourceSchema.optional(),
  model_source: AiModelSourceSchema.optional(),
};
import { IdSchema, PlatformSchema, TagSchema } from './entities.js';
import { MarkdownSchema } from './api.js';
import { VariantWarningSchema } from './variants.js';

/**
 * Text AI tasks (QC-022). Both kinds run as AI jobs on the QC-021 runner:
 * stop = `POST /api/v1/ai/jobs/:id/cancel`, retry = `POST /api/v1/ai/jobs/:id/retry`
 * (a retry replays the same prompt, so it stays on the same source revision).
 * Results are candidates only; nothing is written until the user accepts.
 */

const ModelSchema = z.string().trim().min(1).max(100);
const AiRunSchema = {
  provider: AiProviderSchema,
  /** Omitted: the prompt's default model (same provider), else the provider's text model. */
  model: ModelSchema.optional(),
  /**
   * Output language (QC-075); omitted: the preference. A prompt with its own
   * language wins; `follow` detects the source (the selection).
   */
  ...AiLanguageRequestShape,
  /**
   * A prompt-library entry (QC-075), its variables expanded on the server.
   * Its own model and language win over the request's. Rewrites: its content
   * is the instruction (built-ins map to their mode); suggestions: a `title`
   * prompt adds to the request. Another scene: 400.
   */
  prompt_id: PromptIdSchema.optional(),
};

// ---- Platform suggestions ---------------------------------------------------------

const ALL_PLATFORMS = PlatformSchema.options;
const ALL_FIELDS = SuggestionFieldSchema.options;

export const PlatformSuggestionsRequestSchema = z.object({
  ...AiRunSchema,
  platforms: z
    .array(PlatformSchema)
    .min(1)
    .max(4)
    .default([...ALL_PLATFORMS]),
  fields: z
    .array(SuggestionFieldSchema)
    .min(1)
    .max(3)
    .default([...ALL_FIELDS]),
  /** Candidates per field and platform. */
  count: z.number().int().min(1).max(5).default(3),
});
export type PlatformSuggestionsRequest = z.input<typeof PlatformSuggestionsRequestSchema>;

/** One text candidate with its limit warnings (never blocking). */
export const TextCandidateSchema = z.object({
  text: z.string(),
  warnings: z.array(VariantWarningSchema),
});
export type TextCandidate = z.infer<typeof TextCandidateSchema>;

export const TagsCandidateSchema = z.object({
  tags: z.array(TagSchema),
  warnings: z.array(VariantWarningSchema),
});
export type TagsCandidate = z.infer<typeof TagsCandidateSchema>;

/** `result.json` of a succeeded platform-suggestions job. Fields not requested are omitted. */
export const PlatformSuggestionsResultSchema = z.object({
  type: z.literal('platform_suggestions'),
  platforms: z.array(
    z.object({
      platform: PlatformSchema,
      titles: z.array(TextCandidateSchema).optional(),
      /** Short intro text; checked against the platform's body limit. */
      summaries: z.array(TextCandidateSchema).optional(),
      tags: z.array(TagsCandidateSchema).optional(),
    }),
  ),
  ...CandidateMarks,
});
export type PlatformSuggestionsResult = z.infer<typeof PlatformSuggestionsResultSchema>;

// ---- Rewrite ----------------------------------------------------------------------------

export const RewriteRequestSchema = z
  .object({
    ...AiRunSchema,
    /** Optional with `prompt_id` (then `custom`, or the built-in's own mode). */
    mode: RewriteModeSchema.optional(),
    /** Target tone for `tone`, e.g. 「輕鬆口語」. */
    tone: z.string().trim().min(1).max(100).optional(),
    /** Extra instruction; required for `custom`, optional otherwise. */
    instruction: z.string().trim().min(1).max(2000).optional(),
    /**
     * Rewrite only this range of the source revision's Markdown (UTF-16
     * offsets, `end` exclusive). Omit to rewrite the whole text.
     */
    selection: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
      .refine((s) => s.end > s.start, 'selection.end must be after selection.start')
      .optional(),
  })
  .refine((r) => r.mode !== undefined || r.prompt_id !== undefined, {
    message: 'send a mode or a prompt_id',
    path: ['mode'],
  })
  .refine(
    (r) =>
      r.mode !== 'custom' ||
      r.instruction !== undefined ||
      (r.prompt_id !== undefined && !r.prompt_id.startsWith('builtin-')),
    { message: 'custom rewrites need an instruction or a prompt', path: ['instruction'] },
  )
  .refine((r) => r.mode !== 'tone' || r.tone !== undefined, {
    message: 'tone rewrites need a tone',
    path: ['tone'],
  });
export type RewriteRequest = z.input<typeof RewriteRequestSchema>;

/** `result.json` of a succeeded rewrite job. */
export const RewriteResultSchema = z.object({
  type: z.literal('rewrite'),
  /** The revision the candidate was written from; accepting uses it as `base_revision`. */
  source_revision: IdSchema,
  /** Rewritten text for the selection, or for the whole document. */
  text: z.string(),
  /** Range of the source Markdown that `text` replaces (whole document when no selection). */
  range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  /** Full document with `text` spliced in, for "accept all". */
  full_markdown: z.string(),
  ...CandidateMarks,
});
export type RewriteResult = z.infer<typeof RewriteResultSchema>;

/**
 * Accept a rewrite. The client sends the final full text it composed (all,
 * part or edited); the server never merges. Written with
 * `base_revision = source_revision`: if the work changed since, 409.
 */
export const AcceptRewriteRequestSchema = z.object({
  markdown: MarkdownSchema,
  title: z.string().trim().min(1).max(500).optional(),
});
export type AcceptRewriteRequest = z.input<typeof AcceptRewriteRequestSchema>;

export const WorkAiJobParamsSchema = z.object({ id: IdSchema, jobId: IdSchema });

/**
 * Response of `POST /works/:id/ai/rewrite` and `/ai/suggestions` (QC-029):
 * the queued job plus whether it is one that was already queued or running.
 */
export const WorkAiJobResponseSchema = CreateAiJobResponseSchema.extend({
  /**
   * True: an identical request (same work, same parameters, same
   * `source_revision`) is already queued or running, and `job` is that one;
   * nothing new was sent or charged. Finished jobs never count: asking again
   * after one finishes generates again.
   */
  in_progress: z.boolean(),
});
export type WorkAiJobResponse = z.infer<typeof WorkAiJobResponseSchema>;
