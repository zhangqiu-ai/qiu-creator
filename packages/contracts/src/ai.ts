import { z } from 'zod';
import { AIActionSchema, IdSchema, PlatformSchema, TimestampSchema } from './entities.js';

// ---- Providers ------------------------------------------------------------------

/**
 * Cloud AI providers: text via every provider, video via
 * Gemini. Local models are deferred; the server keeps the provider interface
 * open for them but they are not part of this enum yet.
 */
export const AiProviderSchema = z.enum(['gemini', 'anthropic', 'openai', 'new-api']);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const AI_PROVIDER_NAMES: Readonly<Record<AiProvider, { name: string; company: string }>> = {
  gemini: { name: 'Gemini', company: 'Google' },
  anthropic: { name: 'Claude', company: 'Anthropic' },
  openai: { name: 'GPT', company: 'OpenAI' },
  'new-api': { name: 'New API', company: '你設定的 New API 中轉站' },
};

/** Default models; the user can change them per provider. */
export const AI_DEFAULT_MODELS: Readonly<
  Record<AiProvider, { text: string; video: string | null }>
> = {
  gemini: { text: 'gemini-3.8-flash', video: 'gemini-3.8-flash' },
  anthropic: { text: 'claude-opus-5-5', video: null },
  openai: { text: 'gpt-5.5', video: null },
  'new-api': { text: 'gpt-4o-mini', video: null },
};

/**
 * Version of the first-use notice. Raising it asks every provider for a new
 * confirmation, e.g. when the notice text changes materially.
 */
export const AI_NOTICE_VERSION = 1;

/** First-use notice: what is sent where. Shown before the user can enable a provider. */
export function aiConsentNotice(provider: AiProvider): string {
  if (provider === 'new-api') {
    return [
      '你主動送出的作品文字會傳到你設定的 New API 中轉站，由中轉站轉送給模型供應商。',
      '中轉站和模型供應商可能依各自的設定及條款保留內容。費用依中轉站的計價為準。',
    ].join('\n');
  }
  const { name, company } = AI_PROVIDER_NAMES[provider];
  return [
    `使用 ${name} 時，你主動送出的內容（作品標題、正文、標籤，以及你選擇的圖片或視頻）會經網路傳送到 ${company} 的伺服器處理。`,
    `${company} 依其服務條款處理與保留這些資料；本 App 不會在你沒有操作時自動送出任何內容。`,
    '費用由你的 API 金鑰帳戶支付，App 顯示的金額是依參考價格的估算。',
  ].join('\n');
}

// ---- Prices -----------------------------------------------------------------------

export interface AiModelPrice {
  /** USD per 1M input tokens. */
  input_per_mtok: number;
  /** USD per 1M output tokens (including thinking where the provider bills it). */
  output_per_mtok: number;
}

/**
 * **參考價格、可調。** Standard short-context list prices from each provider's
 * official pricing page on 2026-11-17, in USD per 1M tokens. Providers change
 * them (Google has announced Gemini increases on 2026-12-01 and 2027-01-01);
 * the user can override any model in AI settings. Costs computed from them
 * are always labelled as estimates.
 */
export const AI_PRICES_AS_OF = '2026-11-17';
export const AI_PRICE_TABLE: Readonly<Record<string, AiModelPrice>> = {
  // Anthropic
  'claude-opus-5-5': { input_per_mtok: 4, output_per_mtok: 20 },
  'claude-sonnet-5-5': { input_per_mtok: 2, output_per_mtok: 10 },
  'claude-haiku-5-5': { input_per_mtok: 0.1, output_per_mtok: 0.5 },
  'claude-fable-5-2': { input_per_mtok: 8, output_per_mtok: 40 },
  // OpenAI
  'gpt-5.5': { input_per_mtok: 5, output_per_mtok: 30 },
  'gpt-5.4': { input_per_mtok: 2.5, output_per_mtok: 15 },
  'gpt-5.4-mini': { input_per_mtok: 0.75, output_per_mtok: 4.5 },
  'gpt-5-mini': { input_per_mtok: 0.25, output_per_mtok: 2 },
  // Google (text/image/video input at the same rate unless noted)
  'gemini-3.8-flash': { input_per_mtok: 0.75, output_per_mtok: 3.75 },
  'gemini-3.5-flash-lite': { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  'gemini-4-hydrogen': { input_per_mtok: 1.5, output_per_mtok: 7.5 },
};

const ModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:/-]+$/, 'model names use letters, digits and . _ : / -');

