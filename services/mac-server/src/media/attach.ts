import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AttachWorkMediaResponse } from '@qiu-creator/contracts';
import { isPathInside, isSafeFileName } from '@qiu-creator/domain';
import type { AssetService } from '../assets/asset-service.js';
import { ServiceError } from '../errors.js';
import type { Layout } from '../layout.js';
import type { WorkService } from '../works/work-service.js';

/**
 * QC-039: make a library asset usable from a managed work's Markdown.
 *
 * Managed Markdown can only reach the work's own `assets/` folder
 * (`WorkMediaService`), so the asset's file is copied there:
 *
 * - The copy is independent: trashing or purging the library asset later
 *   does not break images already in the post.
 * - Same content (sha256) already in `assets/` is reused, not copied again.
 * - A different file with the same name gets `name-2.png`, `name-3.png`…;
 *   an existing file is never overwritten (exclusive `link`, not `rename`).
 * - The copy is written to a temporary file, checked against the asset's
 *   sha256 and fsynced before it appears under its final name.
 * - Every path is checked to stay inside `library/works/<id>/assets/`.
 * - The asset is linked to the work (idempotent), so QC-037 treats it as in use.
 * - The work's Markdown is never written here.
 *
 * External (mounted) works answer 409 `attach_external_unsupported`: the app
 * never writes into the user's own folders.
 */
export class WorkMediaAttacher {
  /** One attach at a time per work, so two requests cannot race on names. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly layout: Layout,
    private readonly works: WorkService,
    private readonly assets: AssetService,
  ) {}

  attach(workId: string, assetId: string): Promise<AttachWorkMediaResponse> {
    const previous = this.queues.get(workId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.attachNow(workId, assetId));
    this.queues.set(workId, run);
    // Clean up on both outcomes without leaving a second, unhandled rejection behind.
    const done = (): void => {
      if (this.queues.get(workId) === run) this.queues.delete(workId);
    };
    run.then(done, done);
    return run;
  }

  private async attachNow(workId: string, assetId: string): Promise<AttachWorkMediaResponse> {
    const ctx = this.works.mediaContext(workId); // 404 for an unknown work
    if (ctx.mountId !== null) {
      throw new ServiceError(
        409,
        'attach_external_unsupported',
        'an external work cannot take copied-in files; add the image to its own folder',
      );
    }
    const asset = this.assets.get(assetId); // 404 for an unknown asset
    if (asset.deleted_at != null) {
      throw new ServiceError(409, 'asset_in_trash', 'the asset is in 最近刪除; restore it first');
    }

    let source: string;
    try {
      source = this.assets.filePath(asset);
    } catch (err) {
      if (err instanceof ServiceError && err.statusCode === 404) {
        throw new ServiceError(409, 'asset_file_missing', 'the asset file is not on disk');
      }
      throw err;
    }

    const workDir = this.layout.abs(this.layout.workDirRel(workId));
    const dir = path.join(workDir, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    if (!isPathInside(workDir, dir) || fs.lstatSync(dir).isSymbolicLink()) {
      throw new ServiceError(403, 'path_rejected', 'the work folder is not usable');
    }

    let name = findSameContent(dir, asset.bytes, asset.sha256);
    const copied = name === null;
    if (name === null) name = await this.copyIn(source, dir, attachName(asset), asset.sha256);

    const linked = this.assets.workAssets(workId).some((item) => item.asset.id === assetId);
    if (!linked) this.assets.link(workId, assetId, asset.kind === 'video' ? 'video' : 'body');

    return { src: `assets/${name}`, copied, asset: this.assets.get(assetId) };
  }

  private async copyIn(
    source: string,
    dir: string,
    wanted: string,
    sha256: string,
  ): Promise<string> {
    const tmp = path.join(dir, `.attach-${randomUUID()}.tmp`);
    try {
      await fs.promises.copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
      if (hashFile(tmp) !== sha256) {
        throw new ServiceError(409, 'asset_file_missing', 'the asset file changed on disk');
      }
      const fd = fs.openSync(tmp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const { stem, ext } = splitName(wanted);
      for (let n = 1; n < 10_000; n += 1) {
        const name = n === 1 ? wanted : `${stem}-${String(n)}${ext}`;
        const target = path.join(dir, name);
        if (!isPathInside(dir, target) || path.dirname(target) !== dir) {
          throw new ServiceError(403, 'path_rejected', 'file name is not allowed');
        }
        try {
          // link() fails if the name exists: an existing file is never replaced.
          fs.linkSync(tmp, target);
          return name;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      throw new ServiceError(409, 'validation_error', 'too many files with this name');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

const UNSAFE_CHARS = new Set([
  ':',
  '(',
  ')',
  '[',
  ']',
  '<',
  '>',
  '#',
  '?',
  '%',
  '"',
  "'",
  '`',
  '\\',
  '/',
]);

/**
 * A regular file directly in `dir` with this size and sha256 (not a symlink,
 * not a dot-file, not `exclude`), if any. Shared with the delete rules (QC-037).
 */
export function findSameContent(
  dir: string,
  bytes: number,
  sha256: string,
  exclude: string | null = null,
): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (exclude !== null && path.resolve(file) === path.resolve(exclude)) continue;
    if (fs.statSync(file).size !== bytes) continue;
    if (hashFile(file) === sha256) return entry.name;
  }
  return null;
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/**
 * A single safe file name for the copy: the original name's last segment,
 * with separators, control characters and Markdown-breaking characters
 * replaced, kept short; falls back to `image.<ext>`.
 */
export function attachName(asset: {
  original_name?: string | null | undefined;
  path: string;
  mime_type: string;
}): string {
  const raw = (asset.original_name ?? '').split(/[\\/]/).pop() ?? '';
  const fromPath = asset.path.split(/[\\/]/).pop() ?? '';
  // Control characters, separators and characters that break `![](…)` or need escaping.
  let cleaned = '';
  for (const ch of raw === '' ? fromPath : raw) {
    const code = ch.charCodeAt(0);
    cleaned += code < 32 || code === 127 || UNSAFE_CHARS.has(ch) ? '-' : ch;
  }
  let name = cleaned
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .trim();
  if (name.length > 120) {
    const { stem, ext } = splitName(name);
    name = stem.slice(0, 120 - ext.length) + ext;
  }
  if (name === '' || !isSafeFileName(name) || splitName(name).stem === '') {
    const ext = splitName(fromPath).ext || `.${asset.mime_type.split('/')[1] ?? 'bin'}`;
    name = `image${ext}`;
  }
  return name;
}
