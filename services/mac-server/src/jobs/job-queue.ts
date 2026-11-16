import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { ChangeFeed } from '../events/change-feed.js';

export type JobKind = 'asset.thumbnail' | 'asset.probe' | 'import.url' | 'mount.scan';

/** Throw from a handler to fail the job immediately, without the automatic retries. */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  subject_id: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow extends Omit<JobRecord, 'payload'> {
  payload: string;
}

export type JobHandler = (job: JobRecord) => Promise<void>;

export interface JobQueueOptions {
  /** Poll interval when idle; enqueue also wakes the worker immediately. */
  pollMs?: number;
  /** Base for exponential retry backoff. */
  retryBaseMs?: number;
}

function toRecord(row: JobRow): JobRecord {
  const payload: unknown = JSON.parse(row.payload);
  return {
    ...row,
    payload:
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {},
  };
}

/**
 * Durable single-worker job queue stored in SQLite.
 *
 * - Jobs are rows in `background_jobs`; enqueueing is part of the caller's transaction.
 * - On `start()`, rows left `running` by a crash or shutdown are re-queued, so work resumes after restart.
 * - Failures retry with exponential backoff up to `max_attempts`, then stay `failed`.
 * Jobs run one at a time; thumbnails and probes are short and this keeps CPU use predictable.
 */
export class JobQueue {
  private readonly handlers = new Map<JobKind, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private current: Promise<void> | undefined;
  private readonly pollMs: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly db: Db,
    private readonly feed: ChangeFeed,
    options: JobQueueOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Insert a job unless an unfinished one already exists for the same kind and subject. */
  enqueue(kind: JobKind, subjectId: string, payload: Record<string, unknown> = {}): string {
    const existing = this.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM background_jobs
         WHERE kind = ? AND subject_id = ? AND status IN ('queued','running')`,
      )
      .get(kind, subjectId);
    if (existing) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO background_jobs (id, kind, subject_id, payload, status, run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, kind, subjectId, JSON.stringify(payload), now, now, now);
    this.feed.record('job', id, 'job.queued', { kind, subject_id: subjectId });
    this.wake();
    return id;
  }

  get(id: string): JobRecord | undefined {
    const row = this.db
      .prepare<[string], JobRow>('SELECT * FROM background_jobs WHERE id = ?')
      .get(id);
    return row ? toRecord(row) : undefined;
  }

  list(subjectId?: string): JobRecord[] {
    const rows =
      subjectId === undefined
        ? this.db.prepare<[], JobRow>('SELECT * FROM background_jobs ORDER BY created_at').all()
        : this.db
            .prepare<[string], JobRow>(
              'SELECT * FROM background_jobs WHERE subject_id = ? ORDER BY created_at',
            )
            .all(subjectId);
    return rows.map(toRecord);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const now = new Date().toISOString();
    const resumed = this.db
      .prepare(
        "UPDATE background_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
      )
      .run(now);
    if (resumed.changes > 0) this.wake();
    this.schedule(0);
  }

  /** Stop taking new jobs and wait for the current one to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** Resolve once no runnable job is left (tests and evidence scripts). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.current;
      const pending = this.db
        .prepare<[], { n: number }>(
          "SELECT count(*) AS n FROM background_jobs WHERE status IN ('queued','running')",
        )
        .get();
      if ((pending?.n ?? 0) === 0) return;
      this.wake();
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job queue did not drain in time');
  }

  /** Re-read on every loop turn: `stop()` may flip it while a job is awaited. */
  private isActive(): boolean {
    return !this.stopped && this.db.open;
  }

  private wake(): void {
    if (!this.stopped) this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.current = this.tick();
    }, delay);
    this.timer.unref();
  }

  private claimNext(): JobRecord | undefined {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare<[string], JobRow>(
          `SELECT * FROM background_jobs WHERE status = 'queued' AND run_after <= ?
           ORDER BY run_after, created_at LIMIT 1`,
        )
        .get(now);
      if (!row) return undefined;
      this.db
        .prepare(
          "UPDATE background_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, row.id);
      this.feed.record('job', row.id, 'job.running', {
        kind: row.kind,
        subject_id: row.subject_id,
      });
      return toRecord({ ...row, status: 'running', attempts: row.attempts + 1 });
    })();
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.db.open) return;
    this.running = true;
    try {
      for (let job = this.claimNext(); job && this.isActive(); job = this.claimNext()) {
        await this.runOne(job);
      }
    } finally {
      this.running = false;
    }
    this.schedule(this.pollMs);
  }

  private async runOne(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.kind);
    let error: string | null = null;
    let permanent = false;
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(job);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      permanent = err instanceof PermanentJobError;
    }
    if (!this.db.open) return;
    const now = new Date();
    this.db.transaction(() => {
      if (error === null) {
        this.db
          .prepare(
            "UPDATE background_jobs SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now.toISOString(), job.id);
        this.feed.record('job', job.id, 'job.succeeded', {
          kind: job.kind,
          subject_id: job.subject_id,
        });
        return;
      }
      const retry = !permanent && job.attempts < job.max_attempts;
      const runAfter = new Date(now.getTime() + this.retryBaseMs * 2 ** (job.attempts - 1));
      this.db
        .prepare(
          'UPDATE background_jobs SET status = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?',
        )
        .run(retry ? 'queued' : 'failed', error, runAfter.toISOString(), now.toISOString(), job.id);
      if (!retry) {
        this.feed.record('job', job.id, 'job.failed', {
          kind: job.kind,
          subject_id: job.subject_id,
          error,
        });
      }
    })();
  }
}
