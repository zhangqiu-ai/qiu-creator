import {
  charCount,
  PROMPT_VARIABLES,
  PromptExportSchema,
  type Prompt,
  type PromptExport,
} from '@qiu-creator/contracts';
import { matchesSearch } from '@qiu-creator/domain/search';

/**
 * Pure helpers of the Prompt 庫 page (QC-075, PT-20261122-003): the grouped
 * list, the search filter, variable marking and insertion, and the small
 * pieces the editor needs. Everything here is testable without a DOM.
 */

/** Every spelling the server expands, longest first so `{語言}` never matches half a token. */
const SPELLINGS: readonly string[] = Object.values(PROMPT_VARIABLES)
  .flatMap((names) => [...names])
  .sort((a, b) => b.length - a.length);

/** The chips the editor offers, in the order the prototype lists them. */
export const VARIABLE_CHIPS: readonly { variable: keyof typeof PROMPT_VARIABLES; token: string }[] =
  (Object.keys(PROMPT_VARIABLES) as (keyof typeof PROMPT_VARIABLES)[]).map((variable) => ({
    variable,
    token: `{${PROMPT_VARIABLES[variable][0]}}`,
  }));

function variableRe(): RegExp {
  return new RegExp(`\\{(?:${SPELLINGS.join('|')})\\}`, 'g');
}

/** Whether `token` (with its braces) is one of this version's variables. */
export function isVariable(token: string): boolean {
  return /^\{.+\}$/.test(token) && SPELLINGS.includes(token.slice(1, -1));
}

export interface ContentPart {
  text: string;
  /** One of the five variables, in either spelling: marked in the content. */
  variable: boolean;
}

/**
 * The content split into plain text and variables, so the editor can mark
 * `{選取}` and friends (both the Traditional and the Simplified spelling).
 */
export function splitVariables(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let at = 0;
  for (const m of content.matchAll(variableRe())) {
    const start = m.index;
    if (start > at) parts.push({ text: content.slice(at, start), variable: false });
    parts.push({ text: m[0], variable: true });
    at = start + m[0].length;
  }
  if (at < content.length) parts.push({ text: content.slice(at), variable: false });
  return parts;
}

/** Put `token` in at the cursor (replacing a selection); the caret lands after it. */
export function insertVariable(
  content: string,
  start: number,
  end: number,
  token: string,
): { content: string; caret: number } {
  const from = Math.max(0, Math.min(start, content.length));
  const to = Math.max(from, Math.min(end, content.length));
  return {
    content: content.slice(0, from) + token + content.slice(to),
    caret: from + token.length,
  };
}

/** A prompt matches a search by its name, its content or its group. */
export function matchesPrompt(prompt: Prompt, query: string): boolean {
  if (query.trim() === '') return true;
  return (
    matchesSearch(prompt.name, query) ||
    matchesSearch(prompt.content, query) ||
    (prompt.group !== null && matchesSearch(prompt.group, query))
  );
}

export interface PromptGroup {
  /** 'builtin' for the read-only ones, the group's name, or '' for the ungrouped customs. */
  key: string;
  name: string;
  builtin: boolean;
  items: Prompt[];
}

/**
 * The list: 內建 first, then the custom groups in the order their first
 * prompt appears, with the ungrouped ones last. While searching, groups with
 * no hit are left out (the groups themselves only exist through their prompts).
 */
export function groupPrompts(
  prompts: readonly Prompt[],
  query: string,
  labels: { builtin: string; ungrouped: string },
): PromptGroup[] {
  const hits = prompts.filter((p) => matchesPrompt(p, query));
  const builtins = hits.filter((p) => p.builtin);
  const groups: PromptGroup[] = [];
  if (builtins.length > 0)
    groups.push({ key: 'builtin', name: labels.builtin, builtin: true, items: builtins });
  const byKey = new Map<string, PromptGroup>();
  for (const p of hits) {
    if (p.builtin) continue;
    const key = p.group ?? '';
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, name: key === '' ? labels.ungrouped : key, builtin: false, items: [] };
      byKey.set(key, group);
    }
    group.items.push(p);
  }
  const custom = [...byKey.values()];
  return [...groups, ...custom.filter((g) => g.key !== ''), ...custom.filter((g) => g.key === '')];
}