export const AiModelPriceSchema = z.object({
  input_per_mtok: z.number().nonnegative().max(10_000),
  output_per_mtok: z.number().nonnegative().max(10_000),
});

// ---- Provider status, keys, consent ------------------------------------------------

export const AiProviderStatusSchema = z.object({
  provider: AiProviderSchema,
  name: z.string(),
  company: z.string(),
  /** Whether a key is stored in the Mac's Keychain. The key itself is never returned. */
  key_configured: z.boolean(),
  key_updated_at: TimestampSchema.nullable(),
  text_model: z.string(),
  /** Only Gemini handles video; null elsewhere. */
  video_model: z.string().nullable(),
  /** The notice the user must confirm before anything is sent to this provider. */
  notice: z.object({
    version: z.number().int().positive(),
    text: z.string(),
    /** Identifies the New API endpoint and key pairing this notice applies to. */
    credential_id: IdSchema.optional(),
  }),
  /** Confirmation of the current notice version, or null when not (or no longer) confirmed. */
  consent: z.object({ version: z.number().int().positive(), at: TimestampSchema }).nullable(),
  /** Key and current consent present: jobs can be submitted. */
  ready: z.boolean(),
});
export type AiProviderStatus = z.infer<typeof AiProviderStatusSchema>;

export const AiProviderListResponseSchema = z.object({ items: z.array(AiProviderStatusSchema) });
export type AiProviderListResponse = z.infer<typeof AiProviderListResponseSchema>;

export const AiProviderParamsSchema = z.object({ provider: AiProviderSchema });

const NewApiBaseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      !/[?#]/.test(value) &&
      /\/v1\/?$/.test(url.pathname) &&
      !url.pathname.endsWith('/v1/v1') &&
      !url.pathname.endsWith('/v1/v1/')
    );
  }, 'use an HTTPS Base URL ending in /v1, without credentials, query or fragment')
  .transform((value) => new URL(value).href.replace(/\/$/, ''));

/** Store a key in the Keychain. The New API key and base URL are written together. */
export const SetAiKeyRequestSchema = z.object({
  api_key: z
    .string()
    .min(8, 'API key looks too short')
    .max(512, 'API key looks too long')
    .regex(/^[\x21-\x7e]+$/, 'API key must be printable ASCII without spaces'),
  base_url: NewApiBaseUrlSchema.optional(),
});
export type SetAiKeyRequest = z.input<typeof SetAiKeyRequestSchema>;

export const AiConsentRequestSchema = z.object({
  /** Must equal the current `notice.version`, proving the client showed that text. */
  notice_version: z.number().int().positive(),
  credential_id: IdSchema.optional(),
});
export type AiConsentRequest = z.input<typeof AiConsentRequestSchema>;

export const PatchAiProviderRequestSchema = z
  .object({
    text_model: ModelNameSchema.optional(),
    video_model: ModelNameSchema.optional(),
  })
  .refine((v) => v.text_model !== undefined || v.video_model !== undefined, {
    message: 'at least one field is required',
  });
export type PatchAiProviderRequest = z.input<typeof PatchAiProviderRequestSchema>;

// ---- Settings: budget and price overrides --------------------------------------------

