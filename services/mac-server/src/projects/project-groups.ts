import { randomUUID } from 'node:crypto';
import {
  AssignProjectGroupRequestSchema,
  CreateProjectGroupRequestSchema,
  PatchProjectGroupRequestSchema,
  PROJECT_GROUPS_MAX,
  type AssignProjectGroupRequest,
  type CreateProjectGroupRequest,
  type PatchProjectGroupRequest,
  type ProjectGroup,
  type WorkProjectGroup,
} from '@qiu-creator/contracts';
import { checkRevision, resolveBaseRevision } from '@qiu-creator/domain';
import { currentPrincipal } from '../auth/actor-context.js';
import { currentProjectLimit } from '../auth/project-scope.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { WorkService } from '../works/work-service.js';

interface GroupRow {
  id: string;
  project_id: string;
  name: string;
  ordered: number;
  sort_order: number;
  created_by: string;
  created_by_token: string | null;
  created_by_name: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** Members in stored order: position, then when they joined the project, then id. */
const MEMBER_ORDER = 'wp.position, wp.added_at, wp.work_id';

/**
 * A project's groups in order, each with its works (not in 回收站) in stored
 * order (QC-113). The caller checks that the project may be read.
 */
export function groupsOf(db: Db, projectId: string): ProjectGroup[] {
  const members = new Map<string, string[]>();
  for (const m of db
    .prepare<[string], { group_id: string; work_id: string }>(
      `SELECT wp.group_id, wp.work_id FROM work_projects wp JOIN works w ON w.id = wp.work_id
       WHERE wp.project_id = ? AND wp.group_id IS NOT NULL AND w.deleted_at IS NULL
       ORDER BY ${MEMBER_ORDER}`,
    )
    .all(projectId)) {
    members.set(m.group_id, [...(members.get(m.group_id) ?? []), m.work_id]);
  }
  return groupRows(db, projectId).map((row) => toGroup(row, members.get(row.id) ?? []));
}

/**
 * A work's group in each live project where it is in one, in sidebar order
 * (QC-113), with its episode in a series. Episodes count only works not in
 * 回收站, so they never have gaps. A token limited to projects sees only those.
 */
export function workGroupsOf(db: Db, workId: string): WorkProjectGroup[] {
  const limit = currentProjectLimit();
  return db
    .prepare<
      [string],
      {
        project_id: string;
        group_id: string;
        group_name: string;
        ordered: number;
        rank: number;
      }
    >(
      `SELECT wp.project_id, g.id AS group_id, g.name AS group_name, g.ordered,
         (SELECT count(*) FROM work_projects o JOIN works ow ON ow.id = o.work_id
          WHERE o.project_id = wp.project_id AND o.group_id = wp.group_id
            AND ow.deleted_at IS NULL
            AND (o.position < wp.position
              OR (o.position = wp.position AND (o.added_at < wp.added_at
                OR (o.added_at = wp.added_at AND o.work_id < wp.work_id))))) AS rank
       FROM work_projects wp
       JOIN project_groups g ON g.id = wp.group_id AND g.project_id = wp.project_id
       JOIN projects p ON p.id = wp.project_id
       WHERE wp.work_id = ? AND p.deleted_at IS NULL
       ORDER BY p.sort_order, p.id`,
    )
    .all(workId)
    .filter((r) => limit === null || limit.includes(r.project_id))
    .map((r) => ({
      project_id: r.project_id,
      group_id: r.group_id,
      group_name: r.group_name,
      ordered: r.ordered === 1,
      episode: r.ordered === 1 ? r.rank + 1 : null,
    }));
}

function groupRows(db: Db, projectId: string): GroupRow[] {
  return db
    .prepare<[string], GroupRow>(
      'SELECT * FROM project_groups WHERE project_id = ? ORDER BY sort_order, id',
    )
    .all(projectId);
}

function toGroup(row: GroupRow, workIds: string[]): ProjectGroup {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    ordered: row.ordered === 1,
    sort_order: row.sort_order,
    revision: row.revision,
    created_by: {
      kind: row.created_by === 'agent' ? 'agent' : 'user',
      token_id: row.created_by_token,
      token_name: row.created_by_name,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    work_count: workIds.length,
    work_ids: workIds,
  };
}

/**
 * Groups and series inside a project (QC-113). Only the database changes:
 * works keep their revision and files. Every change is one
 * `project.groups_changed` event on the project.
 */
export class ProjectGroupService {
  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly feed: ChangeFeed | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(projectId: string): ProjectGroup[] {
    this.requireLiveProject(projectId);
    return groupsOf(this.db, projectId);
  }