/** Every custom prompt's id, in library order (what `prompts.reorder` takes). */
export function customIds(prompts: readonly Prompt[]): string[] {
  return prompts.filter((p) => !p.builtin).map((p) => p.id);
}

/** The custom order with `id` moved one place up or down (unchanged at either end). */
export function moveCustom(prompts: readonly Prompt[], id: string, step: -1 | 1): string[] {
  const ids = customIds(prompts);
  const at = ids.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

/** The custom order with the dragged prompt put where the one it was dropped on is. */
export function dropCustom(
  prompts: readonly Prompt[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const ids = customIds(prompts);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Which prompt the list selects after `id` is gone: the next one, else the one before. */
export function afterRemoval(prompts: readonly Prompt[], id: string): string | null {
  const ids = customIds(prompts);
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** The prompt the page opens on: the first custom one, or nothing when there are none. */
export function firstSelection(prompts: readonly Prompt[]): string | null {
  return customIds(prompts)[0] ?? null;
}

/** One line of the content for a list row (its line breaks collapsed). */
export function previewLine(content: string, max = 80): string {
  const line = content.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max).join('')}…`;
}

/** How much longer or shorter a candidate is, for the candidate bar. */
export function changeCount(before: string, after: string): string {
  const delta = charCount(after) - charCount(before);
  return delta >= 0 ? `+${String(delta)}` : String(delta);
}

/** The groups already in use, for the 分組 field's suggestions. */
export function groupNames(prompts: readonly Prompt[]): string[] {
  const names = new Set<string>();
  for (const p of prompts) if (!p.builtin && p.group !== null) names.add(p.group);
  return [...names];
}

/** `prompts-2026-11-22.json`, the name the exported file is offered under. */
export function exportFileName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `prompts-${stamp}.json`;
}

/** A chosen file's text as an import, or null when it is not a prompt export. */
export function parseImport(text: string): PromptExport | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PromptExportSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** A draft being written: the fields a prompt has before it is saved. */
export interface PromptDraft {
  name: string;
  content: string;
  scene: Prompt['scene'];
  group: string;
  model: Prompt['model'];
  language: Prompt['language'];
}

export function draftOf(prompt: Prompt): PromptDraft {
  return {
    name: prompt.name,
    content: prompt.content,
    scene: prompt.scene,
    group: prompt.group ?? '',
    model: prompt.model,
    language: prompt.language,
  };
}

export function emptyDraft(): PromptDraft {
  return { name: '', content: '', scene: 'selection', group: '', model: null, language: null };
}

/** Whether two drafts hold the same prompt (分組 is trimmed, as the service stores it). */
export function sameDraft(a: PromptDraft, b: PromptDraft): boolean {
  return (
    a.name === b.name &&
    a.content === b.content &&
    a.scene === b.scene &&
    a.group.trim() === b.group.trim() &&
    a.language === b.language &&
    a.model?.provider === b.model?.provider &&
    a.model?.model === b.model?.model
  );
}

/** Whether anything in the draft differs from the saved prompt. */
export function draftChanged(draft: PromptDraft, prompt: Prompt): boolean {
  return !sameDraft(draft, draftOf(prompt));
}

/** A draft can be saved once it has both a name and content (the service asks for both). */
export function savable(draft: PromptDraft): boolean {
  return draft.name.trim() !== '' && draft.content.trim() !== '';
}

/** `provider:model`, how a model is named in the 預設模型 list. */
export function modelKey(model: Prompt['model']): string {
  return model === null ? '' : `${model.provider}:${model.model}`;
}

/** A `provider:model` value back from the 預設模型 list, or null for 沿用工具列. */
export function modelFromKey(key: string): Prompt['model'] {
  const at = key.indexOf(':');
  if (at <= 0) return null;
  const provider = key.slice(0, at);
  const model = key.slice(at + 1);
  if (model === '') return null;
  if (
    provider !== 'gemini' &&
    provider !== 'anthropic' &&
    provider !== 'openai' &&
    provider !== 'new-api'
  )
    return null;
  return { provider, model };
}
