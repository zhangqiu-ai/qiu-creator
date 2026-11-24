import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_TRASH_RETENTION_DAYS,
  type AssetRecord,
  type AssetReferences,
  type AssetRemoval,
  type BatchAssetsRequest,
  type DeleteAssetRequest,
  type DeleteAssetResponse,
  type MarkdownReferrer,
  type PurgedAsset,
  type UpdateAssetRequest,
} from '@qiu-creator/contracts';
import { checkRevision, resolveBaseRevision } from '@qiu-creator/domain';
import { ProjectScope } from '../auth/project-scope.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { Layout } from '../layout.js';
import {
  toRecord,
  variantCoverSql,
  variantImageSql,
  type AssetRow,
  type AssetService,
} from './asset-service.js';
import { defaultSystemTrash, type SystemTrash } from './system-trash.js';
import { findSameContent } from '../media/attach.js';

/** Each binds the asset id twice (see variantCoverSql). */
const VARIANT_COVER_SQL = variantCoverSql('?');
const VARIANT_IMAGE_SQL = variantImageSql('?');

const DAY_MS = 24 * 60 * 60 * 1000;

/** The message the app shows when the Trash refused the file (QC-037). */
export const TRASH_FAILED_MESSAGE = '無法移到系統垃圾桶，原檔未變動';

export interface AssetLibraryOptions {
  trash?: SystemTrash;
  /** Works whose current Markdown links to a managed asset's file (purge warns about them). */
  markdownReferrers?: (asset: AssetRecord) => MarkdownReferrer[];
  now?: () => Date;
  /** How often to look for trashed assets past 30 days (default 1 hour). */
  purgeCheckMs?: number;
  onError?: (err: unknown) => void;
}

type PurgeReason = 'manual' | 'empty' | 'expired';

/**
 * Edit, delete and 最近刪除 for the asset library (QC-037).
 *
 * - Deleting never touches references: work links and variant ids stay, so a
 *   restore brings everything back. Trashed assets are hidden from listings
 *   and work asset lists, and cannot be linked.
 * - Managed files stay where they are until the asset is purged (by hand or
 *   30 days after deletion); external originals are never moved or deleted
 *   unless the request explicitly asks for the macOS Trash.
 */
export class AssetLibrary {
  private readonly trashBin: SystemTrash;
  private readonly now: () => Date;
  private readonly purgeCheckMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly assets: AssetService,
    private readonly feed: ChangeFeed | undefined,
    private readonly options: AssetLibraryOptions = {},
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

  // ---- Edit -------------------------------------------------------------------

