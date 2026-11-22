import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import {
  WORKS_BATCH_MAX,
  type Work,
  type WorkDetail,
  type WorkStatus,
} from '@qiu-creator/contracts';
import { batchKey, summarize } from './library-trash.js';
import type { ChangeOutcome, EditorTabHandle, WorkPatch } from './tab-handle.js';

/** The editors mounted in tabs, by work id, shared by the tab bar and 作品庫 (QC-052). */
export type EditorHandles = Map<string, EditorTabHandle>;

export interface WorkRef {
  id: string;
  current_revision_id: string;
}

/**
 * Rename a work or change its status from 作品庫 or the tab bar. A work open
 * in a tab changes through its editor; any other work is patched against the
 * revision the list showed, so a newer edit elsewhere answers 409 and nothing
 * is overwritten.
 */
export async function changeWork(
  client: CreatorHubClient,
  work: WorkRef,
  patch: WorkPatch,
  handles: EditorHandles,
): Promise<{ outcome: ChangeOutcome; work: WorkDetail | null }> {
  const handle = handles.get(work.id);
  if (handle !== undefined) return { outcome: await handle.change(patch), work: null };
  try {
    const next = await client.works.patch(work.id, {
      ...patch,
      base_revision: work.current_revision_id,
    });
    return { outcome: 'saved', work: next };
  } catch (err) {
    return {
      outcome: err instanceof ApiError && err.status === 409 ? 'conflict' : 'failed',
      work: null,
    };
  }
}

// ---- 刪除、還原、批量 (QC-052 on the QC-051 API) ----

/** What a bulk action did: the works the service returned, and why the others did not change. */
export interface BulkOutcome {
  ok: Work[];
  failed: { id: string; code: string | null }[];
}

type BatchChange =
  | { action: 'trash' }
  | { action: 'restore' }
  | { action: 'set_status'; status: WorkStatus }
  | { action: 'add_tags' | 'remove_tags'; tags: string[] };

function codeOf(err: unknown): string | null {
  return err instanceof ApiError ? (err.code ?? null) : null;
}

/**
 * Run one change on many works with `POST /works/batch` (one request per
 * 200, each with its own idempotency key). Items fail on their own; nothing
 * is rolled back.
 */
export async function batchWorks(
  client: CreatorHubClient,
  change: BatchChange,
  works: readonly WorkRef[],
): Promise<BulkOutcome> {
  const out: BulkOutcome = { ok: [], failed: [] };
  for (let i = 0; i < works.length; i += WORKS_BATCH_MAX) {
    const items = works
      .slice(i, i + WORKS_BATCH_MAX)
      .map((w) => ({ id: w.id, base_revision: w.current_revision_id }));
    try {
      const res = await client.works.batch({ ...change, items }, { idempotencyKey: batchKey() });
      const s = summarize(res.results);
      out.ok.push(...s.ok);
      out.failed.push(...s.failed);
    } catch (err) {
      out.failed.push(...items.map((it) => ({ id: it.id, code: codeOf(err) })));
    }
  }
  return out;
}

/**
 * 刪除: one work with `DELETE /works/:id` (which can also move an external
 * work's file to the macOS Trash), several with the batch endpoint (which
 * only unindexes external works).
 */
export async function trashWorks(
  client: CreatorHubClient,
  works: readonly WorkRef[],
  options: { moveOriginal?: boolean } = {},
): Promise<BulkOutcome> {
  const only = works.length === 1 ? works[0] : undefined;
  if (only === undefined) return batchWorks(client, { action: 'trash' }, works);
  try {
    const res = await client.works.trash(only.id, {
      base_revision: only.current_revision_id,
      ...(options.moveOriginal === true ? { move_original_to_trash: true } : {}),
    });
    return { ok: [res.work], failed: [] };
  } catch (err) {
    return { ok: [], failed: [{ id: only.id, code: codeOf(err) }] };
  }
}

/** 還原 from 最近刪除: the revision and history stay as they were. */
export async function restoreWorks(
  client: CreatorHubClient,
  works: readonly WorkRef[],
): Promise<BulkOutcome> {
  const only = works.length === 1 ? works[0] : undefined;
  if (only === undefined) return batchWorks(client, { action: 'restore' }, works);
  try {
    const work = await client.works.restoreFromTrash(only.id, {
      base_revision: only.current_revision_id,
    });
    return { ok: [work], failed: [] };
  } catch (err) {
    return { ok: [], failed: [{ id: only.id, code: codeOf(err) }] };
  }
}

/** 永久刪除 works in 最近刪除, one request each (there is no batch purge). */
export async function purgeWorks(
  client: CreatorHubClient,
  ids: readonly string[],
): Promise<{ purged: string[]; failed: { id: string; code: string | null }[] }> {
  const purged: string[] = [];
  const failed: { id: string; code: string | null }[] = [];
  for (const id of ids) {
    try {
      await client.works.purge(id);
      purged.push(id);
    } catch (err) {
      failed.push({ id, code: codeOf(err) });
    }
  }
  return { purged, failed };
}

/**
 * Before a batch change, save what the open editors hold and take the works'
 * newest revisions, so the batch neither loses an unsaved edit nor answers
 * 409 for the editor's own last save. Clean editors then follow the batch's
 * revision through SSE.
 */
export async function freshRevisions<W extends WorkRef>(
  client: CreatorHubClient,
  works: readonly W[],
  handles: EditorHandles,
): Promise<W[]> {
  const open = works.filter((w) => handles.has(w.id));
  if (open.length === 0) return [...works];
  for (const w of open) {
    const handle = handles.get(w.id);
    if (handle !== undefined) await handle.flush();
  }
  const res = await client.works.list({ ids: open.map((w) => w.id) });
  const now = new Map(res.items.map((w) => [w.id, w.current_revision_id]));
  return works.map((w) => {
    const rev = now.get(w.id);
    return rev === undefined ? w : { ...w, current_revision_id: rev };
  });
}
