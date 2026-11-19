import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { isRestoring, RESTORING_TEXT } from './restoring.js';
import type { HealthResponse, Mount, MountStatus } from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AiSettingsSection } from './AiSettingsSection.js';
import { AppearanceSection } from './AppearanceSection.js';
import {
  CATEGORY_HEADING,
  currentCategory,
  SettingsNav,
  type SettingsCategory,
} from './SettingsNav.js';
import { BackupSection } from './BackupSection.js';
import { versionLabel, formatStamp, type BackupSession } from './backups.js';
import { Chip } from './Chip.js';
import { Dialog } from './Dialog.js';
import { useRefreshOn } from './events.js';
import type { EventStreamStatus } from '../shared/bridge.js';
import type { ServiceSummary } from './sidebar-prefs.js';
import { formatWhen, type ChipTone } from './format.js';
import { Icon } from './Icon.js';

const MOUNT_STATUS: Readonly<Record<MountStatus, { label: string; tone: ChipTone }>> = {
  active: { label: '監控中', tone: 'ok' },
  unavailable: { label: '找不到資料夾', tone: 'bad' },
  removed: { label: '已卸載', tone: 'neutral' },
};

/** The service's `mount_rejected` messages, in the user's words. */
export function mountErrorText(err: unknown): string {
  if (isRestoring(err)) return RESTORING_TEXT;
  if (!(err instanceof ApiError)) return '無法掛載，請確認本機服務是否運行';
  const message = err.message;
  if (err.code !== 'mount_rejected') {
    return err.code === 'validation_error' ? '路徑格式不正確' : '無法掛載這個資料夾';
  }
  if (message.includes('already mounted')) return '這個資料夾已經掛載';
  if (message.includes('not a readable folder')) return '無法讀取這個資料夾';
  if (message.includes('filesystem root')) return '不能掛載整個磁碟';
  if (message.includes('home folder')) return '請選擇特定資料夾，不能掛載整個使用者目錄';
  if (message.includes('CreatorHub data folder')) return '不能掛載托管目錄，或包含托管目錄的資料夾';
  if (message.includes('overlaps')) return '和已掛載的資料夾重疊';
  return '無法掛載這個資料夾';
}

