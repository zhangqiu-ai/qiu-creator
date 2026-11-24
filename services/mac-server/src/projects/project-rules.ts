import path from 'node:path';
import {
  ProjectRulesSchema,
  RulesPreviewRequestSchema,
  SuggestProjectsRequestSchema,
  type AutoAssignment,
  type ProjectMatch,
  type ProjectRules,
  type RulesPreviewRequest,
  type RulesPreviewResponse,
  type SuggestProjectsRequest,
} from '@qiu-creator/contracts';
import { isEmptyRules, matchRules, type WorkForRules } from '@qiu-creator/domain/project-rules';
import { currentProjectLimit, WORK_IN_LIMIT_SQL } from '../auth/project-scope.js';
import type { Db } from '../db/database.js';
import { notFound } from '../errors.js';
import type { WorkService } from '../works/work-service.js';

/** Stored rules, tolerating rows written before a field existed. */
export function parseRules(raw: string): ProjectRules {
  const parsed = ProjectRulesSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : ProjectRulesSchema.parse({});
}

interface RuleProject {
  id: string;
  name: string;
  rules: ProjectRules;
}

interface WorkRow {
  id: string;
  title: string;
  tags: string;
  source: string;
  storage_mode: string;
  source_path: string;
  mount_id: string | null;
  updated_at: string;
}

/**
 * Project suggestions and automatic assignment by rules (QC-092). Scoring
 * is `matchRules` from `@qiu-creator/domain/project-rules`: fixed weights,
 * no AI, every point explained. A token limited to projects only gets its
 * own projects as candidates.
 */
export class ProjectRuleService {
  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
  ) {}

  /** Candidates for a saved work, best first (score > 0 only). */
  forWork(workId: string): ProjectMatch[] {
    return this.rank(this.workInput(workId));
  }

  /** Candidates for content not saved yet. */
  forDraft(input: SuggestProjectsRequest): ProjectMatch[] {
    const req = SuggestProjectsRequestSchema.parse(input);
    return this.rank({
      title: req.title,
      markdown: req.markdown,
      tags: req.tags,
      source: req.source ?? null,
    });
  }

  /** What `auto_assign` does for new content: ≥ 0.8 assigned, 0.5–0.8 suggested. */
  autoAssignment(input: WorkForRules): AutoAssignment {
    const matches = this.rank(input);
    return {
      assigned: matches.filter((m) => m.outcome === 'auto'),
      suggested: matches.filter((m) => m.outcome === 'suggest'),
    };
  }

  /** Try `rules` on the most recently updated works, without saving anything. */
  preview(projectId: string, input: RulesPreviewRequest): RulesPreviewResponse {
    const req = RulesPreviewRequestSchema.parse(input);
    const project = this.db
      .prepare<[string], { id: string }>(
        'SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL',
      )
      .get(projectId);
    if (project === undefined) throw notFound('project');
    const where = ['w.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    const limit = currentProjectLimit();
    if (limit !== null) {
      where.push(WORK_IN_LIMIT_SQL);
      params.push(JSON.stringify(limit));
    }
    const rows = this.db
      .prepare<(string | number)[], WorkRow>(
        `SELECT w.id, w.title, w.tags, w.source, w.storage_mode, w.source_path, w.mount_id,
           w.updated_at FROM works w WHERE ${where.join(' AND ')}
         ORDER BY w.updated_at DESC, w.id LIMIT ?`,
      )
      .all(...params, req.limit);
    return {
      items: rows.map((row) => {
        const m = matchRules(this.rowInput(row), req.rules);
        const member =
          this.db
            .prepare<[string, string], { one: number }>(
              'SELECT 1 AS one FROM work_projects WHERE work_id = ? AND project_id = ?',
            )
            .get(row.id, projectId) !== undefined;
        return {
          work_id: row.id,
          title: row.title,
          updated_at: row.updated_at,
          score: m.score,
          outcome: m.outcome,
          reasons: m.reasons,
          member,
        };
      }),
    };
  }

  // ---- internals ----------------------------------------------------------------

  private rank(input: WorkForRules): ProjectMatch[] {
    return this.ruleProjects()
      .map((p) => {
        const m = matchRules(input, p.rules);
        return { project_id: p.id, project_name: p.name, ...m };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.project_name.localeCompare(b.project_name));
  }

  /** Live projects that have rules, inside the token's limit. */
  private ruleProjects(): RuleProject[] {
    const limit = currentProjectLimit();
    return this.db
      .prepare<[], { id: string; name: string; rules: string }>(
        'SELECT id, name, rules FROM projects WHERE deleted_at IS NULL ORDER BY sort_order, id',
      )
      .all()
      .filter((p) => limit === null || limit.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, rules: parseRules(p.rules) }))
      .filter((p) => !isEmptyRules(p.rules));
  }

  private workInput(workId: string): WorkForRules {
    const row = this.db
      .prepare<[string], WorkRow>(
        `SELECT id, title, tags, source, storage_mode, source_path, mount_id, updated_at
         FROM works WHERE id = ?`,
      )
      .get(workId);
    if (row === undefined) throw notFound('work');
    return this.rowInput(row);
  }

  private rowInput(row: WorkRow): WorkForRules {
    const external = row.storage_mode === 'external' && row.mount_id !== null;
    // External works store their path relative to the mount's root.
    const root = external
      ? this.db
          .prepare<[string], { root_path: string }>('SELECT root_path FROM mounts WHERE id = ?')
          .get(row.mount_id ?? '')?.root_path
      : undefined;
    return {
      title: row.title,
      markdown: this.works.get(row.id).markdown,
      tags: JSON.parse(row.tags) as string[],
      source: row.source,
      mountId: external ? row.mount_id : null,
      filePath: root === undefined ? null : path.join(root, row.source_path),
    };
  }
}
