import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
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
