import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { isRestoring, restoringText } from './restoring.js';
import type { ImportJobRecord } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useRefreshOn, useUploads } from './events.js';
import { progressStyle } from './motion.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import {
  countRows,
  filterRows,
  methodLabel,
  taskRows,
  type TaskFilter,
  type TaskRow,
} from './tasks.js';
import { TokensPanel } from './TokensPanel.js';

const FILTERS: readonly TaskFilter[] = ['all', 'run', 'fail', 'done'];

function filterLabel(filter: TaskFilter): string {
  switch (filter) {
    case 'all':
      return t('library.all');
    case 'run':
      return t('library.taskRunning');
    case 'fail':
      return t('library.taskFailed');
    case 'done':
      return t('common.done');
  }
}

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
              ? t('library.notRetryable')
              : isRestoring(err)
                ? restoringText()
                : t('library.retryFailed'),
        });
        load();
      });
  };

  const pick = () => {
    void window.creatorhub?.pickAndUpload();
  };

  return (
    <main className="page" aria-label={t('library.imports')}>
      <header className="page__header">
        <h1 className="page__title">{t('library.imports')}</h1>
        <div className="seg" role="group" aria-label={t('library.status')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
            >
              {filterLabel(f)}
              <span className="seg__n">{counts[f]}</span>
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
          {t('library.pasteUrl')}
        </button>
        <button type="button" className="btn btn--primary" onClick={pick}>
          <Icon name="upload" />
          {t('library.upload')}
        </button>
      </header>

      <div className="imports">
        <section
          className="card imports__list"
          aria-label={t('library.tasks')}
          aria-busy={jobs === null && !failed}
        >
          {failed && (
            <div className="banner banner--bad" role="alert">
              <Icon name="offline" />
              <span className="banner__text">{t('library.importsLoadFailed')}</span>
              <button type="button" className="btn btn--small" onClick={load}>
                {t('common.retry')}
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
                <span className="state-card__title">{t('library.noTasks')}</span>
                <div className="state-card__actions">
                  <button type="button" className="btn btn--primary" onClick={pick}>
                    {t('library.upload')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setUrlOpen(true);
                    }}
                  >
                    {t('library.pasteUrl')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="imports__empty">
                <span className="muted">{t('library.noTasksInFilter')}</span>
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
      <span className="trow__icon" role="img" aria-label={methodLabel(row.method)}>
        <Icon name={METHOD_ICON[row.method]} size={14} />
      </span>
      <div className="trow__main">
        <div className="trow__line">
          <span className="trow__name">{row.name}</span>
          {row.size !== null && <span className="faint trow__size">{row.size}</span>}
        </div>
        <div className="trow__line trow__sub">
          <span>{methodLabel(row.method)}</span>
          <span aria-hidden="true">·</span>
          <span className={row.method === 'url' ? 'mono trow__origin' : 'trow__origin'}>
            {row.origin}
          </span>
        </div>
        {row.reason !== null && <div className="trow__reason">{row.reason}</div>}
        {/* QC-048: the raw service text, collapsed and with keys and tokens removed. */}
        {row.reasonDetail !== null && row.reasonDetail !== row.reason && (
          <TechnicalDetails text={row.reasonDetail} />
        )}
        {row.reused && <div className="faint">{t('library.reusedNote')}</div>}
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
        {(row.running || (row.cancelled && pct !== null)) && (
          <div
            className={pct === null ? 'bar bar--indeterminate' : 'bar'}
            role="progressbar"
            aria-label={row.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span style={progressStyle(pct)} />
          </div>
        )}
      </div>
      <div className="trow__actions">
        {row.canRetry && (
          <button type="button" className="btn btn--small" onClick={onRetry}>
            <Icon name="retry" size={14} />
            {row.cancelled ? t('library.resume') : t('common.retry')}
          </button>
        )}
        {row.canCancel && (
          <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        {row.group === 'done' && row.assetId !== null && (
          <button type="button" className="btn btn--ghost btn--small" onClick={onOpen}>
            {row.reused ? t('library.openReusedAsset') : t('common.open')}
          </button>
        )}
        {row.canDismiss && (
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label={t('library.dismissRow', { name: row.name })}
            title={t('library.dismiss')}
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
  if (reason === 'blocked_address') return t('library.urlBlocked');
  return t('library.urlNotImportable');
}

export function validateImportUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return t('library.urlRequired');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return t('library.urlSchemeOnly');
  } catch {
    return t('library.urlMalformed');
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
          setError(t('library.urlOrNameInvalid'));
        } else if (err instanceof ApiError && err.code === 'idempotency_key_reused') {
          key.current = newKey();
          setError(t('library.importKeyReused'));
        } else if (isRestoring(err)) {
          setError(restoringText());
        } else {
          setError(t('library.importCreateFailed'));
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
      title={t('library.importFromUrl')}
      onClose={onClose}
      footer={
        <>
          <span className="faint dialog__hint">{t('library.importUrlHint')}</span>
          <button type="button" className="btn btn--ghost dialog__primary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={submit}>
            {t('library.import')}
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">{t('library.url')}</span>
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
            {t('library.filename')} <span className="faint">{t('library.optional')}</span>
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
