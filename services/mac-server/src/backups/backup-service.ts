import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_RETENTION_PER_KIND,
  BackupIdSchema,
  BackupSchema,
  type Backup,
  type BackupFailureReason,
  type BackupKind,
  type ListBackupsResponse,
  type RestoreBackupResponse,
} from '@qiu-creator/contracts';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import { migrations } from '../db/migrations.js';
import { notFound, ServiceError } from '../errors.js';
import type { ChangeFeed } from '../events/change-feed.js';
import type { Layout } from '../layout.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackupOptions {
  /** How often to check whether the daily backup is due (default 1 h). */
  checkMs?: number;
  /** First check after start (default 1 min), so startup is not slowed down. */
  initialDelayMs?: number;
  /** Clock (tests). */
  now?: () => Date;
  /** Keep this many backups per kind (default 14). */
  retention?: number;
  /** `false`: no daily scheduler (tests drive `runDaily()` themselves). */
  schedule?: boolean;
}

/** Written next to the database while a restore waits for the service to reopen it. */
const PendingRestoreSchema = z.object({
  backup_id: BackupIdSchema,
  safety_backup_id: BackupIdSchema,
  /** Change-log sequence before the restore; the restored log continues after it. */
  previous_seq: z.number().int().nonnegative(),
});
export type PendingRestore = z.infer<typeof PendingRestoreSchema>;

const SidecarSchema = BackupSchema.omit({ id: true });

/** A backup copy was made but did not pass `PRAGMA integrity_check`. */
export class BackupIntegrityError extends Error {}

/** Category of a backup failure for the interface (QC-043); the message stays the technical detail. */
export function backupFailureReason(err: unknown): BackupFailureReason {
  if (err instanceof BackupIntegrityError) return 'integrity_failed';
  const code =
    err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
  if (code === null) return 'unknown';
  if (['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(code)) return 'disk_full';
  if (
    ['EACCES', 'EPERM', 'EROFS', 'SQLITE_READONLY', 'SQLITE_PERM', 'SQLITE_CANTOPEN'].includes(code)
  )
    return 'permission_denied';
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') return 'integrity_failed';
  return 'io_error';
}

/** Untranslated technical text of a failure. */
export function failureDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function backupsDir(layout: Layout): string {
  return path.join(layout.home, 'backups');
}

function pendingFile(layout: Layout): string {
  return path.join(layout.home, 'data', 'restore-pending.json');
}

function backupFile(layout: Layout, id: string): string {
  return path.join(backupsDir(layout), `${BackupIdSchema.parse(id)}.sqlite`);
}

function fsyncPath(p: string): void {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `PRAGMA integrity_check` and the newest applied migration of a database
 * file, opened read-only so the check never changes it.
 */
export function inspectDatabase(file: string): {
  ok: boolean;
  schemaVersion: string | null;
  migrationIds: string[];
} {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok';
    let ids: string[] = [];
    try {
      ids = db
        .prepare<[], { id: string }>('SELECT id FROM schema_migrations ORDER BY id')
        .all()
        .map((r) => r.id);
    } catch {
      ids = [];
    }
    return { ok, schemaVersion: ids.at(-1) ?? null, migrationIds: ids };
  } catch {
    return { ok: false, schemaVersion: null, migrationIds: [] };
  } finally {
    db?.close();
  }
}

/**
 * Called before the database is opened. If a restore is pending, put the
 * backup in place of the database (copy to a temp file, fsync, drop the old
 * WAL and shared-memory files, rename over). Returns the pending restore so
 * the caller can finish it once the database is open, or null.
 * An unusable backup cancels the restore and leaves the database as it was.
 */
export function applyPendingRestore(
  layout: Layout,
  log: (msg: string) => void = () => undefined,
): PendingRestore | null {
  const marker = pendingFile(layout);
  if (!fs.existsSync(marker)) return null;
  let pending: PendingRestore;
  try {
    pending = PendingRestoreSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')));
  } catch {
    log('restore marker is unreadable; restore cancelled');
    fs.rmSync(marker, { force: true });
    return null;
  }
  const source = backupFile(layout, pending.backup_id);
  if (!inspectDatabase(source).ok) {
    log(`backup ${pending.backup_id} is missing or damaged; restore cancelled`);
    fs.rmSync(marker, { force: true });
    return null;
  }
  const target = layout.databaseFile;
  const tmp = `${target}.restoring`;
  fs.copyFileSync(source, tmp);
  fs.chmodSync(tmp, 0o600);
  fsyncPath(tmp);
  // The old WAL belongs to the old database (its content is in the safety backup).
  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  fs.renameSync(tmp, target);
  fsyncPath(path.dirname(target));
  return pending;
}

/** After the restored database is open: continue the change log, announce, clear the marker. */
export function finishRestore(layout: Layout, db: Db, feed: ChangeFeed, pending: PendingRestore) {
  db.transaction(() => {
    const row = db
      .prepare<[], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'")
      .get();
    if (row === undefined) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('change_log', ?)").run(
        pending.previous_seq,
      );
    } else if (row.seq < pending.previous_seq) {
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'change_log'").run(
        pending.previous_seq,
      );
    }
    feed.record('system', 'database', 'backup.restored', {
      backup_id: pending.backup_id,
      safety_backup_id: pending.safety_backup_id,
    });
  })();
  fs.rmSync(pendingFile(layout), { force: true });
}

