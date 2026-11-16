import type { CreatorHubClient } from '@qiu-creator/api-client';
import { WorkSchema, type Work, type WorkDetail } from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connect, type ConnectResult } from './api.js';
import { WorkEditor } from './WorkEditor.js';
import type { SaveStatus } from './work-session.js';
import { WorkList } from './WorkList.js';

type Connection = { state: 'connecting' } | ConnectResult;

const CONNECTION_MESSAGE: Readonly<Record<Exclude<ConnectResult, { ok: true }>['reason'], string>> =
  {
    service_down: '服務未運行',
    unauthorized: '權杖無效',
    home_missing: '未設定 CREATORHUB_HOME',
  };

export function App() {
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });

  const tryConnect = useCallback(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) {
      setConnection({ ok: false, reason: 'service_down' });
      return;
    }
    setConnection({ state: 'connecting' });
    void connect(bridge).then(setConnection);
  }, []);

  useEffect(tryConnect, [tryConnect]);

  if ('state' in connection) {
    return (
      <div className="center-state" aria-busy="true">
        連線中
      </div>
    );
  }
  if (!connection.ok) {
    return (
      <div className="center-state" role="alert">
        <span>{CONNECTION_MESSAGE[connection.reason]}</span>
        <button type="button" onClick={tryConnect}>
          重試
        </button>
      </div>
    );
  }
  return <Workbench client={connection.client} />;
}

function Workbench({ client }: { client: CreatorHubClient }) {
  const [works, setWorks] = useState<readonly Work[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [openWork, setOpenWork] = useState<WorkDetail | null>(null);
  const [openError, setOpenError] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const openWorkId = useRef<string | null>(null);
  openWorkId.current = openWork?.id ?? null;
  const appliedQuery = useRef('');

  const loadWorks = useCallback(
    (q: string) => {
      appliedQuery.current = q;
      setLoadError(false);
      client.works
        .list(q.trim() === '' ? { limit: 200 } : { q: q.trim(), limit: 200 })
        .then((res) => {
          if (appliedQuery.current === q) setWorks(res.items);
        })
        .catch(() => {
          setLoadError(true);
        });
    },
    [client],
  );

  useEffect(() => {
    loadWorks('');
  }, [loadWorks]);

  // Search: debounced, and never while the IME is still composing.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQueryChange = useCallback(
    (q: string, composing: boolean) => {
      setQuery(q);
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
      if (composing) return;
      searchTimer.current = setTimeout(() => {
        loadWorks(q);
      }, 250);
    },
    [loadWorks],
  );

  const editorStatus = useRef<SaveStatus>('saved');
  const onStatusChange = useCallback((status: SaveStatus) => {
    editorStatus.current = status;
  }, []);

  /** Leaving a work with an unresolved conflict would drop the user's draft: ask first. */
  const confirmLeave = useCallback(
    () =>
      editorStatus.current !== 'conflict' ||
      window.confirm('有未解決的版本衝突，離開會捨棄你的修改？'),
    [],
  );

  const open = useCallback(
    (id: string) => {
      if (id === openWorkId.current || !confirmLeave()) return;
      setOpenError(false);
      client.works
        .get(id)
        .then((w) => {
          editorStatus.current = 'saved';
          setOpenWork(w);
        })
        .catch(() => {
          setOpenError(true);
        });
    },
    [client, confirmLeave],
  );

  const onSaved = useCallback((saved: WorkDetail) => {
    setWorks((list) => {
      if (list === null) return list;
      const summary = WorkSchema.parse(saved); // drops the Markdown body
      return [summary, ...list.filter((w) => w.id !== saved.id)];
    });
  }, []);

  const onCreated = useCallback(
    (created: WorkDetail) => {
      loadWorks(appliedQuery.current);
      editorStatus.current = 'saved';
      setOpenWork(created);
    },
    [loadWorks],
  );

  const create = useCallback(() => {
    if (creating || !confirmLeave()) return;
    setCreating(true);
    client.works
      .create({ title: '未命名', markdown: '', source: 'mac-app' })
      .then(onCreated)
      .catch(() => {
        setLoadError(true);
      })
      .finally(() => {
        setCreating(false);
      });
  }, [client, confirmLeave, creating, onCreated]);

  // ⌘N new work, ⌘F search. Ignored during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        create();
      } else if (key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [create]);

  return (
    <div className="workbench">
      <WorkList
        ref={searchRef}
        works={works}
        selectedId={openWork?.id ?? null}
        query={query}
        loadError={loadError}
        creating={creating}
        onQueryChange={onQueryChange}
        onSelect={open}
        onCreate={create}
        onRetry={() => {
          loadWorks(appliedQuery.current);
        }}
      />
      {openWork !== null ? (
        <WorkEditor
          key={openWork.id}
          client={client}
          work={openWork}
          onSaved={onSaved}
          onCreated={onCreated}
          onStatusChange={onStatusChange}
        />
      ) : (
        <main className="center-state">{openError ? '無法開啟作品' : '未選取作品'}</main>
      )}
    </div>
  );
}
