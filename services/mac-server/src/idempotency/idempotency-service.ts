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

  /** Async runs in progress, by principal + endpoint + key (see `runAsync`). */
  private readonly inFlight = new Map<
    string,
    { requestHash: string; result: Promise<StoredResponse> }
  >();

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
    const lookup = this.lookup(principal, endpoint, rawKey, requestBody);
    if (lookup.kind === 'none') return { ...create(), replayed: false };
    if (lookup.kind === 'replay') return { ...lookup.stored, replayed: true };
    return this.db.transaction(() => {
      const result = create();
      this.store(principal, endpoint, lookup.key, lookup.requestHash, result);
      return { ...result, replayed: false };
    })();
  }

  /**
   * Like `run` for work that awaits (QC-051 batch). The result is stored when
   * `create` resolves; a second request with the same key while the first is
   * still running waits for it and gets its result as a replay. A rejected
   * `create` stores nothing, so the client may retry with the same key.
   */
  async runAsync(
    principal: Principal,
    endpoint: string,
    rawKey: string | string[] | undefined,
    requestBody: unknown,
    create: () => Promise<StoredResponse>,
  ): Promise<{ statusCode: number; body: unknown; replayed: boolean }> {
    const lookup = this.lookup(principal, endpoint, rawKey, requestBody);
    if (lookup.kind === 'none') return { ...(await create()), replayed: false };
    if (lookup.kind === 'replay') return { ...lookup.stored, replayed: true };
    const slot = `${principal.id}\0${endpoint}\0${lookup.key}`;
    const running = this.inFlight.get(slot);
    if (running !== undefined) {
      if (running.requestHash !== lookup.requestHash) throw keyReused();
      return { ...(await running.result), replayed: true };
    }
    const result = (async () => {
      const response = await create();
      this.store(principal, endpoint, lookup.key, lookup.requestHash, response);
      return response;
    })();
    this.inFlight.set(slot, { requestHash: lookup.requestHash, result });
    try {
      return { ...(await result), replayed: false };
    } finally {
      this.inFlight.delete(slot);
    }
  }

  private lookup(
    principal: Principal,
    endpoint: string,
    rawKey: string | string[] | undefined,
    requestBody: unknown,
  ):
    | { kind: 'none' }
    | { kind: 'replay'; stored: StoredResponse }
    | { kind: 'new'; key: string; requestHash: string } {
    const key = typeof rawKey === 'string' ? rawKey.trim() : undefined;
    if (key === undefined || key === '') {
      if (principal.kind === 'agent') {
        throw new ServiceError(
          428,
          'precondition_required',
          'agent tokens must send an Idempotency-Key header on this endpoint',
        );
      }
      return { kind: 'none' };
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
      if (existing.request_hash !== requestHash) throw keyReused();
      return {
        kind: 'replay',
        stored: {
          statusCode: existing.status_code,
          body: JSON.parse(existing.response_body) as unknown,
        },
      };
    }
    return { kind: 'new', key, requestHash };
  }

  private store(
    principal: Principal,
    endpoint: string,
    key: string,
    requestHash: string,
    result: StoredResponse,
  ): void {
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
  }
}

function keyReused(): ServiceError {
  return new ServiceError(
    422,
    'idempotency_key_reused',
    'this Idempotency-Key was already used with a different request body',
  );
}