export const AiSettingsSchema = z.object({
  /** Monthly reminder threshold in USD; exceeding it warns but never blocks. Null = off. */
  monthly_budget_usd: z.number().nonnegative().max(1_000_000).nullable(),
  /** Per-model price overrides on top of `AI_PRICE_TABLE`. */
  price_overrides: z.record(ModelNameSchema, AiModelPriceSchema),
  prices_as_of: z.string(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const PatchAiSettingsRequestSchema = z
  .object({
    monthly_budget_usd: z.number().nonnegative().max(1_000_000).nullable().optional(),
    /** Replaces the whole override map. */
    price_overrides: z.record(ModelNameSchema, AiModelPriceSchema).optional(),
  })
  .refine((v) => v.monthly_budget_usd !== undefined || v.price_overrides !== undefined, {
    message: 'at least one field is required',
  });
export type PatchAiSettingsRequest = z.input<typeof PatchAiSettingsRequestSchema>;

// ---- Jobs -------------------------------------------------------------------------------

/** A generic text task. Concrete AI actions (QC-022, QC-023) build these server-side. */
export const AiTextInputSchema = z.object({
  system: z.string().max(20_000).optional(),
  prompt: z.string().min(1).max(500_000),
  /** JSON Schema for structured output; the result is then parsed into `result.json`. */
  json_schema: z.record(z.string(), z.unknown()).optional(),
  max_output_tokens: z.number().int().min(16).max(64_000).default(2048),
});
export type AiTextInput = z.infer<typeof AiTextInputSchema>;

export const CreateAiJobRequestSchema = z.object({
  provider: AiProviderSchema,
  /** Defaults to the provider's configured text model. */
  model: ModelNameSchema.optional(),
  action: AIActionSchema,
  work_id: IdSchema.optional(),
  source_revision: IdSchema.optional(),
  input: AiTextInputSchema,
});
export type CreateAiJobRequest = z.input<typeof CreateAiJobRequestSchema>;

export const AiFailureCodeSchema = z.enum([
  /** 429 from the provider; retried automatically. */
  'rate_limited',
  /** 401/403: the key is wrong, revoked or lacks access. */
  'invalid_key',
  /** No key stored (it was deleted after the job was queued). */
  'missing_key',
  /** Consent was withdrawn after the job was queued. */
  'consent_required',
  /** The request took too long; retried automatically. */
  'timeout',
  /** The provider refused or safety-blocked the content. */
  'content_blocked',
  /** 5xx/overloaded/connection error; retried automatically. */
  'provider_unavailable',
  /** 400/404/422: bad model name, unsupported option, too long input… */
  'bad_request',
  /** Structured output did not parse as JSON (e.g. cut off at max tokens). */
  'invalid_output',
  /** Gemini could not process the uploaded file (file state FAILED, QC-023). */
  'file_processing_failed',
  /** The source asset is gone or unreadable when the job runs (QC-023). */
  'source_unavailable',
  'unknown',
]);
export type AiFailureCode = z.infer<typeof AiFailureCodeSchema>;

export const AiJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;

export const AiUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export const AiCostEstimateSchema = z.object({
  provider: AiProviderSchema,
  model: z.string(),
  /** Rough count before sending (CJK ≈ 1 token/char, other text ≈ 4 chars/token). */
  input_tokens: z.number().int().nonnegative(),
  max_output_tokens: z.number().int().nonnegative(),
  /** Upper bound if the full output budget is used; null when the model has no price. */
  max_cost_usd: z.number().nonnegative().nullable(),
  price: AiModelPriceSchema.nullable(),
  /** Always true: costs are estimates from reference prices. */
  estimated: z.literal(true),
});
export type AiCostEstimate = z.infer<typeof AiCostEstimateSchema>;

/** Month-to-date spend against the reminder threshold. Never blocks a job. */
export const AiBudgetStatusSchema = z.object({
  /** Local calendar month, `YYYY-MM`. */
  month: z.string(),
  spent_usd: z.number().nonnegative(),
  budget_usd: z.number().nonnegative().nullable(),
  /** spent + this job's maximum estimate (null outside job submission). */
  projected_usd: z.number().nonnegative().nullable(),
  over_budget: z.boolean(),
  /** Human-readable reminder when over budget; null otherwise. */
  warning: z.string().nullable(),
});
export type AiBudgetStatus = z.infer<typeof AiBudgetStatusSchema>;

// ---- Text AI task metadata (QC-022; requests and results are in ai-text.ts) -------------

export const SuggestionFieldSchema = z.enum(['title', 'summary', 'tags']);
export type SuggestionField = z.infer<typeof SuggestionFieldSchema>;

/** 潤色 / 縮寫 / 擴寫 / 語氣調整 / 補充指令（自訂）. */
export const RewriteModeSchema = z.enum(['polish', 'shorten', 'expand', 'tone', 'custom']);
export type RewriteMode = z.infer<typeof RewriteModeSchema>;

export const AiTaskSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('platform_suggestions'),
    platforms: z.array(PlatformSchema),
    fields: z.array(SuggestionFieldSchema),
    count: z.number().int(),
    /** Each platform variant's revision when the job was created (null = no variant yet). */
    variant_revisions: z.record(z.string(), z.number().int().positive().nullable()),
  }),
  z.object({
    type: z.literal('video_understanding'),
    asset_id: IdSchema,
    /** Content hash of the video at submission; part of the cache key. */
    sha256: z.string(),
    /** MIME type sent to Gemini (e.g. `video/mov` for QuickTime). */
    mime_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
    duration_seconds: z.number().nonnegative().nullable(),
    resolution: z.enum(['default', 'low']),
  }),
  z.object({
    type: z.literal('rewrite'),
    mode: RewriteModeSchema,
    tone: z.string().nullable(),
    instruction: z.string().nullable(),
    range: z.object({ start: z.number().int(), end: z.number().int() }),
  }),
]);
export type AiTask = z.infer<typeof AiTaskSchema>;

