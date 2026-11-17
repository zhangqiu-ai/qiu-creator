import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreateWorkRequestSchema,
  ListWorksQuerySchema,
  WorkSchema,
  type CreateWorkRequest,
  type ExternalState,
  type ListWorksQuery,
  type ListWorksResponse,
  type Revision,
  type RevisionDetail,
  type RevisionSource,
  type Work,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { checkRevision, isPathInside, resolveInside, sha256Hex } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import {
  atomicWriteFileSync,
  nodeFsOps,
  writeNewFileSync,
  type AtomicFsOps,
} from '../fs/atomic.js';
import type { Layout } from '../layout.js';

interface WorkRow {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string;
  source: string;
  storage_mode: string;
  source_path: string;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
  mount_id: string | null;
  external_state: string | null;
}

interface RevisionRow {
  revision_id: string;
  work_id: string;
  parent_revision_id: string | null;
  content_hash: string;
  snapshot_path: string;
  title: string;
  source: string;
  created_at: string;
}

export interface PatchWorkInput {
  /** Effective base revision (from body or If-Match); `null` when the client sent none. */
  baseRevision: string | null;
  title?: string | undefined;
  markdown?: string | undefined;
  type?: Work['type'] | undefined;
  status?: Work['status'] | undefined;
  tags?: string[] | undefined;
}

/** See `WorkService.mediaContext`. Paths in `baseDir`/`allowedPrefix` use `/`. */
export interface MediaContext {
  workId: string;
  revisionId: string;
  markdown: string;
  mountId: string | null;
  root: string | null;
  baseDir: string;
  allowedPrefix: string | null;
}

/** Where an external file lives. `null` path = mount not active, or the file is not a safe regular file. */
interface ExternalLocation {
  root: string;
  file: string;
}

/** First Markdown ATX heading, else the file name without extension. */
export function titleFromMarkdown(markdown: string, fileName: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim();
  const fallback = path.basename(fileName).replace(/\.(md|markdown)$/i, '');
  return (heading !== undefined && heading !== '' ? heading : fallback).slice(0, 500) || 'Untitled';
}

/**
 * Works and their revisions.
 *
 * - **Managed** works live in `library/works/<id>/source.md`.
 * - **External** works live in a mounted folder and are indexed in place:
 *   never moved or deleted. Their snapshots still go to
 *   `library/works/<id>/revisions/`, so history survives whatever happens
 *   to the original file. A missing file is a state, not an error.
 *
 * Every content change is an immutable snapshot plus an atomic replace of
 * the source file, recorded in SQLite. All filesystem and database work is
 * synchronous so requests and watcher events in this process cannot
 * interleave between the revision check and the write.
 */