  get(projectId: string, groupId: string): ProjectGroup {
    this.requireLiveProject(projectId);
    return this.view(this.groupRow(projectId, groupId));
  }

  /** A new group after the project's others; names are unique in a project. */
  create(projectId: string, input: CreateProjectGroupRequest): ProjectGroup {
    const req = CreateProjectGroupRequestSchema.parse(input);
    return this.db.transaction(() => {
      this.requireLiveProject(projectId);
      const rows = groupRows(this.db, projectId);
      if (rows.length >= PROJECT_GROUPS_MAX) {
        throw new ServiceError(
          400,
          'validation_error',
          `a project has at most ${String(PROJECT_GROUPS_MAX)} groups`,
          { max: PROJECT_GROUPS_MAX },
        );
      }
      this.requireFreeName(projectId, req.name, null);
      const p = currentPrincipal();
      const agent = p?.kind === 'agent' ? p : null;
      const id = randomUUID();
      const now = this.stamp();
      this.db
        .prepare(
          `INSERT INTO project_groups (id, project_id, name, ordered, sort_order, created_by,
             created_by_token, created_by_name, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          req.name,
          req.ordered ? 1 : 0,
          rows.length,
          agent === null ? 'user' : 'agent',
          agent?.id ?? null,
          agent?.name ?? null,
          now,
          now,
        );
      this.record(projectId, { change: 'created', group_id: id });
      return this.view(this.groupRow(projectId, id));
    })();
  }

  /**
   * Rename, turn a series on or off, or move the group (上移／下移). Needs
   * `base_revision` or `If-Match`: 428 without, 409 `revision_conflict` when stale.
   */
  patch(
    projectId: string,
    groupId: string,
    input: PatchProjectGroupRequest,
    ifMatch: string | undefined,
  ): ProjectGroup {
    const body = PatchProjectGroupRequestSchema.parse(input);
    return this.db.transaction(() => {
      this.requireLiveProject(projectId);
      const row = this.groupRow(projectId, groupId);
      this.checkBase(row, body.base_revision, ifMatch);
      const fields: string[] = [];
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (body.name !== undefined && body.name !== row.name) {
        this.requireFreeName(projectId, body.name, groupId);
        sets.push('name = ?');
        values.push(body.name);
        fields.push('name');
      }
      if (body.ordered !== undefined && body.ordered !== (row.ordered === 1)) {
        sets.push('ordered = ?');
        values.push(body.ordered ? 1 : 0);
        fields.push('ordered');
      }
      if (body.sort_order !== undefined) {
        const ids = groupRows(this.db, projectId).map((g) => g.id);
        const others = ids.filter((id) => id !== groupId);
        const at = Math.min(body.sort_order, others.length);
        const next = [...others.slice(0, at), groupId, ...others.slice(at)];
        if (next.some((id, i) => ids[i] !== id)) {
          next.forEach((id, i) => {
            this.db.prepare('UPDATE project_groups SET sort_order = ? WHERE id = ?').run(i, id);
          });
          fields.push('sort_order');
        }
      }
      if (fields.length === 0) return this.view(row);
      this.db
        .prepare(
          `UPDATE project_groups SET ${[...sets, 'revision = revision + 1', 'updated_at = ?'].join(', ')}
           WHERE id = ?`,
        )
        .run(...values, this.stamp(), groupId);
      const view = this.view(this.groupRow(projectId, groupId));
      this.record(projectId, {
        change: 'updated',
        group_id: groupId,
        fields,
        revision: view.revision,
        // Names and episode numbers on the works' cards change with these.
        ...(fields.includes('name') || fields.includes('ordered')
          ? { work_ids: view.work_ids }
          : {}),
      });
      return view;
    })();
  }

  /** Delete the group; its works go back to 未分組 (they stay in the project). */
  remove(projectId: string, groupId: string): string[] {
    return this.db.transaction(() => {
      this.requireLiveProject(projectId);
      this.groupRow(projectId, groupId);
      const workIds = this.members(projectId, groupId);
      this.db
        .prepare(
          `UPDATE work_projects SET group_id = NULL, position = NULL
           WHERE project_id = ? AND group_id = ?`,
        )
        .run(projectId, groupId);
      this.db.prepare('DELETE FROM project_groups WHERE id = ?').run(groupId);
      groupRows(this.db, projectId).forEach((g, i) => {
        if (g.sort_order !== i) {
          this.db.prepare('UPDATE project_groups SET sort_order = ? WHERE id = ?').run(i, g.id);
        }
      });
      this.record(projectId, { change: 'deleted', group_id: groupId, work_ids: workIds });
      return workIds;
    })();
  }

  /**
   * Put works of the project in a group (at `position`, 1-based, or at the
   * end) or back in 未分組. All or nothing: 404 for an unknown work, 409
   * `work_in_trash`, 409 `work_not_in_project` with `details.work_ids`.
   * Returns the works whose group or place changed.
   */
  assign(projectId: string, input: AssignProjectGroupRequest): string[] {
    const req = AssignProjectGroupRequestSchema.parse(input);
    return this.db.transaction(() => {
      this.requireLiveProject(projectId);
      if (req.group_id !== null) this.groupRow(projectId, req.group_id);
      if (req.group_id === null && req.position !== undefined) {
        throw new ServiceError(400, 'validation_error', 'position needs a group_id');
      }
      for (const workId of req.work_ids) this.works.requireActive(workId);
      const current = new Map<string, string | null>();
      for (const r of this.db
        .prepare<[string, string], { work_id: string; group_id: string | null }>(
          `SELECT work_id, group_id FROM work_projects
           WHERE project_id = ? AND work_id IN (SELECT value FROM json_each(?))`,
        )
        .all(projectId, JSON.stringify(req.work_ids))) {
        current.set(r.work_id, r.group_id);
      }
      const outside = req.work_ids.filter((id) => !current.has(id));
      if (outside.length > 0) {
        throw new ServiceError(
          409,
          'work_not_in_project',
          'these works are not in the project; add them to it first',
          { work_ids: outside },
        );
      }

      const affected = new Set<string>();
      for (const g of current.values()) if (g !== null) affected.add(g);
      if (req.group_id !== null) affected.add(req.group_id);
      const before = new Map<string, string[]>();
      for (const g of affected) before.set(g, this.members(projectId, g, true));

      const moving = new Set(req.work_ids);
      if (req.group_id === null) {
        const clear = this.db.prepare(
          `UPDATE work_projects SET group_id = NULL, position = NULL
           WHERE project_id = ? AND work_id = ?`,
        );
        for (const workId of req.work_ids) clear.run(projectId, workId);
      } else {
        const rest = (before.get(req.group_id) ?? []).filter((id) => !moving.has(id));
        const at = this.insertIndex(rest, req.position);
        this.writeOrder(projectId, req.group_id, [
          ...rest.slice(0, at),
          ...req.work_ids,
          ...rest.slice(at),
        ]);
      }
      for (const g of affected) {
        if (g !== req.group_id) this.writeOrder(projectId, g, this.members(projectId, g, true));
      }

      const changed = new Set<string>();
      for (const [g, was] of before) {
        const now = this.members(projectId, g, true);
        const at = new Map(now.map((id, i) => [id, i]));
        was.forEach((id, i) => {
          if (at.get(id) !== i) changed.add(id);
        });
        now.forEach((id, i) => {
          if (was[i] !== id) changed.add(id);
        });
      }
      for (const workId of req.work_ids) {
        if ((current.get(workId) ?? null) !== req.group_id) changed.add(workId);
      }
      const workIds = [...changed];
      if (workIds.length > 0) {
        this.record(projectId, { change: 'assigned', group_id: req.group_id, work_ids: workIds });
      }
      return workIds;
    })();
  }

  // ---- Internals ----------------------------------------------------------------

  /**
   * Where `position` (1-based among works not in 回收站) falls in `rest`, the
   * group's members in order with works in 回收站 kept at their place.
   */
  private insertIndex(rest: string[], position: number | undefined): number {
    if (position === undefined) return rest.length;
    const live = this.liveSet(rest);
    let seen = 0;
    for (let i = 0; i < rest.length; i += 1) {
      const id = rest[i];
      if (id !== undefined && live.has(id)) {
        if (seen === position - 1) return i;
        seen += 1;
      }
    }
    return rest.length;
  }

  private liveSet(ids: string[]): Set<string> {
    return new Set(
      this.db
        .prepare<[string], { id: string }>(
          `SELECT id FROM works WHERE deleted_at IS NULL
           AND id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids))
        .map((r) => r.id),
    );
  }

