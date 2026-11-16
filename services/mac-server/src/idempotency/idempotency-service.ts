import { IdempotencyKeySchema } from '@qiu-creator/contracts';
import { sha256Hex } from '@qiu-creator/domain';
import type { Db } from '../db/database.js';
import { ServiceError } from '../errors.js';
import type { Principal } from '../auth/token-service.js';

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

/** JSON with object keys sorted, so equivalent bodies hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface RecordRow {
  request_hash: string;
  status_code: number;
  response_body: string;
}

/**
 * Idempotency-Key handling for creating endpoints.
 *
 * `run()` is synchronous end to end (lookup, create, store) so two requests
 * with the same key in this process cannot both create. Keys are scoped per
 * principal and endpoint. Reusing a key with a different body is a client
 * bug and returns 422 instead of silently returning the old result.
 */
export class IdempotencyService {
  constructor(private readonly db: Db) {}

  /**
   * @param required agent tokens must send a key on creating endpoints; the owner token may omit it.
   * @returns the response to send and whether it was replayed.
   */
  run(
    principal: Principal,
    endpoint: string,
    rawKey: string | string[] | undefined,
    requestBody: unknown,
    create: () => { statusCode: number; body: unknown },
  ): { statusCode: number; body: unknown; replayed: boolean } {
    const key = typeof rawKey === 'string' ? rawKey.trim() : undefined;
    if (key === undefined || key === '') {
      if (principal.kind === 'agent') {
        throw new ServiceError(
          428,
          'precondition_required',
          'agent tokens must send an Idempotency-Key header on this endpoint',
        );
      }
      return { ...create(), replayed: false };
    }
    const parsed = IdempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw new ServiceError(
        400,
        'validation_error',
        'Idempotency-Key must be 8-200 printable ASCII characters without spaces',
      );
    }
    const requestHash = sha256Hex(canonicalJson(requestBody));
    const existing = this.db
      .prepare<[string, string, string], RecordRow>(
        `SELECT request_hash, status_code, response_body FROM idempotency_records
         WHERE principal = ? AND endpoint = ? AND key = ?`,
      )
      .get(principal.id, endpoint, key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ServiceError(
          422,
          'idempotency_key_reused',
          'this Idempotency-Key was already used with a different request body',
        );
      }
      return {
        statusCode: existing.status_code,
        body: JSON.parse(existing.response_body) as unknown,
        replayed: true,
      };
    }
    return this.db.transaction(() => {
      const result = create();
      this.db
        .prepare(
          `INSERT INTO idempotency_records
             (principal, endpoint, key, request_hash, status_code, response_body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          principal.id,
          endpoint,
          key,
          requestHash,
          result.statusCode,
          JSON.stringify(result.body),
          new Date().toISOString(),
        );
      return { ...result, replayed: false };
    })();
  }
}
