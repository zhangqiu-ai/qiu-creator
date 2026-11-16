import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetKind, AssetOrigin, WorkAssetRole } from '@qiu-creator/contracts';
import { sha256Hex, UnsafePathError } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import { resolveRealPathInside } from '../fs/safe-path.js';
import type { Layout } from '../layout.js';

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

export function guessMedia(fileName: string): { mime: string; kind: AssetKind } {
  return (
    MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? {
      mime: 'application/octet-stream',
      kind: 'other',
    }
  );
}

export interface StreamTarget {
  absPath: string;
  size: number;
  mimeType: string;
}

interface AssetRow {
  id: string;
  path: string;
  mime_type: string;
}

export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
  ) {}

  /**
   * Copy a local file into a managed work's `assets/` folder and index it.
   * M0 helper for dev scripts and tests; the upload/URL import center is M1.
   */
  registerFromFile(
    workId: string,
    sourceFile: string,
    options: { origin?: AssetOrigin; role?: WorkAssetRole } = {},
  ): { id: string } {
    const work = this.db
      .prepare<[string], { id: string }>('SELECT id FROM works WHERE id = ?')
      .get(workId);
    if (!work) throw notFound('work');
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
          `INSERT INTO assets (id, kind, path, sha256, mime_type, bytes, duration, width, height, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, kind, rel, sha, mime, bytes, options.origin ?? 'manual', now);
      this.db
        .prepare(
          `INSERT INTO work_assets (work_id, asset_id, role, position)
           VALUES (?, ?, ?, (SELECT count(*) FROM work_assets WHERE work_id = ?))`,
        )
        .run(workId, id, options.role ?? (kind === 'video' ? 'video' : 'body'), workId);
    })();
    return { id };
  }

  /** Locate an asset's file for streaming, refusing paths that escape CREATORHUB_HOME. */
  streamTarget(id: string): StreamTarget {
    const row = this.db
      .prepare<[string], AssetRow>('SELECT id, path, mime_type FROM assets WHERE id = ?')
      .get(id);
    if (!row) throw notFound('asset');
    let absPath: string;
    try {
      absPath = resolveRealPathInside(this.layout.home, row.path);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw new ServiceError(403, 'path_rejected', 'asset path is outside the CreatorHub home');
      }
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new ServiceError(404, 'not_found', 'asset file is missing on disk');
      }
      throw err;
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new ServiceError(404, 'not_found', 'asset is not a regular file');
    return { absPath, size: stat.size, mimeType: row.mime_type };
  }
}