  /** Positions 1..n in this order. */
  private writeOrder(projectId: string, groupId: string, workIds: string[]): void {
    const set = this.db.prepare(
      'UPDATE work_projects SET group_id = ?, position = ? WHERE project_id = ? AND work_id = ?',
    );
    workIds.forEach((workId, i) => set.run(groupId, i + 1, projectId, workId));
  }

  /** The group's works in stored order; works in 回收站 only with `withTrashed`. */
  private members(projectId: string, groupId: string, withTrashed = false): string[] {
    return this.db
      .prepare<[string, string], { work_id: string }>(
        `SELECT wp.work_id FROM work_projects wp JOIN works w ON w.id = wp.work_id
         WHERE wp.project_id = ? AND wp.group_id = ?
           ${withTrashed ? '' : 'AND w.deleted_at IS NULL'}
         ORDER BY ${MEMBER_ORDER}`,
      )
      .all(projectId, groupId)
      .map((r) => r.work_id);
  }

  private view(row: GroupRow): ProjectGroup {
    return toGroup(row, this.members(row.project_id, row.id));
  }

  private groupRow(projectId: string, groupId: string): GroupRow {
    const row = this.db
      .prepare<[string, string], GroupRow>(
        'SELECT * FROM project_groups WHERE id = ? AND project_id = ?',
      )
      .get(groupId, projectId);
    if (row === undefined) {
      throw new ServiceError(404, 'not_found', 'project group not found', { group_id: groupId });
    }
    return row;
  }

