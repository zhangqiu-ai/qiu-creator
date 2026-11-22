import { z } from 'zod';
import { AiProviderSchema } from './ai.js';
import { TimestampSchema } from './entities.js';

/**
 * Models a New API relay offers to the stored key (QC-054), for the settings
 * dropdown. `GET /api/v1/ai/providers/new-api/models`, owner token only.
 */

/**
 * - `chat`: a known chat/text model family with no non-chat marker.
 * - `image`: image generation (e.g. `gpt-image-2`, `dall-e-3`, `flux…`).
 * - `unknown`: everything else — custom relay names, and audio, embedding,
 *   moderation or rerank models. Never hidden by the server.
 */
export const AiModelKindSchema = z.enum(['chat', 'image', 'unknown']);
export type AiModelKind = z.infer<typeof AiModelKindSchema>;

export const AiRelayModelSchema = z.object({
  /** Exactly as the relay lists it in `data[].id`; save it as `text_model`. */
  id: z.string().min(1).max(200),
  kind: AiModelKindSchema,
  /** A price override exists in AI settings, so costs can be estimated. */
  priced: z.boolean(),
});
export type AiRelayModel = z.infer<typeof AiRelayModelSchema>;

export const AiProviderModelsQuerySchema = z.object({
  /** `1` skips the cache and asks the relay again. */
  refresh: z.enum(['0', '1']).optional(),
});
export type AiProviderModelsQuery = z.input<typeof AiProviderModelsQuerySchema>;

export const AiProviderModelsResponseSchema = z.object({
  provider: AiProviderSchema,
  /** Sorted by id; duplicates removed. */
  models: z.array(AiRelayModelSchema),
  /** When the relay was asked; older than now when served from the cache. */
  fetched_at: TimestampSchema,
});
export type AiProviderModelsResponse = z.infer<typeof AiProviderModelsResponseSchema>;

/** 測試連線 gives up after this long (QC-057), or sooner if the adapter's timeout is shorter. */
export const AI_TEST_TIMEOUT_MS = 10_000;

/** How long the server reuses a model list for the same key and Base URL. */
export const AI_MODELS_CACHE_SECONDS = 600;

/** Largest model-list response the server reads from a relay. */
export const AI_MODELS_MAX_BYTES = 2 * 1024 * 1024;

/** Why the relay could not be reached (`ai_gateway_unreachable`, `details.reason`). */
export const AiGatewayUnreachableReasonSchema = z.enum([
  'timeout',
  'dns',
  'tls',
  'connection',
  /** 5xx from the provider; `details.status`. */
  'unavailable',
  /** 402, or 429 whose error says quota, billing or balance (`insufficient_quota`, `RESOURCE_EXHAUSTED`…); `details.status` (QC-057). */
  'quota',
  /** Any other 429: a plain rate limit, try again shortly; `details.status` (QC-057). */
  'rate_limited',
]);
export type AiGatewayUnreachableReason = z.infer<typeof AiGatewayUnreachableReasonSchema>;

/**
 * `POST /api/v1/ai/providers/:provider/test` (QC-057): one model-list GET
 * with the stored key, sent only when the user presses 測試連線. It sends no
 * content and costs nothing, so no consent is needed.
 */
export const AiProviderTestResponseSchema = z.object({
  provider: AiProviderSchema,
  ok: z.boolean(),
  /** Time to the full answer (or the failure), in milliseconds. */
  latency_ms: z.number().int().nonnegative(),
  /** Models the key can use; null when the test failed. */
  model_count: z.number().int().nonnegative().nullable(),
  /**
   * Whether the configured text model is in that list; null when the test
   * failed. False is a hint, not an error: some relays list fewer models than they serve.
   */
  text_model_listed: z.boolean().nullable(),
  /** Same shape as an error response's `error`: `ai_key_invalid`, `ai_gateway_unreachable`, `ai_gateway_bad_response`. */
  error: z
    .object({
      code: z.enum(['ai_key_invalid', 'ai_gateway_unreachable', 'ai_gateway_bad_response']),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  tested_at: TimestampSchema,
});
export type AiProviderTestResponse = z.infer<typeof AiProviderTestResponseSchema>;

/** Why the relay's answer was not a model list (`ai_gateway_bad_response`, `details.reason`). */
export const AiGatewayBadResponseReasonSchema = z.enum([
  'not_json',
  /** JSON without a `data` array of `{ id }` objects. */
  'missing_data',
  /** Larger than `AI_MODELS_MAX_BYTES`. */
  'too_large',
  /** Any other HTTP status (e.g. 404 when the Base URL path is wrong); `details.status`. */
  'unexpected_status',
  /** The relay redirected; redirects are not followed so the key goes nowhere else. */
  'redirect',
]);
export type AiGatewayBadResponseReason = z.infer<typeof AiGatewayBadResponseReasonSchema>;

const IMAGE_MARKERS = [
  'image',
  'dall-e',
  'dalle',
  'imagen',
  'flux',
  'midjourney',
  'stable-diffusion',
  'sdxl',
  'sd3',
  'seedream',
  'kolors',
  'cogview',
  'recraft',
  'ideogram',
];

const NON_CHAT_MARKERS = [
  'tts',
  'whisper',
  'transcribe',
  'speech',
  'audio',
  'embed',
  'moderation',
  'rerank',
  'realtime',
  'video',
  'sora',
  'veo',
];

const CHAT_FAMILIES =
  /^(gpt-|chatgpt|o[1-9](-|$)|claude|gemini|gemma|deepseek|qwen|qwq|glm|chatglm|kimi|moonshot|llama|mistral|mixtral|codestral|grok|doubao|ernie|hunyuan|yi-|baichuan|minimax|abab|step-|internlm|phi-|command)/;

/**
 * Conservative kind of a model id: image markers win, then any non-chat
 * marker makes it `unknown`, and only a known chat family is `chat`.
 * Vendor prefixes such as `openai/` or `models/` are ignored.
 */
export function classifyModelKind(id: string): AiModelKind {
  const name = id.trim().toLowerCase();
  const bare = name.slice(name.lastIndexOf('/') + 1);
  if (IMAGE_MARKERS.some((m) => name.includes(m))) return 'image';
  if (NON_CHAT_MARKERS.some((m) => name.includes(m))) return 'unknown';
  return CHAT_FAMILIES.test(bare) ? 'chat' : 'unknown';
}
