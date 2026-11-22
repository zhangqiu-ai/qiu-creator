import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { isRestoring, restoringText } from './restoring.js';
import type { HealthResponse, Mount, MountStatus } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AiServicesPage, aiNavTone } from './AiServicesPage.js';
import { AiSettingsStore } from './ai-settings.js';
import { AppearanceSection } from './AppearanceSection.js';
import {
  CATEGORY_HEADING,
  readLastCategory,
  SettingsNav,
  writeLastCategory,
  type SettingsCategory,
} from './SettingsNav.js';
import { BackupSection } from './BackupSection.js';
import { versionLabel, formatStamp, type BackupSession } from './backups.js';
import { Dialog } from './Dialog.js';
import { useRefreshOn } from './events.js';
import type { EventStreamStatus } from '../shared/bridge.js';
import type { ServiceSummary } from './sidebar-prefs.js';
import { formatWhen, type ChipTone } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';

const MOUNT_STATUS: Readonly<Record<MountStatus, { label: string; tone: ChipTone }>> = {
  active: {
    get label() {
      return t('serviceSettings.mountActive');
    },
    tone: 'ok',
  },
  unavailable: {
    get label() {
      return t('serviceSettings.mountMissing');
    },
    tone: 'bad',
  },
  removed: {
    get label() {
      return t('serviceSettings.mountRemoved');
    },
    tone: 'neutral',
  },
};

const MOUNT_TONE: Readonly<Record<MountStatus, 'ok' | 'bad' | 'none'>> = {
  active: 'ok',
  unavailable: 'bad',
  removed: 'none',
};

/** The app icon (the same mark as the Dock icon) for 關於. */
function AppMark() {
  return (
    <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="15"
        fill="#1C1B19"
        stroke="rgba(255,255,255,.14)"
        strokeWidth="2"
      />
      <circle cx="29" cy="29" r="11.5" fill="none" stroke="#F6F5F1" strokeWidth="7" />
      <path d="M40.5 21v21" stroke="#F6F5F1" strokeWidth="7" strokeLinecap="round" />
      <circle cx="40.5" cy="51" r="5" fill="#8EA2FF" />
    </svg>
  );
}

