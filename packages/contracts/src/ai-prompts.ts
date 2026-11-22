import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';

/**
 * AI output language, prompt library and remembered models (QC-075,
 * prototype PT-20261122-003). Everything lives on the Mac (SQLite), shared
 * by every device.
 */

const ProviderSchema = z.enum(['gemini', 'anthropic', 'openai', 'new-api']);

// ---- Output language --------------------------------------------------------------

/** `follow` = 跟隨原文 (the default): the server detects the source's language. */
export const AiOutputLanguageSchema = z.enum(['follow', 'zh-Hans', 'zh-Hant', 'en']);
export type AiOutputLanguage = z.infer<typeof AiOutputLanguageSchema>;

/** A language the AI is actually told to write in. */
export const AiConcreteLanguageSchema = z.enum(['zh-Hans', 'zh-Hant', 'en']);
export type AiConcreteLanguage = z.infer<typeof AiConcreteLanguageSchema>;

/**
 * Where a job's language came from: the prompt's own setting (「prompt 指定」),
 * the request, the global preference, detection of the source (`follow`),
 * or the interface language when detection could not tell.
 */
export const AiLanguageSourceSchema = z.enum([
  'prompt',
  'request',
  'preference',
  'detected',
  'interface',
]);
export type AiLanguageSource = z.infer<typeof AiLanguageSourceSchema>;

/** Where a job's model came from: the prompt (「prompt 指定」), the request, or the provider's default. */
export const AiModelSourceSchema = z.enum(['prompt', 'request', 'default']);
export type AiModelSource = z.infer<typeof AiModelSourceSchema>;

/** What a task is, for remembering the last model used per task. */
export const AiTaskKindSchema = z.enum(['rewrite', 'suggestions', 'video', 'image', 'prompt']);
export type AiTaskKind = z.infer<typeof AiTaskKindSchema>;

export const AiModelChoiceSchema = z.object({
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(100),
});
export type AiModelChoice = z.infer<typeof AiModelChoiceSchema>;

export const AiPreferencesSchema = z.object({
  /** Language AI text is written in; `follow` by default. */
  output_language: AiOutputLanguageSchema,
  /**
   * The provider and model last used (or picked) for each task; null when
   * never. Recorded on every submitted job (not when a prompt chose the
   * model); the app may also set it when the user switches model.
   */
  last_models: z.record(AiTaskKindSchema, AiModelChoiceSchema.nullable()),
});
export type AiPreferences = z.infer<typeof AiPreferencesSchema>;

export const PatchAiPreferencesRequestSchema = z
  .object({
    output_language: AiOutputLanguageSchema.optional(),
    /** Merged: only the tasks sent change; null clears one. */
    last_models: z.partialRecord(AiTaskKindSchema, AiModelChoiceSchema.nullable()).optional(),
  })
  .refine((v) => v.output_language !== undefined || v.last_models !== undefined, {
    message: 'at least one field is required',
  });
export type PatchAiPreferencesRequest = z.input<typeof PatchAiPreferencesRequestSchema>;

/**
 * Language fields every AI text request takes (QC-075). `language` omitted
 * means the preference; a prompt's own language wins over both.
 */
export const AiLanguageRequestShape = {
  language: AiOutputLanguageSchema.optional(),
  /** The app's interface language: used when `follow` cannot detect the source. */
  interface_language: AiConcreteLanguageSchema.optional(),
};

// ---- Models to switch between ----------------------------------------------------

export const AiModelsQuerySchema = z.object({
  kind: z.enum(['chat', 'image']).default('chat'),
});
export type AiModelsQuery = z.input<typeof AiModelsQuerySchema>;

export const AiModelsResponseSchema = z.object({
  /**
   * Models of providers that are ready (key stored and notice confirmed):
   * New API's list (QC-054, `chat` includes `unknown` names), the configured
   * text model of the others. `default`: the provider's configured model.
   */
  items: z.array(
    z.object({
      provider: ProviderSchema,
      model: z.string(),
      kind: z.enum(['chat', 'image', 'unknown']),
      default: z.boolean(),
      /**
       * Where the entry comes from (QC-082): `list` the relay's list just
       * read; `cache` the last list read, when reading it again failed;
       * `configured` the models the app already stores (New API's text
       * model and the New API models last used), when there is no list.
       */
      source: z.enum(['list', 'cache', 'configured']).default('list'),
    }),
  ),
  /**
   * Providers whose list could not be read (e.g. the relay is down). Their
   * entries then come from `fallback` (show 「清單讀取失敗，使用已存模型」).
   */
  errors: z.array(
    z.object({
      provider: ProviderSchema,
      /** The error code, e.g. `ai_gateway_unreachable`, `ai_key_invalid`. */
      code: z.string(),
      /** `details.reason` when there is one, e.g. `timeout`, `dns`, `quota`. */
      reason: z.string().nullable().default(null),
      /** What was listed instead; `none` when there was nothing to fall back on. */
      fallback: z.enum(['cache', 'configured', 'none']).default('none'),
      /** When the cached list was read (`fallback: cache`). */
      cached_at: z.string().nullable().default(null),
    }),
  ),
});
export type AiModelsResponse = z.infer<typeof AiModelsResponseSchema>;

