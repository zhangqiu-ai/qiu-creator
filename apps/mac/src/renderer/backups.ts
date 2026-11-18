import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  Backup,
  BackupKind,
  ChangeEvent,
  HealthResponse,
  ListBackupsResponse,
} from '@qiu-creator/contracts';
import { formatBytes } from './format.js';

/**
 * Settings → 備份 (QC-031). Framework-free so it can be tested without React;
 * the page reads it through `useSyncExternalStore`. It lives as long as the
 * connection (App), not the settings page, so a restore in progress keeps
 * being followed when the user moves to another page.
 */

export const KIND_LABEL: Readonly<Record<BackupKind, string>> = {
  daily: '每日',
  manual: '手動',
  pre_restore: '還原前',
};

const clock = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 「今天 03:00」「昨天 03:00」「11/14 03:00」「2025/11/14 03:00」: backups need the time of day. */
export function formatStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  const hm = clock.format(d);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  if (days === -1) return `明天 ${hm}`;
  const md = `${String(d.getMonth() + 1)}/${String(d.getDate())}`;
  return d.getFullYear() === now.getFullYear()
    ? `${md} ${hm}`
    : `${String(d.getFullYear())}/${md} ${hm}`;
}

/** 「48 MB · 每日」 */
export function backupSummary(backup: Pick<Backup, 'size_bytes' | 'kind'>): string {
  return `${formatBytes(backup.size_bytes)} · ${KIND_LABEL[backup.kind]}`;
}

/** 「0.4.0 · a1b2c3d · 建置於 11/18 14:05」, or 「0.4.0 · 從原始碼執行」 without build info. */
export function versionLabel(
  health: Pick<HealthResponse, 'version' | 'commit' | 'built_at'>,
  formatTime: (iso: string) => string,
): string {
  const parts = [health.version];
  if (health.commit !== null && health.commit !== '') parts.push(health.commit.slice(0, 7));
  if (health.built_at !== null && health.built_at !== '') {
    const when = Date.parse(health.built_at);
    parts.push(`建置於 ${Number.isNaN(when) ? health.built_at : formatTime(health.built_at)}`);
  }
  if (health.commit === null && health.built_at === null) parts.push('從原始碼執行');
  return parts.join(' · ');
}

export type RestorePhase =
  | { phase: 'idle' }
  /** POST sent: the service is backing up the current state, then switching. */
  | { phase: 'sending'; backup: Backup }
  /** Accepted; the service is reopening itself on the restored database. */
  | { phase: 'reloading'; backup: Backup; safety: Backup }
  | { phase: 'done'; backup: Backup; safety: Backup }
  /** Accepted, but only applied when the service next starts. */
  | { phase: 'restart_required'; backup: Backup; safety: Backup }
  | {
      phase: 'failed';
      backup: Backup;
      /** `request`: refused, nothing changed. `unknown`: no answer. `reload`: accepted but the service did not come back. */
      stage: 'request' | 'unknown' | 'reload';
      message: string;
      detail: string | null;
      safety: Backup | null;
    };

export interface BackupState {
  list: ListBackupsResponse | null;
  loadError: string | null;
  creating: boolean;
  /** The newest manual backup made from this window, for 「已備份」 feedback. */
  created: Backup | null;
  createError: { message: string; detail: string | null } | null;
  restore: RestorePhase;
  /** A restore started by someone else (another window, an Agent) is being applied. */
  externalRestore: boolean;
}

export interface BackupSessionOptions {
  client: Pick<CreatorHubClient, 'backups' | 'health'>;
  /** Called once the service runs on the restored database: every cached page must refetch. */
  onDataReplaced: () => void;
  /** Skip the event stream's reconnect backoff (the relay resumes with Last-Event-ID). */
  wakeEvents?: () => void;
  pollMs?: number;
  /** Give up waiting for the service after this long (it can be retried). */
  reloadTimeoutMs?: number;
}

function detailOf(err: unknown): string | null {
  if (err instanceof ApiError) return err.message === '' ? null : err.message;
  return err instanceof Error && err.message !== '' ? err.message : null;
}

/** Why a restore request was refused, in the user's words. */
export function restoreErrorText(err: unknown): { stage: 'request' | 'unknown'; message: string } {
  if (!(err instanceof ApiError)) {
    return { stage: 'unknown', message: '沒有收到服務的回應，無法確定是否已還原' };
  }
  switch (err.code) {
    case 'backup_not_restorable':
      return { stage: 'request', message: '這份備份未通過完整性檢查，不能還原；資料沒有變更' };
    case 'backup_failed':
      return { stage: 'request', message: '無法先備份目前的資料，所以沒有還原' };
    case 'restore_in_progress':
      return { stage: 'request', message: '已經有一個還原正在進行' };
    case 'not_found':
      return { stage: 'request', message: '找不到這份備份，可能已被清理；資料沒有變更' };
    default:
      return err.status >= 500
        ? { stage: 'unknown', message: '服務在還原時出錯，無法確定是否已還原' }
        : { stage: 'request', message: '服務拒絕了這次還原；資料沒有變更' };
  }
}

export function createErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'restore_in_progress') {
    return '正在還原，完成後再備份';
  }
  return err instanceof ApiError ? '備份失敗' : '備份失敗：沒有收到服務的回應';
}

