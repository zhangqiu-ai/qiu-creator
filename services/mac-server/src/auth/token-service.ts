import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ApiTokenSchema,
  CreateTokenRequestSchema,
  type ApiToken,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type TokenScope,
} from '@qiu-creator/contracts';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';

/** Who made a request: the owner's main token, or a scoped agent token. */
export type Principal =
  | { kind: 'owner'; id: 'owner'; scopes: readonly TokenScope[] }
  | { kind: 'agent'; id: string; name: string; scopes: readonly TokenScope[] };

/** Routes behind the auth hook always have a principal; this narrows the type. */
export function requirePrincipal(principal: Principal | null): Principal {
  if (principal === null)
    throw new ServiceError(401, 'unauthorized', 'missing or invalid bearer token');
  return principal;
}

export const ALL_SCOPES: readonly TokenScope[] = ['read', 'import', 'write'];
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
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
}

function toToken(row: TokenRow): ApiToken {
  return ApiTokenSchema.parse({ ...row, scopes: JSON.parse(row.scopes) as unknown });
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
    const token = toToken(row);
    return { kind: 'agent', id: token.id, name: token.name, scopes: token.scopes };
  }

  create(input: CreateTokenRequest): CreateTokenResponse {
    const req = CreateTokenRequestSchema.parse(input);
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const scopes = [...new Set(req.scopes)].sort();
    this.db
      .prepare(
        `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        req.name,
        secret.slice(0, SHOWN_PREFIX_LENGTH),
        sha256(secret).toString('hex'),
        JSON.stringify(scopes),
        new Date().toISOString(),
      );
    return { token: this.get(id), secret };
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
