import type { WorkStatus } from '@qiu-creator/contracts';
import type { Draft, WorkSession } from './work-session.js';

/**
 * - `pending`: the editor kept the new title but has not saved it yet (offline,
 *   a save error); its own save state shows that and it keeps retrying.
 */
export type ChangeOutcome = 'saved' | 'conflict' | 'failed' | 'pending';

/** What 作品庫 and the tab bar change on a work without opening its editor. */
export interface WorkPatch {
  title?: string;
  status?: WorkStatus;
}

/** What the tab bar and 作品庫 can ask of a mounted editor (QC-047, rename since QC-052). */
export interface EditorTabHandle {
  /** Save now; true when nothing unsaved is left. */
  flush: () => Promise<boolean>;
  /** Stop saving and hand back the unsaved draft (不儲存並關閉), or null when there is none. */
  discard: () => Draft | null;
  /**
   * Rename or change the status through the editor's own session, so the
   * change joins its save queue (and its revision) instead of racing it with
   * a second writer.
   */
  change: (patch: WorkPatch) => Promise<ChangeOutcome>;
}

/** The handle every editor kind registers for its session; `onDiscard` stops the close-time flush. */
export function sessionHandle(s: WorkSession, onDiscard: () => void): EditorTabHandle {
  return {
    flush: async () => {
      await s.save();
      return !s.hasUnsavedChanges() && s.snapshot.status !== 'conflict';
    },
    discard: () => {
      onDiscard();
      const draft = s.hasUnsavedChanges() ? s.snapshot.draft : null;
      s.dispose();
      return draft;
    },
    change: async (patch) => {
      if (s.snapshot.readOnly !== null) return 'failed';
      s.edit(patch);
      await s.save();
      const { status } = s.snapshot;
      if (status === 'conflict') return 'conflict';
      return status === 'saved' ? 'saved' : 'pending';
    },
  };
}