export class BackupSession {
  private state: BackupState = {
    list: null,
    loadError: null,
    creating: false,
    created: null,
    createError: null,
    restore: { phase: 'idle' },
    externalRestore: false,
  };
  private readonly listeners = new Set<() => void>();
  private loadSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;
  /** A health check failed since the restore was accepted (the reload was seen). */
  private sawDown = false;
  /** `backup.restored` arrived for the restore being followed. */
  private sawRestored = false;
  private disposed = false;
  private readonly pollMs: number;
  private readonly reloadTimeoutMs: number;

  constructor(private readonly options: BackupSessionOptions) {
    this.pollMs = options.pollMs ?? 700;
    this.reloadTimeoutMs = options.reloadTimeoutMs ?? 60_000;
  }

  get snapshot(): BackupState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BackupState => this.state;

  private set(patch: Partial<BackupState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get busy(): boolean {
    const p = this.state.restore.phase;
    return p === 'sending' || p === 'reloading';
  }

  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const list = await this.options.client.backups.list();
      if (seq === this.loadSeq) this.set({ list, loadError: null });
    } catch (err) {
      if (seq === this.loadSeq) {
        this.set({ loadError: detailOf(err) ?? '無法載入備份清單' });
      }
    }
  }

  async create(): Promise<void> {
    if (this.state.creating || this.busy) return;
    this.set({ creating: true, createError: null, created: null });
    try {
      const backup = await this.options.client.backups.create();
      this.set({ creating: false, created: backup });
    } catch (err) {
      this.set({
        creating: false,
        createError: { message: createErrorText(err), detail: detailOf(err) },
      });
    }
    await this.load();
  }

  async restore(backup: Backup): Promise<void> {
    if (this.busy || backup.integrity !== 'ok') return;
    this.sawDown = false;
    this.sawRestored = false;
    this.set({ restore: { phase: 'sending', backup }, created: null, createError: null });
    let res;
    try {
      res = await this.options.client.backups.restore(backup.id);
    } catch (err) {
      const { stage, message } = restoreErrorText(err);
      this.set({
        restore: { phase: 'failed', backup, stage, message, detail: detailOf(err), safety: null },
      });
      void this.load();
      return;
    }
    if (res.reload === 'restart_required') {
      this.set({ restore: { phase: 'restart_required', backup, safety: res.safety_backup } });
      void this.load();
      return;
    }
    this.set({ restore: { phase: 'reloading', backup, safety: res.safety_backup } });
    this.deadline = Date.now() + this.reloadTimeoutMs;
    this.schedule();
  }

  /** After a 「服務沒有回來」 timeout: keep waiting for another round. */
  recheck(): void {
    const r = this.state.restore;
    if (r.phase !== 'failed' || r.stage !== 'reload' || r.safety === null) return;
    this.set({ restore: { phase: 'reloading', backup: r.backup, safety: r.safety } });
    this.deadline = Date.now() + this.reloadTimeoutMs;
    this.schedule(0);
  }

  /** Close the done / failed / restart notice. */
  dismiss(): void {
    if (this.busy) return;
    this.set({ restore: { phase: 'idle' }, created: null, createError: null });
  }

  /** Change events from the shared stream (only `system` ones matter here). */
  onEvent(event: ChangeEvent): void {
    if (event.entity !== 'system') return;
    switch (event.action) {
      case 'backup.created':
      case 'backup.failed':
        void this.load();
        return;
      case 'backup.restore_started':
        if (!this.busy) this.set({ externalRestore: true });
        return;
      case 'backup.restored': {
        const r = this.state.restore;
        if (r.phase === 'reloading' || r.phase === 'sending') {
          this.sawRestored = true;
          if (r.phase === 'reloading') this.schedule(0);
          return;
        }
        // Restored by someone else: this window's data is stale too.
        this.set({ externalRestore: false });
        this.options.onDataReplaced();
        void this.load();
        return;
      }
      default:
        return;
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposed = true;
    this.listeners.clear();
  }

  private schedule(delay = this.pollMs): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll();
    }, delay);
  }

  /**
   * Wait for the service to come back on the restored database. It answers
   * the restore before it reloads, so a healthy `/health` alone proves
   * nothing: it counts only after a failed check (the reload was seen) or
   * once `backup.restored` has arrived.
   */
  private async poll(): Promise<void> {
    const r = this.state.restore;
    if (r.phase !== 'reloading' || this.disposed) return;
    this.options.wakeEvents?.();
    let up = false;
    try {
      await this.options.client.health();
      up = true;
    } catch {
      this.sawDown = true;
    }
    const now = this.state.restore;
    // Read through a method: TypeScript would narrow `disposed` to false across the await.
    if (now.phase !== 'reloading' || this.isDisposed()) return;
    if (up && (this.sawDown || this.sawRestored)) {
      this.set({
        restore: { phase: 'done', backup: now.backup, safety: now.safety },
        externalRestore: false,
      });
      this.options.onDataReplaced();
      await this.load();
      return;
    }
    if (Date.now() >= this.deadline) {
      this.set({
        restore: {
          phase: 'failed',
          backup: now.backup,
          stage: 'reload',
          message: up
            ? '服務沒有確認還原完成'
            : `服務在 ${String(Math.round(this.reloadTimeoutMs / 1000))} 秒內沒有回來`,
          detail: null,
          safety: now.safety,
        },
      });
      return;
    }
    this.schedule();
  }
}
