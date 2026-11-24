import { randomUUID } from 'node:crypto';
import {
  PROPOSAL_DISCARD_RETENTION_DAYS,
  ProposalDetailSchema,
  ProposalSummarySchema,
  type AcceptProposalRequest,
  type CreateProposalRequest,
  type ListProposalsQuery,
  type ProposalCountsResponse,
  type ProposalDetail,
  type ProposalOverlap,
  type ProposalSummary,
  type WorkDetail,
} from '@qiu-creator/contracts';
import {
  applyHunks,
  conflictRegions,
  HunkConflictError,
  overlappingHunks,
  proposalHunks,
  type ProposalHunkData,
} from '@qiu-creator/domain';
import type { Principal } from '../auth/token-service.js';
import {
  currentProjectLimit,
  WORK_IN_LIMIT_SQL,
  type ProjectScope,
} from '../auth/project-scope.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { WorkService } from '../works/work-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface ProposalRow {
  id: string;
  work_id: string;
  token_id: string;
  token_name: string;
  note: string | null;
  status: string;
  base_revision_id: string;
  proposed_markdown: string;
  hunks: string;
  accepted_hunk_ids: string;
  result_revision_id: string | null;
  created_at: string;
  decided_at: string | null;
  work_title: string;
}

export interface ProposalServiceOptions {
  now?: () => Date;
  /** How often discarded proposals past their 30 days are removed (default hourly; 0 = never). */
  purgeIntervalMs?: number;
}

const parseHunks = (raw: string): ProposalHunkData[] => JSON.parse(raw) as ProposalHunkData[];
const parseIds = (raw: string): string[] => JSON.parse(raw) as string[];

/**
 * Agent proposals (QC-089). An agent's suggested text is stored with its
 * hunks against the base revision; nothing touches the work until the user
 * accepts. Accepting applies the chosen hunks onto the current text (they
 * may be stale but must not overlap later edits) as a new revision naming
 * the agent. Discarded proposals are removed 30 days later.
 */
