import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AssetRecordSchema,
  ListAssetsQuerySchema,
  type AssetKind,
  type AssetOrigin,
  type AssetRecord,
  type AssetWorkItem,
  type ListAssetsQuery,
  type ListAssetsResponse,
  type WorkAssetItem,
  type WorkAssetRole,
} from '@qiu-creator/contracts';
import { sha256Hex, UnsafePathError } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import { ContainedPathError, openContainedFile, type ContainedFile } from '../fs/contained-file.js';
import { resolveRealPathInside } from '../fs/safe-path.js';
import type { JobQueue, JobRecord } from '../jobs/job-queue.js';
import type { Layout } from '../layout.js';
import {
  DEFAULT_SIZE_LIMITS,
  detectMedia,
  MediaRejectedError,
  type SizeLimits,
} from '../media/detect.js';
import { probeMedia } from '../media/ffprobe.js';
import { renderThumbnail } from '../media/thumbnails.js';

const MIME_BY_EXT: Record<string, { mime: string; kind: AssetKind }> = {
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/x-m4v', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.heic': { mime: 'image/heic', kind: 'image' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.md': { mime: 'text/markdown; charset=utf-8', kind: 'markdown' },
};

/** Extension-based guess. Only for the M0 dev helper; uploads are identified by content. */
export function guessMedia(fileName: string): { mime: string; kind: AssetKind } {
  return (
    MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? {
      mime: 'application/octet-stream',
      kind: 'other',
    }
  );
}

/** An opened file ready to stream. `open` consumes the descriptor; call `close` if not streaming. */
export interface StreamTarget {
  size: number;
  mimeType: string;
  open: (start: number, end: number) => Readable;
  close: () => void;
}

/** Stream target over an already-open descriptor (closed when the stream ends). */
export function fdStreamTarget(fd: number, size: number, mimeType: string): StreamTarget {
  let closed = false;
  return {
    size,
    mimeType,
    open: (start, end) => {
      closed = true;
      return fs.createReadStream('', { fd, start, end, autoClose: true });
    },
    close: () => {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
}

/** What `registerExternal` needs to know about a file it indexes in place. */
export interface ExternalFileInfo {
  mountId: string;
  /** Path relative to the mount root, `/`-separated. */
  rel: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  mtimeMs: number;
  /** Computes the sha256 only when the indexed copy is stale. */
  sha256: () => Promise<string>;
}

interface AssetRow {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  mime_type: string;
  bytes: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  origin: string;
  created_at: string;
  original_name: string | null;
  codec: string | null;
  metadata_status: string;
  thumbnail_status: string;
  updated_at: string | null;
  mount_id: string | null;
  file_mtime_ms: number | null;
}

function toRecord(row: AssetRow): AssetRecord {
  return AssetRecordSchema.parse({ ...row, updated_at: row.updated_at ?? row.created_at });
}

/** Make an uploaded name safe for Finder while keeping it recognizable; the extension comes from the content. */
export function storedFileName(originalName: string, ext: string): string {
  const base = path
    .basename(originalName.replaceAll('\\', '/'))
    .replace(/\.[^.]*$/, '')
    // Replace control characters and path separators.
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || '/\\:\u007f'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  return `${base === '' ? 'asset' : base}.${ext}`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

export interface AssetServiceOptions {
  limits?: SizeLimits;
  /** Resolved ffprobe binary, or null when unavailable (metadata then degrades to `unavailable`). */
  ffprobe?: string | null;
}

export interface IngestResult {
  asset: AssetRecord;
  deduplicated: boolean;
}

export class AssetService {
  readonly limits: SizeLimits;
  private readonly ffprobe: string | null;

  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly feed?: ChangeFeed,
    private readonly jobs?: JobQueue,
    options: AssetServiceOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_SIZE_LIMITS;
    this.ffprobe = options.ffprobe ?? null;
    jobs?.register('asset.thumbnail', (job) => this.runThumbnailJob(job));
    jobs?.register('asset.probe', (job) => this.runProbeJob(job));
  }

  /**
   * Validate and store a fully received upload. `tempFile` is consumed: it is
   * moved into the library on success and deleted on rejection or duplicate.
   * Identical content (same sha256) returns the existing asset.
   */
  async ingest(
    tempFile: string,
    originalName: string,
    origin: AssetOrigin = 'upload',
  ): Promise<IngestResult> {
    let media;
    let sha;
    try {
      media = await detectMedia(tempFile, originalName, this.limits);
      sha = await sha256File(tempFile);
    } catch (err) {
      fs.rmSync(tempFile, { force: true });
      if (err instanceof MediaRejectedError) {
        throw new ServiceError(
          err.reason === 'payload_too_large' ? 413 : 415,
          err.reason,
          err.message,
        );
      }
      throw err;
    }

    // Synchronous from here on: the duplicate check and the insert cannot interleave.
    const existing = this.db
      .prepare<[string], AssetRow>(
        // External files can vanish with their folder; uploads only dedupe against managed copies.
        'SELECT * FROM assets WHERE sha256 = ? AND mount_id IS NULL ORDER BY created_at LIMIT 1',
      )
      .get(sha);
    if (existing) {
      fs.rmSync(tempFile, { force: true });
      return { asset: toRecord(existing), deduplicated: true };
    }

    const id = randomUUID();
    const rel = this.layout.libraryAssetRel(id, storedFileName(originalName, media.ext));
    const abs = this.layout.abs(rel);
    const bytes = fs.statSync(tempFile).size;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tempFile, abs);
    const now = new Date().toISOString();
    const wantsThumb = media.kind === 'image';
    const wantsProbe = media.kind === 'video' || media.kind === 'audio';
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, duration, width, height, origin,
               created_at, original_name, codec, metadata_status, thumbnail_status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(
            id,
            media.kind,
            rel,
            sha,
            media.mime,
            bytes,
            origin,
            now,
            originalName,
            wantsProbe ? 'pending' : 'none',
            wantsThumb ? 'pending' : 'none',
            now,
          );
        this.feed?.record('asset', id, 'asset.created', { kind: media.kind });
        if (wantsThumb) this.jobs?.enqueue('asset.thumbnail', id);
        if (wantsProbe) this.jobs?.enqueue('asset.probe', id);
      })();
    } catch (err) {
      fs.rmSync(path.dirname(abs), { recursive: true, force: true });
      throw err;
    }
    return { asset: this.get(id), deduplicated: false };
  }

  get(id: string): AssetRecord {
    const row = this.db.prepare<[string], AssetRow>('SELECT * FROM assets WHERE id = ?').get(id);
    if (!row) throw notFound('asset');
    return toRecord(row);
  }

  list(query: ListAssetsQuery = {}): ListAssetsResponse {
    const q = ListAssetsQuerySchema.parse(query);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.q) {
      where.push("original_name LIKE ? ESCAPE '\\'");
      params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM assets ${whereSql}`)
      .get(...params);
    const rows = this.db
      .prepare<(string | number)[], AssetRow>(
        `SELECT * FROM assets ${whereSql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset);
    return { items: rows.map(toRecord), total: total?.n ?? 0, limit: q.limit, offset: q.offset };
  }

  // ---- Work ↔ asset links -------------------------------------------------

  /** Works that use an asset, most recently updated first (one row per role). */
  assetWorks(assetId: string): AssetWorkItem[] {
    this.get(assetId);
    return this.db
      .prepare<[string], AssetWorkItem>(
        `SELECT w.id AS work_id, w.title, wa.role, wa.position, w.updated_at
         FROM work_assets wa JOIN works w ON w.id = wa.work_id
         WHERE wa.asset_id = ? ORDER BY w.updated_at DESC, w.id, wa.role`,
      )
      .all(assetId);
  }

  workAssets(workId: string): WorkAssetItem[] {
    this.requireWork(workId);
    const rows = this.db
      .prepare<[string], AssetRow & { link_role: string; link_position: number }>(
        `SELECT a.*, wa.role AS link_role, wa.position AS link_position
         FROM work_assets wa JOIN assets a ON a.id = wa.asset_id
         WHERE wa.work_id = ? ORDER BY wa.role, wa.position`,
      )
      .all(workId);
    return rows.map(({ link_role, link_position, ...row }) => ({
      role: link_role as WorkAssetRole,
      position: link_position,
      asset: toRecord(row),
    }));
  }

  /** Link an asset to a work under a role. Re-linking an existing pair moves it to `position`. */
  link(workId: string, assetId: string, role: WorkAssetRole, position?: number): WorkAssetItem[] {
    this.requireWork(workId);
    this.get(assetId);
    this.db.transaction(() => {
      const order = this.roleOrder(workId, role).filter((id) => id !== assetId);
      const at = position === undefined ? order.length : Math.min(position, order.length);
      order.splice(at, 0, assetId);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO work_assets (work_id, asset_id, role, position) VALUES (?, ?, ?, 0)',
        )
        .run(workId, assetId, role);
      this.writeOrder(workId, role, order);
      this.feed?.record('work', workId, 'work.assets_changed', {
        role,
        asset_id: assetId,
        change: 'linked',
      });
    })();
    return this.workAssets(workId);
  }

  unlink(workId: string, assetId: string, role: WorkAssetRole): WorkAssetItem[] {
    this.requireWork(workId);
    this.db.transaction(() => {
      const removed = this.db
        .prepare('DELETE FROM work_assets WHERE work_id = ? AND asset_id = ? AND role = ?')
        .run(workId, assetId, role);
      if (removed.changes === 0) throw notFound('work asset link');
      this.writeOrder(workId, role, this.roleOrder(workId, role));
      this.feed?.record('work', workId, 'work.assets_changed', {
        role,
        asset_id: assetId,
        change: 'unlinked',
      });
    })();
    return this.workAssets(workId);
  }

  /** Replace the order of one role. `assetIds` must be exactly the assets linked under that role. */
  reorder(workId: string, role: WorkAssetRole, assetIds: string[]): WorkAssetItem[] {
    this.requireWork(workId);
    this.db.transaction(() => {
      const current = this.roleOrder(workId, role);
      const same =
        current.length === assetIds.length &&
        new Set(assetIds).size === assetIds.length &&
        assetIds.every((id) => current.includes(id));
      if (!same) {
        throw new ServiceError(
          400,
          'validation_error',
          'asset_ids must list every asset linked with this role exactly once',
          {
            current: current,
          },
        );
      }
      this.writeOrder(workId, role, assetIds);
      this.feed?.record('work', workId, 'work.assets_changed', { role, change: 'reordered' });
    })();
    return this.workAssets(workId);
  }

  private roleOrder(workId: string, role: WorkAssetRole): string[] {
    return this.db
      .prepare<[string, string], { asset_id: string }>(
        'SELECT asset_id FROM work_assets WHERE work_id = ? AND role = ? ORDER BY position, asset_id',
      )
      .all(workId, role)
      .map((r) => r.asset_id);
  }

  private writeOrder(workId: string, role: WorkAssetRole, order: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE work_assets SET position = ? WHERE work_id = ? AND asset_id = ? AND role = ?',
    );
    order.forEach((assetId, index) => stmt.run(index, workId, assetId, role));
  }

  private requireWork(workId: string): void {
    const work = this.db
      .prepare<[string], { id: string }>('SELECT id FROM works WHERE id = ?')
      .get(workId);
    if (!work) throw notFound('work');
  }

  // ---- Files, thumbnails, metadata ------------------------------------------

  /**
   * Copy a local file into a managed work's `assets/` folder and index it.
   * M0 dev helper (scripts/register-asset.ts); uploads go through `ingest`.
   */
  registerFromFile(
    workId: string,
    sourceFile: string,
    options: { origin?: AssetOrigin; role?: WorkAssetRole } = {},
  ): { id: string } {
    this.requireWork(workId);
    const id = randomUUID();
    const { mime, kind } = guessMedia(sourceFile);
    const fileName = `${id}${path.extname(sourceFile).toLowerCase()}`;
    const rel = this.layout.assetRel(workId, fileName);
    const abs = this.layout.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(sourceFile, abs, fs.constants.COPYFILE_EXCL);
    const bytes = fs.statSync(abs).size;
    const sha = sha256Hex(fs.readFileSync(abs));
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, duration, width, height, origin,
             created_at, original_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          kind,
          rel,
          sha,
          mime,
          bytes,
          options.origin ?? 'manual',
          now,
          path.basename(sourceFile),
          now,
        );
      this.db
        .prepare(
          `INSERT INTO work_assets (work_id, asset_id, role, position)
           VALUES (?, ?, ?, (SELECT count(*) FROM work_assets WHERE work_id = ?))`,
        )
        .run(workId, id, options.role ?? (kind === 'video' ? 'video' : 'body'), workId);
      this.feed?.record('asset', id, 'asset.created', { kind });
    })();
    return { id };
  }

  /** Locate an asset's file, refusing paths that escape CREATORHUB_HOME. */
  streamTarget(id: string): StreamTarget {
    const row = this.db
      .prepare<[string], Pick<AssetRow, 'id' | 'path' | 'mime_type' | 'mount_id'>>(
        'SELECT id, path, mime_type, mount_id FROM assets WHERE id = ?',
      )
      .get(id);
    if (!row) throw notFound('asset');
    if (row.mount_id !== null) {
      const file = this.openExternal(row.mount_id, row.path);
      return fdStreamTarget(file.fd, file.size, row.mime_type);
    }
    const absPath = this.resolveAssetFile(row.path);
    const fd = fs.openSync(absPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      throw new ServiceError(404, 'not_found', 'asset is not a regular file');
    }
    return fdStreamTarget(fd, stat.size, row.mime_type);
  }

  /** Managed asset row whose file is `rel` (relative to home), if any. */
  findManagedByPath(rel: string): AssetRecord | undefined {
    const row = this.db
      .prepare<[string], AssetRow>('SELECT * FROM assets WHERE path = ? AND mount_id IS NULL')
      .get(rel);
    return row ? toRecord(row) : undefined;
  }

  /**
   * Index a media file inside a mount in place (never moved or copied) and
   * link it to `workId` as body/video media if it is not linked yet. The file
   * is re-hashed only when its size or mtime changed since it was indexed.
   */
  async registerExternal(workId: string, file: ExternalFileInfo): Promise<AssetRecord> {
    const existing = this.db
      .prepare<[string, string], AssetRow>('SELECT * FROM assets WHERE mount_id = ? AND path = ?')
      .get(file.mountId, file.rel);
    const fresh =
      existing !== undefined &&
      existing.bytes === file.bytes &&
      existing.file_mtime_ms === file.mtimeMs &&
      existing.mime_type === file.mime;
    const sha = fresh ? existing.sha256 : await file.sha256();

    // Synchronous from here: the lookup-and-write cannot interleave with another request.
    const now = new Date().toISOString();
    const role: WorkAssetRole = file.kind === 'video' ? 'video' : 'body';
    let assetId = '';
    this.db.transaction(() => {
      const row = this.db
        .prepare<[string, string], AssetRow>('SELECT * FROM assets WHERE mount_id = ? AND path = ?')
        .get(file.mountId, file.rel);
      const wantsThumb = file.kind === 'image';
      const wantsProbe = file.kind === 'video' || file.kind === 'audio';
      if (row === undefined) {
        assetId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, duration, width, height, origin,
               created_at, original_name, codec, metadata_status, thumbnail_status, updated_at,
               mount_id, file_mtime_ms)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'folder', ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            assetId,
            file.kind,
            file.rel,
            sha,
            file.mime,
            file.bytes,
            now,
            path.posix.basename(file.rel),
            wantsProbe ? 'pending' : 'none',
            wantsThumb ? 'pending' : 'none',
            now,
            file.mountId,
            file.mtimeMs,
          );
        this.feed?.record('asset', assetId, 'asset.created', {
          kind: file.kind,
          mount_id: file.mountId,
        });
        if (wantsThumb) this.jobs?.enqueue('asset.thumbnail', assetId);
        if (wantsProbe) this.jobs?.enqueue('asset.probe', assetId);
      } else {
        assetId = row.id;
        const changed =
          row.sha256 !== sha ||
          row.bytes !== file.bytes ||
          row.file_mtime_ms !== file.mtimeMs ||
          row.mime_type !== file.mime;
        if (changed) {
          this.db
            .prepare(
              `UPDATE assets SET kind = ?, sha256 = ?, mime_type = ?, bytes = ?, file_mtime_ms = ?,
                 thumbnail_status = ?, metadata_status = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              file.kind,
              sha,
              file.mime,
              file.bytes,
              file.mtimeMs,
              wantsThumb ? 'pending' : 'none',
              wantsProbe ? 'pending' : 'none',
              now,
              assetId,
            );
          this.feed?.record('asset', assetId, 'asset.updated', { sha256: sha });
          if (wantsThumb) this.jobs?.enqueue('asset.thumbnail', assetId);
          if (wantsProbe) this.jobs?.enqueue('asset.probe', assetId);
        }
      }
      const linked = this.db
        .prepare<[string, string], { n: number }>(
          'SELECT count(*) AS n FROM work_assets WHERE work_id = ? AND asset_id = ?',
        )
        .get(workId, assetId);
      if ((linked?.n ?? 0) === 0) {
        const order = this.roleOrder(workId, role);
        this.db
          .prepare(
            'INSERT INTO work_assets (work_id, asset_id, role, position) VALUES (?, ?, ?, ?)',
          )
          .run(workId, assetId, role, order.length);
        this.feed?.record('work', workId, 'work.assets_changed', {
          role,
          asset_id: assetId,
          change: 'linked',
        });
      }
    })();
    return this.get(assetId);
  }

  /** Open an external asset's file without following symlinks below the mount root. */
  private openExternal(mountId: string, rel: string): ContainedFile {
    const mount = this.db
      .prepare<[string], { root_path: string; status: string }>(
        'SELECT root_path, status FROM mounts WHERE id = ?',
      )
      .get(mountId);
    if (!mount || mount.status !== 'active') {
      throw new ServiceError(404, 'not_found', 'the folder holding this asset is not mounted');
    }
    try {
      return openContainedFile(mount.root_path, rel);
    } catch (err) {
      if (err instanceof ContainedPathError) {
        throw err.reason === 'rejected'
          ? new ServiceError(403, 'path_rejected', 'asset path is not allowed')
          : new ServiceError(404, 'not_found', 'asset file is missing on disk');
      }
      throw err;
    }
  }

  /** Real path of an asset's file for tools that take a path (sharp, ffprobe). */
  private assetSourcePath(asset: AssetRecord): string {
    if (asset.mount_id === null || asset.mount_id === undefined) {
      return this.resolveAssetFile(asset.path);
    }
    const file = this.openExternal(asset.mount_id, asset.path);
    fs.closeSync(file.fd);
    return file.absPath;
  }

  /**
   * Path of the cached thumbnail, regenerating it if `cache/` was cleared.
   * Only images have thumbnails in M1.
   */
  async thumbnailFile(id: string): Promise<string> {
    const asset = this.get(id);
    if (asset.kind !== 'image') throw new ServiceError(404, 'not_found', 'asset has no thumbnail');
    const target = this.layout.abs(this.layout.thumbnailRel(id));
    if (!fs.existsSync(target)) {
      await this.buildThumbnail(asset);
    }
    return target;
  }

  private resolveAssetFile(relPath: string): string {
    try {
      return resolveRealPathInside(this.layout.home, relPath);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw new ServiceError(403, 'path_rejected', 'asset path is outside the CreatorHub home');
      }
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ServiceError(404, 'not_found', 'asset file is missing on disk');
      }
      throw err;
    }
  }

  private async buildThumbnail(asset: AssetRecord): Promise<void> {
    const source = this.assetSourcePath(asset);
    const dims = await renderThumbnail(source, this.layout.abs(this.layout.thumbnailRel(asset.id)));
    this.updateAsset(asset.id, {
      thumbnail_status: 'ready',
      width: dims.width,
      height: dims.height,
    });
  }

  private async runThumbnailJob(job: JobRecord): Promise<void> {
    try {
      await this.buildThumbnail(this.get(job.subject_id));
    } catch (err) {
      if (job.attempts >= job.max_attempts)
        this.updateAsset(job.subject_id, { thumbnail_status: 'failed' });
      throw err;
    }
  }

  private async runProbeJob(job: JobRecord): Promise<void> {
    const asset = this.get(job.subject_id);
    if (this.ffprobe === null) {
      // Degrade: no duration/size, but never an error.
      this.updateAsset(asset.id, { metadata_status: 'unavailable' });
      return;
    }
    try {
      const result = await probeMedia(this.ffprobe, this.assetSourcePath(asset));
      this.updateAsset(asset.id, { metadata_status: 'ready', ...result });
    } catch (err) {
      if (job.attempts >= job.max_attempts)
        this.updateAsset(asset.id, { metadata_status: 'failed' });
      throw err;
    }
  }

  private updateAsset(
    id: string,
    fields: Partial<
      Pick<
        AssetRow,
        'duration' | 'width' | 'height' | 'codec' | 'metadata_status' | 'thumbnail_status'
      >
    >,
  ): void {
    if (!this.db.open) return;
    const entries = (
      Object.entries(fields) as [string, string | number | null | undefined][]
    ).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const set = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE assets SET ${set}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, v]) => v), new Date().toISOString(), id);
      this.feed?.record('asset', id, 'asset.updated', Object.fromEntries(entries));
    })();
  }
}
