import type { Backup } from '@qiu-creator/contracts';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  backupSummary,
  formatStamp,
  KIND_LABEL,
  nextDailyLabel,
  type BackupSession,
  type BackupState,
  type RestorePhase,
} from './backups.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { tildePath } from './format.js';
import { t } from './i18n.js';
import { backupReasonText } from './server-text.js';
import { TechnicalDetails } from './TechnicalDetails.js';
import { Icon } from './Icon.js';

/** Rows shown before 「全部 N 份」 (PT-20261119-001 「v2 · 設定」: 3). */
export const VISIBLE_ROWS = 3;

function useBackups(session: BackupSession): BackupState {
  return useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    session.getSnapshot,
  );
}

/**
 * 設定 → 備份 (prototype board MacSettings 「備份」「從備份還原」, QC-031).
 * Only the SQLite database is backed up; `.md` sources and media stay on
 * disk (Time Machine). Restoring asks twice and always backs up first.
 */
export function BackupSection({
  session,
  userHome,
}: {
  session: BackupSession;
  userHome: string | null;
}) {
  const s = useBackups(session);
  const [confirming, setConfirming] = useState<Backup | null>(null);
  const [showAll, setShowAll] = useState(false);
  const list = s.list;
  const busy = s.restore.phase === 'sending' || s.restore.phase === 'reloading';
  const latest = list?.backups[0] ?? null;
  const rows = list === null ? [] : showAll ? list.backups : list.backups.slice(0, VISIBLE_ROWS);

  return (
    <section className="set-sec" aria-labelledby="set-backup">
      <header className="set-h">
        <h1 id="set-backup" className="set-h__title" tabIndex={-1}>
          {t('serviceSettings.backupTitle')}
        </h1>
        <div className="set-h__r">
          {s.creating ? (
            <span className="chip chip--accent" role="status">
              <span className="spin" aria-hidden="true" />
              {t('serviceSettings.backupInProgress')}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy || s.externalRestore}
              onClick={() => {
                void session.create();
              }}
            >
              {t('serviceSettings.backupNow')}
            </button>
          )}
        </div>
      </header>
      <p className="set-fn">{t('serviceSettings.backupSub')}</p>

      <RestoreNotice
        restore={s.restore}
        external={s.externalRestore}
        onRecheck={() => {
          session.recheck();
        }}
        onDismiss={() => {
          session.dismiss();
        }}
      />

      <div className="card">
        <div className="ln">
          <div className="ln__main">
            <span className="ln__k">{t('serviceSettings.backupLatest')}</span>
            <span className="ln__v">
              {list === null
                ? '—'
                : latest === null
                  ? t('serviceSettings.backupNone')
                  : `${formatStamp(latest.created_at)} · ${backupSummary(latest)}`}
            </span>
            {s.created !== null && !s.creating && (
              <span className="ln__v backup__ok" role="status">
                {t(
                  s.created.integrity === 'failed'
                    ? 'serviceSettings.backupDoneBroken'
                    : 'serviceSettings.backupDone',
                  { when: formatStamp(s.created.created_at) },
                )}
              </span>
            )}
            {s.createError !== null && (
              <span className="ln__err" role="alert">
                {s.createError.message}
                {s.createError.reason != null && (
                  <span className="err-reason">{s.createError.reason}</span>
                )}
                <TechnicalDetails text={s.createError.detail} />
              </span>
            )}
          </div>
        </div>

        <div className="ln">
          <div className="ln__main">
            <span className="ln__k">{t('serviceSettings.backupDaily')}</span>
            <span className="ln__v">
              {list === null
                ? '—'
                : t('serviceSettings.backupDailyTimes', {
                    last:
                      list.last_daily_at === null
                        ? t('serviceSettings.backupDailyNever')
                        : formatStamp(list.last_daily_at),
                    next: nextDailyLabel(list.next_daily_at),
                  })}
            </span>
            {list !== null && (
              <span className="ln__v faint backup__wrap">
                {t('serviceSettings.backupRetention', { count: list.retention_per_kind })}
              </span>
            )}
            {list?.last_error != null && (
              <span className="ln__err" role="alert">
                {t('serviceSettings.backupDailyFailedLabel')}
                <span>{backupReasonText(list.last_error_reason)}</span>
                <TechnicalDetails text={list.last_error} />
              </span>
            )}
          </div>
          {list?.last_error != null ? (
            <Chip tone="bad">{t('serviceSettings.chipFailed')}</Chip>
          ) : (
            list !== null && <Chip tone="ok">{t('serviceSettings.chipOn')}</Chip>
          )}
        </div>

        <div className="ln">
          <div className="ln__main">
            <span className="ln__k">{t('serviceSettings.backupLocation')}</span>
            <span className="ln__v mono" title={list?.directory}>
              {list === null ? '—' : tildePath(list.directory, userHome)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={list === null}
            onClick={() => {
              void window.creatorhub?.reveal({ kind: 'backups' });
            }}
          >
            {t('common.revealInFinder')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="ln ln--head">
          <span className="ln__k ln__main">{t('serviceSettings.restoreFromBackup')}</span>
          {list !== null && list.backups.length > 0 && (
            <span className="ln__v faint">
              {t('serviceSettings.backupCount', { count: list.backups.length })}
            </span>
          )}
        </div>
        {s.loadError !== null && list === null ? (
          <div className="ln">
            <span className="ln__main ln__err" role="alert">
              {t('serviceSettings.backupListFailed')}
            </span>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void session.load();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        ) : list === null ? (
          <div className="ln" aria-busy="true">
            <span className="skel skel--line" style={{ width: '60%' }} />
          </div>
        ) : list.backups.length === 0 ? (
          <div className="ln backup__empty">
            <Icon name="history" />
            <span className="ln__main">
              <span>{t('serviceSettings.backupEmptyTitle')}</span>
              <span className="ln__v faint">
                {t('serviceSettings.backupEmptyHint', {
                  next: nextDailyLabel(list.next_daily_at),
                })}
              </span>
            </span>
          </div>
        ) : (
          <ul className="backup__list" aria-label={t('serviceSettings.backupListLabel')}>
            {rows.map((b) => (
              <li key={b.id} className="ln backup__row">
                <div className="ln__main">
                  <span className="ln__k">{formatStamp(b.created_at)}</span>
                  <span className="ln__v">
                    {backupSummary(b)}
                    {b.schema_version !== null &&
                      ` · ${t('serviceSettings.backupSchema', { version: b.schema_version })}`}
                  </span>
                </div>
                <Chip
                  tone={
                    b.kind === 'pre_restore' ? 'warn' : b.kind === 'manual' ? 'accent' : 'neutral'
                  }
                >
                  {KIND_LABEL[b.kind]}
                </Chip>
                {b.integrity === 'ok' ? (
                  <Chip tone="ok">
                    <Icon name="check" size={12} />
                    {t('serviceSettings.backupIntact')}
                  </Chip>
                ) : (
                  <Chip tone="bad">{t('serviceSettings.backupBroken')}</Chip>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={b.integrity !== 'ok' || busy || s.externalRestore}
                  title={
                    b.integrity === 'ok' ? undefined : t('serviceSettings.restoreDisabledHint')
                  }
                  aria-label={t('serviceSettings.restoreTo', {
                    when: formatStamp(b.created_at),
                  })}
                  onClick={() => {
                    setConfirming(b);
                  }}
                >
                  {t('serviceSettings.restore')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {list !== null && list.backups.length > VISIBLE_ROWS && (
          <div className="ln ln--more">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                setShowAll(!showAll);
              }}
            >
              <Icon name={showAll ? 'chevronUp' : 'chevronDown'} size={14} />
              {showAll
                ? t('serviceSettings.showLess')
                : t('serviceSettings.showAllBackups', { count: list.backups.length })}
            </button>
          </div>
        )}
      </div>

      {confirming !== null && (
        <Dialog
          title={t('serviceSettings.restoreConfirmTitle', {
            when: formatStamp(confirming.created_at),
          })}
          onClose={() => {
            setConfirming(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  const target = confirming;
                  setConfirming(null);
                  void session.restore(target);
                }}
              >
                {t('serviceSettings.restoreConfirmAction')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>{t('serviceSettings.restoreConfirmBody', { summary: backupSummary(confirming) })}</p>
            <p>
              <strong>{t('serviceSettings.restoreSafetyStrong')}</strong>
              {t('serviceSettings.restoreSafetyRest')}
            </p>
            <p className="muted">{t('serviceSettings.restoreConfirmNote')}</p>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function RestoreNotice({
  restore,
  external,
  onRecheck,
  onDismiss,
}: {
  restore: RestorePhase;
  external: boolean;
  onRecheck: () => void;
  onDismiss: () => void;
}) {
  if (restore.phase === 'idle') {
    if (!external) return null;
    return (
      <div className="card backup__notice" role="status">
        <div className="bar bar--indeterminate" aria-hidden="true">
          <span />
        </div>
        <span className="ln__k">{t('serviceSettings.externalRestoreTitle')}</span>
        <span className="ln__v faint">{t('serviceSettings.externalRestoreHint')}</span>
      </div>
    );
  }
  const when = formatStamp(restore.backup.created_at);
  switch (restore.phase) {
    case 'sending':
    case 'reloading':
      return (
        <div className="card backup__notice" role="status" aria-busy="true">
          <div className="bar bar--indeterminate" aria-hidden="true">
            <span />
          </div>
          <span className="ln__k">{t('serviceSettings.restoringTitle', { when })}</span>
          <span className="ln__v faint">
            {restore.phase === 'sending'
              ? t('serviceSettings.restoringSending')
              : t('serviceSettings.restoringReloading')}
          </span>
        </div>
      );
    case 'done':
      return (
        <div className="card backup__notice backup__notice--ok" role="status">
          <span className="ln__k">
            <Icon name="check" size={14} /> {t('serviceSettings.restoredTitle', { when })}
          </span>
          <span className="ln__v">
            {t('serviceSettings.restoredSafety', {
              when: formatStamp(restore.safety.created_at),
            })}
          </span>
          <div className="backup__notice-actions">
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              {t('serviceSettings.gotIt')}
            </button>
          </div>
        </div>
      );
    case 'restart_required':
      return (
        <div className="card backup__notice backup__notice--warn" role="alert">
          <span className="ln__k">{t('serviceSettings.restartRequiredTitle')}</span>
          <span className="ln__v">
            {t('serviceSettings.restartRequiredBody', {
              when,
              safety: formatStamp(restore.safety.created_at),
            })}
          </span>
          <div className="backup__notice-actions">
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              {t('serviceSettings.gotIt')}
            </button>
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="card backup__notice backup__notice--bad" role="alert">
          <span className="ln__k">
            <Icon name="alert" size={14} /> {t('serviceSettings.restoreFailedTitle', { when })}
          </span>
          <span className="ln__v">{restore.message}</span>
          {restore.safety !== null && (
            <span className="ln__v faint">
              {t('serviceSettings.restoreFailedSafety', {
                when: formatStamp(restore.safety.created_at),
              })}
            </span>
          )}
          {restore.reason != null && <span className="ln__v">{restore.reason}</span>}
          <TechnicalDetails text={restore.detail} />
          <div className="backup__notice-actions">
            {restore.stage === 'reload' && (
              <button type="button" className="btn btn--small btn--primary" onClick={onRecheck}>
                <Icon name="refresh" size={14} />
                {t('serviceSettings.waitAgain')}
              </button>
            )}
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              {t('common.close')}
            </button>
          </div>
        </div>
      );
  }
}
