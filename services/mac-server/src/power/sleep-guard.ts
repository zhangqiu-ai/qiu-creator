import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Db } from '../db/database.js';

/** A held "do not idle-sleep" assertion. */
export interface WakeLock {
  release(): void;
}

/** Takes the OS assertion; injectable so tests never touch the real power settings. */
export interface WakeLockProvider {
  acquire(reason: string): WakeLock;
}

export const CAFFEINATE = '/usr/bin/caffeinate';

/**
 * macOS: `caffeinate -i -w <pid>` holds a PreventUserIdleSystemSleep
 * assertion until it is killed or this process exits (even by SIGKILL, via
 * `-w`). It does not keep the display on and cannot stop sleep when the lid
 * is closed on battery; that is the OS's call (QC-033 checks it on a real Mac).
 */
export class CaffeinateWakeLocks implements WakeLockProvider {
  constructor(
    private readonly binary = CAFFEINATE,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  acquire(): WakeLock {
    let child: ChildProcess | undefined;
    try {
      child = spawn(this.binary, ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('error', this.onError);
      child.unref();
    } catch (err) {
      this.onError(err);
    }
    return {
      release: () => {
        if (child !== undefined && child.exitCode === null) child.kill('SIGTERM');
      },
    };
  }
}

/** For platforms without caffeinate, and as an explicit "off". */
export const noWakeLocks: WakeLockProvider = {
  acquire: () => ({ release: () => undefined }),
};

/** caffeinate on macOS; nothing elsewhere and under the test runner (tests inject their own). */
export function defaultWakeLocks(): WakeLockProvider {
  if (process.env['VITEST'] !== undefined) return noWakeLocks;
  return process.platform === 'darwin' && fs.existsSync(CAFFEINATE)
    ? new CaffeinateWakeLocks()
    : noWakeLocks;
}

export interface SleepGuardOptions {
  provider?: WakeLockProvider;
  /** How often to re-check for long tasks (default 5 s); state changes also trigger a check. */
  checkMs?: number;
  /** Keep holding this long after the last task ends (default 60 s), e.g. between upload chunks. */
  lingerMs?: number;
}

export interface SleepGuardStatus {
  held: boolean;
  reasons: string[];
}

/**
 * Holds one wake lock while any long task is in progress (QC-030): import
 * jobs and AI jobs queued or running, and uploads being received. Released
 * `lingerMs` after the last one ends. After the Mac wakes, jobs continue on
 * their own: interrupted requests fail as timeouts or network errors and are
 * retried by the job runners.
 */
export class SleepGuard {
  private readonly provider: WakeLockProvider;
  private readonly checkMs: number;
  private readonly lingerMs: number;
  private lock: WakeLock | null = null;
  private uploads = 0;
  private idleSince: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private reasons: string[] = [];
  private stopped = false;

  constructor(
    private readonly db: Db,
    options: SleepGuardOptions = {},
  ) {
    this.provider = options.provider ?? defaultWakeLocks();
    this.checkMs = options.checkMs ?? 5000;
    this.lingerMs = options.lingerMs ?? 60_000;
  }

  start(): void {
    this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.lock?.release();
    this.lock = null;
  }

  /** An upload request started receiving bytes; call the returned function when it ends. */
  uploadStarted(): () => void {
    this.uploads++;
    this.check();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.uploads--;
      this.check();
    };
  }

  status(): SleepGuardStatus {
    return { held: this.lock !== null, reasons: [...this.reasons] };
  }

  /** Re-evaluate now (also called on a timer and on job events). */
  check(): void {
    if (this.stopped || !this.db.open) return;
    if (this.timer) clearTimeout(this.timer);
    const reasons = this.busy();
    this.reasons = reasons;
    const now = Date.now();
    if (reasons.length > 0) {
      this.idleSince = null;
      this.lock ??= this.provider.acquire(reasons.join(', '));
    } else if (this.lock !== null) {
      this.idleSince ??= now;
      if (now - this.idleSince >= this.lingerMs) {
        this.lock.release();
        this.lock = null;
        this.idleSince = null;
      }
    }
    const next =
      this.lock !== null && reasons.length === 0 && this.idleSince !== null
        ? Math.min(this.checkMs, Math.max(0, this.lingerMs - (now - this.idleSince)))
        : this.checkMs;
    this.timer = setTimeout(() => {
      this.check();
    }, next);
    this.timer.unref();
  }

  private busy(): string[] {
    const reasons: string[] = [];
    if (this.uploads > 0) reasons.push('upload');
    const count = (sql: string): number => this.db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
    if (
      count("SELECT count(*) AS n FROM import_jobs WHERE status IN ('queued','running')") > 0 ||
      count("SELECT count(*) AS n FROM background_jobs WHERE status IN ('queued','running')") > 0
    )
      reasons.push('import');
    if (
      count(
        "SELECT count(*) AS n FROM ai_jobs WHERE provider IS NOT NULL AND status IN ('queued','running')",
      ) > 0
    )
      reasons.push('ai');
    return reasons;
  }
}
