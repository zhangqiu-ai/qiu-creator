import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ApiTokenSchema,
  CreateTokenRequestSchema,
  UpdateTokenRequestSchema,
  type ApiToken,
  type UpdateTokenRequest,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type TokenScope,
} from '@qiu-creator/contracts';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';

/** Who made a request: the owner's main token, or a scoped agent token. */
export type Principal =
  | { kind: 'owner'; id: 'owner'; scopes: readonly TokenScope[] }
  | {
      kind: 'agent';
      id: string;
      name: string;
      scopes: readonly TokenScope[];
      /** QC-089: may change a work's text directly. */
      allowDirectBodyEdit: boolean;
      /** QC-089: projects it is limited to; null = all. */
      projectIds: readonly string[] | null;
    };

/** Routes behind the auth hook always have a principal; this narrows the type. */
export function requirePrincipal(principal: Principal | null): Principal {
  if (principal === null)
    throw new ServiceError(401, 'unauthorized', 'missing or invalid bearer token');
  return principal;
}

export const ALL_SCOPES: readonly TokenScope[] = ['read', 'import', 'write', 'propose'];
const OWNER: Principal = { kind: 'owner', id: 'owner', scopes: ALL_SCOPES };

/** Agent tokens look like `chk_<32 random bytes, base64url>`; the prefix shown in listings is 12 chars. */
const TOKEN_PREFIX = 'chk_';
const SHOWN_PREFIX_LENGTH = 12;

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  allow_direct_body_edit: number;
  project_ids: string | null;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
}

function toToken(row: TokenRow): ApiToken {
  return ApiTokenSchema.parse({
    ...row,
    scopes: JSON.parse(row.scopes) as unknown,
    allow_direct_body_edit: row.allow_direct_body_edit === 1,
    project_ids: row.project_ids === null ? null : (JSON.parse(row.project_ids) as unknown),
  });
}

function agentPrincipal(token: ApiToken): Principal {
  return {
    kind: 'agent',
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    allowDirectBodyEdit: token.allow_direct_body_edit === true,
    projectIds: token.project_ids ?? null,
  };
}

/** What changed on a token, for its activity log (QC-089). */
function describeChange(before: ApiToken, after: ApiToken): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`name: ${before.name} → ${after.name}`);
  if (JSON.stringify(before.scopes) !== JSON.stringify(after.scopes)) {
    parts.push(`scopes: ${before.scopes.join(',')} → ${after.scopes.join(',')}`);
  }
  if (before.allow_direct_body_edit !== after.allow_direct_body_edit) {
    parts.push(
      `allow_direct_body_edit: ${String(before.allow_direct_body_edit === true)} → ${String(after.allow_direct_body_edit === true)}`,
    );
  }
  if (JSON.stringify(before.project_ids) !== JSON.stringify(after.project_ids)) {
    const show = (ids: readonly string[] | null | undefined) =>
      ids === null || ids === undefined ? 'all' : ids.join(',');
    parts.push(`project_ids: ${show(before.project_ids)} → ${show(after.project_ids)}`);
  }
  return parts.join('; ');
}

/**
 * Authenticates requests and manages agent tokens. Agent secrets are random
 * 256-bit values, so a plain sha256 is enough to store them (no password
 * stretching needed); only the hash and a short display prefix are kept.
 */
export class TokenService {
  private readonly ownerHash: Buffer;

  constructor(
    private readonly db: Db,
    ownerToken: string,
  ) {
    this.ownerHash = sha256(ownerToken);
  }

  authenticate(authorization: string | undefined): Principal | null {
    const presented = bearer(authorization);
    if (presented === undefined) return null;
    const hash = sha256(presented);
    if (timingSafeEqual(hash, this.ownerHash)) return OWNER;
    if (!presented.startsWith(TOKEN_PREFIX)) return null;
    // Lookup by hash: equality on a digest of a random secret leaks nothing useful.
    const row = this.db
      .prepare<[string], TokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?')
      .get(hash.toString('hex'));
    if (!row || row.revoked_at !== null) return null;
    this.db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
    return agentPrincipal(toToken(row));
  }