/** Active and unavailable mounts first, then removed ones. */
export function sortMounts(mounts: readonly Mount[]): Mount[] {
  const rank = (m: Mount) => (m.status === 'removed' ? 1 : 0);
  return [...mounts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * 設定 v2 (PT-20261119-001 「v2 · 設定」, QC-038): a category list on the
 * left and one column that scrolls on its own — 外觀, 本機服務, 備份與還原
 * (QC-031), AI 服務 (QC-025), 資料夾, 關於. Starting and stopping the
 * service and switching start-at-login or sleep prevention have no API
 * (launchd and the service decide), so those rows explain instead of
 * offering switches that would do nothing. Tailscale and pairing are phase two.
 */
export function SettingsPage({
  client,
  home,
  userHome = null,
  baseUrl,
  focusSection,
  backups = null,
  dataEpoch = 0,
  health,
  eventStatus,
  service,
  checkHealth,
}: {
  /**
   * The app's one service check (QC-041 sidebar dot): this page shows the
   * same health, live-update status and summary, never a second copy.
   */
  health: HealthResponse | 'down' | null;
  eventStatus: EventStreamStatus | null;
  service: ServiceSummary;
  checkHealth: () => void;
  client: CreatorHubClient;
  home: string | null;
  userHome?: string | null;
  baseUrl: string;
  /** The app's backup session; null hides the section (e.g. in tests without one). */
  backups?: BackupSession | null;
  /** Changes when a restore replaced the database: refetch everything shown here. */
  dataEpoch?: number;
  /** Scroll to and focus a section, e.g. from 「前往設定」. */
  focusSection?: 'ai';
}) {
  const aiHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusSection !== 'ai') return;
    aiHeading.current?.scrollIntoView({ block: 'start' });
    aiHeading.current?.focus();
    setCurrentCat('ai');
  }, [focusSection]);
  const [mounts, setMounts] = useState<Mount[] | null>(null);
  const [mountsFailed, setMountsFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [removing, setRemoving] = useState<Mount | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [currentCat, setCurrentCat] = useState<SettingsCategory>('appearance');
  const goTo = useCallback((cat: SettingsCategory) => {
    const heading = document.getElementById(CATEGORY_HEADING[cat]);
    if (heading === null) return;
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
    setCurrentCat(cat);
  }, []);
  // The category whose heading was passed last is the one being read.
  const trackScroll = useCallback(() => {
    const body = bodyRef.current;
    if (body === null) return;
    setCurrentCat(currentCategory(body));
  }, []);

  const loadMounts = useCallback(() => {
    client.mounts
      .list()
      .then((res) => {
        setMountsFailed(false);
        setMounts(sortMounts(res.items));
      })
      .catch(() => {
        setMountsFailed(true);
      });
  }, [client]);

  // After a restore replaced the database, ask the service again (one shared check).
  useEffect(() => {
    if (dataEpoch > 0) checkHealth();
  }, [checkHealth, dataEpoch]);
  useEffect(loadMounts, [loadMounts, dataEpoch]);
  useEffect(() => {
    void backups?.load();
  }, [backups]);
  // Scans and missing/restored files arrive as work events.
  useRefreshOn(['work'], loadMounts, 400);

  const mountPath = (path: string) => {
    setAdding(true);
    setAddError(null);
    client.mounts
      .create({ path })
      .then(() => {
        setAdding(false);
        loadMounts();
      })
      .catch((err: unknown) => {
        setAdding(false);
        setAddError(mountErrorText(err));
      });
  };

  const addMount = () => {
    void window.creatorhub?.pickFolder().then((picked) => {
      if (picked !== null) mountPath(picked);
    });
  };

  const rescan = (m: Mount) => {
    setBusyId(m.id);
    setRowError(null);
    client.mounts
      .rescan(m.id)
      .then(() => {
        setBusyId(null);
        loadMounts();
      })
      .catch((err: unknown) => {
        setBusyId(null);
        setRowError({ id: m.id, message: isRestoring(err) ? RESTORING_TEXT : '重新掃描失敗' });
      });
  };

  const address = baseUrl.replace(/^https?:\/\//, '');
  const up = health !== null && health !== 'down';
  const live = active(mounts);

  return (
    <main className="page" aria-label="設定">
      <header className="page__header">
        <h1 className="page__title">設定</h1>
      </header>
      <div className="settings-layout">
        <SettingsNav
          current={currentCat}
          tone={health === null ? null : service.tone}
          onPick={goTo}
        />
        <div className="set-body" ref={bodyRef} onScroll={trackScroll}>
          <div className="settings">
            <AppearanceSection />

            <section className="settings__sec" aria-labelledby="set-service">
              <h2 id="set-service" className="settings__h" tabIndex={-1}>
                本機服務
              </h2>
              <p className="settings__sub">由系統常駐管理（launchd），關閉視窗不會停止服務。</p>
              <div className="card">
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">狀態</span>
                    <span className="ln__v mono">{address}</span>
                  </div>
                  <span role="status">
                    {health === null ? (
                      <Chip>檢查中</Chip>
                    ) : up ? (
                      <Chip tone="ok">執行中</Chip>
                    ) : (
                      <Chip tone="bad">未回應</Chip>
                    )}
                  </span>
                  <button type="button" className="btn btn--ghost btn--small" onClick={checkHealth}>
                    <Icon name="refresh" size={14} />
                    重新檢查
                  </button>
                </div>
                <div className="ln">
                  <span className="ln__k ln__main">即時更新</span>
                  <span role="status">
                    {eventStatus === 'open' ? (
                      <Chip tone="ok">已連線</Chip>
                    ) : eventStatus === 'reconnecting' ? (
                      <Chip tone="warn">重新連線中</Chip>
                    ) : (
                      <Chip>連線中</Chip>
                    )}
                  </span>
                </div>
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">開機自動啟動</span>
                    <span className="ln__v faint">安裝時已設定由 launchd 在登入後啟動</span>
                  </div>
                </div>
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">防止睡眠</span>
                    <span className="ln__v faint settings__wrap">
                      匯入、上傳與 AI 任務進行時，服務會自動防止閒置睡眠；任務結束後恢復
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {backups !== null && <BackupSection session={backups} userHome={userHome} />}

            <AiSettingsSection key={dataEpoch} client={client} headingRef={aiHeading} />

            <section className="settings__sec" aria-labelledby="set-folders">
              <h2 id="set-folders" className="settings__h" tabIndex={-1}>
                資料夾
              </h2>
              <div className="card">
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">托管目錄</span>
                    <span className="ln__v mono">{home ?? '—'}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    disabled={home === null}
                    onClick={() => {
                      void window.creatorhub?.reveal({ kind: 'home' });
                    }}
                  >
                    在 Finder 顯示
                  </button>
                </div>

                {mountsFailed ? (
                  <div className="ln">
                    <span className="ln__main muted">無法載入外部掛載</span>
                    <button type="button" className="btn btn--small" onClick={loadMounts}>
                      重試
                    </button>
                  </div>
                ) : mounts === null ? (
                  <div className="ln" aria-busy="true">
                    <span className="skel skel--line" style={{ width: '60%' }} />
                  </div>
                ) : (
                  mounts.map((m) => (
                    <div key={m.id} className={m.status === 'removed' ? 'ln ln--dim' : 'ln'}>
                      <Icon name="folder" />
                      <div className="ln__main">
                        <span className="ln__k">{m.name}</span>
                        <span className="ln__v mono" title={m.root_path}>
                          {m.root_path}
                        </span>
                        <span className="ln__v faint">
                          {m.work_count} 篇作品
                          {m.last_scan_at !== null && ` · ${formatWhen(m.last_scan_at)} 掃描`}
                        </span>
                        {m.status === 'unavailable' && (
                          <span className="ln__err" role="status">
                            資料夾目前無法讀取（可能被移動、改名或外接磁碟未連接）。作品保留在庫中，資料夾回來後重新掃描即可恢復。
                          </span>
                        )}
                        {rowError?.id === m.id && (
                          <span className="ln__err" role="alert">
                            {rowError.message}
                          </span>
                        )}
                      </div>
                      <Chip tone={MOUNT_STATUS[m.status].tone}>{MOUNT_STATUS[m.status].label}</Chip>
                      {m.status === 'removed' ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          disabled={adding}
                          onClick={() => {
                            mountPath(m.root_path);
                          }}
                        >
                          重新掛載
                        </button>
                      ) : (
                        <div className="ln__actions">
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            disabled={busyId === m.id}
                            onClick={() => {
                              rescan(m);
                            }}
                          >
                            <Icon name="refresh" size={14} />
                            {busyId === m.id ? '已排入' : '重新掃描'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            disabled={m.status === 'unavailable'}
                            onClick={() => {
                              void window.creatorhub?.reveal({ kind: 'mount', id: m.id });
                            }}
                          >
                            在 Finder 顯示
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            onClick={() => {
                              setRemoving(m);
                            }}
                          >
                            卸載
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}

                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">外部掛載</span>
                    <span className="ln__v faint">
                      {live === 0
                        ? '把現有的寫作資料夾加進作品庫；原檔留在原處，不會被移動'
                        : `${live} 個資料夾 · 原檔不移動`}
                    </span>
                    {addError !== null && (
                      <span className="ln__err" role="alert">
                        {addError}
                      </span>
                    )}
                  </div>
                  <button type="button" className="btn" disabled={adding} onClick={addMount}>
                    <Icon name="plus" size={14} />
                    {adding ? '掛載中…' : '掛載資料夾'}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings__sec" aria-labelledby="set-about">
              <h2 id="set-about" className="settings__h" tabIndex={-1}>
                關於
              </h2>
              <div className="card">
                <div className="ln">
                  <span className="ln__k ln__main">App</span>
                  <span className="ln__v mono">qiu-creator</span>
                </div>
                <div className="ln">
                  <span className="ln__k ln__main">服務版本</span>
                  <span
                    className="ln__v mono"
                    title={up ? (health.commit ?? undefined) : undefined}
                  >
                    {up ? versionLabel(health, (iso) => formatStamp(iso)) : '—'}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {removing !== null && (
        <Dialog
          title={`卸載「${removing.name}」？`}
          onClose={() => {
            setRemoving(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost dialog__primary"
                data-autofocus
                onClick={() => {
                  setRemoving(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  client.mounts
                    .remove(target.id)
                    .then(loadMounts)
                    .catch((err: unknown) => {
                      setRowError({
                        id: target.id,
                        message: isRestoring(err) ? RESTORING_TEXT : '卸載失敗',
                      });
                    });
                }}
              >
                卸載
              </button>
            </>
          }
        >
          <div className="form">
            <p>停止監控這個資料夾。磁碟上的檔案不會被移動或刪除。</p>
            <p className="muted">
              它的 {removing.work_count}{' '}
              篇作品仍留在作品庫，標示為「已卸載」；之後重新掛載同一個資料夾，作品與版本記錄會接回來。
            </p>
          </div>
        </Dialog>
      )}
    </main>
  );
}

function active(mounts: readonly Mount[] | null): number {
  return mounts === null ? 0 : mounts.filter((m) => m.status !== 'removed').length;
}
