import { z } from 'zod';
import { IdSchema, TimestampSchema } from './entities.js';

/**
 * 作品文字字體 (QC-103): which Chinese script text written into works by
 * agents should use. The four platforms are mainland platforms, so the
 * default is Simplified; the owner can change it globally, and a project can
 * override it (null follows the global setting).
 *
 * Text that agent tokens send (title, Markdown, description, tags, platform
 * titles and tags) is converted on the server with OpenCC; responses say so in
 * `script_conversion`. The owner's own writes and existing works are never
 * converted.
 */
export const TEXT_SCRIPTS = ['zh-Hans', 'zh-Hant'] as const;
export const TextScriptSchema = z.enum(TEXT_SCRIPTS);
export type TextScript = z.infer<typeof TextScriptSchema>;

export const DEFAULT_TEXT_SCRIPT: TextScript = 'zh-Hans';

/** `GET`/`PUT /api/v1/settings/text-script`: the global setting. */
export const TextScriptSettingSchema = z.object({
  script: TextScriptSchema,
  /** When the owner last changed it; null while it is the default. */
  updated_at: TimestampSchema.nullable(),
});
export type TextScriptSetting = z.infer<typeof TextScriptSettingSchema>;

/** `PUT /api/v1/settings/text-script` (owner only). */
export const PutTextScriptSettingRequestSchema = z.object({ script: TextScriptSchema });
export type PutTextScriptSettingRequest = z.input<typeof PutTextScriptSettingRequestSchema>;

/** A project's override: a script, or null to follow the global setting. */
export const ProjectTextScriptSchema = TextScriptSchema.nullable();

export const SCRIPT_CONVERTED_FIELDS = ['title', 'markdown', 'description', 'tags'] as const;
export const ScriptConvertedFieldSchema = z.enum(SCRIPT_CONVERTED_FIELDS);
export type ScriptConvertedField = z.infer<typeof ScriptConvertedFieldSchema>;

/**
 * Present on a write response only when the server changed the text an agent
 * sent: the script it was converted to and which fields changed (for a
 * proposal, `markdown` is the proposed text). Absent when nothing changed.
 */
export const ScriptConversionSchema = z.object({
  script: TextScriptSchema,
  fields: z.array(ScriptConvertedFieldSchema).min(1),
});
export type ScriptConversion = z.infer<typeof ScriptConversionSchema>;

/**
 * In `GET /api/v1/session` (and so `server_status`): the global setting and
 * the projects that override it (only projects the token may see). A work in
 * projects follows their override; when its projects override with different
 * scripts, or none does, the global setting applies.
 */
export const SessionTextScriptSchema = z.object({
  default: TextScriptSchema,
  projects: z.array(z.object({ project_id: IdSchema, name: z.string(), script: TextScriptSchema })),
});
export type SessionTextScript = z.infer<typeof SessionTextScriptSchema>;
