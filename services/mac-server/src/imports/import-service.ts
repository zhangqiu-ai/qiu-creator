import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ImportJobRecordSchema,
  ImportUrlRequestSchema,
  ListJobsQuerySchema,
  type ImportErrorCode,
  type ImportJobRecord,
  type ImportUrlRequest,
  type ListJobsQuery,
  type ListJobsResponse,
  type WorkAssetRole,
} from '@qiu-creator/contracts';
import type { AssetService } from '../assets/asset-service.js';
import type { Principal } from '../auth/token-service.js';
import type { Db } from '../db/database.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import { PermanentJobError, type JobQueue, type JobRecord } from '../jobs/job-queue.js';
import type { Layout } from '../layout.js';
import { maxUploadBytes } from '../media/detect.js';
import {
  assertFetchableUrl,
  DownloadError,
  safeDownload,
  type DownloadOptions,
} from '../net/safe-download.js';

interface ImportRow {
  id: string;
  method: string;
  status: string;
  progress: number;
  retry_count: number;
  error: string | null;
  idempotency_key: string | null;
  payload: string | null;
  result_work_id: string | null;
  created_at: string;
  updated_at: string;
  url: string | null;
  filename: string | null;
  error_code: string | null;
  result_asset_id: string | null;
  link_work_id: string | null;
  link_role: string | null;
  created_by: string | null;
}

function toRecord(row: ImportRow): ImportJobRecord {
  const key = row.idempotency_key;
  return ImportJobRecordSchema.parse({
    ...row,
    // Stored as "<principal>:<key>"; clients only ever see their own key.
    idempotency_key: key === null ? null : key.slice(key.indexOf(':') + 1),
  });
}

export type DownloadSettings = Omit<DownloadOptions, 'maxBytes'> & { maxBytes?: number };

/**
 * URL import jobs: rows in `import_jobs`, executed by the durable job queue.
 * Downloads go through `safeDownload` (SSRF-safe) into `data/incoming/`, then
 * through the same `AssetService.ingest` as uploads (magic bytes, size,
 * dedup, thumbnails/probing).
 */