/**
 * Online SQLite backups (QC-030): daily, manual and before each restore,
 * each checked with `PRAGMA integrity_check`, kept 14 per kind.
 */
export class BackupService {
  private readonly now: () => Date;
  private readonly retention: number;
  private readonly checkMs: number;
  private readonly initialDelayMs: number;
  private readonly scheduled: boolean;
  private timer: NodeJS.Timeout | undefined;
  /** Backups run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastError: string | null = null;
  private lastErrorReason: BackupFailureReason | null = null;
  private restoring = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly layout: Layout,
    private readonly feed: ChangeFeed,
    options: BackupOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retention = options.retention ?? BACKUP_RETENTION_PER_KIND;
    this.checkMs = options.checkMs ?? 60 * 60 * 1000;
    this.initialDelayMs = options.initialDelayMs ?? 60 * 1000;
    this.scheduled = options.schedule ?? true;
  }

  get dir(): string {
    return backupsDir(this.layout);
  }

  /** True after a restore was accepted: writes are refused until the service reloads. */
  get isRestoring(): boolean {
    return this.restoring;
  }

  start(): void {
    if (!this.scheduled) return;
    this.arm(this.initialDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain.catch(() => undefined);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runDaily().finally(() => {
        this.arm(this.checkMs);
      });
    }, ms);
    this.timer.unref();
  }

  list(): ListBackupsResponse {
    const backups = this.read();
    const lastDaily = backups.find((b) => b.kind === 'daily');
    const next =
      lastDaily === undefined ? this.now() : new Date(Date.parse(lastDaily.created_at) + DAY_MS);
    return {
      backups,
      retention_per_kind: this.retention,
      directory: this.dir,
      last_daily_at: lastDaily?.created_at ?? null,
      next_daily_at: next.toISOString(),
      last_error: this.lastError,
      last_error_reason: this.lastErrorReason,
    };
  }

  get(id: string): Backup {
    const found = this.read().find((b) => b.id === id);
    if (found === undefined) throw notFound('backup');
    return found;
  }

  /** Take the daily backup if the newest one is a day old or there is none. */
  async runDaily(): Promise<Backup | null> {
    const last = this.read().find((b) => b.kind === 'daily');
    if (last !== undefined && this.now().getTime() - Date.parse(last.created_at) < DAY_MS) {
      return null;
    }
    try {
      const backup = await this.create('daily');
      if (backup.integrity !== 'ok')
        throw new BackupIntegrityError(`backup ${backup.id} failed its integrity check`);
      this.lastError = null;
      this.lastErrorReason = null;
      return backup;
    } catch (err) {
      // Restoring or stopping is not a failure worth reporting.
      if (err instanceof ServiceError && err.code === 'restore_in_progress') return null;
      if (this.stopped || !this.db.open) return null;
      this.lastError = failureDetail(err);
      this.lastErrorReason = backupFailureReason(err);
      this.feed.record('system', 'database', 'backup.failed', {
        kind: 'daily',
        reason: this.lastErrorReason,
        error: this.lastError,
      });
      return null;
    }
  }

  /** Online copy, integrity check, sidecar, retention. Serialised with other backups. */
  create(kind: BackupKind): Promise<Backup> {
    if (this.restoring) {
      return Promise.reject(
        new ServiceError(409, 'restore_in_progress', 'a restore is in progress'),
      );
    }
    const run = this.chain.then(() => this.make(kind));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async make(kind: BackupKind): Promise<Backup> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const createdAt = this.now();
    const id = this.newId(createdAt, kind);
    const file = path.join(this.dir, `${id}.sqlite`);
    const partial = `${file}.partial`;
    try {
      await this.db.backup(partial);
      // A self-contained single file: no WAL, so read-only checks leave nothing behind.
      const copy = new Database(partial);
      try {
        copy.pragma('journal_mode = DELETE');
      } finally {
        copy.close();
      }
      fs.chmodSync(partial, 0o600);
      fsyncPath(partial);
      const check = inspectDatabase(partial);
      fs.renameSync(partial, file);
      const backup: Backup = {
        id,
        kind,
        created_at: createdAt.toISOString(),
        size_bytes: fs.statSync(file).size,
        integrity: check.ok ? 'ok' : 'failed',
        schema_version: check.schemaVersion,
      };
      const sidecar: z.infer<typeof SidecarSchema> = {
        kind: backup.kind,
        created_at: backup.created_at,
        size_bytes: backup.size_bytes,
        integrity: backup.integrity,
        schema_version: backup.schema_version,
      };
      fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(sidecar), {
        mode: 0o600,
      });
      fsyncPath(this.dir);
      this.prune(kind);
      this.feed.record('system', 'database', 'backup.created', {
        backup_id: id,
        kind,
        integrity: backup.integrity,
      });
      return backup;
    } finally {
      for (const f of [partial, `${partial}-wal`, `${partial}-shm`, `${partial}-journal`]) {
        fs.rmSync(f, { force: true });
      }
    }
  }

  /**
   * Accept a restore: check the backup again, make a `pre_restore` backup of
   * the current state, then leave a marker that the next database open
   * applies. Writes are refused from here on; the caller reloads the service.
   */
  async restore(
    id: string,
    reload: 'in_process' | 'restart_required',
  ): Promise<RestoreBackupResponse> {
    if (this.restoring) {
      throw new ServiceError(409, 'restore_in_progress', 'a restore is already in progress');
    }
    const target = this.get(id);
    const check = inspectDatabase(backupFile(this.layout, id));
    if (target.integrity !== 'ok' || !check.ok) {
      throw new ServiceError(
        409,
        'backup_not_restorable',
        'this backup failed its integrity check and cannot be restored',
      );
    }
    const known = new Set(migrations.map((m) => m.id));
    const unknown = check.migrationIds.filter((m) => !known.has(m));
    if (unknown.length > 0) {
      throw new ServiceError(
        409,
        'backup_not_restorable',
        'this backup comes from a newer version of the service',
        { unknown_migrations: unknown },
      );
    }
    // 409, not 5xx: the outcome is certain. Nothing was restored and the
    // database is unchanged, so the client can say so and offer to retry.
    const refuse = (err: unknown): ServiceError =>
      new ServiceError(
        409,
        'backup_failed',
        'could not make a sound backup of the current state; nothing was restored',
        { reason: backupFailureReason(err), detail: failureDetail(err) },
      );
    let safety: Backup;
    try {
      safety = await this.create('pre_restore');
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      throw refuse(err);
    }
    if (safety.integrity !== 'ok')
      throw refuse(new BackupIntegrityError(`backup ${safety.id} failed its integrity check`));
    this.restoring = true;
    const marker = pendingFile(this.layout);
    try {
      // The marker is written in the same transaction as the event: both or neither.
      this.db.transaction(() => {
        this.feed.record('system', 'database', 'backup.restore_started', {
          backup_id: id,
          safety_backup_id: safety.id,
        });
        const pending: PendingRestore = {
          backup_id: id,
          safety_backup_id: safety.id,
          previous_seq: this.feed.latestSeq(),
        };
        fs.writeFileSync(`${marker}.tmp`, JSON.stringify(pending), { mode: 0o600 });
        fs.renameSync(`${marker}.tmp`, marker);
      })();
    } catch (err) {
      this.restoring = false;
      throw err;
    }
    return { restored_from: target, safety_backup: safety, reload };
  }

  private newId(at: Date, kind: BackupKind): string {
    const stamp = at
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.(\d{3})Z$/, '$1Z');
    const base = `${stamp}-${kind}`;
    let id = base;
    for (let n = 1; fs.existsSync(path.join(this.dir, `${id}.sqlite`)); n++) id = `${base}-${n}`;
    return id;
  }

  /** Backups with both files present, newest first. Unknown files are ignored. */
  private read(): Backup[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: Backup[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!BackupIdSchema.safeParse(id).success) continue;
      if (!names.includes(`${id}.sqlite`)) continue;
      try {
        const sidecar = SidecarSchema.parse(
          JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')),
        );
        out.push({ id, ...sidecar });
      } catch {
        // A damaged sidecar: not listed (and so never restored).
      }
    }
    return out.sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1,
    );
  }

  private prune(kind: BackupKind): void {
    const old = this.read()
      .filter((b) => b.kind === kind)
      .slice(this.retention);
    for (const b of old) {
      fs.rmSync(path.join(this.dir, `${b.id}.sqlite`), { force: true });
      fs.rmSync(path.join(this.dir, `${b.id}.json`), { force: true });
    }
  }
}
