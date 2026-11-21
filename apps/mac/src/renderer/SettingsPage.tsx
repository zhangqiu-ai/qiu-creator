import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { isRestoring, restoringText } from './restoring.js';
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
        setRowError({
          id: m.id,
          message: isRestoring(err) ? restoringText() : t('serviceSettings.mountRescanFailed'),
        });
      });
  };

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
          current={currentCat}
          tone={health === null ? null : service.tone}
          onPick={goTo}
        />
        <div className="set-body" ref={bodyRef} onScroll={trackScroll}>
          <div className="settings">
            <AppearanceSection />

            <section className="settings__sec" aria-labelledby="set-service">
              <h2 id="set-service" className="settings__h" tabIndex={-1}>
                {t('serviceSettings.serviceTitle')}
              </h2>
              <p className="settings__sub">{t('serviceSettings.serviceSub')}</p>
              <div className="card">
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">{t('serviceSettings.statusLabel')}</span>
                    <span className="ln__v mono">{address}</span>
                  </div>
                  <span role="status">
                    {health === null ? (
                      <Chip>{t('serviceSettings.statusChecking')}</Chip>
                    ) : up ? (
                      <Chip tone="ok">{t('serviceSettings.statusRunning')}</Chip>
                    ) : (
                      <Chip tone="bad">{t('serviceSettings.statusDown')}</Chip>
                    )}
                  </span>
                  <button type="button" className="btn btn--ghost btn--small" onClick={checkHealth}>
                    <Icon name="refresh" size={14} />
                    {t('common.recheck')}
                  </button>
                </div>
                <div className="ln">
                  <span className="ln__k ln__main">{t('serviceSettings.liveUpdates')}</span>
                  <span role="status">
                    {eventStatus === 'open' ? (
                      <Chip tone="ok">{t('serviceSettings.liveConnected')}</Chip>
                    ) : eventStatus === 'reconnecting' ? (
                      <Chip tone="warn">{t('serviceSettings.liveReconnecting')}</Chip>
                    ) : (
                      <Chip>{t('serviceSettings.liveConnecting')}</Chip>
                    )}
                  </span>
                </div>
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">{t('serviceSettings.startAtLogin')}</span>
                    <span className="ln__v faint">{t('serviceSettings.startAtLoginHint')}</span>
                  </div>
                </div>
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">{t('serviceSettings.preventSleep')}</span>
                    <span className="ln__v faint settings__wrap">
                      {t('serviceSettings.preventSleepHint')}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {backups !== null && <BackupSection session={backups} userHome={userHome} />}

            <AiSettingsSection key={dataEpoch} client={client} headingRef={aiHeading} />

            <section className="settings__sec" aria-labelledby="set-folders">
              <h2 id="set-folders" className="settings__h" tabIndex={-1}>
                {t('serviceSettings.foldersTitle')}
              </h2>
              <div className="card">
                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">{t('serviceSettings.managedFolder')}</span>
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
                    {t('common.revealInFinder')}
                  </button>
                </div>

                {mountsFailed ? (
                  <div className="ln">
                    <span className="ln__main muted">{t('serviceSettings.mountsLoadFailed')}</span>
                    <button type="button" className="btn btn--small" onClick={loadMounts}>
                      {t('common.retry')}
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
                          {t('serviceSettings.mountWorkCount', { count: m.work_count })}
                          {m.last_scan_at !== null &&
                            ` · ${t('serviceSettings.mountScannedAt', { when: formatWhen(m.last_scan_at) })}`}
                        </span>
                        {m.status === 'unavailable' && (
                          <span className="ln__err" role="status">
                            {t('serviceSettings.mountUnavailableHint')}
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
                          {t('serviceSettings.mountRemount')}
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

                <div className="ln">
                  <div className="ln__main">
                    <span className="ln__k">{t('serviceSettings.mountsTitle')}</span>
                    <span className="ln__v faint">
                      {live === 0
                        ? t('serviceSettings.mountsEmptyHint')
                        : t('serviceSettings.mountsCount', { count: live })}
                    </span>
                    {addError !== null && (
                      <span className="ln__err" role="alert">
                        {addError}
                      </span>
                    )}
                  </div>
                  <button type="button" className="btn" disabled={adding} onClick={addMount}>
                    <Icon name="plus" size={14} />
                    {adding ? t('serviceSettings.mountAdding') : t('serviceSettings.mountAdd')}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings__sec" aria-labelledby="set-about">
              <h2 id="set-about" className="settings__h" tabIndex={-1}>
                {t('serviceSettings.aboutTitle')}
              </h2>
              <div className="card">
                <div className="ln">
                  <span className="ln__k ln__main">App</span>
                  <span className="ln__v mono">qiu-creator</span>
                </div>
                <div className="ln">
                  <span className="ln__k ln__main">{t('serviceSettings.serviceVersion')}</span>
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
