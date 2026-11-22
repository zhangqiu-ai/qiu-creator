import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { HealthResponse, WorkDetail } from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { connect, type ConnectResult } from './api.js';
import { AssetsPage } from './AssetsPage.js';
import { BackupSession, type BackupState } from './backups.js';
import { onRestoringSeen } from './restoring.js';
import { EditorTabs } from './EditorTabs.js';
import { useChangeEvents, useEventStatus, useRefreshOn, useUploads } from './events.js';
import { Icon } from './Icon.js';
import { ImportsPage } from './ImportsPage.js';
import { LibraryPage } from './LibraryPage.js';
import { PreviewPage } from './PreviewPage.js';
import { AiWorkbenchPage } from './AiWorkbenchPage.js';
import { SettingsPage } from './SettingsPage.js';
import { Sidebar, type NavPage } from './Sidebar.js';
import { SidebarProjects, type LibraryScope } from './SidebarProjects.js';
import { ProjectsStore } from './projects-store.js';
import { ProjectsContext } from './ProjectTags.js';
import { ProjectsDnd } from './projects-dnd.js';
import { AppMotion } from './motion.js';
import { serviceSummary } from './sidebar-prefs.js';
import { t, useLocale } from './i18n.js';
import { TabsModel } from './tabs.js';
import type { EditorHandles } from './work-actions.js';
import { ToastHost } from './toasts.js';

type Connection = { state: 'connecting' } | ConnectResult;
type Route =
  | { page: 'library' }
  | { page: 'editor' }
  | {
      page: 'assets';
      focusAssetId: string | null;
      startAt?: number;
      /** 用到的素材 of a project (QC-062): the assets its works use. */
      projectId?: string;
    }
  | { page: 'ai' }
  | { page: 'imports' }
  | { page: 'preview'; workId: string | null; from: WorkDetail | null }
  | { page: 'settings'; section?: 'ai' };

/** `/health` for the sidebar's service dot: on connect, every 30 s, and on 重新檢查. */
function useServiceHealth(client: CreatorHubClient | null) {
  const [health, setHealth] = useState<HealthResponse | 'down' | null>(null);
  const checkHealth = useCallback(() => {
    if (client === null) {
      setHealth(null);
      return;
    }
    client
      .health()
      .then(setHealth)
      .catch(() => {
        setHealth('down');
      });
  }, [client]);
  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [checkHealth]);
  return { health, checkHealth };
}

/** Queued and running import jobs on the service plus this session's active uploads. */
function useActiveTaskCount(client: CreatorHubClient | null, dataEpoch: number): number {
  const [jobs, setJobs] = useState(0);
  const uploads = useUploads();
  const load = useCallback(() => {
    if (client === null) return;
    void Promise.all([
      client.jobs.list({ status: 'running', limit: 1 }),
      client.jobs.list({ status: 'queued', limit: 1 }),
    ])
      .then(([running, queued]) => {
        setJobs(running.total + queued.total);
      })
      .catch(() => {
        // Badge only; the 匯入任務 page reports errors.
      });
  }, [client]);
  useEffect(load, [load, dataEpoch]);
  useRefreshOn(['job'], load, 300);
  return jobs + uploads.filter((u) => u.state === 'queued' || u.state === 'uploading').length;
}

const NO_BACKUPS = (): (() => void) => () => undefined;

/**
 * Backups for this connection (QC-031). Kept at the app level so a restore
 * keeps being followed when the user leaves 設定, and so the whole app can
 * refetch once the service runs on the restored database.
 */
function useBackupSession(client: CreatorHubClient | null, onDataReplaced: () => void) {
  const [session, setSession] = useState<BackupSession | null>(null);
  useEffect(() => {
    if (client === null) {
      setSession(null);
      return;
    }
    // Created in the effect: StrictMode would dispose a memoized instance (QC-025).
    const s = new BackupSession({
      client,
      onDataReplaced,
      wakeEvents: () => {
        void window.creatorhub?.eventStatus();
      },
    });
    setSession(s);
    return () => {
      s.dispose();
    };
  }, [client, onDataReplaced]);
  useChangeEvents((event) => {
    session?.onEvent(event);
  });
  // Any page's write that met 503 `restoring` means a restore is being applied.
  useEffect(() => {
    if (session === null) return;
    return onRestoringSeen(() => {
      session.noteRestoring();
    });
  }, [session]);
  const state = useSyncExternalStore<BackupState | null>(
    session?.subscribe ?? NO_BACKUPS,
    () => session?.getSnapshot() ?? null,
  );
  return { session, state };
}