/** The service's `mount_rejected` messages, in the user's words. */
export function mountErrorText(err: unknown): string {
  if (isRestoring(err)) return restoringText();
  if (!(err instanceof ApiError)) return t('serviceSettings.mountErrServiceDown');
  const message = err.message;
  if (err.code !== 'mount_rejected') {
    return err.code === 'validation_error'
      ? t('serviceSettings.mountErrBadPath')
      : t('errors.mount_rejected');
  }
  if (message.includes('already mounted')) return t('serviceSettings.mountErrAlready');
  if (message.includes('not a readable folder')) return t('serviceSettings.mountErrUnreadable');
  if (message.includes('filesystem root')) return t('serviceSettings.mountErrRoot');
  if (message.includes('home folder')) return t('serviceSettings.mountErrHome');
  if (message.includes('CreatorHub data folder')) return t('serviceSettings.mountErrManaged');
  if (message.includes('overlaps')) return t('serviceSettings.mountErrOverlap');
  return t('errors.mount_rejected');
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
  // One page per category (QC-057); 設定 reopens on the one shown last.
  const [cat, setCat] = useState<SettingsCategory>(() =>
    focusSection === 'ai' ? 'ai' : readLastCategory(),
  );
  const focusOnShow = useRef(focusSection === 'ai');
  useEffect(() => {
    if (focusSection !== 'ai') return;
    focusOnShow.current = true;
    setCat('ai');
  }, [focusSection]);
  const goTo = useCallback((next: SettingsCategory) => {
    focusOnShow.current = true;
    setCat(next);
    writeLastCategory(next);
  }, []);
  // The new page's title takes focus, so a screen reader hears where it is.
  useEffect(() => {
    if (!focusOnShow.current) return;
    focusOnShow.current = false;
    document.getElementById(CATEGORY_HEADING[cat])?.focus();
  }, [cat]);

  // AI 服務 state lives here, so the category dot shows even on other pages.
  const aiStore = useMemo(() => new AiSettingsStore(client), [client]);
  const ai = useSyncExternalStore(
    useCallback((cb) => aiStore.subscribe(cb), [aiStore]),
    () => aiStore.snapshot,
  );
  useEffect(() => {
    void aiStore.load();
  }, [aiStore, dataEpoch]);

  const [mounts, setMounts] = useState<Mount[] | null>(null);
  const [mountsFailed, setMountsFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [removing, setRemoving] = useState<Mount | null>(null);
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
        setRowError({
          id: m.id,
          message: isRestoring(err) ? restoringText() : t('serviceSettings.mountRescanFailed'),
        });
      });
  };

  // When the shown status was last asked for (the service check is the app's one source).
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    if (health !== null) setCheckedAt(new Date().toISOString());
  }, [health]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const address = baseUrl.replace(/^https?:\/\//, '');
  const up = health !== null && health !== 'down';
  const live = active(mounts);

  return (
    <main className="page" aria-label={t('serviceSettings.title')}>
      <header className="page__header">
        <h1 className="page__title">{t('serviceSettings.title')}</h1>
      </header>
      <div className="settings-layout">
        <SettingsNav
          current={cat}
          tone={health === null ? null : service.tone}
          aiTone={aiNavTone(ai)}
          onPick={goTo}
        />
        <div className="set-body">
          <div key={cat} className={cat === 'ai' ? 'set-page set-page--wide' : 'set-page'}>
            {cat === 'appearance' && <AppearanceSection />}

            {cat === 'service' && (
              <section className="set-sec" aria-labelledby="set-service">
                <header className="set-h">
                  <h1 id="set-service" className="set-h__title" tabIndex={-1}>
                    {t('serviceSettings.serviceTitle')}
                  </h1>
                  <div className="set-h__r">
                    <button type="button" className="btn btn--small" onClick={checkHealth}>
                      <Icon name="refresh" size={14} />
                      {t('common.recheck')}
                    </button>
                  </div>
                </header>
                <section className="set-g" aria-labelledby="set-g-svc">
                  <h2 className="set-g__t" id="set-g-svc">
                    {t('settingsPages.gService')}
                  </h2>
                  <div className="set-list">
                    <div className="set-row">
                      <div className="set-row__k">
                        <b>{t('serviceSettings.statusLabel')}</b>
                        {checkedAt !== null && (
                          <span>
                            {t('settingsPages.checkedAt', { when: formatWhen(checkedAt) })}
                          </span>
                        )}
                      </div>
                      <span
                        role="status"
                        className={`set-st set-st--${health === null ? 'run' : up ? 'ok' : 'bad'}`}
                      >
                        <i aria-hidden="true" />
                        {health === null
                          ? t('serviceSettings.statusChecking')
                          : up
                            ? t('serviceSettings.statusRunning')
                            : t('serviceSettings.statusDown')}
                      </span>
                    </div>
                    <div className="set-row">
                      <div className="set-row__k">
                        <b>{t('settingsPages.address')}</b>
                      </div>
                      <span className="set-row__v mono">{address}</span>
                    </div>
                    <div className="set-row">
                      <div className="set-row__k">
                        <b>{t('serviceSettings.liveUpdates')}</b>
                      </div>
                      <span
                        role="status"
                        className={`set-st set-st--${
                          eventStatus === 'open'
                            ? 'ok'
                            : eventStatus === 'reconnecting'
                              ? 'warn'
                              : 'run'
                        }`}
                      >
                        <i aria-hidden="true" />
                        {eventStatus === 'open'
                          ? t('serviceSettings.liveConnected')
                          : eventStatus === 'reconnecting'
                            ? t('serviceSettings.liveReconnecting')
                            : t('serviceSettings.liveConnecting')}
                      </span>
                    </div>
                  </div>
                  <p className="set-fn">{t('serviceSettings.serviceSub')}</p>
                </section>
                <section className="set-g" aria-labelledby="set-g-sys">
                  <h2 className="set-g__t" id="set-g-sys">
                    {t('settingsPages.gSystem')}
                  </h2>
                  <div className="set-list">
                    <div className="set-row" title={t('serviceSettings.startAtLoginHint')}>
                      <div className="set-row__k">
                        <b>{t('serviceSettings.startAtLogin')}</b>
                      </div>
                      <span className="set-row__v">{t('settingsPages.launchd')}</span>
                    </div>
                    <div className="set-row" title={t('serviceSettings.preventSleepHint')}>
                      <div className="set-row__k">
                        <b>{t('serviceSettings.preventSleep')}</b>
                      </div>
                      <span className="set-row__v">{t('settingsPages.sleepAuto')}</span>
                    </div>
                  </div>
                </section>
              </section>
            )}

            {cat === 'backup' && backups !== null && (
              <BackupSection session={backups} userHome={userHome} />
            )}

            {cat === 'ai' && <AiServicesPage store={aiStore} s={ai} headingRef={aiHeading} />}

            {cat === 'folders' && (
              <section className="set-sec" aria-labelledby="set-folders">
                <header className="set-h">
                  <h1 id="set-folders" className="set-h__title" tabIndex={-1}>
                    {t('serviceSettings.foldersTitle')}
                  </h1>
                  <div className="set-h__r">
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      disabled={adding}
                      onClick={addMount}
                    >
                      <Icon name="plus" size={14} />
                      {adding ? t('serviceSettings.mountAdding') : t('serviceSettings.mountAdd')}
                    </button>
                  </div>
                </header>
                {addError !== null && (
                  <p className="set-err" role="alert">
                    {addError}
                  </p>
                )}
                <section className="set-g" aria-labelledby="set-g-managed">
                  <h2 className="set-g__t" id="set-g-managed">
                    {t('settingsPages.gManaged')}
                  </h2>
                  <div className="set-list">
                    <div className="set-row">
                      <span className="set-row__ic" aria-hidden="true">
                        <Icon name="folder" />
                      </span>
                      <div className="set-row__k">
                        <b>{home === null ? '—' : (home.split('/').pop() ?? home)}</b>
                        <span className="mono">{home ?? '—'}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={home === null}
                        onClick={() => {
                          void window.creatorhub?.reveal({ kind: 'home' });
                        }}
                      >
                        {t('common.revealInFinder')}
                      </button>
                    </div>
                  </div>
                </section>
                <section className="set-g" aria-labelledby="set-g-mounts">
                  <h2 className="set-g__t" id="set-g-mounts">
                    {t('settingsPages.gMounts')}
                    {live > 0 && <span className="set-g__r num">{live}</span>}
                  </h2>
                  <div className="set-list">
                    {mountsFailed ? (
                      <div className="set-row">
                        <span className="set-row__k muted">
                          {t('serviceSettings.mountsLoadFailed')}
                        </span>
                        <button type="button" className="btn btn--small" onClick={loadMounts}>
                          {t('common.retry')}
                        </button>
                      </div>
                    ) : mounts === null ? (
                      <div className="set-row" aria-busy="true">
                        <span className="skel skel--line" style={{ width: '60%' }} />
                      </div>
                    ) : mounts.length === 0 ? (
                      <div className="set-row">
                        <span className="set-row__k faint set-row__wrap">
                          {t('settingsPages.mountsEmpty')}
                        </span>
                      </div>
                    ) : (
                      mounts.map((m) => (
                        <div
                          key={m.id}
                          className={
                            m.status === 'removed'
                              ? 'set-row set-row--top set-row--dim'
                              : 'set-row set-row--top'
                          }
                        >
                          <span className="set-row__ic" aria-hidden="true">
                            <Icon name="folder" />
                          </span>
                          <div className="set-row__k">
                            <b>{m.name}</b>
                            <span className="mono" title={m.root_path}>
                              {m.root_path}
                            </span>
                            <span>
                              {t('serviceSettings.mountWorkCount', { count: m.work_count })}
                              {m.last_scan_at !== null &&
                                ` · ${t('serviceSettings.mountScannedAt', { when: formatWhen(m.last_scan_at) })}`}
                            </span>
                            {m.status === 'unavailable' && (
                              <span className="set-err set-row__wrap" role="status">
                                {t('serviceSettings.mountUnavailableHint')}
                              </span>
                            )}
                            {rowError?.id === m.id && (
                              <span className="set-err set-row__wrap" role="alert">
                                {rowError.message}
                              </span>
                            )}
                          </div>
                          <span className={`set-st set-st--${MOUNT_TONE[m.status]}`}>
                            <i aria-hidden="true" />
                            {MOUNT_STATUS[m.status].label}
                          </span>
                          {m.status === 'removed' ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--small"
                              disabled={adding}
                              onClick={() => {
                                mountPath(m.root_path);
                              }}
                            >
                              {t('serviceSettings.mountRemount')}
                            </button>
                          ) : (
                            <div className="set-row__acts">
                              <button
                                type="button"
                                className="btn btn--ghost btn--small"
                                disabled={busyId === m.id}
                                onClick={() => {
                                  rescan(m);
                                }}
                              >
                                {busyId === m.id
                                  ? t('serviceSettings.mountRescanQueued')
                                  : t('serviceSettings.mountRescan')}
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--small"
                                disabled={m.status === 'unavailable'}
                                onClick={() => {
                                  void window.creatorhub?.reveal({ kind: 'mount', id: m.id });
                                }}
                              >
                                {t('common.revealInFinder')}
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--small"
                                onClick={() => {
                                  setRemoving(m);
                                }}
                              >
                                {t('serviceSettings.mountUnlink')}
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {mounts !== null && mounts.length > 0 && (
                    <p className="set-fn">{t('serviceSettings.mountsEmptyHint')}</p>
                  )}
                </section>
              </section>
            )}

            {cat === 'about' && (
              <section className="set-sec" aria-labelledby="set-about">
                <header className="set-h">
                  <h1 id="set-about" className="set-h__title" tabIndex={-1}>
                    {t('serviceSettings.aboutTitle')}
                  </h1>
                </header>
                <div className="set-list">
                  <div className="set-about">
                    <AppMark />
                    <div className="set-about__t">
                      <b>qiu-creator</b>
                      <span className="num">{up ? health.version : '—'}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={!up}
                      onClick={() => {
                        if (!up) return;
                        void window.creatorhub
                          ?.copyText(
                            `qiu-creator ${versionLabel(health, (iso) => formatStamp(iso))}`,
                          )
                          .then(() => {
                            setCopied(true);
                          });
                      }}
                    >
                      {copied ? t('common.copied') : t('settingsPages.copyInfo')}
                    </button>
                  </div>
                  <div className="set-row">
                    <div className="set-row__k">
                      <b>{t('serviceSettings.serviceVersion')}</b>
                    </div>
                    <span className="set-row__v mono">
                      {up
                        ? [health.version, health.commit ?? null].filter(Boolean).join(' · ')
                        : '—'}
                    </span>
                  </div>
                  <div className="set-row">
                    <div className="set-row__k">
                      <b>{t('settingsPages.built')}</b>
                    </div>
                    <span className="set-row__v num">
                      {!up
                        ? '—'
                        : health.built_at == null
                          ? t('settingsPages.fromSource')
                          : formatStamp(health.built_at)}
                    </span>
                  </div>
                  <div className="set-row">
                    <div className="set-row__k">
                      <b>{t('settingsPages.dataDir')}</b>
                    </div>
                    <span className="set-row__v mono">{home ?? '—'}</span>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {removing !== null && (
        <Dialog
          title={t('serviceSettings.unlinkTitle', { name: removing.name })}
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
                {t('common.cancel')}
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
                        message: isRestoring(err)
                          ? restoringText()
                          : t('serviceSettings.mountUnlinkFailed'),
                      });
                    });
                }}
              >
                {t('serviceSettings.mountUnlink')}
              </button>
            </>
          }
        >
          <div className="form">
            <p>{t('serviceSettings.unlinkBody')}</p>
            <p className="muted">
              {t('serviceSettings.unlinkNote', { count: removing.work_count })}
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
