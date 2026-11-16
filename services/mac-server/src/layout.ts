import fs from 'node:fs';
import path from 'node:path';
import { assertSafeFileName } from '@qiu-creator/domain';

/**
 * On-disk layout under CREATORHUB_HOME (plan section 3):
 *   library/works/<work-id>/source.md
 *   library/works/<work-id>/assets/
 *   library/works/<work-id>/revisions/<revision-id>.md
 *   cache/   (rebuildable)
 *   data/    (SQLite, token)
 * All paths stored in SQLite are relative to home.
 */
export class Layout {
  constructor(readonly home: string) {}

  ensureBase(): void {
    for (const dir of ['library/works', 'cache', 'data']) {
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

  abs(relative: string): string {
    return path.join(this.home, relative);
  }
}
