import { z } from 'zod';
import { TimestampSchema } from './entities.js';

/**
 * SQLite backups (QC-030). Online copies of the database under
 * `<CREATORHUB_HOME>/backups`. Only the database: `.md` sources, revision
 * snapshots and media are files on disk and are not part of a backup (use
 * Time Machine for those). All routes are owner-only.
 */

/** Why a backup exists. `pre_restore` is the automatic copy taken right before a restore. */
export const BackupKindSchema = z.enum(['daily', 'manual', 'pre_restore']);
export type BackupKind = z.infer<typeof BackupKindSchema>;

/** Newest backups kept per kind; older ones of that kind are deleted after each new backup. */
export const BACKUP_RETENTION_PER_KIND = 14;

/** `<UTC yyyymmddThhmmssSSS>Z-<kind>`, optionally `-<n>` when two land in the same millisecond. */
export const BackupIdSchema = z
  .string()
  .regex(/^\d{8}T\d{9}Z-(daily|manual|pre_restore)(-\d{1,3})?$/, 'not a backup id');

export const BackupSchema = z.object({
  id: BackupIdSchema,
  kind: BackupKindSchema,
  created_at: TimestampSchema,
  size_bytes: z.number().int().nonnegative(),
  /**
   * Result of `PRAGMA integrity_check` on the copy, run when it was made.
   * Only `ok` backups can be restored.
   */
  integrity: z.enum(['ok', 'failed']),
  /** Newest schema migration in the copy, e.g. `0011`. */
  schema_version: z.string().nullable(),
});
export type Backup = z.infer<typeof BackupSchema>;

export const ListBackupsResponseSchema = z.object({
  /** Newest first. */
  backups: z.array(BackupSchema),
  retention_per_kind: z.number().int().positive(),
  /** Absolute path of the backup folder on the Mac. */
  directory: z.string(),
  /** Newest daily backup, or null if none yet. */
  last_daily_at: TimestampSchema.nullable(),
  /** When the next daily backup is due (it runs at the first check after this time). */
  next_daily_at: TimestampSchema,
  /** The last automatic backup failure since the service started, if the latest attempt failed. */
  last_error: z.string().nullable(),
});
export type ListBackupsResponse = z.infer<typeof ListBackupsResponseSchema>;

export const BackupParamsSchema = z.object({ id: BackupIdSchema });

export const RestoreBackupRequestSchema = z.object({
  /** Must be `true`: a restore replaces every record made after the backup. */
  confirm: z.literal(true),
});
export type RestoreBackupRequest = z.input<typeof RestoreBackupRequestSchema>;

export const RestoreBackupResponseSchema = z.object({
  restored_from: BackupSchema,
  /** The automatic backup of the state just before the restore; restore it to undo. */
  safety_backup: BackupSchema,
  /**
   * `in_process`: the service closes and reopens itself on the restored database
   * right after this response (requests fail for a moment; poll `/health`, then
   * refetch everything). `restart_required`: the host cannot reload in place; the
   * restore is applied on the next start.
   */
  reload: z.enum(['in_process', 'restart_required']),
});
export type RestoreBackupResponse = z.infer<typeof RestoreBackupResponseSchema>;
