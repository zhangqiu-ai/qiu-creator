import { ApiError } from '@qiu-creator/api-client';
import type {
  Backup,
  ChangeAction,
  ChangeEvent,
  HealthResponse,
  ListBackupsResponse,
  RestoreBackupResponse,
} from '@qiu-creator/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackupSession,
  backupSummary,
  createErrorText,
  formatStamp,
  dailyScheduleText,
  firstBackupText,
  restoreErrorText,
  versionLabel,
  type BackupSessionOptions,
} from '../src/renderer/backups.js';

const HEALTH: HealthResponse = {
  status: 'ok',
  service: 'creatorhub-mac-server',
  version: '0.1.0',
  commit: null,
  built_at: null,
};

function backup(id: string, patch: Partial<Backup> = {}): Backup {
  return {
    id,
    kind: 'daily',
    created_at: '2026-11-18T03:00:00.000Z',
    size_bytes: 48_000_000,
    integrity: 'ok',
    schema_version: '0011',
    ...patch,
  };
}

const DAILY = backup('20261118T030000000Z-daily');
const BROKEN = backup('20261117T030000000Z-daily', {
  created_at: '2026-11-17T03:00:00.000Z',
  integrity: 'failed',
});
const SAFETY = backup('20261118T101500000Z-pre_restore', {
  kind: 'pre_restore',
  created_at: '2026-11-18T10:15:00.000Z',
});

function listing(backups: Backup[]): ListBackupsResponse {
  return {
    backups,
    retention_per_kind: 14,
    directory: '/tmp/home/backups',
    last_daily_at: backups.find((b) => b.kind === 'daily')?.created_at ?? null,
    next_daily_at: '2026-11-19T03:00:00.000Z',
    last_error: null,
  };
}

function apiError(
  status: number,
  code: string,
  message = code,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(
    status,
    { error: { code, message, details } } as unknown as ConstructorParameters<typeof ApiError>[1],
    message,
  );
}

const RESTORING = () =>
  apiError(503, 'restoring', 'a restore is in progress; try again in a moment');

function systemEvent(
  action: ChangeAction,
  seq: number,
  data: Record<string, unknown> = {},
): ChangeEvent {
  return {
    seq,
    entity: 'system',
    entity_id: 'database',
    action,
    created_at: '2026-11-18T10:15:01.000Z',
    data,
  };
}

/** A scriptable stand-in for the service's backup routes and /health. */
class FakeService {
  backups: Backup[] = [DAILY, BROKEN];
  /** What /health does next: answer, or fail like a service in the middle of a reload. */
  healthQueue: ('up' | 'down')[] = [];
  healthDefault: 'up' | 'down' = 'up';
  healthCalls = 0;
  listCalls = 0;
  restoreResult: RestoreBackupResponse['reload'] | Error = 'in_process';
  createResult: Backup | Error = backup('20261118T101000000Z-manual', { kind: 'manual' });
  restored: string[] = [];

  client: BackupSessionOptions['client'] = {
    health: () => {
      this.healthCalls += 1;
      const next = this.healthQueue.shift() ?? this.healthDefault;
      return next === 'up'
        ? Promise.resolve(HEALTH)
        : Promise.reject(new TypeError('fetch failed'));
    },
    backups: {
      list: () => {
        this.listCalls += 1;
        return Promise.resolve(listing(this.backups));
      },
      create: () => {
        const r = this.createResult;
        if (r instanceof Error) return Promise.reject(r);
        this.backups = [r, ...this.backups];
        return Promise.resolve(r);
      },
      restore: (id: string) => {
        const r = this.restoreResult;
        if (r instanceof Error) return Promise.reject(r);
        this.restored.push(id);
        const from = this.backups.find((b) => b.id === id) ?? DAILY;
        this.backups = [SAFETY, ...this.backups];
        return Promise.resolve({ restored_from: from, safety_backup: SAFETY, reload: r });
      },
    },
  };
}