/**
 * Editor tabs (QC-047): restored from the app preferences once per launch,
 * and saved there whenever they change.
 */
function useTabs(client: CreatorHubClient | null, onRestored: () => void) {
  const [model] = useState(() => new TabsModel());
  const restored = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (client === null || restored.current) return;
    restored.current = true;
    const bridge = window.creatorhub;
    if (bridge === undefined) {
      setReady(true);
      return;
    }
    void bridge
      .getTabs()
      .then((saved) => {
        if (saved !== null && saved.items.length > 0 && model.tabs.length === 0) {
          model.restore(saved);
          onRestored();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setReady(true);
      });
  }, [client, model, onRestored]);
  useEffect(() => {
    // Nothing is written before the saved tabs were read, so they are never overwritten by none.
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = JSON.stringify(model.persisted());
    const off = model.subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const next = model.persisted();
        const text = JSON.stringify(next);
        if (text === last) return;
        last = text;
        void window.creatorhub?.setTabs(next).catch(() => undefined);
      }, 300);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ready, model]);
  return model;
}

/**
 * App shell from the approved prototype (PT-20261116-001): a left navigation
 * column and one page at a time. 發布中心 is phase two. The editor area keeps
 * its tabs mounted while another page is in front (QC-047).
 */
export function App() {
  // Re-render the whole tree in place when the language changes (QC-042).
  useLocale();
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [route, setRoute] = useState<Route>({ page: 'library' });
  const [home, setHome] = useState<string | null>(null);
  const [userHome, setUserHome] = useState<string | null>(null);

  const tryConnect = useCallback(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) {
      setConnection({ ok: false, reason: 'service_down', baseUrl: '' });
      return;
    }
    setConnection({ state: 'connecting' });
    void connect(bridge).then(setConnection);
    void bridge.appInfo().then((info) => {
      setHome(info.home);
      setUserHome(info.userHome);
    });
  }, []);

  useEffect(tryConnect, [tryConnect]);

  const client = 'state' in connection || !connection.ok ? null : connection.client;
  // Bumped when a backup restore replaced the database: every page refetches.
  const [dataEpoch, setDataEpoch] = useState(0);
  const onDataReplaced = useCallback(() => {
    setDataEpoch((n) => n + 1);
  }, []);
  const backups = useBackupSession(client, onDataReplaced);
  const projects = useProjects(client, dataEpoch);
  const projectsState = useSyncExternalStore(
    projects?.subscribe ?? NO_PROJECTS,
    projects?.getSnapshot ?? EMPTY_PROJECTS,
  );
  const [scope, setScope] = useState<LibraryScope>({ kind: 'all' });
  // A project that went away (deleted, archived elsewhere): back to 全部作品.
  const scopedProject =
    scope.kind === 'project'
      ? (projectsState.projects?.find((p) => p.id === scope.id) ?? null)
      : null;
  useEffect(() => {
    if (scope.kind === 'project' && projectsState.projects !== null && scopedProject === null)
      setScope({ kind: 'all' });
  }, [scope, projectsState.projects, scopedProject]);
  const restoring =
    backups.state !== null &&
    (backups.state.restore.phase === 'sending' ||
      backups.state.restore.phase === 'reloading' ||
      backups.state.externalRestore);
  const serviceUp = client !== null;
  const activeTasks = useActiveTaskCount(client, dataEpoch);
  const events = useEventStatus();
  const { health, checkHealth } = useServiceHealth(client);
  // Live updates dropped: find out right away whether the service itself is gone.
  useEffect(() => {
    if (events === 'reconnecting') checkHealth();
  }, [events, checkHealth]);
  const service = serviceSummary({
    serviceUp: serviceUp && health !== 'down',
    events,
    health: health === 'down' ? null : health,
    restoring,
  });
  const address = 'state' in connection ? '' : connection.baseUrl.replace(/^https?:\/\//, '');

  const showEditor = useCallback(() => {
    setRoute({ page: 'editor' });
  }, []);
  const tabs = useTabs(client, showEditor);
  const tabsState = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
  /** Works fetched to open a tab, handed to its editor so it does not fetch them again. */
  const [preloaded] = useState(() => new Map<string, WorkDetail>());
  const [focusToken, setFocusToken] = useState(0);
  const focusEditor = useCallback(() => {
    setFocusToken((n) => n + 1);
    setRoute({ page: 'editor' });
  }, []);
  // Editors mounted in tabs, so 作品庫 renames an open work through its editor (QC-052).
  const [editorHandles] = useState<EditorHandles>(() => new Map());
  const openTab = useCallback(
    (work: WorkDetail) => {
      if (tabs.find(work.id) === null) preloaded.set(work.id, work);
      tabs.open({ id: work.id, kind: work.type, title: work.title });
      focusEditor();
    },
    [tabs, preloaded, focusEditor],
  );
  const openWork = useCallback(
    (id: string) => {
      if (client === null) return;
      // Already open: focus (and flash) its tab, with whatever is unsaved in it.
      const open = tabs.find(id);
      if (open !== null) {
        tabs.open(open);
        focusEditor();
        return;
      }
      void client.works.get(id).then(openTab);
    },
    [client, tabs, openTab, focusEditor],
  );
  // The last tab closed: back to 作品庫.
  useEffect(() => {
    if (route.page === 'editor' && tabsState.tabs.length === 0) setRoute({ page: 'library' });
  }, [route.page, tabsState.tabs.length]);

  // The work in the active tab, so 平台預覽 in the navigation goes straight to it.
  const lastWorkId = tabsState.activeId;
  // 設定… (⌘,) from the app menu (QC-057).
  useEffect(
    () =>
      window.creatorhub?.onTabCommand((command) => {
        if (command === 'settings') setRoute({ page: 'settings' });
      }),
    [],
  );

  const go = (page: NavPage) => {
    if (page === 'library') setScope({ kind: 'all' });
    if (page === 'assets') setRoute({ page, focusAssetId: null });
    else if (page === 'preview') setRoute({ page, workId: lastWorkId, from: null });
    else setRoute({ page });
  };
  const current: NavPage = route.page === 'editor' ? 'library' : route.page;
  const openScope = (next: LibraryScope) => {
    setScope(next);
    setRoute({ page: 'library' });
  };

  return (
    <AppMotion>
      <ProjectsContext.Provider value={projects}>
        <ProjectsDnd store={projects}>
          <div className="shell">
            <Sidebar
              current={current}
              onNavigate={go}
              importsCount={activeTasks}
              service={service}
              address={address}
              onRecheck={() => {
                if (client === null) tryConnect();
                else checkHealth();
              }}
              libraryScoped={scope.kind !== 'all'}
              projects={
                projects === null || client === null
                  ? undefined
                  : (rail) => (
                      <SidebarProjects
                        store={projects}
                        s={projectsState}
                        client={client}
                        rail={rail}
                        scope={scope}
                        active={current === 'library' && route.page === 'library'}
                        onOpen={openScope}
                      />
                    )
              }
            />

            {'state' in connection ? (
              <main className="page page--center" aria-busy="true" />
            ) : !connection.ok ? (
              <main className="page page--center">
                <ServiceProblem
                  reason={connection.reason}
                  address={connection.baseUrl.replace(/^https?:\/\//, '')}
                  onRetry={tryConnect}
                />
              </main>
            ) : route.page === 'library' ? (
              <LibraryPage
                key={`library:${String(dataEpoch)}`}
                client={connection.client}
                scope={scope}
                projects={projects}
                projectsState={projectsState}
                onScope={openScope}
                onOpenProjectAssets={(id) => {
                  setRoute({ page: 'assets', focusAssetId: null, projectId: id });
                }}
                userHome={userHome}
                onOpen={openWork}
                onCreated={openTab}
                handles={editorHandles}
                onOpenInBackground={(work) => {
                  tabs.openInBackground({ id: work.id, kind: work.type, title: work.title });
                }}
                onRenamed={(id, title) => {
                  if (tabs.find(id) !== null) tabs.update(id, { title });
                }}
                onTrashed={(ids) => {
                  // Saved before deleting, so nothing unsaved is lost; 復原 does not reopen them.
                  for (const id of ids) if (tabs.find(id) !== null) tabs.close(id);
                }}
              />
            ) : route.page === 'editor' ? null : route.page === 'assets' ? (
              <AssetsPage
                key={`${route.focusAssetId ?? 'assets'}:${String(route.startAt ?? '')}:${route.projectId ?? ''}:${String(dataEpoch)}`}
                client={connection.client}
                project={
                  route.projectId === undefined
                    ? null
                    : (projectsState.projects?.find((p) => p.id === route.projectId) ?? null)
                }
                onClearProject={() => {
                  setRoute({ page: 'assets', focusAssetId: null });
                }}
                onBackToProject={(id) => {
                  openScope({ kind: 'project', id });
                }}
                home={home}
                userHome={userHome}
                focusAssetId={route.focusAssetId}
                startAt={route.startAt ?? null}
                onOpenWork={openWork}
                onOpenImports={() => {
                  go('imports');
                }}
                onOpenSettings={() => {
                  go('settings');
                }}
              />
            ) : route.page === 'preview' ? (
              <PreviewPage
                key={`preview:${String(dataEpoch)}`}
                client={connection.client}
                workId={route.workId}
                onPickWork={(id) => {
                  setRoute({ page: 'preview', workId: id, from: null });
                }}
                onBack={
                  route.workId === null
                    ? null
                    : () => {
                        if (route.workId !== null) openWork(route.workId);
                      }
                }
              />
            ) : route.page === 'ai' ? (
              <AiWorkbenchPage
                key={`ai:${String(dataEpoch)}`}
                client={connection.client}
                onOpenSettings={() => {
                  setRoute({ page: 'settings', section: 'ai' });
                }}
                onOpenAssets={() => {
                  go('assets');
                }}
                onOpenAsset={(id, at) => {
                  setRoute({ page: 'assets', focusAssetId: id, startAt: at });
                }}
              />
            ) : route.page === 'imports' ? (
              <ImportsPage
                key={`imports:${String(dataEpoch)}`}
                client={connection.client}
                onOpenAsset={(id) => {
                  setRoute({ page: 'assets', focusAssetId: id });
                }}
              />
            ) : (
              <SettingsPage
                key={route.section ?? 'settings'}
                client={connection.client}
                home={home}
                userHome={userHome}
                baseUrl={connection.baseUrl}
                focusSection={route.section}
                backups={backups.session}
                dataEpoch={dataEpoch}
                health={health}
                eventStatus={events}
                service={service}
                checkHealth={checkHealth}
              />
            )}
            {client !== null && (
              <EditorTabs
                model={tabs}
                handles={editorHandles}
                client={client}
                userHome={userHome}
                visible={route.page === 'editor'}
                preloaded={preloaded}
                focusToken={focusToken}
                onFocusEditor={focusEditor}
                onBack={() => {
                  setRoute({ page: 'library' });
                }}
                onPreview={(work) => {
                  setRoute({ page: 'preview', workId: work.id, from: work });
                }}
                onOpenSettings={() => {
                  setRoute({ page: 'settings', section: 'ai' });
                }}
              />
            )}
            <ToastHost />
          </div>
        </ProjectsDnd>
      </ProjectsContext.Provider>
    </AppMotion>
  );
}

function ServiceProblem({
  reason,
  address,
  onRetry,
}: {
  reason: Exclude<ConnectResult, { ok: true }>['reason'];
  address: string;
  onRetry: () => void;
}) {
  const title =
    reason === 'service_down'
      ? t('shell.connectServiceDown')
      : reason === 'unauthorized'
        ? t('shell.connectUnauthorized')
        : t('shell.connectHomeMissing');
  return (
    <div className="state-card" role="alert">
      <Icon name="offline" size={28} />
      <span className="state-card__title">{title}</span>
      {reason === 'service_down' && address !== '' && (
        <span className="mono state-card__detail">{address}</span>
      )}
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}

const NO_PROJECTS = (): (() => void) => () => undefined;
const EMPTY: ReturnType<ProjectsStore['getSnapshot']> = {
  projects: null,
  allCount: null,
  unassignedCount: null,
  failed: false,
};
const EMPTY_PROJECTS = () => EMPTY;

/** One project list per connection, loaded at once and kept fresh by SSE (QC-062). */
function useProjects(client: CreatorHubClient | null, dataEpoch: number): ProjectsStore | null {
  const [store, setStore] = useState<ProjectsStore | null>(null);
  useEffect(() => {
    setStore(client === null ? null : new ProjectsStore(client));
  }, [client]);
  useEffect(() => {
    void store?.load();
  }, [store, dataEpoch]);
  useRefreshOn(
    ['project', 'work'],
    () => {
      void store?.load();
    },
    300,
  );
  return store;
}