export const AiJobRecordSchema = z.object({
  id: IdSchema,
  provider: AiProviderSchema,
  model: z.string(),
  action: AIActionSchema,
  work_id: IdSchema.nullable(),
  source_revision: IdSchema.nullable(),
  status: AiJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  error_code: AiFailureCodeSchema.nullable(),
  /** Readable reason, with request content and keys stripped. */
  error: z.string().nullable(),
  result: z.object({ text: z.string(), json: z.unknown().optional() }).nullable(),
  usage: AiUsageSchema.nullable(),
  /** From the provider-reported usage and the price table; an estimate. */
  cost_usd: z.number().nonnegative().nullable(),
  estimate: AiCostEstimateSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  started_at: TimestampSchema.nullable(),
  finished_at: TimestampSchema.nullable(),
  /** What a text AI job was for (QC-022); null for generic jobs. */
  task: AiTaskSchema.nullable().optional(),
  /** Revision created when the user accepted this job's rewrite (QC-022). */
  accepted_revision_id: IdSchema.nullable().optional(),
  /** Live progress of multi-step jobs such as video understanding (QC-023). */
  progress: z
    .object({
      phase: z.enum(['uploading', 'processing', 'analyzing']),
      uploaded_bytes: z.number().int().nonnegative(),
      total_bytes: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type AiJobRecord = z.infer<typeof AiJobRecordSchema>;

export const CreateAiJobResponseSchema = z.object({
  job: AiJobRecordSchema,
  budget: AiBudgetStatusSchema,
});
export type CreateAiJobResponse = z.infer<typeof CreateAiJobResponseSchema>;

export const AiEstimateResponseSchema = z.object({
  estimate: AiCostEstimateSchema,
  budget: AiBudgetStatusSchema,
});
export type AiEstimateResponse = z.infer<typeof AiEstimateResponseSchema>;

export const ListAiJobsQuerySchema = z.object({
  status: AiJobStatusSchema.optional(),
  work_id: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAiJobsQuery = Partial<z.output<typeof ListAiJobsQuerySchema>>;

export const ListAiJobsResponseSchema = z.object({
  items: z.array(AiJobRecordSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListAiJobsResponse = z.infer<typeof ListAiJobsResponseSchema>;

export const AiUsageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const AiUsageResponseSchema = z.object({
  month: z.string(),
  by_provider: z.array(
    z.object({
      provider: AiProviderSchema,
      jobs: z.number().int().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cost_usd: z.number().nonnegative(),
    }),
  ),
  budget: AiBudgetStatusSchema,
  prices_as_of: z.string(),
});
export type AiUsageResponse = z.infer<typeof AiUsageResponseSchema>;

/** Rough token count used before sending; the provider's reported usage replaces it after. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      code >= 0x20000
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** USD cost for a usage at a price (per 1M tokens). */
export function costUsd(price: AiModelPrice, input: number, output: number): number {
  return (input * price.input_per_mtok + output * price.output_per_mtok) / 1_000_000;
}