describe('backup helpers', () => {
  it('formats stamps with the time of day', () => {
    const now = new Date(2026, 10, 18, 12, 0);
    expect(formatStamp(new Date(2026, 10, 18, 3, 0).toISOString(), now)).toBe('今天 03:00');
    expect(formatStamp(new Date(2026, 10, 17, 3, 0).toISOString(), now)).toBe('昨天 03:00');
    expect(formatStamp(new Date(2026, 10, 19, 3, 0).toISOString(), now)).toBe('明天 03:00');
    expect(formatStamp(new Date(2026, 10, 14, 3, 5).toISOString(), now)).toBe('11/14 03:05');
    expect(formatStamp(new Date(2025, 10, 14, 3, 5).toISOString(), now)).toBe('2025/11/14 03:05');
    expect(formatStamp('not a date', now)).toBe('not a date');
  });

  it('writes the daily line as a sentence before the first backup and when one is due (QC-057)', () => {
    const now = new Date(2026, 10, 18, 12, 0);
    const past = new Date(2026, 10, 17, 8, 41).toISOString();
    const tomorrow = new Date(2026, 10, 19, 3, 0).toISOString();
    const today3 = new Date(2026, 10, 18, 3, 0).toISOString();
    expect(dailyScheduleText({ last_daily_at: null, next_daily_at: past }, now)).toBe(
      '還沒有自動備份 · 第一份即將建立',
    );
    expect(dailyScheduleText({ last_daily_at: null, next_daily_at: tomorrow }, now)).toBe(
      '還沒有自動備份 · 第一份會在 明天 03:00 建立',
    );
    expect(dailyScheduleText({ last_daily_at: today3, next_daily_at: tomorrow }, now)).toBe(
      '上次 今天 03:00 · 下次 明天 03:00',
    );
    expect(
      dailyScheduleText({ last_daily_at: today3, next_daily_at: now.toISOString() }, now),
    ).toBe('上次 今天 03:00 · 下次即將開始');
    expect(firstBackupText({ next_daily_at: past }, now)).toBe(
      '第一份每日備份即將自動建立，也可以按「立即備份」。',
    );
    expect(firstBackupText({ next_daily_at: tomorrow }, now)).toBe(
      '第一份每日備份會在 明天 03:00 自動建立，也可以按「立即備份」。',
    );
    // Never the old broken fragments.
    for (const text of [
      dailyScheduleText({ last_daily_at: null, next_daily_at: past }, now),
      firstBackupText({ next_daily_at: past }, now),
    ]) {
      expect(text).not.toMatch(/尚未執行|在 即將執行/);
    }
  });

  it('summarises size and kind', () => {
    expect(backupSummary(DAILY)).toBe('48 MB · 每日');
    expect(backupSummary(SAFETY)).toBe('48 MB · 還原前');
  });

  it('labels the service version, with or without build info', () => {
    const at = (iso: string) => `<${iso}>`;
    expect(versionLabel(HEALTH, at)).toBe('0.1.0 · 從原始碼執行');
    expect(
      versionLabel(
        { version: '0.1.0', commit: 'a1b2c3d4e5f6', built_at: '2026-11-18T06:00:00Z' },
        at,
      ),
    ).toBe('0.1.0 · a1b2c3d · 建置於 <2026-11-18T06:00:00Z>');
    expect(versionLabel({ version: '0.1.0', commit: 'a1b2c3d', built_at: null }, at)).toBe(
      '0.1.0 · a1b2c3d',
    );
    expect(versionLabel({ version: '0.1.0', commit: null, built_at: 'garbage' }, at)).toBe(
      '0.1.0 · 建置於 garbage',
    );
    // A service from before QC-030 leaves both out.
    expect(versionLabel({ version: '0.0.9' }, at)).toBe('0.0.9 · 從原始碼執行');
    expect(versionLabel({ version: '0.1.0', commit: 'a1b2c3d' }, at)).toBe('0.1.0 · a1b2c3d');
  });

  it('explains why a restore was refused', () => {
    expect(restoreErrorText(apiError(409, 'backup_not_restorable'))).toEqual({
      stage: 'request',
      message: '這份備份未通過完整性檢查，或來自較新的版本，不能還原；資料沒有變更',
    });
    // 409 backup_failed is definite: nothing was restored.
    expect(restoreErrorText(apiError(409, 'backup_failed'))).toEqual({
      stage: 'request',
      message: '無法先備份目前的資料，所以沒有還原；資料沒有變更',
    });
    expect(restoreErrorText(apiError(409, 'restore_in_progress')).message).toBe(
      '已經有一個還原正在進行',
    );
    expect(restoreErrorText(apiError(404, 'not_found')).stage).toBe('request');
    expect(restoreErrorText(apiError(500, 'internal_error')).stage).toBe('unknown');
    expect(restoreErrorText(new TypeError('fetch failed')).stage).toBe('unknown');
    expect(createErrorText(apiError(500, 'backup_failed'))).toBe('備份失敗，沒有產生副本');
    expect(createErrorText(new TypeError('fetch failed'))).toBe('備份失敗：沒有收到服務的回應');
  });
});

