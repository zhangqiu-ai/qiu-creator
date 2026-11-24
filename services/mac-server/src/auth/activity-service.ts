import type { ListTokenActivityQuery, TokenActivity } from '@qiu-creator/contracts';
import { TokenActivitySchema } from '@qiu-creator/contracts';
import type { Db } from '../db/database.js';

/** Entries kept per token; older ones are dropped as new ones come in. */
export const TOKEN_ACTIVITY_KEPT = 2000;

export interface RequestActivity {
  tokenId: string;
  method: string;
  route: string;
  params: Record<string, unknown>;
  status: number;
  code: string | null;
  reason: string | null;
  revision: string | null;
}

interface ActivityRow {
  id: number;
  token_id: string;
  at: string;
  kind: string;
  method: string;
  route: string;
  target_type: string | null;
  target_id: string | null;
  status: number;
  result: string;
  code: string | null;
  reason: string | null;
  revision: string | null;
}

/** What a route acts on, from its pattern: `/api/v1/works/:id/…` → a work. */
function target(route: string, params: Record<string, unknown>): [string | null, string | null] {
  const id = typeof params['id'] === 'string' ? params['id'] : null;
  const kinds: [string, string][] = [
    ['/api/v1/works/:id', 'work'],
    ['/api/v1/projects/:id', 'project'],
    ['/api/v1/proposals/:id', 'proposal'],
    ['/api/v1/assets/:id', 'asset'],
    ['/api/v1/jobs/:id', 'job'],
  ];
  const hit = kinds.find(([prefix]) => route === prefix || route.startsWith(`${prefix}/`));
  if (hit !== undefined && id !== null) return [hit[1], id];
  return [null, null];
}

/**
 * What agent tokens did (QC-089): every request that changes something and
 * every refused one, plus the owner's changes to the token (written by
 * `TokenService`). Reads that succeed are not recorded.
 */
export class ActivityService {
  constructor(private readonly db: Db) {}

  recordRequest(a: RequestActivity): void {
    const [targetType, targetId] = target(a.route, a.params);
    const result = a.status >= 500 ? 'error' : a.status >= 400 ? 'rejected' : 'ok';
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO token_activity (token_id, at, kind, method, route, target_type, target_id,
             status, result, code, reason, revision)
           VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.tokenId,
          new Date().toISOString(),
          a.method,
          a.route,
          targetType,
          targetId,
          a.status,
          result,
          a.code,
          a.reason,
          a.revision,
        );
      this.db
        .prepare(
          `DELETE FROM token_activity WHERE token_id = ? AND id <= (
             SELECT id FROM token_activity WHERE token_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(a.tokenId, a.tokenId, TOKEN_ACTIVITY_KEPT);
    })();
  }

  list(
    tokenId: string,
    query: Required<Pick<ListTokenActivityQuery, 'limit'>> & ListTokenActivityQuery,
  ): { items: TokenActivity[]; next_before: number | null } {
    const rows = this.db
      .prepare<[string, number, number], ActivityRow>(
        `SELECT * FROM token_activity WHERE token_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(tokenId, query.before ?? Number.MAX_SAFE_INTEGER, query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((r) => TokenActivitySchema.parse(r)),
      next_before: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
