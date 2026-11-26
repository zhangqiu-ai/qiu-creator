import fs from 'node:fs';
import path from 'node:path';
import {
  BatchWorksRequestSchema,
  WORK_TRASH_RETENTION_DAYS,
  type BatchWorkResult,
  type BatchWorksRequest,
  type BatchWorksResponse,
  type DeleteWorkRequest,
  type DeleteWorkResponse,
  type PurgedWork,
  type ScriptConversion,
  type WorkDetail,
  type WorkListItem,
  type WorkRemoval,
} from '@qiu-creator/contracts';
import type { Db } from '../db/database.js';
import { ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { Layout } from '../layout.js';
import { defaultSystemTrash, type SystemTrash } from '../assets/system-trash.js';
import { TRASH_FAILED_MESSAGE } from '../assets/asset-library.js';
import type { WorkComposer } from './work-composer.js';
import type { TextScriptService } from './text-script-service.js';
import type { WorkService, WorkTrashTarget } from './work-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorkTrashOptions {
  trash?: SystemTrash;
  now?: () => Date;
  /** How often to look for works deleted more than 30 days ago (default 1 hour). */
  purgeCheckMs?: number;
  onError?: (err: unknown) => void;
  /** QC-103: converts tags agent tokens add to the work's script. */
  textScripts?: TextScriptService;
}

type PurgeReason = 'manual' | 'empty' | 'expired';
type BatchRequest = ReturnType<typeof BatchWorksRequestSchema.parse>;

/**
 * 最近刪除 and batch edits for works (QC-051), like assets (QC-037).
 *
 * - Deleting only marks the row: the revision, history, links and platform
 *   variants stay, so restoring brings the work back exactly as it was.
 * - Managed works keep their folder in CreatorHub until they are purged (by
 *   hand or 30 days after deletion); nothing is removed before that.
 * - External works are only unindexed. Their file is moved to the macOS Trash
 *   only when the owner asks for it on a single delete; it is never deleted.
 */