// ---- Prompt library ---------------------------------------------------------------

/** Where a prompt applies: selected text, the whole text, titles, or images. */
export const PromptSceneSchema = z.enum(['selection', 'full', 'title', 'image']);
export type PromptScene = z.infer<typeof PromptSceneSchema>;

/** Built-in prompts: read-only, listed first, copyable. */
export const BUILTIN_PROMPT_IDS = [
  'builtin-polish',
  'builtin-expand',
  'builtin-shorten',
  'builtin-tone',
  'builtin-title',
  'builtin-cover',
] as const;
export const BuiltinPromptIdSchema = z.enum(BUILTIN_PROMPT_IDS);
export type BuiltinPromptId = z.infer<typeof BuiltinPromptIdSchema>;

/** A custom prompt's UUID or a built-in id. */
export const PromptIdSchema = z.union([IdSchema, BuiltinPromptIdSchema]);

export const PROMPT_NAME_MAX = 40;
export const PROMPT_CONTENT_MAX = 4000;
export const PROMPT_GROUP_MAX = 40;
/** Most prompts one import takes. */
export const PROMPT_IMPORT_MAX = 500;

const NameSchema = z.string().trim().min(1).max(PROMPT_NAME_MAX);
const ContentSchema = z.string().trim().min(1).max(PROMPT_CONTENT_MAX);
const GroupSchema = z.string().trim().min(1).max(PROMPT_GROUP_MAX).nullable();

