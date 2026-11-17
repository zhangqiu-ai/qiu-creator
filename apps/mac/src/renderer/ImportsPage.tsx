import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { ImportJobRecord } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useRefreshOn, useUploads } from './events.js';
import { Icon, type IconName } from './Icon.js';
import {
  countRows,
  filterRows,
  METHOD_LABEL,
  taskRows,
  type TaskFilter,
  type TaskRow,
} from './tasks.js';
import { TokensPanel } from './TokensPanel.js';

const FILTERS: readonly { key: TaskFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'run', label: '進行中' },
  { key: 'fail', label: '失敗' },
  { key: 'done', label: '完成' },
];

const METHOD_ICON: Readonly<Record<TaskRow['method'], IconName>> = {
  url: 'link',
  upload: 'upload',
  folder: 'folder',
  markdown: 'api',
};

/**
 * 匯入任務 (prototype board MacImports): URL import jobs from the service
 * merged with this session's uploads, live from SSE `job.*` events and the
 * main process's upload manager. Failures retry in place.
 */
export function ImportsPage({
  client,
  onOpenAsset,
}: {
  client: CreatorHubClient;
  onOpenAsset: (assetId: string) => void;
}) {
  const [jobs, setJobs] = useState<ImportJobRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [urlOpen, setUrlOpen] = useState(false);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const uploads = useUploads();
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    client.jobs
      .list({ limit: 200 })
      .then((res) => {
        if (id !== request.current) return;
        setFailed(false);
        setJobs(res.items);
      })
      .catch(() => {
        if (id !== request.current) return;
        setFailed(true);
      });
  }, [client]);

  useEffect(load, [load]);
  useRefreshOn(['job'], load);

  const rows = useMemo(() => taskRows(jobs ?? [], uploads), [jobs, uploads]);
  const counts = countRows(rows);
  const shown = filterRows(rows, filter);

  const retry = (row: TaskRow) => {
    setRowError(null);
    if (row.source === 'upload') {
      void window.creatorhub?.retryUpload(row.id);
      return;
    }
    client.jobs
      .retry(row.id)
      .then(load)
      .catch((err: unknown) => {
        setRowError({
          key: row.key,
          message:
            err instanceof ApiError && err.code === 'job_not_retryable'
              ? '這個任務目前不能重試'
              : '重試失敗，請稍後再試',
        });
        load();
      });
  };

  const pick = () => {
    void window.creatorhub?.pickAndUpload();
  };

  return (
    <main className="page" aria-label="匯入任務">
      <header className="page__header">
        <h1 className="page__title">匯入任務</h1>
        <div className="seg" role="group" aria-label="狀態">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
              }}
            >
              {f.label}
              <span className="seg__n">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <span className="page__spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setUrlOpen(true);
          }}
        >
          <Icon name="link" />
          貼上 URL
        </button>
        <button type="button" className="btn btn--primary" onClick={pick}>
          <Icon name="upload" />
          上傳
        </button>
      </header>

      <div className="imports">
        <section
          className="card imports__list"
          aria-label="任務"
          aria-busy={jobs === null && !failed}
        >
          {failed && (
            <div className="banner banner--bad" role="alert">
              <Icon name="offline" />
              <span className="banner__text">無法載入服務端的匯入任務</span>
              <button type="button" className="btn btn--small" onClick={load}>
                重試
              </button>
            </div>
          )}
          {jobs === null && !failed ? (
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="trow" aria-hidden="true">
                <span className="skel trow__icon" />
                <span className="skel skel--line" style={{ width: '60%' }} />
                <span className="skel skel--line" />
                <span />
              </div>
            ))
          ) : shown.length === 0 ? (
            rows.length === 0 ? (
              <div className="imports__empty">
                <Icon name="imports" size={28} />
                <span className="state-card__title">無任務</span>
                <div className="state-card__actions">
                  <button type="button" className="btn btn--primary" onClick={pick}>
                    上傳
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setUrlOpen(true);
                    }}
                  >
                    貼上 URL
                  </button>
                </div>
              </div>
            ) : (
              <div className="imports__empty">
                <span className="muted">這個分類沒有任務</span>
              </div>
            )
          ) : (
            <ul className="trows">
              {shown.map((row) => (
                <TaskRowView
                  key={row.key}
                  row={row}
                  error={rowError?.key === row.key ? rowError.message : null}
                  onRetry={() => {
                    retry(row);
                  }}
                  onCancel={() => {
                    void window.creatorhub?.cancelUpload(row.id);
                  }}
                  onDismiss={() => {
                    void window.creatorhub?.dismissUpload(row.id);
                  }}
                  onOpen={() => {
                    if (row.assetId !== null) onOpenAsset(row.assetId);
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        <div className="imports__side">
          <TokensPanel client={client} />
        </div>
      </div>

      {urlOpen && (
        <UrlImportDialog
          client={client}
          onClose={() => {
            setUrlOpen(false);
          }}
          onQueued={() => {
            setUrlOpen(false);
            setFilter('all');
            load();
          }}
        />
      )}
    </main>
  );
}

function TaskRowView({
  row,
  error,
  onRetry,
  onCancel,
  onDismiss,
  onOpen,
}: {
  row: TaskRow;
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const pct = row.progress === null ? null : Math.round(row.progress * 100);
  return (
    <li className="trow">
      <span className="trow__icon" role="img" aria-label={METHOD_LABEL[row.method]}>
        <Icon name={METHOD_ICON[row.method]} size={14} />
      </span>
      <div className="trow__main">
        <div className="trow__line">
          <span className="trow__name">{row.name}</span>
          {row.size !== null && <span className="faint trow__size">{row.size}</span>}
        </div>
        <div className="trow__line trow__sub">
          <span>{METHOD_LABEL[row.method]}</span>
          <span aria-hidden="true">·</span>
          <span className={row.method === 'url' ? 'mono trow__origin' : 'trow__origin'}>
            {row.origin}
          </span>
        </div>
        {row.reason !== null && (
          <div className="trow__reason" title={row.reasonDetail ?? undefined}>
            {row.reason}
          </div>
        )}
        {row.reused && <div className="faint">內容與既有素材相同，沿用原素材，沒有重複儲存</div>}
        {error !== null && (
          <div className="trow__reason" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="trow__status">
        <span className="trow__chip">
          <Chip tone={row.tone}>{row.label}</Chip>
          {row.running && pct !== null && <span className="trow__pct">{pct}%</span>}
        </span>
        {(row.running || (row.label === '已取消' && pct !== null)) && (
          <div
            className={pct === null ? 'bar bar--indeterminate' : 'bar'}
            role="progressbar"
            aria-label={row.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="trow__actions">
        {row.canRetry && (
          <button type="button" className="btn btn--small" onClick={onRetry}>
            <Icon name="retry" size={14} />
            {row.label === '已取消' ? '繼續' : '重試'}
          </button>
        )}
        {row.canCancel && (
          <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>
            取消
          </button>
        )}
        {row.group === 'done' && row.assetId !== null && (
          <button type="button" className="btn btn--ghost btn--small" onClick={onOpen}>
            {row.reused ? '沿用原素材' : '開啟'}
          </button>
        )}
        {row.canDismiss && (
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label={`從列表移除 ${row.name}`}
            title="從列表移除"
            onClick={onDismiss}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

function newKey(): string {
  return crypto.randomUUID();
}

/** The service refuses literal private addresses and bad schemes before queuing a job. */
export function urlRejectedText(err: ApiError): string {
  const reason = err.body?.error.details?.['reason'];
  if (reason === 'blocked_address') return '內網或本機位址，已阻擋。只能匯入公開網址。';
  return '這個網址不能匯入';
}

export function validateImportUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return '請輸入網址';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支援 http 或 https 網址';
  } catch {
    return '網址格式不正確';
  }
  return null;
}

function UrlImportDialog({
  client,
  onClose,
  onQueued,
}: {
  client: CreatorHubClient;
  onClose: () => void;
  onQueued: () => void;
}) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per dialog: pressing 匯入 twice, or a retry after a lost response, reuses the same job.
  const key = useRef(newKey());

  const submit = () => {
    if (busy) return;
    const problem = validateImportUrl(url);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const name = filename.trim();
    client.imports
      .url(
        { url: url.trim(), filename: name === '' ? undefined : name },
        { idempotencyKey: key.current },
      )
      .then(onQueued)
      .catch((err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.code === 'url_rejected') {
          setError(urlRejectedText(err));
        } else if (err instanceof ApiError && err.code === 'validation_error') {
          setError('網址或檔名格式不正確');
        } else if (err instanceof ApiError && err.code === 'idempotency_key_reused') {
          key.current = newKey();
          setError('內容已變更，請再按一次匯入');
        } else {
          setError('無法建立匯入任務，請確認本機服務是否運行');
        }
      });
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      title="從 URL 匯入"
      onClose={onClose}
      footer={
        <>
          <span className="faint dialog__hint">只下載公開網址；內網與本機位址會被阻擋</span>
          <button type="button" className="btn btn--ghost dialog__primary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={submit}>
            匯入
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">網址</span>
          <input
            data-autofocus
            className="input mono"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={url}
            aria-invalid={error !== null}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter}
          />
        </label>
        <label className="field">
          <span className="field__label">
            檔名 <span className="faint">（選填）</span>
          </span>
          <input
            className="input"
            type="text"
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value);
            }}
            onKeyDown={onEnter}
          />
        </label>
        {error !== null && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