export class WorkService {
  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly fsOps: AtomicFsOps = nodeFsOps,
    private readonly feed?: ChangeFeed,
  ) {}

  create(input: CreateWorkRequest): WorkDetail {
    const req = CreateWorkRequestSchema.parse(input);
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const sourceRel = this.layout.sourceRel(id);
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const workDir = this.layout.abs(this.layout.workDirRel(id));

    fs.mkdirSync(path.join(workDir, 'revisions'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
    try {
      writeNewFileSync(this.layout.abs(snapshotRel), req.markdown);
      atomicWriteFileSync(this.layout.abs(sourceRel), req.markdown, this.fsOps);
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
               current_revision_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'managed', ?, ?, ?, ?)`,
          )
          .run(
            id,
            req.title,
            req.type,
            req.status,
            JSON.stringify(req.tags),
            req.source,
            sourceRel,
            revisionId,
            now,
            now,
          );
        this.insertRevision({
          revision_id: revisionId,
          work_id: id,
          parent_revision_id: null,
          content_hash: sha256Hex(req.markdown),
          snapshot_path: snapshotRel,
          title: req.title,
          source: 'create',
          created_at: now,
        });
        this.indexFts(id, req.title, req.tags, req.markdown);
        this.feed?.record('work', id, 'work.created', { revision_id: revisionId });
      })();
    } catch (err) {
      // Nothing references this directory yet; remove it so a failed create leaves no orphan.
      fs.rmSync(workDir, { recursive: true, force: true });
      throw err;
    }
    return this.get(id);
  }

  get(id: string): WorkDetail {
    const row = this.reconcileExternalChange(this.requireRow(id));
    return { ...toWork(row), markdown: this.readCurrent(row) };
  }

  list(query: ListWorksQuery = {}): ListWorksResponse {
    const q = ListWorksQuerySchema.parse(query);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.type) {
      where.push('w.type = ?');
      params.push(q.type);
    }
    if (q.status) {
      where.push('w.status = ?');
      params.push(q.status);
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(w.tags) WHERE value = ?)');
      params.push(q.tag);
    }
    if (q.q) {
      if (Array.from(q.q).length >= 3) {
        // trigram FTS: quote as a phrase so user input is never parsed as FTS syntax.
        where.push('w.id IN (SELECT work_id FROM works_fts WHERE works_fts MATCH ?)');
        params.push(`"${q.q.replaceAll('"', '""')}"`);
      } else {
        // trigram needs 3+ characters; fall back to a substring scan for short queries.
        where.push("(w.title LIKE ? ESCAPE '\\' OR w.tags LIKE ? ESCAPE '\\')");
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(like, like);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM works w ${whereSql}`)
      .get(...params);
    const rows = this.db
      .prepare<(string | number)[], WorkRow>(
        `SELECT w.* FROM works w ${whereSql} ORDER BY w.updated_at DESC, w.id LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset);
    return { items: rows.map(toWork), total: total?.n ?? 0, limit: q.limit, offset: q.offset };
  }

  patch(id: string, input: PatchWorkInput): WorkDetail {
    const row = this.checkedRow(id, input.baseRevision, 'edit a work');
    const fields = (['title', 'markdown', 'type', 'status', 'tags'] as const).filter(
      (f) => input[f] !== undefined,
    );
    return this.commitRevision(row, {
      markdown: input.markdown,
      title: input.title,
      type: input.type,
      status: input.status,
      // Order kept, duplicates dropped: tags are a set.
      tags: input.tags === undefined ? undefined : [...new Set(input.tags)],
      source: 'edit',
      event: { fields },
    });
  }

  /** One historical revision with its Markdown snapshot. */
  revision(id: string, revisionId: string): RevisionDetail {
    this.reconcileExternalChange(this.requireRow(id));
    const r = this.requireRevision(id, revisionId);
    return { ...toRevision(r), title: r.title, markdown: this.readSnapshot(r) };
  }

  /**
   * Restore an old revision: append a new `restore` revision whose Markdown
   * and title are copied from `revisionId`. History is never rewritten; the
   * restored-from revision and everything after it stay readable. Status,
   * type and tags are not versioned and are left as they are.
   */
  restore(id: string, revisionId: string, baseRevision: string | null): WorkDetail {
    const row = this.checkedRow(id, baseRevision, 'restore a revision');
    const target = this.requireRevision(id, revisionId);
    return this.commitRevision(row, {
      markdown: this.readSnapshot(target),
      title: target.title,
      source: 'restore',
      event: { restored_from: revisionId, fields: ['title', 'markdown'] },
    });
  }

  /** Reconcile, then enforce the revision precondition (428 when absent, 409 when stale). */
  private checkedRow(id: string, baseRevision: string | null, action: string): WorkRow {
    const row = this.reconcileExternalChange(this.requireRow(id));
    const check = checkRevision(baseRevision, row.current_revision_id);
    if (!check.ok) {
      if (check.reason === 'missing_base') {
        throw new ServiceError(
          428,
          'precondition_required',
          `base_revision or If-Match is required to ${action}`,
          { current_revision: row.current_revision_id },
        );
      }
      throw new ServiceError(
        409,
        'revision_conflict',
        'work was changed since base_revision; reload and merge before saving',
        { current_revision: row.current_revision_id, base_revision: check.base },
      );
    }
    return row;
  }

  /**
   * Write a new revision: immutable snapshot first, then an atomic replace of
   * the source file (only when the Markdown changed), then the database row.
   * On failure the source file is rolled back and the snapshot removed.
   */
  private commitRevision(
    row: WorkRow,
    change: {
      markdown?: string | undefined;
      title?: string | undefined;
      type?: Work['type'] | undefined;
      status?: Work['status'] | undefined;
      tags?: string[] | undefined;
      source: RevisionSource;
      event: Record<string, unknown>;
    },
  ): WorkDetail {
    const id = row.id;
    const sourceAbs = this.writableSource(row);
    const previous = this.readCurrent(row);
    const markdown = change.markdown ?? previous;
    const title = change.title ?? row.title;
    const tags = change.tags ?? parseTags(row.tags);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const contentChanged = markdown !== previous;

    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), markdown);
    try {
      if (contentChanged) atomicWriteFileSync(sourceAbs, markdown, this.fsOps);
      this.db.transaction(() => {
        const updated = this.db
          .prepare(
            `UPDATE works SET title = ?, type = ?, status = ?, tags = ?, current_revision_id = ?,
               updated_at = ? WHERE id = ? AND current_revision_id = ?`,
          )
          .run(
            title,
            change.type ?? row.type,
            change.status ?? row.status,
            JSON.stringify(tags),
            revisionId,
            now,
            id,
            row.current_revision_id,
          );
        if (updated.changes !== 1) {
          throw new ServiceError(409, 'revision_conflict', 'work was changed concurrently', {
            current_revision: this.requireRow(id).current_revision_id,
            base_revision: row.current_revision_id,
          });
        }
        this.insertRevision({
          revision_id: revisionId,
          work_id: id,
          parent_revision_id: row.current_revision_id,
          content_hash: sha256Hex(markdown),
          snapshot_path: snapshotRel,
          title,
          source: change.source,
          created_at: now,
        });
        this.indexFts(id, title, tags, markdown);
        this.feed?.record('work', id, 'work.updated', {
          revision_id: revisionId,
          source: change.source,
          ...change.event,
        });
      })();
    } catch (err) {
      // Roll the file back so disk and database keep agreeing.
      if (
        contentChanged &&
        fs.existsSync(sourceAbs) &&
        fs.readFileSync(sourceAbs, 'utf8') !== previous
      ) {
        atomicWriteFileSync(sourceAbs, previous);
      }
      fs.rmSync(this.layout.abs(snapshotRel), { force: true });
      throw err;
    }
    return this.get(id);
  }

  private requireRevision(workId: string, revisionId: string): RevisionRow {
    const r = this.db
      .prepare<[string, string], RevisionRow>(
        'SELECT * FROM revisions WHERE work_id = ? AND revision_id = ?',
      )
      .get(workId, revisionId);
    if (!r) throw notFound('revision');
    return r;
  }

  private readSnapshot(r: RevisionRow): string {
    try {
      return fs.readFileSync(this.layout.abs(r.snapshot_path), 'utf8');
    } catch (err) {
      throw new ServiceError(500, 'internal_error', 'revision snapshot is missing or unreadable', {
        revision_id: r.revision_id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Where a work's relative media references resolve from, plus the Markdown
   * to scan. Managed: the work folder (only `assets/…` is servable). External:
   * the mount root, with references relative to the note's own folder.
   * `root` is null when an external work's mount is not active.
   */
  mediaContext(id: string): MediaContext {
    const row = this.reconcileExternalChange(this.requireRow(id));
    const markdown = this.readCurrent(row);
    if (row.storage_mode !== 'external') {
      return {
        workId: id,
        revisionId: row.current_revision_id,
        markdown,
        mountId: null,
        root: this.layout.abs(this.layout.workDirRel(id)),
        baseDir: '',
        allowedPrefix: 'assets/',
      };
    }
    const location =
      row.mount_id === null ? null : this.externalLocation(row.mount_id, row.source_path);
    const dir = path.posix.dirname(row.source_path.split(path.sep).join('/'));
    return {
      workId: id,
      revisionId: row.current_revision_id,
      markdown,
      mountId: row.mount_id,
      root: location?.root ?? null,
      baseDir: dir === '.' ? '' : dir,
      allowedPrefix: null,
    };
  }

  revisions(id: string): Revision[] {
    this.reconcileExternalChange(this.requireRow(id));
    return this.db
      .prepare<[string], RevisionRow>(
        'SELECT * FROM revisions WHERE work_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(id)
      .map(toRevision);
  }

  // ---- External (mounted) works ---------------------------------------------

  /**
   * Index or refresh the external file at `rel` in `mountId`. Creates the work
   * on first sight; otherwise reconciles (new content → `external` revision,
   * reappeared file → `present`). Content identical to the current revision
   * is a no-op, which is what keeps the app's own writes from echoing back.
   * Returns the work id, or `null` when the file is not a readable regular file.
   */
  syncExternalFile(mountId: string, rel: string, sourceLabel: string): string | null {
    const existing = this.db
      .prepare<[string, string], WorkRow>(
        'SELECT * FROM works WHERE mount_id = ? AND source_path = ?',
      )
      .get(mountId, rel);
    if (existing) {
      this.reconcileExternalChange(existing);
      return existing.id;
    }
    const location = this.externalLocation(mountId, rel);
    if (location === null) return null;
    const content = readRegularFile(location.file);
    if (content === null) return null;

    // A file that reappears elsewhere with the content of a missing work is a rename/move.
    const moved = this.findMissingByHash(mountId, sha256Hex(content));
    if (moved !== undefined) {
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE works SET source_path = ?, external_state = 'present', updated_at = ? WHERE id = ?",
          )
          .run(rel, new Date().toISOString(), moved.id);
        this.feed?.record('work', moved.id, 'work.source_restored', {
          from: moved.source_path,
          to: rel,
          reason: 'moved',
        });
      })();
      return moved.id;
    }

    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const title = titleFromMarkdown(content, rel);
    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), content);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO works (id, title, type, status, tags, source, storage_mode, source_path,
             current_revision_id, created_at, updated_at, mount_id, external_state)
           VALUES (?, ?, 'article', 'drafting', '[]', ?, 'external', ?, ?, ?, ?, ?, 'present')`,
        )
        .run(id, title, sourceLabel, rel, revisionId, now, now, mountId);
      this.insertRevision({
        revision_id: revisionId,
        work_id: id,
        parent_revision_id: null,
        content_hash: sha256Hex(content),
        snapshot_path: snapshotRel,
        title,
        source: 'create',
        created_at: now,
      });
      this.indexFts(id, title, [], content);
      this.feed?.record('work', id, 'work.created', {
        revision_id: revisionId,
        mount_id: mountId,
        path: rel,
      });
    })();
    return id;
  }

  /** Re-check one external work by path (e.g. after a watcher `unlink`). Unknown paths are ignored. */
  checkExternalPath(mountId: string, rel: string): void {
    const row = this.db
      .prepare<[string, string], WorkRow>(
        'SELECT * FROM works WHERE mount_id = ? AND source_path = ?',
      )
      .get(mountId, rel);
    if (row) this.reconcileExternalChange(row);
  }

  /** Paths of all works indexed from a mount, for rescans. */
  externalPaths(mountId: string): string[] {
    return this.db
      .prepare<[string], { source_path: string }>(
        'SELECT source_path FROM works WHERE mount_id = ?',
      )
      .all(mountId)
      .map((r) => r.source_path);
  }

  /** Set every work of a mount to `state` (used for unmount / unavailable), with events. */
  setMountState(mountId: string, state: ExternalState): void {
    const rows = this.db
      .prepare<[string, string], WorkRow>(
        "SELECT * FROM works WHERE mount_id = ? AND coalesce(external_state, '') != ?",
      )
      .all(mountId, state);
    if (rows.length === 0) return;
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const row of rows) {
        this.db
          .prepare('UPDATE works SET external_state = ?, updated_at = ? WHERE id = ?')
          .run(state, now, row.id);
        this.feed?.record(
          'work',
          row.id,
          state === 'present' ? 'work.source_restored' : 'work.source_missing',
          { state },
        );
      }
    })();
  }

  private findMissingByHash(mountId: string, hash: string): WorkRow | undefined {
    return this.db
      .prepare<[string, string], WorkRow>(
        `SELECT w.* FROM works w JOIN revisions r ON r.revision_id = w.current_revision_id
         WHERE w.mount_id = ? AND w.external_state = 'missing' AND r.content_hash = ?
         ORDER BY w.updated_at DESC LIMIT 1`,
      )
      .get(mountId, hash);
  }

  /** Resolve a mount-relative path; `null` if the mount is not active. Rejects traversal. */
  private externalLocation(mountId: string, rel: string): ExternalLocation | null {
    const mount = this.db
      .prepare<[string], { root_path: string; status: string }>(
        'SELECT root_path, status FROM mounts WHERE id = ?',
      )
      .get(mountId);
    if (!mount || mount.status !== 'active') return null;
    return { root: mount.root_path, file: resolveInside(mount.root_path, rel) };
  }

  // ---- Source files -----------------------------------------------------------

  private requireRow(id: string): WorkRow {
    const row = this.db.prepare<[string], WorkRow>('SELECT * FROM works WHERE id = ?').get(id);
    if (!row) throw notFound('work');
    return row;
  }

  /**
   * Current content of the source file, or `null` if it cannot be read
   * safely. External files must be regular files (not symlinks) whose real
   * path stays inside the real mount root.
   */
  private readSourceFile(row: WorkRow): string | null {
    if (row.storage_mode !== 'external') {
      try {
        return fs.readFileSync(this.layout.abs(row.source_path), 'utf8');
      } catch (err) {
        throw new ServiceError(500, 'internal_error', 'work source file is missing or unreadable', {
          work_id: row.id,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (row.mount_id === null) return null;
    const location = this.externalLocation(row.mount_id, row.source_path);
    if (location === null) return null;
    try {
      const realRoot = fs.realpathSync(location.root);
      if (!isPathInside(realRoot, fs.realpathSync(path.dirname(location.file)))) return null;
    } catch {
      return null;
    }
    return readRegularFile(location.file);
  }

  /** Disk content when readable, otherwise the latest snapshot (missing/unmounted external works). */
  private readCurrent(row: WorkRow): string {
    const disk = this.readSourceFile(row);
    if (disk !== null) return disk;
    const snap = this.db
      .prepare<[string], { snapshot_path: string }>(
        'SELECT snapshot_path FROM revisions WHERE revision_id = ?',
      )
      .get(row.current_revision_id);
    if (!snap)
      throw new ServiceError(500, 'internal_error', 'current revision snapshot is missing');
    return fs.readFileSync(this.layout.abs(snap.snapshot_path), 'utf8');
  }

  /** Path a PATCH may write to. External works can only be written while their file is present. */
  private writableSource(row: WorkRow): string {
    if (row.storage_mode !== 'external') return this.layout.abs(row.source_path);
    const location =
      row.mount_id === null ? null : this.externalLocation(row.mount_id, row.source_path);
    if (
      location === null ||
      row.external_state !== 'present' ||
      this.readSourceFile(row) === null
    ) {
      throw new ServiceError(
        409,
        'source_missing',
        'the external file is missing or its folder is not mounted; nothing was written',
        { external_state: row.external_state, path: row.source_path },
      );
    }
    return location.file;
  }

  /**
   * Bring the database in line with the file on disk:
   * - content differs from the current revision → snapshot it as an
   *   `external` revision (clients holding the old revision then get 409
   *   instead of overwriting the outside edit);
   * - external file gone → mark `missing` (history and snapshots are kept);
   * - external file back → mark `present`.
   * Identical content is a no-op, so the app's own writes never echo back.
   */
  private reconcileExternalChange(row: WorkRow): WorkRow {
    const onDisk = this.readSourceFile(row);
    const external = row.storage_mode === 'external';
    if (onDisk === null) {
      if (external && row.external_state === 'present' && this.mountActive(row.mount_id)) {
        const now = new Date().toISOString();
        this.db.transaction(() => {
          this.db
            .prepare("UPDATE works SET external_state = 'missing', updated_at = ? WHERE id = ?")
            .run(now, row.id);
          this.feed?.record('work', row.id, 'work.source_missing', { path: row.source_path });
        })();
        return { ...row, external_state: 'missing', updated_at: now };
      }
      return row;
    }

    let current = row;
    if (external && row.external_state !== 'present') {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE works SET external_state = 'present', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.feed?.record('work', row.id, 'work.source_restored', { path: row.source_path });
      })();
      current = { ...row, external_state: 'present', updated_at: now };
    }

    const hash = sha256Hex(onDisk);
    const head = this.db
      .prepare<[string], { content_hash: string }>(
        'SELECT content_hash FROM revisions WHERE revision_id = ?',
      )
      .get(current.current_revision_id);
    if (head?.content_hash === hash) return current;

    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(current.id, revisionId);
    fs.mkdirSync(path.dirname(this.layout.abs(snapshotRel)), { recursive: true });
    writeNewFileSync(this.layout.abs(snapshotRel), onDisk);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE works SET current_revision_id = ?, updated_at = ? WHERE id = ?')
        .run(revisionId, now, current.id);
      this.insertRevision({
        revision_id: revisionId,
        work_id: current.id,
        parent_revision_id: current.current_revision_id,
        content_hash: hash,
        snapshot_path: snapshotRel,
        title: current.title,
        source: 'external',
        created_at: now,
      });
      this.indexFts(current.id, current.title, parseTags(current.tags), onDisk);
      this.feed?.record('work', current.id, 'work.external_revision', { revision_id: revisionId });
    })();
    return { ...current, current_revision_id: revisionId, updated_at: now };
  }

  private mountActive(mountId: string | null): boolean {
    if (mountId === null) return false;
    const m = this.db
      .prepare<[string], { status: string }>('SELECT status FROM mounts WHERE id = ?')
      .get(mountId);
    return m?.status === 'active';
  }

  private insertRevision(r: RevisionRow): void {
    this.db
      .prepare(
        `INSERT INTO revisions (revision_id, work_id, parent_revision_id, content_hash, snapshot_path,
           title, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.revision_id,
        r.work_id,
        r.parent_revision_id,
        r.content_hash,
        r.snapshot_path,
        r.title,
        r.source,
        r.created_at,
      );
  }

  private indexFts(id: string, title: string, tags: string[], body: string): void {
    this.db.prepare('DELETE FROM works_fts WHERE work_id = ?').run(id);
    this.db
      .prepare('INSERT INTO works_fts (work_id, title, tags, body) VALUES (?, ?, ?, ?)')
      .run(id, title, tags.join(' '), body);
  }
}

/** UTF-8 content of a regular file (symlinks and other types are refused), or `null`. */
function readRegularFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function toRevision(r: RevisionRow): Revision {
  return {
    work_id: r.work_id,
    revision_id: r.revision_id,
    parent_revision_id: r.parent_revision_id,
    content_hash: r.content_hash,
    created_at: r.created_at,
    source: r.source as RevisionSource,
  };
}

function parseTags(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function toWork(row: WorkRow): Work {
  const external = row.storage_mode === 'external';
  return WorkSchema.parse({
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    tags: parseTags(row.tags),
    source: row.source,
    storage_mode: row.storage_mode,
    current_revision_id: row.current_revision_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    mount_id: row.mount_id,
    external_state: row.external_state,
    external_path: external ? row.source_path : null,
  });
}
