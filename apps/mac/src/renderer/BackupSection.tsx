import type { Backup } from '@qiu-creator/contracts';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  backupSummary,
  formatStamp,
  KIND_LABEL,
  type BackupSession,
  type BackupState,
  type RestorePhase,
} from './backups.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { tildePath } from './format.js';
import { Icon } from './Icon.js';

/** Rows shown before 「顯示全部」. */
const VISIBLE_ROWS = 5;

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
    <section className="settings__sec" aria-labelledby="set-backup">
      <h2 id="set-backup" className="settings__h">
        備份
      </h2>

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
            <span className="ln__k">最近備份</span>
            <span className="ln__v">
              {list === null
                ? '—'
                : latest === null
                  ? '還沒有備份'
                  : `${formatStamp(latest.created_at)} · ${backupSummary(latest)}`}
            </span>
            {s.created !== null && !s.creating && (
              <span className="ln__v backup__ok" role="status">
                已備份 · {formatStamp(s.created.created_at)}
                {s.created.integrity === 'failed' && '（完整性檢查未通過）'}
              </span>
            )}
            {s.createError !== null && (
              <span className="ln__err" role="alert">
                {s.createError.message}
                {s.createError.detail !== null && (
                  <span className="mono backup__detail">{s.createError.detail}</span>
                )}
              </span>
            )}
          </div>
          {s.creating ? (
            <span className="chip chip--accent" role="status">
              <span className="spin" aria-hidden="true" />
              備份中
            </span>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy || s.externalRestore}
              onClick={() => {
                void session.create();
              }}
            >
              立即備份
            </button>
          )}
        </div>

        <div className="ln">
          <div className="ln__main">
            <span className="ln__k">每日自動備份</span>
            <span className="ln__v">
              {list === null
                ? '—'
                : `上次 ${list.last_daily_at === null ? '尚未執行' : formatStamp(list.last_daily_at)} · 下次 ${formatStamp(list.next_daily_at)}`}
            </span>
            {list !== null && (
              <span className="ln__v faint">
                每種保留最新 {list.retention_per_kind} 份 · 只備份資料庫；原稿與媒體請用 Time
                Machine
              </span>
            )}
            {list?.last_error != null && (
              <span className="ln__err" role="alert">
                上次自動備份失敗：<span className="mono backup__detail">{list.last_error}</span>
              </span>
            )}
          </div>
          {list?.last_error != null ? (
            <Chip tone="bad">失敗</Chip>
          ) : (
            list !== null && <Chip tone="ok">開啟</Chip>
          )}
        </div>

        <div className="ln">
          <div className="ln__main">
            <span className="ln__k">備份位置</span>
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
            在 Finder 顯示
          </button>
        </div>
      </div>

      <div className="card">
        <div className="ln ln--head">
          <span className="ln__k ln__main">從備份還原</span>
          {list !== null && list.backups.length > 0 && (
            <span className="ln__v faint">{list.backups.length} 份</span>
          )}
        </div>
        {s.loadError !== null && list === null ? (
          <div className="ln">
            <span className="ln__main ln__err" role="alert">
              無法載入備份清單
            </span>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void session.load();
              }}
            >
              重試
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
              <span>還沒有可以還原的備份</span>
              <span className="ln__v faint">
                第一份每日備份會在 {formatStamp(list.next_daily_at)}{' '}
                之後自動建立，也可以按「立即備份」。
              </span>
            </span>
          </div>
        ) : (
          <ul className="backup__list" aria-label="最近備份">
            {rows.map((b) => (
              <li key={b.id} className="ln backup__row">
                <div className="ln__main">
                  <span className="ln__k">{formatStamp(b.created_at)}</span>
                  <span className="ln__v">
                    {backupSummary(b)}
                    {b.schema_version !== null && ` · 結構 ${b.schema_version}`}
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
                    完整
                  </Chip>
                ) : (
                  <Chip tone="bad">檢查未通過</Chip>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={b.integrity !== 'ok' || busy || s.externalRestore}
                  title={b.integrity === 'ok' ? undefined : '未通過完整性檢查的備份不能還原'}
                  aria-label={`還原到 ${formatStamp(b.created_at)} 的備份`}
                  onClick={() => {
                    setConfirming(b);
                  }}
                >
                  還原
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
              {showAll ? '只顯示最近 5 份' : `顯示全部 ${String(list.backups.length)} 份`}
            </button>
          </div>
        )}
      </div>

      {confirming !== null && (
        <Dialog
          title={`還原到 ${formatStamp(confirming.created_at)} 的備份？`}
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
                取消
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
                備份目前狀態並還原
              </button>
            </>
          }
        >
          <div className="form">
            <p>
              作品索引、版本記錄、平台版本、匯入與 AI 任務、設定都會回到這份備份的時間（
              {backupSummary(confirming)}）。之後的變更會被取代。
            </p>
            <p>
              <strong>還原前會先自動備份目前的狀態</strong>
              （種類「還原前」），需要時可以從清單再還原回來。
            </p>
            <p className="muted">
              磁碟上的 .md 原稿與媒體檔案不會改變。還原時本機服務會重新載入幾秒，期間其他頁面與
              Agent 的請求會暫時失敗。
            </p>
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
        <span className="ln__k">本機服務正在還原資料庫</span>
        <span className="ln__v faint">由其他視窗或工具發起；完成後會重新載入資料。</span>
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
          <span className="ln__k">還原中 · {when}</span>
          <span className="ln__v faint">
            {restore.phase === 'sending'
              ? '正在備份目前的狀態，然後換上這份備份…'
              : '本機服務正在重新載入。完成後所有頁面會重新讀取資料，不要關閉 App。'}
          </span>
        </div>
      );
    case 'done':
      return (
        <div className="card backup__notice backup__notice--ok" role="status">
          <span className="ln__k">
            <Icon name="check" size={14} /> 已還原到 {when} 的備份
          </span>
          <span className="ln__v">
            還原前的狀態已備份為「{formatStamp(restore.safety.created_at)} ·
            還原前」，需要時可以再還原回來。
          </span>
          <div className="backup__notice-actions">
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              知道了
            </button>
          </div>
        </div>
      );
    case 'restart_required':
      return (
        <div className="card backup__notice backup__notice--warn" role="alert">
          <span className="ln__k">需要重新啟動本機服務</span>
          <span className="ln__v">
            {when}{' '}
            的備份已排定，會在本機服務下次啟動時套用；在那之前資料不會改變。目前的狀態已備份為「
            {formatStamp(restore.safety.created_at)} · 還原前」。
          </span>
          <div className="backup__notice-actions">
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              知道了
            </button>
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="card backup__notice backup__notice--bad" role="alert">
          <span className="ln__k">
            <Icon name="alert" size={14} /> 還原失敗 · {when}
          </span>
          <span className="ln__v">{restore.message}</span>
          {restore.safety !== null && (
            <span className="ln__v faint">
              還原前的狀態已備份為「{formatStamp(restore.safety.created_at)} · 還原前」。
            </span>
          )}
          {restore.detail !== null && <span className="mono backup__detail">{restore.detail}</span>}
          <div className="backup__notice-actions">
            {restore.stage === 'reload' && (
              <button type="button" className="btn btn--small btn--primary" onClick={onRecheck}>
                <Icon name="refresh" size={14} />
                再等一次
              </button>
            )}
            <button type="button" className="btn btn--small" onClick={onDismiss}>
              關閉
            </button>
          </div>
        </div>
      );
  }
}
