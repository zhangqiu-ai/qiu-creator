import type { WorkDetail } from '@qiu-creator/contracts';
import { useCallback, useEffect, useState } from 'react';
import { connect, type ConnectResult } from './api.js';
import { EditorPage } from './EditorPage.js';
import { Icon } from './Icon.js';
import { LibraryPage } from './LibraryPage.js';

type Connection = { state: 'connecting' } | ConnectResult;
type Route = { page: 'library' } | { page: 'editor'; work: WorkDetail };

/**
 * App shell from the approved prototype (PT-20261116-001): a left navigation
 * column and one page at a time. Only 作品庫 exists in QC-002; the other
 * destinations arrive with their own tasks.
 */
export function App() {
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [route, setRoute] = useState<Route>({ page: 'library' });

  const tryConnect = useCallback(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) {
      setConnection({ ok: false, reason: 'service_down', baseUrl: '' });
      return;
    }
    setConnection({ state: 'connecting' });
    void connect(bridge).then(setConnection);
  }, []);

  useEffect(tryConnect, [tryConnect]);

  const client = 'state' in connection || !connection.ok ? null : connection.client;
  const serviceUp = client !== null;

  const openWork = useCallback(
    (id: string) => {
      if (client === null) return;
      void client.works.get(id).then((work) => {
        setRoute({ page: 'editor', work });
      });
    },
    [client],
  );

  return (
    <div className="shell">
      <nav className="side" aria-label="主導航">
        <div className="side__brand">
          <span className="side__mark" aria-hidden="true" />
          <span className="side__label">qiu-creator</span>
        </div>
        <button
          type="button"
          className="nav-item"
          aria-current={route.page === 'library' ? 'page' : undefined}
          title="作品庫"
          onClick={() => {
            setRoute({ page: 'library' });
          }}
        >
          <Icon name="library" />
          <span className="side__label">作品庫</span>
        </button>
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
          onOpen={openWork}
          onCreated={(work) => {
            setRoute({ page: 'editor', work });
          }}
        />
      ) : (
        <EditorPage
          key={route.work.id}
          client={connection.client}
          work={route.work}
          onBack={() => {
            setRoute({ page: 'library' });
          }}
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