export const PromptSchema = z.object({
  id: PromptIdSchema,
  builtin: z.boolean(),
  name: z.string(),
  group: z.string().nullable(),
  scene: PromptSceneSchema,
  content: z.string(),
  /** The prompt's own model (wins over the toolbar's); null = the toolbar's. */
  model: AiModelChoiceSchema.nullable(),
  /** The prompt's own output language (wins over the preference); null = the preference. */
  language: AiOutputLanguageSchema.nullable(),
  /** 0 for built-ins (they never change). */
  revision: z.number().int().nonnegative(),
  /** Jobs that used it. */
  use_count: z.number().int().nonnegative(),
  last_used_at: TimestampSchema.nullable(),
  created_at: TimestampSchema.nullable(),
  updated_at: TimestampSchema.nullable(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptListResponseSchema = z.object({ items: z.array(PromptSchema) });
export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

export const CreatePromptRequestSchema = z.object({
  name: NameSchema,
  content: ContentSchema,
  scene: PromptSceneSchema.default('selection'),
  group: GroupSchema.default(null),
  model: AiModelChoiceSchema.nullable().default(null),
  language: AiOutputLanguageSchema.nullable().default(null),
});
export type CreatePromptRequest = z.input<typeof CreatePromptRequestSchema>;

export const PatchPromptRequestSchema = z
  .object({
    /** Or `If-Match: "<revision>"`. */
    base_revision: z.number().int().positive().optional(),
    name: NameSchema.optional(),
    content: ContentSchema.optional(),
    scene: PromptSceneSchema.optional(),
    group: GroupSchema.optional(),
    model: AiModelChoiceSchema.nullable().optional(),
    language: AiOutputLanguageSchema.nullable().optional(),
  })
  .refine(
    (v) => [v.name, v.content, v.scene, v.group, v.model, v.language].some((f) => f !== undefined),
    { message: 'at least one field is required' },
  );
export type PatchPromptRequest = z.input<typeof PatchPromptRequestSchema>;

export const PromptParamsSchema = z.object({ id: PromptIdSchema });

export const ReorderPromptsRequestSchema = z.object({
  /** Every custom prompt, in the new order. */
  ids: z.array(IdSchema).max(10_000),
});
export type ReorderPromptsRequest = z.input<typeof ReorderPromptsRequestSchema>;

export const PromptExportItemSchema = z.object({
  name: NameSchema,
  group: GroupSchema.optional(),
  scene: PromptSceneSchema.default('selection'),
  content: ContentSchema,
  model: AiModelChoiceSchema.nullable().optional(),
  language: AiOutputLanguageSchema.nullable().optional(),
});

/**
 * `GET /api/v1/ai/prompts/export` (custom prompts only, no usage counts);
 * also what `POST /api/v1/ai/prompts/import` takes.
 */
export const PromptExportSchema = z.object({
  version: z.literal(1),
  exported_at: TimestampSchema.optional(),
  prompts: z.array(PromptExportItemSchema).max(PROMPT_IMPORT_MAX),
});
export type PromptExport = z.infer<typeof PromptExportSchema>;
export type PromptImportRequest = z.input<typeof PromptExportSchema>;

export const PromptImportResponseSchema = z.object({
  /** Added at the end, in file order. */
  imported: z.number().int().nonnegative(),
  /** Of those, how many had a name already in use and were named 「…（副本）」. */
  renamed: z.number().int().nonnegative(),
  items: z.array(PromptSchema),
});
export type PromptImportResponse = z.infer<typeof PromptImportResponseSchema>;

// ---- Variables ----------------------------------------------------------------------

/**
 * The five variables of this version, expanded on the server (Traditional
 * and Simplified spellings). Unknown `{…}`, or a variable with no value in
 * that job (e.g. `{平台}` outside platform preview), are left as written.
 * - selection: the selected text, else the text the job works on;
 * - title: the work's title; text: its whole body;
 * - platform: the platform's name (title and cover jobs for a platform);
 * - language: the output language's name.
 */
export const PROMPT_VARIABLES = {
  selection: ['選取', '选取'],
  title: ['標題', '标题'],
  text: ['全文'],
  platform: ['平台'],
  language: ['語言', '语言'],
} as const;
export type PromptVariable = keyof typeof PROMPT_VARIABLES;

export const PromptPreviewRequestSchema = z.object({
  content: z.string().max(PROMPT_CONTENT_MAX),
  work_id: IdSchema.optional(),
  /** UTF-16 range of the work's current Markdown. */
  selection: z
    .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
    .refine((s) => s.end > s.start, 'selection.end must be after selection.start')
    .optional(),
  platform: z.enum(['xiaohongshu', 'wechat_mp', 'douyin', 'wechat_channels']).optional(),
  ...AiLanguageRequestShape,
});
export type PromptPreviewRequest = z.input<typeof PromptPreviewRequestSchema>;

export const PromptPreviewResponseSchema = z.object({
  text: z.string(),
  /** Every `{…}` in the content, in order of first use; `known: false` stays as written. */
  variables: z.array(z.object({ name: z.string(), known: z.boolean() })),
  /** The language `{語言}` and a job would use. */
  language: AiConcreteLanguageSchema,
  language_source: AiLanguageSourceSchema,
});
export type PromptPreviewResponse = z.infer<typeof PromptPreviewResponseSchema>;

// ---- AI-suggested prompts -------------------------------------------------------------

export const SuggestPromptRequestSchema = z.object({
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(100).optional(),
  /** Language the prompt is written in; `follow`: the description's. */
  ...AiLanguageRequestShape,
  /** What the prompt should do, in the user's words. */
  description: z.string().trim().min(1).max(2000),
  /** Rewrite this custom or built-in prompt instead of writing a new one. */
  base_prompt_id: PromptIdSchema.optional(),
  /** For a new prompt; a rewrite keeps the prompt's scene unless told otherwise. */
  scene: PromptSceneSchema.optional(),
});
export type SuggestPromptRequest = z.input<typeof SuggestPromptRequestSchema>;

const PromptDraftSchema = z.object({
  name: z.string(),
  scene: PromptSceneSchema,
  content: z.string(),
});

/**
 * `result.json` of a succeeded prompt suggestion. Nothing is written: keep it
 * with `POST /prompts` (new) or `PATCH /prompts/:id` with `base_revision`.
 */
export const PromptSuggestionResultSchema = z.object({
  type: z.literal('prompt_suggestion'),
  base_prompt_id: PromptIdSchema.nullable(),
  /** The prompt's revision when asked (null for new prompts and built-ins). */
  base_revision: z.number().int().positive().nullable(),
  original: PromptDraftSchema.nullable(),
  candidate: PromptDraftSchema,
  language: AiConcreteLanguageSchema,
  language_source: AiLanguageSourceSchema,
});
export type PromptSuggestionResult = z.infer<typeof PromptSuggestionResultSchema>;
