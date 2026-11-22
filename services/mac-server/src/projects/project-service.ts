import { randomUUID } from 'node:crypto';
import {
  BatchWorkProjectsRequestSchema,
  CreateProjectRequestSchema,
  PatchProjectRequestSchema,
  PROJECT_TRASH_RETENTION_DAYS,
  ReorderProjectsRequestSchema,
  WorkStatusSchema,
  type BatchWorkProjectsRequest,
  type BatchWorkProjectsResponse,
  type BatchWorkProjectsResult,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type Project,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type WorkStatus,
} from '@qiu-creator/contracts';
import { checkRevision, resolveBaseRevision } from '@qiu-creator/domain';
import { PROJECT_ASSETS_SQL } from '../assets/asset-service.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { WorkService } from '../works/work-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  name: string;
  color: number;
  sort_order: number;
  revision: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  work_count: number;
}

export interface ProjectServiceOptions {
  now?: () => Date;
  /** How often deleted projects past 30 days are removed (default 1 hour). */
  purgeCheckMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Projects (QC-062): named, colored groups of works, many to many. Only the
 * database records membership; works' Markdown and files are never touched,
 * and deleting a project never deletes a work. Deleted projects are hidden
 * and restorable for 30 days, then removed with their memberships.
 */
export class ProjectService {
  private readonly now: () => Date;
  private readonly purgeCheckMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly feed: ChangeFeed | undefined,
    private readonly options: ProjectServiceOptions = {},
  ) {
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

  // ---- Projects ---------------------------------------------------------------

  /** Every project that is not deleted, archived ones included, in sidebar order. */
  list(): Project[] {
    return this.rows('p.deleted_at IS NULL').map(toProject);
  }

  get(id: string): Project {
    return toProject(this.liveRow(id));
  }

  create(input: CreateProjectRequest): Project {
    const req = CreateProjectRequestSchema.parse(input);
    const id = randomUUID();
    const now = this.stamp();
    this.db.transaction(() => {
      const last = this.db
        .prepare<[], { max: number | null }>(
          'SELECT max(sort_order) AS max FROM projects WHERE deleted_at IS NULL',
        )
        .get();
      this.db
        .prepare(
          `INSERT INTO projects (id, name, color, sort_order, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, req.name, req.color, (last?.max ?? -1) + 1, now, now);
      this.feed?.record('project', id, 'project.created', {});
    })();
    return this.get(id);
  }

  patch(id: string, input: PatchProjectRequest, ifMatch: string | undefined): Project {
    const body = PatchProjectRequestSchema.parse(input);
    return this.db.transaction(() => {
      const row = this.liveRow(id);
      this.checkBase(row, body.base_revision, ifMatch);
      const fields: string[] = [];
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      if (body.name !== undefined && body.name !== row.name) {
        sets.push('name = ?');
        values.push(body.name);
        fields.push('name');
      }
      if (body.color !== undefined && body.color !== row.color) {
        sets.push('color = ?');
        values.push(body.color);
        fields.push('color');
      }
      if (body.archived !== undefined && body.archived !== (row.archived_at !== null)) {
        sets.push('archived_at = ?');
        values.push(body.archived ? this.stamp() : null);
        fields.push('archived');
      }
      if (fields.length === 0) return toProject(row);
      this.db
        .prepare(
          `UPDATE projects SET ${sets.join(', ')}, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(...values, this.stamp(), id, row.revision);
      this.feed?.record('project', id, 'project.updated', {
        fields,
        revision: row.revision + 1,
      });
      return this.get(id);
    })();
  }

  /** Replace the order of every live project; the list must be exactly those ids. */
  reorder(input: ReorderProjectsRequest): Project[] {
    const req = ReorderProjectsRequestSchema.parse(input);
    return this.db.transaction(() => {
      const live = this.list().map((p) => p.id);
      const missing = live.filter((id) => !req.ids.includes(id));
      const unknown = req.ids.filter((id) => !live.includes(id));
      if (missing.length > 0 || unknown.length > 0) {
        throw new ServiceError(
          400,
          'validation_error',
          'ids must list every project that is not deleted, exactly once',
          { missing, unknown },
        );
      }
      req.ids.forEach((id, index) => {
        this.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?').run(index, id);
      });
      this.feed?.record('project', 'order', 'project.reordered', { ids: req.ids });
      return this.list();
    })();
  }

  /** Hide the project; works stay, in their other projects too. Restorable for 30 days. */
  remove(id: string): Project {
    return this.db.transaction(() => {
      const row = this.liveRow(id);
      const now = this.stamp();
      this.db
        .prepare(
          'UPDATE projects SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(now, now, id);
      this.feed?.record('project', id, 'project.deleted', {});
      return toProject({ ...row, deleted_at: now, revision: row.revision + 1, updated_at: now });
    })();
  }

  /** Undo a delete: the project comes back with the same works, at its old place. */
  restore(id: string): Project {
    return this.db.transaction(() => {
      const row = this.anyRow(id);
      if (row.deleted_at === null) return toProject(row);
      this.db
        .prepare(
          'UPDATE projects SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(this.stamp(), id);
      this.feed?.record('project', id, 'project.restored', {});
      return this.get(id);
    })();
  }

  /** Remove projects deleted more than 30 days ago, with their memberships. Works stay. */
  purgeExpired(): string[] {
    const cutoff = new Date(this.now().getTime() - PROJECT_TRASH_RETENTION_DAYS * DAY_MS);
    const ids = this.db
      .prepare<[string], { id: string }>(
        'SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY id',
      )
      .all(cutoff.toISOString())
      .map((r) => r.id);
    for (const id of ids) {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
        this.feed?.record('project', id, 'project.deleted', { purged: true });
      })();
    }
    return ids;
  }

  summary(id: string): ProjectSummary {
    const row = this.liveRow(id);
    const counts = this.db
      .prepare<[string], { status: string; n: number }>(
        `SELECT w.status, count(*) AS n FROM work_projects wp JOIN works w ON w.id = wp.work_id
         WHERE wp.project_id = ? AND w.deleted_at IS NULL GROUP BY w.status`,
      )
      .all(id);
    const byStatus: Record<WorkStatus, number> = {
      drafting: 0,
      in_review: 0,
      ready: 0,
      published: 0,
    };
    for (const c of counts) {
      const status = WorkStatusSchema.safeParse(c.status);
      if (status.success) byStatus[status.data] = c.n;
    }
    const last = this.db
      .prepare<[string], { at: string | null }>(
        `SELECT max(w.updated_at) AS at FROM work_projects wp JOIN works w ON w.id = wp.work_id
         WHERE wp.project_id = ? AND w.deleted_at IS NULL`,
      )
      .get(id);
    const assets = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT count(*) AS n FROM assets
         WHERE deleted_at IS NULL AND id IN (${PROJECT_ASSETS_SQL})`,
      )
      .get(id, id);
    // QC-067: works that become 未分類 when this project is deleted.
    const sole = this.db
      .prepare<[string], { n: number }>(
        `SELECT count(*) AS n FROM work_projects wp JOIN works w ON w.id = wp.work_id
         WHERE wp.project_id = ? AND w.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM work_projects o JOIN projects p ON p.id = o.project_id
                           WHERE o.work_id = w.id AND o.project_id <> wp.project_id
                             AND p.deleted_at IS NULL)`,
      )
      .get(id);
    return {
      project: toProject(row),
      by_status: byStatus,
      last_updated_at: last?.at ?? null,
      asset_count: assets?.n ?? 0,
      sole_count: sole?.n ?? 0,
    };
  }

  // ---- Membership -------------------------------------------------------------

  /**
   * Add works to and remove them from projects. Projects are checked first
   * (404 for any unknown or deleted one, nothing changes); then each work
   * succeeds or fails on its own. Works keep their revision.
   */
  batch(input: BatchWorkProjectsRequest): BatchWorkProjectsResponse {
    const req = BatchWorkProjectsRequestSchema.parse(input);
    this.works.requireLiveProjects([...req.add, ...req.remove]);
    const results: BatchWorkProjectsResult[] = [];
    for (const workId of req.work_ids) {
      try {
        this.db.transaction(() => {
          this.works.requireActive(workId);
          const now = this.stamp();
          const added = req.add.filter(
            (projectId) =>
              this.db
                .prepare(
                  'INSERT OR IGNORE INTO work_projects (work_id, project_id, added_at) VALUES (?, ?, ?)',
                )
                .run(workId, projectId, now).changes === 1,
          );
          const removed = req.remove.filter(
            (projectId) =>
              this.db
                .prepare('DELETE FROM work_projects WHERE work_id = ? AND project_id = ?')
                .run(workId, projectId).changes === 1,
          );
          if (added.length + removed.length > 0) {
            this.feed?.record('work', workId, 'work.projects_changed', { added, removed });
          }
        })();
        results.push({ id: workId, ok: true, work: this.works.listItemById(workId) });
      } catch (err) {
        if (!(err instanceof ServiceError)) throw err;
        results.push({
          id: workId,
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            ...(err.details === undefined ? {} : { details: err.details }),
          },
        });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  // ---- Internals ----------------------------------------------------------------

  private rows(where: string, ...params: string[]): ProjectRow[] {
    return this.db
      .prepare<string[], ProjectRow>(
        `SELECT p.*, (SELECT count(*) FROM work_projects wp JOIN works w ON w.id = wp.work_id
                       WHERE wp.project_id = p.id AND w.deleted_at IS NULL) AS work_count
         FROM projects p WHERE ${where} ORDER BY p.sort_order, p.id`,
      )
      .all(...params);
  }

  private anyRow(id: string): ProjectRow {
    const row = this.rows('p.id = ?', id)[0];
    if (row === undefined) throw notFound('project');
    return row;
  }

  /** Deleted projects are as good as gone: 404. */
  private liveRow(id: string): ProjectRow {
    const row = this.anyRow(id);
    if (row.deleted_at !== null) throw notFound('project');
    return row;
  }

  private checkBase(
    row: ProjectRow,
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
        'base_revision or If-Match is required to edit a project',
        { current_revision: row.revision },
      );
    }
    throw new ServiceError(
      409,
      'revision_conflict',
      'the project was changed since base_revision; reload before saving',
      { current_revision: row.revision, base_revision: check.base },
    );
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

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sort_order: row.sort_order,
    revision: row.revision,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
    work_count: row.work_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