  update(id: string, body: UpdateAssetRequest, ifMatch: string | undefined): AssetRecord {
    return this.db.transaction(() => {
      const row = this.row(id);
      this.requireActive(row);
      this.checkBase(row, body.base_revision, ifMatch);
      const fields: Record<string, string | null> = {};
      if (body.display_name !== undefined) fields['display_name'] = body.display_name;
      if (body.tags !== undefined) fields['tags'] = JSON.stringify(uniqueTags(body.tags));
      if (body.alt_text !== undefined) fields['alt_text'] = body.alt_text;
      if (body.note !== undefined) fields['note'] = body.note;
      const names = Object.keys(fields);
      const revision = row.revision + 1;
      this.db
        .prepare(
          `UPDATE assets SET ${names.map((n) => `${n} = ?`).join(', ')}, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(...Object.values(fields), revision, this.stamp(), id, row.revision);
      this.feed?.record('asset', id, 'asset.updated', { fields: names, revision });
      return this.assets.get(id);
    })();
  }

  // ---- References ---------------------------------------------------------------

  /**
   * Works and platform variants that use the asset. References from works in
   * 最近刪除 are listed apart in `in_trash` (QC-053) and do not make the asset
   * count as in use.
   */
  references(id: string): AssetReferences {
    this.row(id);
    const asset = this.assets.get(id);
    const rows = this.db
      .prepare<
        [string],
        Omit<AssetReferences['works'][number], 'independent_copy'> & {
          storage_mode: string;
          trashed: number;
        }
      >(
        `SELECT w.id AS work_id, w.title, wa.role, wa.position, w.storage_mode,
           w.deleted_at IS NOT NULL AS trashed
         FROM work_assets wa JOIN works w ON w.id = wa.work_id
         WHERE wa.asset_id = ? ORDER BY w.updated_at DESC, w.id, wa.role`,
      )
      .all(id);
    const works = rows.map(({ storage_mode, trashed, ...ref }) => ({
      trashed: trashed === 1,
      ref: {
        ...ref,
        independent_copy:
          ref.role === 'body' && storage_mode !== 'external' && this.hasCopy(ref.work_id, asset),
      },
    }));
    const variants = this.db
      .prepare<
        [string, string, string, string],
        AssetReferences['variants'][number] & { trashed: number }
      >(
        `SELECT pv.work_id, w.title, pv.platform, 'cover' AS usage,
           w.deleted_at IS NOT NULL AS trashed
         FROM platform_variants pv JOIN works w ON w.id = pv.work_id
         WHERE pv.deleted_at IS NULL AND ${VARIANT_COVER_SQL}
         UNION ALL
         SELECT pv.work_id, w.title, pv.platform, 'image' AS usage,
           w.deleted_at IS NOT NULL AS trashed
         FROM platform_variants pv JOIN works w ON w.id = pv.work_id
         WHERE pv.deleted_at IS NULL AND ${VARIANT_IMAGE_SQL}
         ORDER BY 1, 3, 4`,
      )
      .all(id, id, id, id)
      .map(({ trashed, ...ref }) => ({ trashed: trashed === 1, ref }));
    // QC-089: a token limited to projects sees only references from its works.
    const scope = new ProjectScope(this.db);
    const visible = <T extends { ref: { work_id: string } }>(list: T[]): T[] =>
      list.filter((x) => scope.allowsWork(x.ref.work_id));
    const shownWorks = visible(works);
    const shownVariants = visible(variants);
    return {
      works: shownWorks.filter((w) => !w.trashed).map((w) => w.ref),
      variants: shownVariants.filter((v) => !v.trashed).map((v) => v.ref),
      in_trash: {
        works: shownWorks.filter((w) => w.trashed).map((w) => w.ref),
        variants: shownVariants.filter((v) => v.trashed).map((v) => v.ref),
      },
    };
  }

  /**
   * A body image of a managed work survives deleting the library asset when the
   * work's own `assets/` holds another file with the same content (QC-039 attach).
   * The asset's own file does not count: deleting the asset removes it.
   */
  private hasCopy(workId: string, asset: AssetRecord): boolean {
    const dir = this.layout.abs(path.join(this.layout.workDirRel(workId), 'assets'));
    const own = asset.mount_id == null ? this.layout.abs(asset.path) : null;
    return findSameContent(dir, asset.bytes, asset.sha256, own) !== null;
  }

  // ---- Delete and restore -------------------------------------------------------

  async trash(id: string, request: DeleteAssetRequest = {}): Promise<DeleteAssetResponse> {
    const row = this.row(id);
    this.requireActive(row);
    const external = row.mount_id !== null;
    const moveOriginal = request.move_original_to_trash === true;
    if (moveOriginal && !external) {
      throw new ServiceError(
        400,
        'validation_error',
        'move_original_to_trash is only for assets in a mounted folder',
      );
    }
    const references = this.references(id);
    this.requireConfirmed(request.confirm === true, [{ id, references }], true);

    let removal: AssetRemoval = external ? 'unindexed' : 'trashed';
    if (moveOriginal) {
      const file = this.existingFile(row);
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
      // The Trash call is async: another request may have removed it meanwhile.
      // The original is in the Trash by now, so that outcome is still recorded.
      if (!moveOriginal) this.requireActive(this.row(id));
      this.markRemoved(id, removal);
    })();
    return { asset: this.assets.get(id), references };
  }

  /** Back from 最近刪除 with its references. Restoring an active asset is a no-op. */
  restore(id: string): AssetRecord {
    const row = this.row(id);
    if (row.deleted_at === null) return toRecord(row);
    this.existingFile(row);
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE assets SET deleted_at = NULL, removal = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
        )
        .run(this.stamp(), id);
      // Its work links come back at the end of each role (the others may have been reordered).
      const links = this.db
        .prepare<[string], { work_id: string; role: string }>(
          'SELECT work_id, role FROM work_assets WHERE asset_id = ?',
        )
        .all(id);
      for (const link of links) {
        this.db
          .prepare(
            `UPDATE work_assets SET position = (
               SELECT count(*) FROM work_assets wa JOIN assets a ON a.id = wa.asset_id
               WHERE wa.work_id = ? AND wa.role = ? AND wa.asset_id <> ? AND a.deleted_at IS NULL)
             WHERE work_id = ? AND role = ? AND asset_id = ?`,
          )
          .run(link.work_id, link.role, id, link.work_id, link.role, id);
      }
      this.feed?.record('asset', id, 'asset.restored', {});
      this.notifyWorks(id, 'restored');
    })();
    return this.assets.get(id);
  }

  // ---- Permanent deletion ---------------------------------------------------------

  purge(id: string): PurgedAsset {
    const row = this.row(id);
    if (row.deleted_at === null) {
      throw new ServiceError(404, 'not_found', 'asset is not in 最近刪除');
    }
    return this.purgeRow(row, 'manual');
  }

  emptyTrash(): PurgedAsset[] {
    return this.trashedRows('1').map((row) => this.purgeRow(row, 'empty'));
  }

  /** Purge everything deleted more than 30 days ago. */
  purgeExpired(): PurgedAsset[] {
    const cutoff = new Date(this.now().getTime() - ASSET_TRASH_RETENTION_DAYS * DAY_MS);
    return this.trashedRows('deleted_at <= ?', cutoff.toISOString()).map((row) =>
      this.purgeRow(row, 'expired'),
    );
  }

  // ---- Batch ------------------------------------------------------------------------

  batch(request: BatchAssetsRequest): AssetRecord[] {
    const ids = [...new Set(request.ids)];
    return this.db.transaction(() => {
      const rows = ids.map((id) => {
        const row = this.db
          .prepare<[string], AssetRow>('SELECT * FROM assets WHERE id = ?')
          .get(id);
        if (!row) throw new ServiceError(404, 'not_found', 'asset not found', { asset_id: id });
        return row;
      });
      const trashed = rows.filter((r) => r.deleted_at !== null).map((r) => r.id);
      if (trashed.length > 0) {
        throw new ServiceError(409, 'asset_in_trash', 'some assets are in 最近刪除', {
          asset_ids: trashed,
        });
      }
      if (request.action === 'trash') {
        this.requireConfirmed(
          request.confirm === true,
          rows.map((r) => ({ id: r.id, references: this.references(r.id) })),
        );
        for (const r of rows) this.markRemoved(r.id, r.mount_id === null ? 'trashed' : 'unindexed');
      } else {
        for (const r of rows) {
          const current = parseTagList(r.tags);
          const next =
            request.action === 'add_tags'
              ? uniqueTags([...current, ...request.tags])
              : current.filter((t) => !request.tags.includes(t));
          if (next.length > 64) {
            throw new ServiceError(400, 'validation_error', 'an asset can have at most 64 tags', {
              asset_id: r.id,
            });
          }
          if (JSON.stringify(next) === JSON.stringify(current)) continue;
          const revision = r.revision + 1;
          this.db
            .prepare('UPDATE assets SET tags = ?, revision = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(next), revision, this.stamp(), r.id);
          this.feed?.record('asset', r.id, 'asset.updated', { fields: ['tags'], revision });
        }
      }
      return ids.map((id) => this.assets.get(id));
    })();
  }

  // ---- Internals ------------------------------------------------------------------

  private row(id: string): AssetRow {
    const row = this.db.prepare<[string], AssetRow>('SELECT * FROM assets WHERE id = ?').get(id);
    if (!row) throw notFound('asset');
    return row;
  }

  private requireActive(row: AssetRow): void {
    if (row.deleted_at !== null) {
      throw new ServiceError(409, 'asset_in_trash', 'the asset is in 最近刪除; restore it first');
    }
  }

  /** 409 `asset_in_use` unless confirmed: `details.references` for one asset, `details.assets` for a batch. */
  private requireConfirmed(
    confirmed: boolean,
    candidates: { id: string; references: AssetReferences }[],
    single = false,
  ): void {
    const inUse = candidates.filter(
      (u) => u.references.works.length + u.references.variants.length > 0,
    );
    if (inUse.length === 0 || confirmed) return;
    throw new ServiceError(
      409,
      'asset_in_use',
      'the asset is used by works or platform variants; resend with confirm: true',
      single ? { references: inUse[0]?.references } : { assets: inUse },
    );
  }

  private checkBase(
    row: AssetRow,
    bodyBase: number | undefined,
    ifMatch: string | undefined,
  ): void {
    const current = String(row.revision);
    const base = resolveBaseRevision(
      bodyBase === undefined ? undefined : String(bodyBase),
      ifMatch,
      current,
    );
    const check = checkRevision(base, current);
    if (check.ok) return;
    if (check.reason === 'missing_base') {
      throw new ServiceError(
        428,
        'precondition_required',
        'base_revision or If-Match is required to edit an asset',
        { current_revision: row.revision },
      );
    }
    throw new ServiceError(
      409,
      'revision_conflict',
      'the asset was changed since base_revision; reload before saving',
      { current_revision: row.revision, base_revision: check.base },
    );
  }

  /** Absolute path of the asset's file; 409 `asset_file_missing` when it is not there. */
  private existingFile(row: AssetRow): string {
    try {
      return this.assets.filePath(toRecord(row));
    } catch (err) {
      if (err instanceof ServiceError && err.statusCode === 404) {
        throw new ServiceError(
          409,
          'asset_file_missing',
          row.removal === 'original_trashed'
            ? 'the original is still in the Trash; put it back in Finder, then restore'
            : 'the file is not at its path any more',
          { path: row.path },
        );
      }
      throw err;
    }
  }

  private markRemoved(id: string, removal: AssetRemoval): void {
    this.db
      .prepare('UPDATE assets SET deleted_at = ?, removal = ?, updated_at = ? WHERE id = ?')
      .run(this.stamp(), removal, this.stamp(), id);
    this.feed?.record('asset', id, 'asset.trashed', { removal });
    this.notifyWorks(id, 'trashed');
  }

  /** Works listing this asset see it vanish or come back. */
  private notifyWorks(id: string, change: 'trashed' | 'restored' | 'deleted'): void {
    const works = this.db
      .prepare<[string], { work_id: string }>(
        'SELECT DISTINCT work_id FROM work_assets WHERE asset_id = ?',
      )
      .all(id);
    for (const w of works) {
      this.feed?.record('work', w.work_id, 'work.assets_changed', { asset_id: id, change });
    }
  }

  private trashedRows(where: string, ...params: string[]): AssetRow[] {
    return this.db
      .prepare<string[], AssetRow>(
        `SELECT * FROM assets WHERE deleted_at IS NOT NULL AND ${where} ORDER BY deleted_at, id`,
      )
      .all(...params);
  }

  private purgeRow(row: AssetRow, reason: PurgeReason): PurgedAsset {
    const removal = (row.removal ?? 'trashed') as AssetRemoval;
    const managed = row.mount_id === null;
    const referrers = managed ? (this.options.markdownReferrers?.(toRecord(row)) ?? []) : [];
    this.db.transaction(() => {
      // Work links cascade and old variant covers become NULL through the
      // foreign keys; variant image lists and overrides (QC-084) drop the id
      // here. Variant history keeps it.
      this.db
        .prepare(
          `UPDATE platform_variants
           SET image_asset_ids = (SELECT json_group_array(j.value) FROM json_each(image_asset_ids) j
                                  WHERE j.value <> ?)
           WHERE EXISTS (SELECT 1 FROM json_each(image_asset_ids) j WHERE j.value = ?)`,
        )
        .run(row.id, row.id);
      this.db
        .prepare(
          `UPDATE platform_variants SET cover_override = NULL
           WHERE json_extract(cover_override, '$.asset_id') = ?`,
        )
        .run(row.id);
      this.db
        .prepare(
          `UPDATE platform_variants SET image_order_override = json_object(
             'order', (SELECT json_group_array(j.value) FROM json_each(image_order_override, '$.order') j WHERE j.value <> @id),
             'hidden', (SELECT json_group_array(j.value) FROM json_each(image_order_override, '$.hidden') j WHERE j.value <> @id),
             'extra', (SELECT json_group_array(j.value) FROM json_each(image_order_override, '$.extra') j WHERE j.value <> @id))
           WHERE image_order_override IS NOT NULL
             AND EXISTS (SELECT 1 FROM json_each(image_order_override, '$.order') j WHERE j.value = @id
                         UNION ALL
                         SELECT 1 FROM json_each(image_order_override, '$.hidden') j WHERE j.value = @id)`,
        )
        .run({ id: row.id });
      this.notifyWorks(row.id, 'deleted');
      this.db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
      this.feed?.record('asset', row.id, 'asset.deleted', { removal, reason });
    })();
    if (managed) this.removeManagedFiles(row);
    fs.rmSync(this.layout.abs(this.layout.thumbnailRel(row.id)), { force: true });
    return { id: row.id, removal, markdown_referrers: referrers };
  }

  /** Delete a purged managed asset's file (and its library folder), never anything outside home. */
  private removeManagedFiles(row: AssetRow): void {
    const shared = this.db
      .prepare<[string], { n: number }>(
        'SELECT count(*) AS n FROM assets WHERE path = ? AND mount_id IS NULL',
      )
      .get(row.path);
    if ((shared?.n ?? 0) > 0) return;
    const parts = row.path.split(path.sep);
    const libraryDir =
      parts.length === 4 && parts[0] === 'library' && parts[1] === 'assets' && parts[2] === row.id;
    try {
      const file = this.assets.filePath(toRecord(row));
      if (libraryDir) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      else fs.rmSync(file, { force: true });
    } catch (err) {
      // Already gone, or unsafe: the record is deleted either way.
      if (!(err instanceof ServiceError)) this.options.onError?.(err);
    }
  }

  private purgeExpiredSafely(): void {
    try {
      if (this.db.open) this.purgeExpired();
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

function parseTagList(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ''))];
}
