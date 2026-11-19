import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { HealthResponse, WorkDetail } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { connect, type ConnectResult } from './api.js';
import { AssetsPage } from './AssetsPage.js';
import { BackupSession, type BackupState } from './backups.js';
import { onRestoringSeen } from './restoring.js';
import { EditorPage } from './EditorPage.js';
import { useChangeEvents, useEventStatus, useRefreshOn, useUploads } from './events.js';
import { Icon } from './Icon.js';
import { ImportsPage } from './ImportsPage.js';
import { LibraryPage } from './LibraryPage.js';
import { PreviewPage } from './PreviewPage.js';
import { AiWorkbenchPage } from './AiWorkbenchPage.js';
import { SettingsPage } from './SettingsPage.js';
import { Sidebar, type NavPage } from './Sidebar.js';
import { serviceSummary } from './sidebar-prefs.js';

type Connection = { state: 'connecting' } | ConnectResult;
type Route =
  | { page: 'library' }
  | { page: 'editor'; work: WorkDetail }
  | { page: 'assets'; focusAssetId: string | null; startAt?: number }
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
 * App shell from the approved prototype (PT-20261116-001): a left navigation
 * column and one page at a time. 發布中心 is phase two.
 */
export function App() {
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

  const openWork = useCallback(
    (id: string) => {
      if (client === null) return;
      void client.works.get(id).then((work) => {
        setLastWorkId(work.id);
        setRoute({ page: 'editor', work });
      });
    },
    [client],
  );

  // The work last opened in the editor, so 平台預覽 in the navigation goes straight to it.
  const [lastWorkId, setLastWorkId] = useState<string | null>(null);
  const go = (page: NavPage) => {
    if (page === 'assets') setRoute({ page, focusAssetId: null });
    else if (page === 'preview') setRoute({ page, workId: lastWorkId, from: null });
    else setRoute({ page });
  };
  const current: NavPage = route.page === 'editor' ? 'library' : route.page;

  return (
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
          userHome={userHome}
          onOpen={openWork}
          onCreated={(work) => {
            setRoute({ page: 'editor', work });
          }}
        />
      ) : route.page === 'editor' ? (
        <EditorPage
          key={route.work.id}
          client={connection.client}
          work={route.work}
          userHome={userHome}
          onPreview={() => {
            setRoute({ page: 'preview', workId: route.work.id, from: route.work });
          }}
          onOpenSettings={() => {
            setRoute({ page: 'settings', section: 'ai' });
          }}
          onBack={() => {
            setRoute({ page: 'library' });
          }}
        />
      ) : route.page === 'assets' ? (
        <AssetsPage
          key={`${route.focusAssetId ?? 'assets'}:${String(route.startAt ?? '')}:${String(dataEpoch)}`}
          client={connection.client}
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
            setLastWorkId(id);
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
    </div>
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
      ? '本機服務未回應'
      : reason === 'unauthorized'
        ? '權杖無效'
        : '未設定 CREATORHUB_HOME';
  return (
    <div className="state-card" role="alert">
      <Icon name="offline" size={28} />
      <span className="state-card__title">{title}</span>
      {reason === 'service_down' && address !== '' && (
        <span className="mono state-card__detail">{address}</span>
      )}
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        重試
      </button>
    </div>
  );
}
