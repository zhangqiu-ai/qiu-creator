import {
  BackupParamsSchema,
  BackupSchema,
  ErrorResponseSchema,
  ListBackupsResponseSchema,
  RestoreBackupRequestSchema,
  RestoreBackupResponseSchema,
} from '@qiu-creator/contracts';
import type { BackupService } from '../backups/backup-service.js';
import { ServiceError } from '../errors.js';
import type { App } from '../http/app-type.js';

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

/**
 * SQLite backups (QC-030), owner token only. `reload` reopens the service on
 * the restored database after the response is sent; without it the restore
 * waits for the next start.
 */
export function registerBackupRoutes(
  app: App,
  backups: BackupService,
  reload: ((afterResponse: Promise<void>) => void) | undefined,
): void {
  app.get(
    '/api/v1/backups',
    {
      schema: {
        description:
          'Database backups, newest first, with the retention (14 per kind), folder and daily schedule. Only the SQLite database is backed up; `.md` files and media are not.',
        response: { 200: ListBackupsResponseSchema, ...errors },
      },
    },
    () => backups.list(),
  );

  app.post(
    '/api/v1/backups',
    {
      schema: {
        description:
          'Back up now (online copy, then `PRAGMA integrity_check`). 201 with the backup; check `integrity`. 500 `backup_failed` when no copy could be made (e.g. disk full).',
        response: { 201: BackupSchema, ...errors },
      },
    },
    async (_req, reply) => {
      let backup;
      try {
        backup = await backups.create('manual');
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        // Disk full, permission problems...: a real server-side failure.
        throw new ServiceError(500, 'backup_failed', 'the backup could not be made', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      reply.code(201);
      return backup;
    },
  );

  app.post(
    '/api/v1/backups/:id/restore',
    {
      schema: {
        description:
          'Restore the database from a backup (`confirm: true`). The backup is checked again and the current state is backed up first (`safety_backup`, kind `pre_restore`). From then on writes get 503 `restoring`. With `reload: in_process` the service reopens itself on the restored database right after this 202: requests fail briefly, SSE drops; poll `/health`, then refetch everything (event `backup.restored`). 409 `backup_not_restorable` for a damaged backup or one from a newer version, 409 `restore_in_progress` if one is already under way, 409 `backup_failed` if the current state could not be backed up (nothing was restored).',
        params: BackupParamsSchema,
        body: RestoreBackupRequestSchema,
        response: { 202: RestoreBackupResponseSchema, ...errors },
      },
    },
    async (req, reply) => {
      const result = await backups.restore(
        req.params.id,
        reload === undefined ? 'restart_required' : 'in_process',
      );
      if (reload !== undefined) {
        // Ask now (so the host knows a reload is coming), run once the answer is out.
        reload(
          new Promise<void>((resolve) => {
            reply.raw.once('close', () => {
              resolve();
            });
          }),
        );
      }
      reply.code(202);
      return result;
    },
  );
}
