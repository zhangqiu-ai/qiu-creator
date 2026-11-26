import {
  DEFAULT_TEXT_SCRIPT,
  PutTextScriptSettingRequestSchema,
  TextScriptSchema,
  type PutTextScriptSettingRequest,
  type ScriptConversion,
  type ScriptConvertedField,
  type SessionTextScript,
  type TextScript,
  type TextScriptSetting,
} from '@qiu-creator/contracts';
import { lineChanges, splitLines } from '@qiu-creator/domain';
import { currentPrincipal } from '../auth/actor-context.js';
import type { Db } from '../db/database.js';
import { convertMarkdown, convertPlain } from './text-script.js';

/** `app_settings` key of the global setting. */
export const TEXT_SCRIPT_SETTING_KEY = 'work_text_script';

/** Text fields of a write that are converted; anything else passes through. */
export interface ScriptFields {
  title?: string | null | undefined;
  markdown?: string | undefined;
  description?: string | undefined;
  tags?: readonly string[] | null | undefined;
}

export interface Converted<T> {
  value: T;
  /** Set only when some field changed. */
  conversion: ScriptConversion | undefined;
}

/** What is stored now, for an edit: only text the agent adds or changes is converted (QC-111). */
export interface ScriptBefore {
  title?: string | null | undefined;
  markdown?: string | null | undefined;
  description?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
}

/**
 * 作品文字字體 (QC-103): the global setting, project overrides, and converting
 * text that agent tokens write. The owner's writes are never converted, and
 * nothing already stored is ever converted: an edit converts only the lines,
 * title and tags the agent added or changed (QC-111).
 */
export class TextScriptService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setting(): TextScriptSetting {
    const row = this.db
      .prepare<[string], { value: string; updated_at: string }>(
        'SELECT value, updated_at FROM app_settings WHERE key = ?',
      )
      .get(TEXT_SCRIPT_SETTING_KEY);
    const parsed = TextScriptSchema.safeParse(row?.value);
    return parsed.success && row !== undefined
      ? { script: parsed.data, updated_at: row.updated_at }
      : { script: DEFAULT_TEXT_SCRIPT, updated_at: null };
  }

  setSetting(input: PutTextScriptSettingRequest): TextScriptSetting {
    const { script } = PutTextScriptSettingRequestSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(TEXT_SCRIPT_SETTING_KEY, script, this.now().toISOString());
    return this.setting();
  }

  /**
   * The script for a work in these projects: their override when the ones
   * that override agree, otherwise (none, or different scripts) the global
   * setting. Deleted projects do not count.
   */
  forProjects(projectIds: readonly string[]): TextScript {
    if (projectIds.length === 0) return this.setting().script;
    const rows = this.db
      .prepare<[string], { text_script: string }>(
        `SELECT DISTINCT text_script FROM projects
         WHERE id IN (SELECT value FROM json_each(?))
           AND deleted_at IS NULL AND text_script IS NOT NULL`,
      )
      .all(JSON.stringify(projectIds));
    return this.pick(rows);
  }

  /** The script for an existing work, from the projects it is in now. */
  forWork(workId: string): TextScript {
    const rows = this.db
      .prepare<[string], { text_script: string }>(
        `SELECT DISTINCT p.text_script FROM work_projects wp JOIN projects p ON p.id = wp.project_id
         WHERE wp.work_id = ? AND p.deleted_at IS NULL AND p.text_script IS NOT NULL`,
      )
      .all(workId);
    return this.pick(rows);
  }

  /** For `GET /api/v1/session`: the setting and the overriding projects within `limit`. */
  session(limit: readonly string[] | null): SessionTextScript {
    const rows = this.db
      .prepare<[], { id: string; name: string; text_script: string }>(
        `SELECT id, name, text_script FROM projects
         WHERE deleted_at IS NULL AND text_script IS NOT NULL ORDER BY sort_order, id`,
      )
      .all();
    const projects: SessionTextScript['projects'] = [];
    for (const r of rows) {
      const script = TextScriptSchema.safeParse(r.text_script);
      if (!script.success || (limit !== null && !limit.includes(r.id))) continue;
      projects.push({ project_id: r.id, name: r.name, script: script.data });
    }
    return { default: this.setting().script, projects };
  }

  /**
   * Convert the text fields of a write when the current request is an agent
   * token's; `target` and `before` are only resolved then. The owner's writes
   * come back unchanged. Without `before` (a new work) everything is
   * converted; with it, only what differs from it (QC-111).
   */
  forAgent<T extends ScriptFields>(
    fields: T,
    target: () => TextScript,
    before?: () => ScriptBefore,
  ): Converted<T> {
    if (currentPrincipal()?.kind !== 'agent') return { value: fields, conversion: undefined };
    return convertFields(fields, target(), before?.());
  }

  private pick(rows: readonly { text_script: string }[]): TextScript {
    const scripts = rows
      .map((r) => TextScriptSchema.safeParse(r.text_script))
      .flatMap((r) => (r.success ? [r.data] : []));
    const [only] = scripts;
    return scripts.length === 1 && only !== undefined ? only : this.setting().script;
  }
}