  /**
   * The principal behind a principal id, if it is still allowed to read
   * (signed media URLs re-check this on every request). `null` once an agent
   * token is revoked or lacks `read`.
   */
  readerById(id: string): Principal | null {
    if (id === OWNER.id) return OWNER;
    const row = this.db
      .prepare<[string], TokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    if (!row || row.revoked_at !== null) return null;
    const token = toToken(row);
    if (!token.scopes.includes('read')) return null;
    return agentPrincipal(token);
  }

  create(input: CreateTokenRequest): CreateTokenResponse {
    const req = CreateTokenRequestSchema.parse(input);
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const scopes = [...new Set(req.scopes)].sort();
    if (req.project_ids !== null) this.requireProjects(req.project_ids);
    this.db
      .prepare(
        `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_at,
           allow_direct_body_edit, project_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        req.name,
        secret.slice(0, SHOWN_PREFIX_LENGTH),
        sha256(secret).toString('hex'),
        JSON.stringify(scopes),
        new Date().toISOString(),
        req.allow_direct_body_edit ? 1 : 0,
        req.project_ids === null ? null : JSON.stringify(req.project_ids),
      );
    const token = this.get(id);
    if (req.allow_direct_body_edit) {
      this.recordOwnerChange(token, 'allow_direct_body_edit: on at creation');
    }
    return { token, secret };
  }

  /**
   * Change a token's name, scopes, direct-edit switch or project limit
   * (QC-089, owner only). The change is written to the token's activity, so
   * turning direct body edits on is always on record.
   */
  update(id: string, input: UpdateTokenRequest): ApiToken {
    const req = UpdateTokenRequestSchema.parse(input);
    const before = this.get(id);
    if (before.revoked_at !== null) {
      throw new ServiceError(409, 'validation_error', 'a revoked token cannot be changed');
    }
    if (req.project_ids !== undefined && req.project_ids !== null) {
      this.requireProjects(req.project_ids);
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE api_tokens SET
             name = coalesce(?, name),
             scopes = coalesce(?, scopes),
             allow_direct_body_edit = coalesce(?, allow_direct_body_edit),
             project_ids = CASE WHEN ? THEN ? ELSE project_ids END
           WHERE id = ?`,
        )
        .run(
          req.name ?? null,
          req.scopes === undefined ? null : JSON.stringify([...new Set(req.scopes)].sort()),
          req.allow_direct_body_edit === undefined ? null : req.allow_direct_body_edit ? 1 : 0,
          req.project_ids === undefined ? 0 : 1,
          req.project_ids === undefined || req.project_ids === null
            ? null
            : JSON.stringify(req.project_ids),
          id,
        );
      const after = this.get(id);
      const change = describeChange(before, after);
      if (change !== '') this.recordOwnerChange(after, change);
    })();
    return this.get(id);
  }

  /** Owner changes to a token go into its activity (QC-089). */
  private recordOwnerChange(token: ApiToken, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO token_activity (token_id, at, kind, method, route, target_type, target_id,
           status, result, code, reason, revision)
         VALUES (?, ?, 'token_updated', 'PATCH', '/api/v1/tokens/:id', 'token', ?, 200, 'ok',
           NULL, ?, NULL)`,
      )
      .run(token.id, new Date().toISOString(), token.id, reason);
  }

  /** Project limits must name live projects. */
  private requireProjects(ids: readonly string[]): void {
    const missing = ids.filter(
      (pid) =>
        this.db
          .prepare<[string], { id: string }>(
            'SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL',
          )
          .get(pid) === undefined,
    );
    if (missing.length > 0) {
      throw new ServiceError(404, 'not_found', 'project not found', { project_ids: missing });
    }
  }

  get(id: string): ApiToken {
    const row = this.db
      .prepare<[string], TokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    if (!row) throw notFound('token');
    return toToken(row);
  }

  list(): ApiToken[] {
    return this.db
      .prepare<[], TokenRow>('SELECT * FROM api_tokens ORDER BY created_at DESC')
      .all()
      .map(toToken);
  }

  /** Revoke immediately; the row is kept so listings show when it was revoked. */
  revoke(id: string): ApiToken {
    const token = this.get(id);
    if (token.revoked_at === null) {
      this.db
        .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    }
    return this.get(id);
  }
}
