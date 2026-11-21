import type { ImportErrorCode, ImportJobRecord, ImportMethod } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';
import type { UploadItem } from '../shared/bridge.js';
import type { ChipTone } from './format.js';
import { formatBytes } from './format.js';
import { t } from './i18n.js';

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
  /** True for a cancelled job or upload (the label is translated, so never compare it). */
  cancelled: boolean;
  /** Asset produced (or reused) by this task. */
  assetId: string | null;
  /** True when the service already had identical content and reused it. */
  reused: boolean;
  createdAt: string;
}

/** 上傳 / 資料夾 in the current language; URL and API read the same everywhere. */
export function methodLabel(method: ImportMethod): string {
  switch (method) {
    case 'url':
      return 'URL';
    case 'upload':
      return t('library.upload');
    case 'folder':
      return t('library.folder');
    case 'markdown':
      return 'API';
  }
}

const IMPORT_ERROR_KEY: Readonly<Record<ImportErrorCode, MessageKey>> = {
  url_rejected: 'library.importErrUrlRejected',
  blocked_address: 'library.importErrBlockedAddress',
  too_many_redirects: 'library.importErrTooManyRedirects',
  http_error: 'library.importErrHttp',
  unsupported_content_type: 'library.importErrContentType',
  payload_too_large: 'library.importErrTooLarge',
  unsupported_media_type: 'library.importErrMediaType',
  timeout: 'library.importErrTimeout',
  network_error: 'library.importErrNetwork',
  internal_error: 'library.importErrInternal',
};

/** Why a URL import failed, in the current language. */
export function importErrorText(code: ImportErrorCode): string {
  return t(IMPORT_ERROR_KEY[code]);
}

const UPLOAD_ERROR_KEY: Readonly<Record<string, MessageKey>> = {
  unsupported_media_type: 'library.importErrMediaType',
  payload_too_large: 'library.importErrTooLarge',
  network_error: 'library.uploadErrNetwork',
  file_changed: 'library.uploadErrFileChanged',
  internal_error: 'library.importErrInternal',
  unauthorized: 'library.uploadErrUnauthorized',
};

/** Why an upload failed, in the current language; null when the code is unknown. */
function uploadErrorText(code: string | null): string | null {
  if (code === null) return null;
  const key = UPLOAD_ERROR_KEY[code];
  return key === undefined ? null : t(key);
}

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
    name: job.filename ?? (job.url === null ? methodLabel(job.method) : nameFromUrl(job.url)),
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
    cancelled: false,
    assetId: job.result_asset_id,
    reused: false,
    createdAt: job.created_at,
  };
  switch (job.status) {
    case 'queued':
      return { ...base, label: t('library.taskQueued'), tone: 'neutral', group: 'run' };
    case 'running':
      return {
        ...base,
        label: t('library.taskRunning'),
        tone: 'accent',
        group: 'run',
        running: true,
        progress: job.progress > 0 && job.progress < 1 ? job.progress : null,
      };
    case 'succeeded':
      return { ...base, label: t('library.taskSucceeded'), tone: 'ok', group: 'done' };
    case 'cancelled':
      return {
        ...base,
        label: t('library.taskCancelled'),
        tone: 'neutral',
        group: 'fail',
        cancelled: true,
      };
    case 'failed':
      return {
        ...base,
        label: t(blocked ? 'library.taskBlocked' : 'library.taskFailed'),
        tone: 'bad',
        group: 'fail',
        // Never the service's own text as the reason (QC-048): it goes under 技術細節.
        reason: job.error_code === null ? t('library.taskFailed') : importErrorText(job.error_code),
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
    origin: t(
      upload.transport === 'tus' ? 'library.originUploadResumable' : 'library.originUpload',
    ),
    size: formatBytes(upload.bytes),
    progress: null,
    running: false,
    reason: null,
    reasonDetail: null,
    canRetry: false,
    canCancel: false,
    canDismiss: false,
    cancelled: false,
    assetId: upload.result?.asset.id ?? null,
    reused: upload.result?.deduplicated ?? false,
    createdAt: upload.createdAt,
  };
  switch (upload.state) {
    case 'queued':
      return {
        ...base,
        label: t('library.taskQueued'),
        tone: 'neutral',
        group: 'run',
        canCancel: true,
      };
    case 'uploading':
      return {
        ...base,
        label: t('library.taskRunning'),
        tone: 'accent',
        group: 'run',
        running: true,
        canCancel: true,
        progress: upload.bytes === 0 ? null : upload.sentBytes / upload.bytes,
      };
    case 'succeeded':
      return upload.result?.deduplicated === true
        ? {
            ...base,
            label: t('library.taskExists'),
            tone: 'warn',
            group: 'done',
            canDismiss: true,
          }
        : {
            ...base,
            label: t('library.taskSucceeded'),
            tone: 'ok',
            group: 'done',
            canDismiss: true,
          };
    case 'cancelled':
      return {
        ...base,
        label: t('library.taskCancelled'),
        tone: 'neutral',
        group: 'fail',
        cancelled: true,
        canRetry: true,
        canDismiss: true,
        progress: upload.bytes === 0 ? null : upload.sentBytes / upload.bytes,
      };
    case 'failed':
      return {
        ...base,
        label: t('library.taskFailed'),
        tone: 'bad',
        group: 'fail',
        reason: uploadErrorText(upload.errorCode) ?? upload.error ?? t('library.uploadFailed'),
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
