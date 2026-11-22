import fs from 'node:fs';
import path from 'node:path';
import { assertSafeFileName } from '@qiu-creator/domain';

/**
 * On-disk layout under CREATORHUB_HOME (plan section 3):
 *   library/works/<work-id>/source.md
 *   library/works/<work-id>/assets/
 *   library/works/<work-id>/revisions/<revision-id>.md
 *   library/assets/<asset-id>/<file-name>   (uploaded assets, deduplicated by sha256)
 *   cache/thumbnails/<asset-id>.webp        (rebuildable)
 *   cache/ai-images/<job-id>/<index>.<ext>  (unkept AI image candidates, QC-070; temporary)
 *   data/    (SQLite, token, data/uploads for tus, data/incoming for direct uploads)
 * All paths stored in SQLite are relative to home.
 */
export class Layout {
  constructor(readonly home: string) {}

  ensureBase(): void {
    for (const dir of [
      'library/works',
      'library/assets',
      'cache',
      'data',
      'data/uploads',
      'data/incoming',
    ]) {
      fs.mkdirSync(path.join(this.home, dir), { recursive: true, mode: 0o700 });
    }
  }

  get databaseFile(): string {
    return path.join(this.home, 'data', 'creatorhub.sqlite');
  }

  workDirRel(workId: string): string {
    return path.join('library', 'works', assertSafeFileName(workId));
  }

  sourceRel(workId: string): string {
    return path.join(this.workDirRel(workId), 'source.md');
  }

  snapshotRel(workId: string, revisionId: string): string {
    return path.join(this.workDirRel(workId), 'revisions', `${assertSafeFileName(revisionId)}.md`);
  }

  assetRel(workId: string, fileName: string): string {
    return path.join(this.workDirRel(workId), 'assets', assertSafeFileName(fileName));
  }

  /** Uploaded assets live in their own folder, shared by every work that links them. */
  libraryAssetRel(assetId: string, fileName: string): string {
    return path.join(
      'library',
      'assets',
      assertSafeFileName(assetId),
      assertSafeFileName(fileName),
    );
  }

  /** Library card image of a work (QC-061), named by its source fingerprint. Rebuildable. */
  workThumbnailRel(workId: string, version: string): string {
    return path.join(
      'cache',
      'work-thumbnails',
      `${assertSafeFileName(workId)}-${assertSafeFileName(version)}.webp`,
    );
  }

  /** Rebuildable thumbnail cache. */
  thumbnailRel(assetId: string): string {
    return path.join('cache', 'thumbnails', `${assertSafeFileName(assetId)}.webp`);
  }

  /** In-progress resumable (tus) uploads. Not a cache: deleting it loses partial uploads. */
  get uploadsDir(): string {
    return path.join(this.home, 'data', 'uploads');
  }

  /** Staging area for single-request uploads before validation. */
  get incomingDir(): string {
    return path.join(this.home, 'data', 'incoming');
  }

  /** Unkept candidates of one AI image job (QC-070); removed when kept, discarded or old. */
  get aiImagesDir(): string {
    return path.join(this.home, 'cache', 'ai-images');
  }

  aiImageJobDir(jobId: string): string {
    return path.join(this.aiImagesDir, assertSafeFileName(jobId));
  }

  abs(relative: string): string {
    return path.join(this.home, relative);
  }
}