export class WorkTrash {
  private readonly trashBin: SystemTrash;
  private readonly now: () => Date;
  private readonly purgeCheckMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly works: WorkService,
    private readonly composer: WorkComposer,
    private readonly feed: ChangeFeed | undefined,
    private readonly options: WorkTrashOptions = {},
  ) {
    this.trashBin = options.trash ?? defaultSystemTrash();
    this.now = options.now ?? (() => new Date());
    this.purgeCheckMs = options.purgeCheckMs ?? 60 * 60 * 1000;
  }

  start(): void {
    this.purgeExpiredSafely();
    this.timer = setInterval(() => {
      this.purgeExpiredSafely();
    }, this.purgeCheckMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---- Delete and restore -------------------------------------------------------

  async trash(
    id: string,
    baseRevision: string | null,
    request: DeleteWorkRequest = {},
  ): Promise<DeleteWorkResponse> {
    const target = this.works.trashTarget(id, baseRevision, 'delete a work');
    requireNotTrashed(target);
    const moveOriginal = request.move_original_to_trash === true;
    if (moveOriginal && target.storageMode !== 'external') {
      throw new ServiceError(
        400,
        'validation_error',
        'move_original_to_trash is only for works in a mounted folder',
      );
    }
    let removal: WorkRemoval = target.storageMode === 'external' ? 'unindexed' : 'trashed';
    if (moveOriginal) {
      const file = this.works.externalSourceFile(id);
      try {
        await this.trashBin.moveToTrash(file);
      } catch (err) {
        throw new ServiceError(500, 'trash_failed', TRASH_FAILED_MESSAGE, {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      removal = 'original_trashed';
    }
    this.db.transaction(() => {
      // The Trash call is async: another request may have deleted it meanwhile.
      // The file is in the Trash by now, so that outcome is still recorded.
      if (!moveOriginal) {
        requireNotTrashed(this.works.trashTarget(id, target.currentRevision, 'delete a work'));
      }
      this.markRemoved(id, removal);
    })();
    return { work: this.works.listItemById(id) };
  }

  /** Back from 最近刪除; revision and history unchanged. An active work is returned as it is. */
  restore(id: string, baseRevision: string | null): WorkDetail {
    const target = this.works.trashTarget(id, baseRevision, 'restore a work');
    if (target.deletedAt === null) return this.works.get(id);
    if (target.removal === 'original_trashed' && !this.works.externalSourcePresent(id)) {
      throw new ServiceError(
        409,
        'source_missing',
        'the file is still in the Trash; put it back in Finder, then restore',
        { path: target.sourcePath },
      );
    }
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          'UPDATE works SET deleted_at = NULL, removal = NULL WHERE id = ? AND deleted_at IS NOT NULL',
        )
        .run(id);
      if (changed.changes === 1) this.feed?.record('work', id, 'work.restored', {});
    })();
    return this.works.get(id);
  }

  // ---- Permanent deletion ---------------------------------------------------------

  purge(id: string): PurgedWork {
    return this.purgeTarget(this.works.trashedTarget(id), 'manual');
  }

  emptyTrash(): PurgedWork[] {
    return this.works.trashedTargets().map((t) => this.purgeTarget(t, 'empty'));
  }

  /** Purge every work deleted more than 30 days ago. */
  purgeExpired(): PurgedWork[] {
    const cutoff = new Date(this.now().getTime() - WORK_TRASH_RETENTION_DAYS * DAY_MS);
    return this.works
      .trashedTargets(cutoff.toISOString())
      .map((t) => this.purgeTarget(t, 'expired'));
  }

  // ---- Batch ------------------------------------------------------------------------

  /**
   * Items are handled one by one, in order; each succeeds or fails on its own
   * and earlier successes stay. Deleting only unindexes external works.
   */
  async batch(input: BatchWorksRequest): Promise<BatchWorksResponse> {
    const request = BatchWorksRequestSchema.parse(input);
    const results: BatchWorkResult[] = [];
    for (const item of request.items) {
      try {
        const done = await this.batchItem(request, item);
        results.push({
          id: item.id,
          ok: true,
          work: done.work,
          ...(done.conversion === undefined ? {} : { script_conversion: done.conversion }),
        });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: itemError(err) });
        if (!(err instanceof ServiceError)) this.options.onError?.(err);
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  private async batchItem(
    request: BatchRequest,
    item: { id: string; base_revision: string },
  ): Promise<{ work: WorkListItem; conversion?: ScriptConversion | undefined }> {
    if (request.action === 'trash') {
      return { work: (await this.trash(item.id, item.base_revision)).work };
    }
    if (request.action === 'restore') {
      this.restore(item.id, item.base_revision);
      return { work: this.works.listItemById(item.id) };
    }
    // Status and tags: the revision check and 409 `work_in_trash` apply even
    // when nothing would change.
    requireNotTrashed(this.works.trashTarget(item.id, item.base_revision, 'edit a work'));
    const current = this.works.get(item.id);
    if (request.action === 'set_status') {
      if (current.status !== request.status) {
        await this.composer.patch(item.id, {
          base_revision: item.base_revision,
          status: request.status,
        });
      }
      return { work: this.works.listItemById(item.id) };
    }
    // QC-103: tags an agent adds are converted to the work's script; tags to
    // remove must match what is stored, so they are not.
    const scripts = this.options.textScripts;
    const added =
      request.action === 'add_tags' && scripts !== undefined
        ? scripts.forAgent(
            { tags: request.tags },
            () => scripts.forWork(item.id),
            // QC-111: tags the work already has stay as they are.
            () => ({ tags: current.tags }),
          )
        : { value: { tags: request.tags }, conversion: undefined };
    const addTags = added.value.tags;
    const next =
      request.action === 'add_tags'
        ? [...new Set([...current.tags, ...addTags])]
        : current.tags.filter((t) => !request.tags.includes(t));
    if (next.length > 64) {
      throw new ServiceError(400, 'validation_error', 'a work can have at most 64 tags');
    }
    if (JSON.stringify(next) !== JSON.stringify(current.tags)) {
      await this.composer.patch(item.id, { base_revision: item.base_revision, tags: next });
    }
    return { work: this.works.listItemById(item.id), conversion: added.conversion };
  }

  // ---- Internals ------------------------------------------------------------------

  private markRemoved(id: string, removal: WorkRemoval): void {
    this.db
      .prepare('UPDATE works SET deleted_at = ?, removal = ? WHERE id = ?')
      .run(this.now().toISOString(), removal, id);
    this.feed?.record('work', id, 'work.trashed', { removal });
  }

  private purgeTarget(target: WorkTrashTarget, reason: PurgeReason): PurgedWork {
    const removal: WorkRemoval = target.removal ?? 'trashed';
    const workDir = this.layout.abs(this.layout.workDirRel(target.id));
    // Library assets whose file lives in this work's folder (Markdown imports)
    // move to their own library folder first, so the asset library keeps them.
    const kept = target.storageMode === 'managed' ? this.rehomeAssets(target.id) : true;
    this.db.transaction(() => {
      this.works.deleteRecords(target);
      this.feed?.record('work', target.id, 'work.deleted', { removal, reason });
    })();
    // External works: the folder only holds snapshots. The file is never touched.
    if (kept) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (err) {
        this.options.onError?.(err);
      }
    }
    return { id: target.id, removal };
  }

  /**
   * Move managed assets stored under `library/works/<id>/` to
   * `library/assets/<asset-id>/`. Returns false if any could not be moved;
   * the work's folder is then left on disk rather than deleting their files.
   */
  private rehomeAssets(workId: string): boolean {
    const prefix = this.layout.workDirRel(workId) + path.sep;
    const rows = this.db
      .prepare<[string, string], { id: string; path: string }>(
        'SELECT id, path FROM assets WHERE mount_id IS NULL AND substr(path, 1, length(?)) = ? ORDER BY id',
      )
      .all(prefix, prefix);
    let ok = true;
    const moved = new Map<string, string>();
    for (const row of rows) {
      const already = moved.get(row.path);
      try {
        const target = already ?? this.layout.libraryAssetRel(row.id, path.basename(row.path));
        if (already === undefined) {
          const from = this.layout.abs(row.path);
          if (!fs.existsSync(from)) continue;
          fs.mkdirSync(path.dirname(this.layout.abs(target)), { recursive: true });
          fs.renameSync(from, this.layout.abs(target));
          moved.set(row.path, target);
        }
        this.db.prepare('UPDATE assets SET path = ? WHERE id = ?').run(target, row.id);
      } catch (err) {
        ok = false;
        this.options.onError?.(err);
      }
    }
    return ok;
  }

  private purgeExpiredSafely(): void {
    try {
      if (this.db.open) this.purgeExpired();
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}

function requireNotTrashed(target: WorkTrashTarget): void {
  if (target.deletedAt !== null) {
    throw new ServiceError(409, 'work_in_trash', 'the work is already in 最近刪除', {
      deleted_at: target.deletedAt,
    });
  }
}

/** A batch item's failure, shaped like an error response body's `error`. */
function itemError(err: unknown): Extract<BatchWorkResult, { ok: false }>['error'] {
  if (err instanceof ServiceError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }
  return { code: 'internal_error', message: 'the item could not be changed' };
}
