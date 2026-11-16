import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreateWorkRequestSchema,
  ListWorksQuerySchema,
  WorkSchema,
  type CreateWorkRequest,
  type ListWorksQuery,
  type ListWorksResponse,
  type Revision,
  type RevisionSource,
  type Work,
  type WorkDetail,
} from '@qiu-creator/contracts';
import { checkRevision, sha256Hex } from '@qiu-creator/domain';
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

/**
 * Managed-mode works: every content change is written as an immutable
 * snapshot plus an atomic replace of `source.md`, then recorded in SQLite.
 * All filesystem and database work is synchronous so concurrent requests in
 * this process cannot interleave between the revision check and the write.
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
    return { ...toWork(row), markdown: this.readSource(row) };
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
    const row = this.reconcileExternalChange(this.requireRow(id));
    const check = checkRevision(input.baseRevision, row.current_revision_id);
    if (!check.ok) {
      if (check.reason === 'missing_base') {
        throw new ServiceError(
          428,
          'precondition_required',
          'base_revision or If-Match is required to edit a work',
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

    const previous = this.readSource(row);
    const markdown = input.markdown ?? previous;
    const title = input.title ?? row.title;
    const tags = input.tags ?? parseTags(row.tags);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(id, revisionId);
    const sourceAbs = this.layout.abs(row.source_path);
    const contentChanged = markdown !== previous;

    writeNewFileSync(this.layout.abs(snapshotRel), markdown);
    try {
      if (contentChanged) atomicWriteFileSync(sourceAbs, markdown, this.fsOps);
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE works SET title = ?, type = ?, status = ?, tags = ?, current_revision_id = ?,
               updated_at = ? WHERE id = ? AND current_revision_id = ?`,
          )
          .run(
            title,
            input.type ?? row.type,
            input.status ?? row.status,
            JSON.stringify(tags),
            revisionId,
            now,
            id,
            row.current_revision_id,
          );
        this.insertRevision({
          revision_id: revisionId,
          work_id: id,
          parent_revision_id: row.current_revision_id,
          content_hash: sha256Hex(markdown),
          snapshot_path: snapshotRel,
          title,
          source: 'edit',
          created_at: now,
        });
        this.indexFts(id, title, tags, markdown);
        this.feed?.record('work', id, 'work.updated', { revision_id: revisionId });
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

  revisions(id: string): Revision[] {
    this.reconcileExternalChange(this.requireRow(id));
    return this.db
      .prepare<[string], RevisionRow>(
        'SELECT * FROM revisions WHERE work_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(id)
      .map((r) => ({
        work_id: r.work_id,
        revision_id: r.revision_id,
        parent_revision_id: r.parent_revision_id,
        content_hash: r.content_hash,
        created_at: r.created_at,
        source: r.source as RevisionSource,
      }));
  }

  private requireRow(id: string): WorkRow {
    const row = this.db.prepare<[string], WorkRow>('SELECT * FROM works WHERE id = ?').get(id);
    if (!row) throw notFound('work');
    return row;
  }

  private readSource(row: WorkRow): string {
    try {
      return fs.readFileSync(this.layout.abs(row.source_path), 'utf8');
    } catch (err) {
      throw new ServiceError(500, 'internal_error', 'work source file is missing or unreadable', {
        work_id: row.id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * If `source.md` was edited outside the app (Finder, another editor), record
   * that content as a new `external` revision first. Clients holding the old
   * revision then get a 409 instead of silently overwriting the external edit.
   */
  private reconcileExternalChange(row: WorkRow): WorkRow {
    const onDisk = this.readSource(row);
    const hash = sha256Hex(onDisk);
    const current = this.db
      .prepare<[string], { content_hash: string }>(
        'SELECT content_hash FROM revisions WHERE revision_id = ?',
      )
      .get(row.current_revision_id);
    if (current?.content_hash === hash) return row;

    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const snapshotRel = this.layout.snapshotRel(row.id, revisionId);
    writeNewFileSync(this.layout.abs(snapshotRel), onDisk);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE works SET current_revision_id = ?, updated_at = ? WHERE id = ?')
        .run(revisionId, now, row.id);
      this.insertRevision({
        revision_id: revisionId,
        work_id: row.id,
        parent_revision_id: row.current_revision_id,
        content_hash: hash,
        snapshot_path: snapshotRel,
        title: row.title,
        source: 'external',
        created_at: now,
      });
      this.indexFts(row.id, row.title, parseTags(row.tags), onDisk);
      this.feed?.record('work', row.id, 'work.external_revision', { revision_id: revisionId });
    })();
    return { ...row, current_revision_id: revisionId, updated_at: now };
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

function parseTags(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function toWork(row: WorkRow): Work {
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
  });
}
