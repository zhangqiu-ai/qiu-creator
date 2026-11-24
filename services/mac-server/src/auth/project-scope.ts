import type { Db } from '../db/database.js';
import { currentPrincipal } from './actor-context.js';

/**
 * Project limits of agent tokens (QC-089). A token limited to projects sees
 * only works in at least one of them; everything else answers as if it did
 * not exist (404), so the limit does not reveal what is outside it.
 */

/** The current request's project limit, or null when there is none. */
export function currentProjectLimit(): readonly string[] | null {
  const p = currentPrincipal();
  return p?.kind === 'agent' ? p.projectIds : null;
}

/** SQL condition (on `w.id`) keeping works inside `limit`; bind `JSON.stringify(limit)`. */
export const WORK_IN_LIMIT_SQL = `w.id IN (SELECT work_id FROM work_projects
  WHERE project_id IN (SELECT value FROM json_each(?)))`;

export class ProjectScope {
  constructor(private readonly db: Db) {}

  /** Whether `workId` is visible under `limit` (always when there is none). */
  allowsWork(workId: string, limit: readonly string[] | null = currentProjectLimit()): boolean {
    if (limit === null) return true;
    return (
      this.db
        .prepare<[string, string], { one: number }>(
          `SELECT 1 AS one FROM work_projects
           WHERE work_id = ? AND project_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
        )
        .get(workId, JSON.stringify(limit)) !== undefined
    );
  }

  allowsProject(
    projectId: string,
    limit: readonly string[] | null = currentProjectLimit(),
  ): boolean {
    return limit === null || limit.includes(projectId);
  }
}