/** `{ script_conversion }` to spread into a response, or nothing. */
export function withConversion(conversion: ScriptConversion | undefined): {
  script_conversion?: ScriptConversion;
} {
  return conversion === undefined ? {} : { script_conversion: conversion };
}

/**
 * Convert a Markdown text, but keep every line that is unchanged from
 * `before` exactly as it is (QC-111). The whole text is converted first, so
 * code blocks and front matter are recognised in context; then the line diff
 * against `before` (the same one proposals are split by) decides which lines
 * take the converted form: only lines the agent added or changed.
 */
export function convertChangedLines(
  text: string,
  before: string | null | undefined,
  script: TextScript,
): string {
  const converted = convertMarkdown(text, script);
  if (converted === text || before === null || before === undefined) return converted;
  const lines = splitLines(text);
  const out = splitLines(converted);
  // OpenCC never adds or removes line breaks; if it ever did, convert nothing
  // rather than risk touching the user's lines.
  if (out.length !== lines.length) return text;
  const changed = new Set<number>();
  for (const c of lineChanges(splitLines(before), lines)) {
    for (let i = c.other_start; i < c.other_end; i += 1) changed.add(i);
  }
  return lines.map((line, i) => (changed.has(i) ? (out[i] ?? line) : line)).join('\n');
}

/**
 * Convert the text fields of `fields` to `script`, reporting which changed.
 * With `before`, only new or changed text is converted: a title equal to the
 * stored one stays, tags already there stay, and Markdown and descriptions
 * keep their unchanged lines (QC-111).
 */
export function convertFields<T extends ScriptFields>(
  fields: T,
  script: TextScript,
  before?: ScriptBefore,
): Converted<T> {
  const changed: ScriptConvertedField[] = [];
  const changes: ScriptFields = {};
  if (typeof fields.title === 'string' && fields.title !== before?.title) {
    const title = convertPlain(fields.title, script);
    if (title !== fields.title) {
      changes.title = title;
      changed.push('title');
    }
  }
  if (fields.markdown !== undefined) {
    const markdown =
      before === undefined
        ? convertMarkdown(fields.markdown, script)
        : convertChangedLines(fields.markdown, before.markdown, script);
    if (markdown !== fields.markdown) {
      changes.markdown = markdown;
      changed.push('markdown');
    }
  }
  if (fields.description !== undefined) {
    const description =
      before === undefined
        ? convertMarkdown(fields.description, script)
        : convertChangedLines(fields.description, before.description, script);
    if (description !== fields.description) {
      changes.description = description;
      changed.push('description');
    }
  }
  const original = fields.tags;
  if (original !== undefined && original !== null) {
    const kept = new Set(before?.tags ?? []);
    const tags = original.map((t) => (kept.has(t) ? t : convertPlain(t, script)));
    if (tags.some((t, i) => t !== original[i])) {
      // Two tags may become one after conversion (`發`/`髮` → `发`).
      changes.tags = [...new Set(tags)];
      changed.push('tags');
    }
  }
  return {
    value: { ...fields, ...changes },
    conversion: changed.length > 0 ? { script, fields: changed } : undefined,
  };
}