describe('BackupSession', () => {
  let svc: FakeService;
  let replaced: number;
  let woken: number;
  let session: BackupSession;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new FakeService();
    replaced = 0;
    woken = 0;
    session = new BackupSession({
      client: svc.client,
      onDataReplaced: () => {
        replaced += 1;
      },
      wakeEvents: () => {
        woken += 1;
      },
      pollMs: 100,
      reloadTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
  });

  it('loads the list and makes a manual backup', async () => {
    await session.load();
    expect(session.snapshot.list?.backups.map((b) => b.id)).toEqual([DAILY.id, BROKEN.id]);
    const changes: boolean[] = [];
    session.subscribe(() => changes.push(session.snapshot.creating));
    await session.create();
    expect(changes[0]).toBe(true);
    expect(session.snapshot.creating).toBe(false);
    expect(session.snapshot.created?.kind).toBe('manual');
    expect(session.snapshot.list?.backups[0]?.kind).toBe('manual');
  });

  it('reports a failed manual backup with the service reason and still refreshes the list', async () => {
    svc.createResult = apiError(500, 'backup_failed', 'the backup could not be made', {
      reason: 'disk_full',
      detail: 'ENOSPC: no space left on device',
    });
    await session.create();
    // QC-043: the category is a sentence in the interface language; the errno text stays as is.
    expect(session.snapshot.createError).toEqual({
      message: '備份失敗，沒有產生副本',
      reason: '磁碟空間不足。',
      detail: 'ENOSPC: no space left on device',
    });
    expect(session.snapshot.created).toBeNull();
    expect(svc.listCalls).toBe(1);

    // An older service sends no reason: the detail is still shown, with no category sentence.
    svc.createResult = apiError(500, 'backup_failed', 'the backup could not be made', {
      detail: 'EIO: i/o error',
    });
    await session.create();
    expect(session.snapshot.createError).toEqual({
      message: '備份失敗，沒有產生副本',
      reason: null,
      detail: 'EIO: i/o error',
    });
  });

  it('clears an old 立即備份 failure once a newer backup is made', async () => {
    svc.createResult = apiError(500, 'backup_failed', 'the backup could not be made');
    await session.create();
    expect(session.snapshot.createError).not.toBeNull();
    session.onEvent(systemEvent('backup.failed', 7, { kind: 'daily', error: 'x' }));
    expect(session.snapshot.createError).not.toBeNull();
    session.onEvent(systemEvent('backup.created', 8, { backup_id: 'y', kind: 'daily' }));
    expect(session.snapshot.createError).toBeNull();
  });

  it('never restores a backup that failed its integrity check', async () => {
    await session.restore(BROKEN);
    expect(svc.restored).toEqual([]);
    expect(session.snapshot.restore.phase).toBe('idle');
  });

  it('does not call a restore done while the old service still answers', async () => {
    await session.restore(DAILY);
    expect(svc.restored).toEqual([DAILY.id]);
    expect(session.snapshot.restore).toMatchObject({ phase: 'reloading', safety: SAFETY });
    // Healthy before the reload: not proof of anything.
    await vi.advanceTimersByTimeAsync(300);
    expect(session.snapshot.restore.phase).toBe('reloading');
    expect(replaced).toBe(0);
    // The service goes away, then comes back.
    svc.healthQueue = ['down', 'down', 'up'];
    await vi.advanceTimersByTimeAsync(300);
    expect(session.snapshot.restore).toMatchObject({
      phase: 'done',
      backup: DAILY,
      safety: SAFETY,
    });
    expect(replaced).toBe(1);
    expect(woken).toBeGreaterThan(0);
    // The list was refetched after the reload and shows the safety backup.
    expect(session.snapshot.list?.backups[0]?.id).toBe(SAFETY.id);
  });

  it('finishes on backup.restored even if no failed health check was seen', async () => {
    await session.restore(DAILY);
    session.onEvent(systemEvent('backup.restore_started', 41, { backup_id: DAILY.id }));
    expect(session.snapshot.externalRestore).toBe(false);
    session.onEvent(systemEvent('backup.restored', 42, { backup_id: DAILY.id }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.snapshot.restore.phase).toBe('done');
    expect(replaced).toBe(1);
  });

  it('gives up after the timeout and can keep waiting', async () => {
    svc.healthDefault = 'down';
    await session.restore(DAILY);
    await vi.advanceTimersByTimeAsync(1200);
    expect(session.snapshot.restore).toMatchObject({
      phase: 'failed',
      stage: 'reload',
      message: '服務在 1 秒內沒有回來',
      safety: SAFETY,
    });
    expect(replaced).toBe(0);
    svc.healthDefault = 'up';
    session.recheck();
    expect(session.snapshot.restore.phase).toBe('reloading');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.snapshot.restore.phase).toBe('done');
    expect(replaced).toBe(1);
  });

  it('says so when the service never confirms the reload', async () => {
    await session.restore(DAILY);
    await vi.advanceTimersByTimeAsync(1200);
    expect(session.snapshot.restore).toMatchObject({
      phase: 'failed',
      stage: 'reload',
      message: '服務沒有確認還原完成',
    });
  });

  it('shows restart_required without refetching', async () => {
    svc.restoreResult = 'restart_required';
    await session.restore(DAILY);
    expect(session.snapshot.restore).toMatchObject({ phase: 'restart_required', safety: SAFETY });
    await vi.advanceTimersByTimeAsync(1000);
    expect(svc.healthCalls).toBe(0);
    expect(replaced).toBe(0);
    session.dismiss();
    expect(session.snapshot.restore.phase).toBe('idle');
  });

  it('shows why a restore was refused', async () => {
    svc.restoreResult = apiError(
      409,
      'backup_not_restorable',
      'this backup failed its integrity check and cannot be restored',
    );
    await session.restore(DAILY);
    expect(session.snapshot.restore).toMatchObject({
      phase: 'failed',
      stage: 'request',
      message: '這份備份未通過完整性檢查，或來自較新的版本，不能還原；資料沒有變更',
      detail: 'this backup failed its integrity check and cannot be restored',
      safety: null,
    });
    // A failure that is not a reload cannot be "waited for".
    session.recheck();
    expect(session.snapshot.restore.phase).toBe('failed');
  });

  it('says a 409 backup_failed restore changed nothing, with the reason from details', async () => {
    svc.restoreResult = apiError(
      409,
      'backup_failed',
      'could not make a sound backup of the current state; nothing was restored',
      { detail: 'integrity_check: database disk image is malformed' },
    );
    await session.restore(DAILY);
    expect(session.snapshot.restore).toMatchObject({
      phase: 'failed',
      stage: 'request',
      message: '無法先備份目前的資料，所以沒有還原；資料沒有變更',
      detail: 'integrity_check: database disk image is malformed',
    });
    expect(JSON.stringify(session.snapshot.restore)).not.toContain('無法確定');
  });

  it('waits instead of failing when the service is already restoring (503)', async () => {
    svc.restoreResult = RESTORING();
    await session.restore(DAILY);
    expect(session.snapshot.restore.phase).toBe('idle');
    expect(session.snapshot.externalRestore).toBe(true);
    svc.healthQueue = ['down', 'up'];
    await vi.advanceTimersByTimeAsync(250);
    expect(session.snapshot.externalRestore).toBe(false);
    expect(replaced).toBe(1);
  });

  it('treats 503 restoring on 立即備份 as a restore under way, not a failed backup', async () => {
    svc.createResult = RESTORING();
    await session.create();
    expect(session.snapshot.createError).toBeNull();
    expect(session.snapshot.creating).toBe(false);
    expect(session.snapshot.externalRestore).toBe(true);
  });

  it('follows a restore it learned of from another page (noteRestoring)', async () => {
    session.noteRestoring();
    session.noteRestoring();
    expect(session.snapshot.externalRestore).toBe(true);
    // backup.restored ends it once; later polls do not refetch again.
    session.onEvent(systemEvent('backup.restored', 9, { backup_id: DAILY.id }));
    expect(session.snapshot.externalRestore).toBe(false);
    svc.healthQueue = ['down', 'up'];
    await vi.advanceTimersByTimeAsync(500);
    expect(replaced).toBe(1);
  });

  it('stops showing an external restore after the timeout and refetches', async () => {
    session.noteRestoring();
    await vi.advanceTimersByTimeAsync(1200);
    expect(session.snapshot.externalRestore).toBe(false);
    expect(replaced).toBe(1);
  });

  it('does not treat its own restore as external', async () => {
    await session.restore(DAILY);
    session.noteRestoring();
    expect(session.snapshot.externalRestore).toBe(false);
    expect(session.snapshot.restore.phase).toBe('reloading');
  });

  it('ignores a second restore while one is in progress', async () => {
    await session.restore(DAILY);
    await session.restore(DAILY);
    expect(svc.restored).toEqual([DAILY.id]);
    session.dismiss();
    expect(session.snapshot.restore.phase).toBe('reloading');
  });

  it('follows backup events from the shared stream', async () => {
    session.onEvent({ ...systemEvent('backup.created', 1), entity: 'work' });
    expect(svc.listCalls).toBe(0);
    session.onEvent(systemEvent('backup.created', 2, { backup_id: 'x', kind: 'daily' }));
    session.onEvent(systemEvent('backup.failed', 3, { kind: 'daily', error: 'disk full' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.listCalls).toBe(2);

    // A restore started elsewhere: this window's data is replaced too.
    session.onEvent(systemEvent('backup.restore_started', 4, { backup_id: DAILY.id }));
    expect(session.snapshot.externalRestore).toBe(true);
    session.onEvent(systemEvent('backup.restored', 5, { backup_id: DAILY.id }));
    expect(session.snapshot.externalRestore).toBe(false);
    expect(replaced).toBe(1);
  });
});