  /** Deleted projects are as good as gone: 404 (their groups come back on restore). */
  private requireLiveProject(projectId: string): void {
    const row = this.db
      .prepare<[string], { deleted_at: string | null }>(
        'SELECT deleted_at FROM projects WHERE id = ?',
      )
      .get(projectId);
    if (row === undefined || row.deleted_at !== null) throw notFound('project');
  }

  private requireFreeName(projectId: string, name: string, self: string | null): void {
    const taken = this.db
      .prepare<[string, string], { id: string }>(
        'SELECT id FROM project_groups WHERE project_id = ? AND name = ?',
      )
      .get(projectId, name);
    if (taken !== undefined && taken.id !== self) {
      throw new ServiceError(
        409,
        'group_name_taken',
        'the project already has a group with this name',
        { group_id: taken.id },
      );
    }
  }

  private checkBase(
    row: GroupRow,
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
        'base_revision or If-Match is required to edit a group',
        { current_revision: row.revision },
      );
    }
    throw new ServiceError(
      409,
      'revision_conflict',
      'the group was changed since base_revision; reload before saving',
      { current_revision: row.revision, base_revision: check.base },
    );
  }

  private record(projectId: string, data: Record<string, unknown>): void {
    this.feed?.record('project', projectId, 'project.groups_changed', data);
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
