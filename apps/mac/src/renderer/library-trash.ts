import type { BatchWorkResult, WorkListItem } from '@qiu-creator/contracts';

/**
 * Pure helpers for deleting, restoring and batch-editing works in 作品庫
 * (QC-052 on the QC-051 API), kept apart so the rules are unit tested.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days until a work in 回收站 is deleted for good, rounded up (30 right after
 * deleting, 1 on its last day); 0 once due; null when unknown.
 */
export function daysLeft(
  purgeAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (purgeAt == null) return null;
  const at = Date.parse(purgeAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

export interface BatchSummary {
  /** Works the service changed (or found already as asked), as it returned them. */
  ok: WorkListItem[];
  failed: { id: string; code: string }[];
}

export function summarize(results: readonly BatchWorkResult[]): BatchSummary {
  const ok: WorkListItem[] = [];
  const failed: { id: string; code: string }[] = [];
  for (const r of results) {
    if (r.ok) ok.push(r.work);
    else failed.push({ id: r.id, code: r.error.code });
  }
  return { ok, failed };
}

/** Tags typed into the batch field: split on commas, 、, spaces or #; trimmed, unique, ≤ 64 chars. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[,，、\s#＃]+/)) {
    const tag = raw.trim().slice(0, 64);
    if (tag !== '') seen.add(tag);
  }
  return [...seen];
}

/** Every tag any of the works has, in first-seen order (the choices for 移除標籤). */
export function unionTags(works: readonly Pick<WorkListItem, 'tags'>[]): string[] {
  return [...new Set(works.flatMap((w) => w.tags))];
}

/**
 * What undoing a tag change must send: for each work, only the tags the
 * change really added (or removed), grouped so works with the same set share
 * one batch request. A work that already had an added tag keeps it on undo.
 */
export function tagUndoGroups(
  before: readonly Pick<WorkListItem, 'id' | 'tags'>[],
  tags: readonly string[],
  mode: 'add' | 'remove',
): { tags: string[]; ids: string[] }[] {
  const groups = new Map<string, { tags: string[]; ids: string[] }>();
  for (const w of before) {
    const has = new Set(w.tags);
    const changed = tags.filter((tag) => (mode === 'add' ? !has.has(tag) : has.has(tag)));
    if (changed.length === 0) continue;
    const key = changed.join('\u0000');
    const group = groups.get(key) ?? { tags: changed, ids: [] };
    group.ids.push(w.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** An idempotency key for one batch request (a retry of the same request reuses it). */
export function batchKey(): string {
  return crypto.randomUUID();
}