export class ProposalService {
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly works: WorkService,
    private readonly scope: ProjectScope,
    private readonly feed?: ChangeFeed,
    options: ProposalServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const interval = options.purgeIntervalMs ?? HOUR_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.purgeExpired();
      }, interval);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  create(principal: Principal, workId: string, req: CreateProposalRequest): ProposalDetail {
    if (principal.kind !== 'agent') {
      throw new ServiceError(
        400,
        'validation_error',
        'proposals come from agent tokens; the owner edits the work directly',
      );
    }
    this.requireVisibleWork(workId);
    this.works.requireActive(workId);
    // 404 when the base is not a revision of this work.
    const base = this.works.revisionMarkdown(workId, req.base_revision);
    const hunks = proposalHunks(base, req.markdown);
    if (hunks.length === 0) {
      throw new ServiceError(400, 'validation_error', 'the proposed text is the same as the base');
    }
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO proposals (id, work_id, token_id, token_name, note, base_revision_id,
             proposed_markdown, hunks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workId,
          principal.id,
          principal.name,
          req.note === undefined || req.note === '' ? null : req.note,
          req.base_revision,
          req.markdown,
          JSON.stringify(hunks),
          at,
        );
      this.feed?.record('work', workId, 'proposal.created', {
        proposal_id: id,
        token_id: principal.id,
        hunks: hunks.length,
      });
    })();
    return this.get(id);
  }

  get(id: string): ProposalDetail {
    const row = this.visibleRow(id);
    const work = this.works.get(row.work_id);
    const base = this.works.revisionMarkdown(row.work_id, row.base_revision_id);
    const hunks = parseHunks(row.hunks);
    const pending = row.status === 'pending';
    const conflicting = pending ? overlappingHunks(base, work.markdown, hunks) : new Set<string>();
    return ProposalDetailSchema.parse({
      ...this.summary(row, pending ? this.overlapOf(row, work, base, conflicting) : 'none'),
      current_revision: work.current_revision_id,
      base_markdown: base,
      proposed_markdown: row.proposed_markdown,
      hunks: hunks.map((h) => ({ ...h, overlap: conflicting.has(h.id) ? 'conflict' : 'none' })),
      accepted_hunk_ids: parseIds(row.accepted_hunk_ids),
      conflicts:
        conflicting.size === 0
          ? []
          : conflictRegions(
              base,
              work.markdown,
              row.proposed_markdown,
              hunks.filter((h) => conflicting.has(h.id)),
            ),
    });
  }

  list(
    query: Required<Pick<ListProposalsQuery, 'status' | 'limit' | 'offset'>> & ListProposalsQuery,
  ): {
    items: ProposalSummary[];
    total: number;
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.status === 'pending') where.push("p.status = 'pending'");
    if (query.status === 'done') where.push("p.status <> 'pending'");
    if (query.work_id !== undefined) {
      where.push('p.work_id = ?');
      params.push(query.work_id);
    }
    if (query.token_id !== undefined) {
      where.push('p.token_id = ?');
      params.push(query.token_id);
    }
    this.limitWhere(where, params);
    const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    const total =
      this.db
        .prepare<(string | number)[], { n: number }>(
          `SELECT count(*) AS n FROM proposals p JOIN works w ON w.id = p.work_id ${whereSql}`,
        )
        .get(...params)?.n ?? 0;
    const rows = this.db
      .prepare<(string | number)[], ProposalRow>(
        `SELECT p.*, w.title AS work_title FROM proposals p JOIN works w ON w.id = p.work_id
         ${whereSql} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset);
    return {
      items: rows.map((row) => {
        if (row.status !== 'pending') return this.summary(row, 'none');
        const work = this.works.get(row.work_id);
        const base = this.works.revisionMarkdown(row.work_id, row.base_revision_id);
        const conflicting = overlappingHunks(base, work.markdown, parseHunks(row.hunks));
        return this.summary(row, this.overlapOf(row, work, base, conflicting));
      }),
      total,
    };
  }

  /** Pending proposals, in total and per work (for the sidebar badge). */
  counts(): ProposalCountsResponse {
    const where = ["p.status = 'pending'", 'w.deleted_at IS NULL'];
    const params: string[] = [];
    this.limitWhere(where, params);
    const rows = this.db
      .prepare<string[], { work_id: string; n: number }>(
        `SELECT p.work_id, count(*) AS n FROM proposals p JOIN works w ON w.id = p.work_id
         WHERE ${where.join(' AND ')} GROUP BY p.work_id`,
      )
      .all(...params);
    return {
      pending: rows.reduce((sum, r) => sum + r.n, 0),
      by_work: Object.fromEntries(rows.map((r) => [r.work_id, r.n])),
    };
  }

  /**
   * Accept all or some hunks (the user's decision). The work must still be
   * at `base_revision` as the user saw it (409 `revision_conflict`); chosen
   * hunks that overlap edits made after the proposal's base are 409
   * `proposal_conflict` with the three-way input. Nothing is written then.
   */
  accept(id: string, req: AcceptProposalRequest): { proposal: ProposalDetail; work: WorkDetail } {
    const row = this.pendingRow(id);
    const work = this.works.get(row.work_id);
    if (work.current_revision_id !== req.base_revision) {
      throw new ServiceError(
        409,
        'revision_conflict',
        'work was changed since base_revision; reload the proposal and decide again',
        { current_revision: work.current_revision_id, base_revision: req.base_revision },
      );
    }
    const hunks = parseHunks(row.hunks);
    const wanted = req.hunk_ids ?? hunks.map((h) => h.id);
    const unknown = wanted.filter((hid) => !hunks.some((h) => h.id === hid));
    if (unknown.length > 0) {
      throw new ServiceError(400, 'validation_error', 'unknown hunk ids', {
        unknown_hunk_ids: unknown,
      });
    }
    const chosen = hunks.filter((h) => wanted.includes(h.id));
    const base = this.works.revisionMarkdown(row.work_id, row.base_revision_id);
    let markdown: string;
    try {
      markdown = applyHunks(base, work.markdown, chosen);
    } catch (err) {
      if (!(err instanceof HunkConflictError)) throw err;
      throw new ServiceError(
        409,
        'proposal_conflict',
        'some chosen changes overlap edits made after the proposal; merge them three-way first',
        {
          hunk_ids: err.hunkIds,
          conflicts: conflictRegions(
            base,
            work.markdown,
            row.proposed_markdown,
            chosen.filter((h) => err.hunkIds.includes(h.id)),
          ),
          current_revision: work.current_revision_id,
        },
      );
    }
    const updated = this.works.applyProposal(row.work_id, req.base_revision, markdown, {
      tokenId: row.token_id,
      name: row.token_name,
      via: 'proposal',
      proposalId: row.id,
    });
    const status = chosen.length === hunks.length ? 'accepted' : 'partially_accepted';
    this.decide(row, status, {
      accepted: chosen.map((h) => h.id),
      revisionId: updated.current_revision_id,
    });
    return { proposal: this.get(id), work: updated };
  }

  discard(id: string): ProposalDetail {
    const row = this.pendingRow(id);
    this.decide(row, 'discarded', { accepted: [], revisionId: null });
    return this.get(id);
  }

  /** Remove discarded proposals older than the retention period. */
  purgeExpired(): number {
    const cutoff = new Date(
      this.now().getTime() - PROPOSAL_DISCARD_RETENTION_DAYS * DAY_MS,
    ).toISOString();
    return this.db
      .prepare("DELETE FROM proposals WHERE status = 'discarded' AND decided_at < ?")
      .run(cutoff).changes;
  }

  // ---- internals ----------------------------------------------------------------

  private decide(
    row: ProposalRow,
    status: 'accepted' | 'partially_accepted' | 'discarded',
    result: { accepted: string[]; revisionId: string | null },
  ): void {
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE proposals SET status = ?, accepted_hunk_ids = ?, result_revision_id = ?,
             decided_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(
          status,
          JSON.stringify(result.accepted),
          result.revisionId,
          this.now().toISOString(),
          row.id,
        );
      if (changed.changes !== 1) throw this.closed();
      this.feed?.record('work', row.work_id, 'proposal.updated', {
        proposal_id: row.id,
        status,
        ...(result.revisionId === null ? {} : { revision_id: result.revisionId }),
      });
    })();
  }

  private overlapOf(
    row: ProposalRow,
    work: WorkDetail,
    base: string,
    conflicting: ReadonlySet<string>,
  ): ProposalOverlap {
    if (conflicting.size > 0) return 'conflict';
    return work.current_revision_id === row.base_revision_id || work.markdown === base
      ? 'none'
      : 'stale';
  }

  private summary(row: ProposalRow, overlap: ProposalOverlap): ProposalSummary {
    const expires =
      row.status === 'discarded' && row.decided_at !== null
        ? new Date(
            new Date(row.decided_at).getTime() + PROPOSAL_DISCARD_RETENTION_DAYS * DAY_MS,
          ).toISOString()
        : null;
    return ProposalSummarySchema.parse({
      id: row.id,
      work_id: row.work_id,
      work_title: row.work_title,
      token_id: row.token_id,
      token_name: row.token_name,
      note: row.note,
      status: row.status,
      base_revision: row.base_revision_id,
      hunk_count: parseHunks(row.hunks).length,
      overlap,
      created_at: row.created_at,
      decided_at: row.decided_at,
      result_revision_id: row.result_revision_id,
      expires_at: expires,
    });
  }

  /** Keep proposals of works inside the current project limit. */
  private limitWhere(where: string[], params: (string | number)[]): void {
    const limit = currentProjectLimit();
    if (limit === null) return;
    where.push(WORK_IN_LIMIT_SQL);
    params.push(JSON.stringify(limit));
  }

  private row(id: string): ProposalRow | undefined {
    return this.db
      .prepare<[string], ProposalRow>(
        `SELECT p.*, w.title AS work_title FROM proposals p JOIN works w ON w.id = p.work_id
         WHERE p.id = ?`,
      )
      .get(id);
  }

  /** 404 for unknown proposals and for ones outside the token's projects. */
  private visibleRow(id: string): ProposalRow {
    const row = this.row(id);
    if (row === undefined || !this.scope.allowsWork(row.work_id)) throw notFound('proposal');
    return row;
  }

  private pendingRow(id: string): ProposalRow {
    const row = this.visibleRow(id);
    if (row.status !== 'pending') throw this.closed();
    return row;
  }

  private requireVisibleWork(workId: string): void {
    this.works.get(workId);
    if (!this.scope.allowsWork(workId)) throw notFound('work');
  }

  private closed(): ServiceError {
    return new ServiceError(
      409,
      'proposal_closed',
      'the proposal was already accepted or discarded',
    );
  }
}
