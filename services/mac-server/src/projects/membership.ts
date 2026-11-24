import type { MembershipAddedBy, RuleReason } from '@qiu-creator/contracts';
import { MembershipAddedBySchema } from '@qiu-creator/contracts';
import { currentPrincipal } from '../auth/actor-context.js';
import type { Db } from '../db/database.js';

/** Who is putting a work into a project (QC-092). */
export type AddedBy =
  | { kind: 'user' }
  | { kind: 'agent'; tokenId: string; tokenName: string }
  | {
      kind: 'rule';
      tokenId: string | null;
      tokenName: string | null;
      score: number;
      reasons: RuleReason[];
    };

/** The requester's own choice: the owner by hand, or an agent token. */
export function requesterAddedBy(): AddedBy {
  const p = currentPrincipal();
  return p?.kind === 'agent'
    ? { kind: 'agent', tokenId: p.id, tokenName: p.name }
    : { kind: 'user' };
}

/** An automatic-rule assignment made for the current requester. */
export function ruleAddedBy(score: number, reasons: RuleReason[]): AddedBy {
  const p = currentPrincipal();
  return {
    kind: 'rule',
    tokenId: p?.kind === 'agent' ? p.id : null,
    tokenName: p?.kind === 'agent' ? p.name : null,
    score,
    reasons,
  };
}

interface MembershipRow {
  added_by: string;
  added_by_token: string | null;
  added_by_name: string | null;
  score: number | null;
  reasons: string;
  added_at: string;
}

export function toAddedBy(row: MembershipRow): MembershipAddedBy {
  return MembershipAddedBySchema.parse({
    kind: row.added_by,
    token_id: row.added_by_token,
    token_name: row.added_by_name,
    score: row.score,
    reasons: JSON.parse(row.reasons) as unknown,
    at: row.added_at,
  });
}

/**
 * Put a work into a project. An existing membership is never overwritten by
 * an agent or a rule; the owner adding it by hand makes it manual (`user`).
 * Returns whether a membership was added, made manual, or left as it was.
 */
export function addMembership(
  db: Db,
  workId: string,
  projectId: string,
  by: AddedBy,
  at: string,
): 'added' | 'made_manual' | 'kept' {
  const existing = db
    .prepare<[string, string], { added_by: string }>(
      'SELECT added_by FROM work_projects WHERE work_id = ? AND project_id = ?',
    )
    .get(workId, projectId);
  if (existing !== undefined) {
    if (by.kind !== 'user' || existing.added_by === 'user') return 'kept';
    db.prepare(
      `UPDATE work_projects SET added_by = 'user', added_by_token = NULL, added_by_name = NULL,
         score = NULL, reasons = '[]' WHERE work_id = ? AND project_id = ?`,
    ).run(workId, projectId);
    return 'made_manual';
  }
  db.prepare(
    `INSERT INTO work_projects (work_id, project_id, added_at, added_by, added_by_token,
       added_by_name, score, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workId,
    projectId,
    at,
    by.kind,
    by.kind === 'user' ? null : by.tokenId,
    by.kind === 'user' ? null : by.tokenName,
    by.kind === 'rule' ? by.score : null,
    JSON.stringify(by.kind === 'rule' ? by.reasons : []),
  );
  return 'added';
}

export function membershipRow(
  db: Db,
  workId: string,
  projectId: string,
): MembershipRow | undefined {
  return db
    .prepare<[string, string], MembershipRow>(
      `SELECT added_by, added_by_token, added_by_name, score, reasons, added_at
       FROM work_projects WHERE work_id = ? AND project_id = ?`,
    )
    .get(workId, projectId);
}