export class ImportService {
  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly assets: AssetService,
    private readonly jobs: JobQueue,
    private readonly feed: ChangeFeed,
    private readonly download: DownloadSettings = {},
  ) {
    jobs.register('import.url', (job) => this.runUrlImport(job));
  }

  /** Create a queued URL import. Cheap checks (scheme, literal private IPs) fail fast with 400. */
  createUrlImport(
    principal: Principal,
    input: ImportUrlRequest,
    idempotencyKey?: string,
  ): ImportJobRecord {
    const req = ImportUrlRequestSchema.parse(input);
    try {
      assertFetchableUrl(req.url);
    } catch (err) {
      if (err instanceof DownloadError)
        throw new ServiceError(400, 'url_rejected', err.message, { reason: err.code });
      throw err;
    }
    if (req.role !== undefined && req.work_id === undefined) {
      throw new ServiceError(400, 'validation_error', 'role requires work_id');
    }
    if (req.work_id !== undefined) {
      const work = this.db
        .prepare<[string], { id: string; deleted_at: string | null }>(
          'SELECT id, deleted_at FROM works WHERE id = ?',
        )
        .get(req.work_id);
      if (!work) throw notFound('work');
      // QC-053: nothing new is linked to a work in 最近刪除.
      if (work.deleted_at !== null) {
        throw new ServiceError(409, 'work_in_trash', 'the work is in 最近刪除; restore it first', {
          work_id: work.id,
          deleted_at: work.deleted_at,
        });
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO import_jobs (id, method, status, progress, retry_count, idempotency_key, payload,
             created_at, updated_at, url, filename, link_work_id, link_role, created_by)
           VALUES (?, 'url', 'queued', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          idempotencyKey === undefined ? null : `${principal.id}:${idempotencyKey}`,
          JSON.stringify(req),
          now,
          now,
          req.url,
          req.filename ?? null,
          req.work_id ?? null,
          req.role ?? null,
          principal.id,
        );
      this.feed.record('job', id, 'job.queued', { type: 'import', method: 'url' });
      this.jobs.enqueue('import.url', id);
    })();
    return this.get(id);
  }

  get(id: string): ImportJobRecord {
    const row = this.db
      .prepare<[string], ImportRow>('SELECT * FROM import_jobs WHERE id = ?')
      .get(id);
    if (!row) throw notFound('job');
    return toRecord(row);
  }

  list(query: ListJobsQuery = {}): ListJobsResponse {
    const q = ListJobsQuerySchema.parse(query);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.method) {
      where.push('method = ?');
      params.push(q.method);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare<(string | number)[], { n: number }>(
        `SELECT count(*) AS n FROM import_jobs ${whereSql}`,
      )
      .get(...params);
    const rows = this.db
      .prepare<(string | number)[], ImportRow>(
        `SELECT * FROM import_jobs ${whereSql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset);
    return { items: rows.map(toRecord), total: total?.n ?? 0, limit: q.limit, offset: q.offset };
  }

  /** Re-run a failed import. Only `failed` jobs can be retried. */
  retry(id: string): ImportJobRecord {
    const job = this.get(id);
    if (job.status !== 'failed') {
      throw new ServiceError(
        409,
        'job_not_retryable',
        `job is ${job.status}; only failed jobs can be retried`,
        {
          status: job.status,
        },
      );
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE import_jobs SET status = 'queued', retry_count = retry_count + 1, progress = 0,
             error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), id);
      this.feed.record('job', id, 'job.queued', { type: 'import', method: 'url', retry: true });
      this.jobs.enqueue('import.url', id);
    })();
    return this.get(id);
  }

  private update(id: string, fields: Partial<Omit<ImportRow, 'id'>>): void {
    const entries = Object.entries(fields);
    const set = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE import_jobs SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v), new Date().toISOString(), id);
  }

  private async runUrlImport(bg: JobRecord): Promise<void> {
    const job = this.get(bg.subject_id);
    if (job.url === null) throw new PermanentJobError('import job has no URL');
    this.db.transaction(() => {
      this.update(job.id, { status: 'running' });
      this.feed.record('job', job.id, 'job.running', { type: 'import', method: 'url' });
    })();

    const temp = path.join(this.layout.incomingDir, `${randomUUID()}.download`);
    try {
      const result = await safeDownload(job.url, temp, {
        ...this.download,
        maxBytes: this.download.maxBytes ?? maxUploadBytes(this.assets.limits),
      });
      const { asset } = await this.assets.ingest(temp, job.filename ?? result.suggestedName, 'url');
      if (job.link_work_id !== null) {
        const role: WorkAssetRole = job.link_role ?? (asset.kind === 'video' ? 'video' : 'body');
        this.assets.link(job.link_work_id, asset.id, role);
      }
      this.db.transaction(() => {
        this.update(job.id, {
          status: 'succeeded',
          progress: 1,
          error: null,
          error_code: null,
          result_asset_id: asset.id,
        });
        this.feed.record('job', job.id, 'job.succeeded', { type: 'import', asset_id: asset.id });
      })();
    } catch (err) {
      fs.rmSync(temp, { force: true });
      const { code, message, retryable } = classify(err);
      const willRetry = retryable && bg.attempts < bg.max_attempts;
      this.db.transaction(() => {
        this.update(job.id, {
          status: willRetry ? 'queued' : 'failed',
          error: message,
          error_code: code,
        });
        if (!willRetry) {
          this.feed.record('job', job.id, 'job.failed', { type: 'import', error_code: code });
        }
      })();
      if (!willRetry) throw new PermanentJobError(message, { cause: err });
      throw err;
    }
  }
}

function classify(err: unknown): { code: ImportErrorCode; message: string; retryable: boolean } {
  if (err instanceof DownloadError)
    return { code: err.code, message: err.message, retryable: err.retryable };
  if (err instanceof ServiceError) {
    if (err.code === 'unsupported_media_type' || err.code === 'payload_too_large') {
      return { code: err.code, message: err.message, retryable: false };
    }
    return { code: 'internal_error', message: err.message, retryable: false };
  }
  return {
    code: 'internal_error',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}
