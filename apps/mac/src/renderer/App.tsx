import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState } from 'react';
import { connect, type ConnectResult } from './api.js';
import { AssetsPage } from './AssetsPage.js';
import { EditorPage } from './EditorPage.js';
import { useRefreshOn, useUploads } from './events.js';
import { Icon, type IconName } from './Icon.js';
import { ImportsPage } from './ImportsPage.js';
import { LibraryPage } from './LibraryPage.js';
import { SettingsPage } from './SettingsPage.js';

type Connection = { state: 'connecting' } | ConnectResult;
type Route =
  | { page: 'library' }
  | { page: 'editor'; work: WorkDetail }
  | { page: 'assets'; focusAssetId: string | null }
  | { page: 'imports' }
  | { page: 'settings' };
type NavPage = 'library' | 'assets' | 'imports' | 'settings';

const NAV: readonly { page: NavPage; label: string; icon: IconName }[] = [
  { page: 'library', label: '作品庫', icon: 'library' },
  { page: 'assets', label: '素材庫', icon: 'assets' },
  { page: 'imports', label: '匯入任務', icon: 'imports' },
  { page: 'settings', label: '設定', icon: 'settings' },
];

/** Queued and running import jobs on the service plus this session's active uploads. */
function useActiveTaskCount(client: CreatorHubClient | null): number {
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
  useEffect(load, [load]);
  useRefreshOn(['job'], load, 300);
  return jobs + uploads.filter((u) => u.state === 'queued' || u.state === 'uploading').length;
}

/**
 * App shell from the approved prototype (PT-20261116-001): a left navigation
 * column and one page at a time. AI 工作台, 平台預覽 and 發布中心 arrive
 * with their own tasks.
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
  const serviceUp = client !== null;
  const activeTasks = useActiveTaskCount(client);

  const openWork = useCallback(
    (id: string) => {
      if (client === null) return;
      void client.works.get(id).then((work) => {
        setRoute({ page: 'editor', work });
      });
    },
    [client],
  );

  const go = (page: NavPage) => {
    setRoute(page === 'assets' ? { page, focusAssetId: null } : { page });
  };
  const current: NavPage = route.page === 'editor' ? 'library' : route.page;

  return (
    <div className="shell">
      <nav className="side" aria-label="主導航">
        <div className="side__brand">
          <span className="side__mark" aria-hidden="true" />
          <span className="side__label">qiu-creator</span>
        </div>
        {NAV.map((item) => (
          <button
            key={item.page}
            type="button"
            className="nav-item"
            aria-current={current === item.page ? 'page' : undefined}
            title={item.label}
            onClick={() => {
              go(item.page);
            }}
          >
            <Icon name={item.icon} />
            <span className="side__label">{item.label}</span>
            {item.page === 'imports' && activeTasks > 0 && (
              <span className="chip chip--accent nav-item__badge">
                <span className="visually-hidden">進行中 </span>
                {activeTasks}
              </span>
            )}
          </button>
        ))}
        <div className="side__foot" role="status" title={serviceUp ? '服務運行中' : '服務未回應'}>
          <span className={serviceUp ? 'dot' : 'dot dot--off'} aria-hidden="true" />
          <span className="side__label">{serviceUp ? '服務運行中' : '服務未回應'}</span>
        </div>
      </nav>

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
          onBack={() => {
            setRoute({ page: 'library' });
          }}
        />
      ) : route.page === 'assets' ? (
        <AssetsPage
          key={route.focusAssetId ?? 'assets'}
          client={connection.client}
          home={home}
          userHome={userHome}
          focusAssetId={route.focusAssetId}
          onOpenWork={openWork}
          onOpenImports={() => {
            go('imports');
          }}
          onOpenSettings={() => {
            go('settings');
          }}
        />
      ) : route.page === 'imports' ? (
        <ImportsPage
          client={connection.client}
          onOpenAsset={(id) => {
            setRoute({ page: 'assets', focusAssetId: id });
          }}
        />
      ) : (
        <SettingsPage client={connection.client} home={home} baseUrl={connection.baseUrl} />
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
