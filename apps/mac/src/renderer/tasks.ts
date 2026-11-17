import type { ImportErrorCode, ImportJobRecord, ImportMethod } from '@qiu-creator/contracts';
import type { UploadItem } from '../shared/bridge.js';
import type { ChipTone } from './format.js';
import { formatBytes } from './format.js';

/** Filter buckets on the 匯入任務 page. */
export type TaskGroup = 'run' | 'fail' | 'done';
export type TaskFilter = 'all' | TaskGroup;

export interface TaskRow {
  key: string;
  source: 'job' | 'upload';
  id: string;
  method: ImportMethod;
  name: string;
  /** Where it came from: the URL, or "Mac 上傳". */
  origin: string;
  size: string | null;
  label: string;
  tone: ChipTone;
  group: TaskGroup;
  /** 0..1 while running; null when the service does not report progress. */
  progress: number | null;
  running: boolean;
  reason: string | null;
  /** Raw service message, shown as a tooltip for diagnosis. */
  reasonDetail: string | null;
  canRetry: boolean;
  canCancel: boolean;
  canDismiss: boolean;
  /** Asset produced (or reused) by this task. */
  assetId: string | null;
  /** True when the service already had identical content and reused it. */
  reused: boolean;
  createdAt: string;
}

export const METHOD_LABEL: Readonly<Record<ImportMethod, string>> = {
  url: 'URL',
  upload: '上傳',
  folder: '資料夾',
  markdown: 'API',
};

export const IMPORT_ERROR_TEXT: Readonly<Record<ImportErrorCode, string>> = {
  url_rejected: '網址無效或不允許',
  blocked_address: '內網或本機位址，已阻擋',
  too_many_redirects: '重新導向次數過多',
  http_error: '來源網站回應錯誤',
  unsupported_content_type: '不支援的內容類型',
  payload_too_large: '檔案超過大小上限',
  unsupported_media_type: '不支援的檔案格式',
  timeout: '下載逾時',
  network_error: '網路連線失敗',
  internal_error: '本機服務內部錯誤',
};

const UPLOAD_ERROR_TEXT: Readonly<Record<string, string>> = {
  unsupported_media_type: '不支援的檔案格式',
  payload_too_large: '檔案超過大小上限',
  network_error: '與本機服務的連線中斷',
  file_changed: '檔案在上傳期間被修改',
  internal_error: '本機服務內部錯誤',
  unauthorized: '權杖無效',
};

/** Path-ish tail of a URL for the second line of a row. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname
      .split('/')
      .filter((s) => s !== '')
      .pop();
    return last === undefined ? new URL(url).host : decodeURIComponent(last);
  } catch {
    return url;
  }
}

export function jobRow(job: ImportJobRecord): TaskRow {
  const blocked = job.error_code === 'blocked_address' || job.error_code === 'url_rejected';
  const base = {
    key: `job:${job.id}`,
    source: 'job' as const,
    id: job.id,
    method: job.method,
    name: job.filename ?? (job.url === null ? METHOD_LABEL[job.method] : nameFromUrl(job.url)),
    origin:
      job.url !== null
        ? shortUrl(job.url)
        : job.created_by !== null && job.created_by !== 'owner'
          ? 'Agent API'
          : 'Mac',
    size: null,
    progress: null,
    running: false,
    reason: null,
    reasonDetail: null,
    canRetry: false,
    canCancel: false,
    canDismiss: false,
    assetId: job.result_asset_id,
    reused: false,
    createdAt: job.created_at,
  };
  switch (job.status) {
    case 'queued':
      return { ...base, label: '排隊', tone: 'neutral', group: 'run' };
    case 'running':
      return {
        ...base,
        label: '進行中',
        tone: 'accent',
        group: 'run',
        running: true,
        progress: job.progress > 0 && job.progress < 1 ? job.progress : null,
      };
    case 'succeeded':
      return { ...base, label: '成功', tone: 'ok', group: 'done' };
    case 'cancelled':
      return { ...base, label: '已取消', tone: 'neutral', group: 'fail' };
    case 'failed':
      return {
        ...base,
        label: blocked ? '已阻擋' : '失敗',
        tone: 'bad',
        group: 'fail',
        reason: job.error_code === null ? (job.error ?? '失敗') : IMPORT_ERROR_TEXT[job.error_code],
        reasonDetail: job.error,
        // The service refuses to retry blocked addresses only by failing again; let the user decide.
        canRetry: true,
      };
  }
}

export function uploadRow(upload: UploadItem): TaskRow {
  const base = {
    key: `upload:${upload.id}`,
    source: 'upload' as const,
    id: upload.id,
    method: 'upload' as const,
    name: upload.filename,
    origin: upload.transport === 'tus' ? 'Mac 上傳 · 可續傳' : 'Mac 上傳',
    size: formatBytes(upload.bytes),
    progress: null,
    running: false,
    reason: null,
    reasonDetail: null,
    canRetry: false,
    canCancel: false,
    canDismiss: false,
    assetId: upload.result?.asset.id ?? null,
    reused: upload.result?.deduplicated ?? false,
    createdAt: upload.createdAt,
  };
  switch (upload.state) {
    case 'queued':
      return { ...base, label: '排隊', tone: 'neutral', group: 'run', canCancel: true };
    case 'uploading':
      return {
        ...base,
        label: '進行中',
        tone: 'accent',
        group: 'run',
        running: true,
        canCancel: true,
        progress: upload.bytes === 0 ? null : upload.sentBytes / upload.bytes,
      };
    case 'succeeded':
      return upload.result?.deduplicated === true
        ? { ...base, label: '已存在', tone: 'warn', group: 'done', canDismiss: true }
        : { ...base, label: '成功', tone: 'ok', group: 'done', canDismiss: true };
    case 'cancelled':
      return {
        ...base,
        label: '已取消',
        tone: 'neutral',
        group: 'fail',
        canRetry: true,
        canDismiss: true,
        progress: upload.bytes === 0 ? null : upload.sentBytes / upload.bytes,
      };
    case 'failed':
      return {
        ...base,
        label: '失敗',
        tone: 'bad',
        group: 'fail',
        reason:
          (upload.errorCode === null ? undefined : UPLOAD_ERROR_TEXT[upload.errorCode]) ??
          upload.error ??
          '上傳失敗',
        reasonDetail: upload.error,
        canRetry: true,
        canDismiss: true,
      };
  }
}

/** Server jobs and this session's uploads, newest first. */
export function taskRows(
  jobs: readonly ImportJobRecord[],
  uploads: readonly UploadItem[],
): TaskRow[] {
  return [...jobs.map(jobRow), ...uploads.map(uploadRow)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function filterRows(rows: readonly TaskRow[], filter: TaskFilter): TaskRow[] {
  return filter === 'all' ? [...rows] : rows.filter((r) => r.group === filter);
}

export function countRows(rows: readonly TaskRow[]): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { all: rows.length, run: 0, fail: 0, done: 0 };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}
