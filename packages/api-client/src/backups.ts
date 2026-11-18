import {
  BackupSchema,
  ListBackupsResponseSchema,
  RestoreBackupRequestSchema,
  RestoreBackupResponseSchema,
  type Backup,
  type ListBackupsResponse,
  type RestoreBackupResponse,
} from '@qiu-creator/contracts';
import { call, type Ctx } from './imports.js';

/** SQLite backups (QC-030). Owner token only; agent tokens get 403. */
export interface CreatorHubBackupsApi {
  /** Backups (newest first), retention, folder and daily schedule. */
  list(): Promise<ListBackupsResponse>;
  /** Make a manual backup now (online copy + integrity check). */
  create(): Promise<Backup>;
  /**
   * Restore the database from a backup. A `pre_restore` backup of the current
   * state is made first. With `reload: 'in_process'` the service reopens itself
   * right after answering: wait for `health()` and refetch everything.
   */
  restore(id: string): Promise<RestoreBackupResponse>;
}

export function createBackupsApi(ctx: Ctx): CreatorHubBackupsApi {
  return {
    list: () => call(ctx, ListBackupsResponseSchema, 'GET', '/api/v1/backups'),
    create: () => call(ctx, BackupSchema, 'POST', '/api/v1/backups', {}),
    restore: (id) =>
      call(
        ctx,
        RestoreBackupResponseSchema,
        'POST',
        `/api/v1/backups/${encodeURIComponent(id)}/restore`,
        RestoreBackupRequestSchema.parse({ confirm: true }),
      ),
  };
}
