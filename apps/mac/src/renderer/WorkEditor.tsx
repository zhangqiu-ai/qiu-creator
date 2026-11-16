import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Revision, WorkDetail } from '@qiu-creator/contracts';
import { MarkdownEditor } from '@qiu-creator/markdown-editor-web';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { diffLines } from './diff.js';
import { formatTime, REVISION_SOURCE_LABEL, SAVE_STATUS_LABEL } from './format.js';
import { Icon } from './Icon.js';
import { WorkSession, type SaveStatus } from './work-session.js';

export interface WorkEditorProps {
  client: CreatorHubClient;
  work: WorkDetail;
  onSaved: (work: WorkDetail) => void;
  onCreated: (work: WorkDetail) => void;
  onStatusChange: (status: SaveStatus) => void;
}

export function WorkEditor(props: WorkEditorProps) {
  const { client, work, onSaved, onStatusChange } = props;
  const [session, setSession] = useState<WorkSession | null>(null);
  useEffect(() => {
    const s = new WorkSession(client, work, { onSaved });
    setSession(s);
    const unsubscribe = s.subscribe((st) => {
      onStatusChange(st.status);
    });
    return () => {
      unsubscribe();
      // Flush pending edits when switching works; a conflict stays unsaved.
      s.close();
    };
  }, [client, work, onSaved, onStatusChange]);

  if (session === null) return <main className="center-state" aria-busy="true" />;
  return <SessionEditor {...props} session={session} />;
}

function SessionEditor({
  client,
  work,
  onCreated,
  session,
}: WorkEditorProps & { session: WorkSession }) {
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );

  /** Bumped when the server version replaces the draft, to remount the editor. */
  const [editorKey, setEditorKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<readonly Revision[] | null>(null);
  const [serverVersion, setServerVersion] = useState<WorkDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRevisions = useCallback(() => {
    client.works
      .revisions(work.id)
      .then((r) => {
        setRevisions(r.items); // newest first
      })
      .catch(() => {
        setRevisions(null);
      });
  }, [client, work.id]);

  useEffect(() => {
    if (showHistory) loadRevisions();
  }, [showHistory, loadRevisions, state.baseRevision]);

  // ⌘S saves now, but never in the middle of an IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.isComposing || session.isComposing()) return;
        void session.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [session]);

  const showDiff = async () => {
    setBusy(true);
    try {
      setServerVersion(await session.fetchServerVersion());
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (!window.confirm('捨棄本機修改，載入伺服器版本？')) return;
    setBusy(true);
    try {
      await session.reloadFromServer();
      setServerVersion(null);
      setEditorKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  const keepBoth = async () => {
    setBusy(true);
    try {
      const created = await session.saveDraftAsNewWork();
      onCreated(created);
    } finally {
      setBusy(false);
    }
  };

  const diff = useMemo(
    () => (serverVersion === null ? null : diffLines(serverVersion.markdown, state.draft.markdown)),
    [serverVersion, state.draft.markdown],
  );

  return (
    <main className="editor" aria-label="編輯作品">
      <header className="editor__header">
        <input
          className="editor__title"
          aria-label="標題"
          value={state.draft.title}
          onChange={(e) => {
            session.edit({ title: e.target.value });
          }}
          onCompositionStart={() => {
            session.setComposing(true);
          }}
          onCompositionEnd={() => {
            session.setComposing(false);
          }}
        />
        <span className="save-status" data-status={state.status} role="status" aria-live="polite">
          {SAVE_STATUS_LABEL[state.status]}
        </span>
        {state.status === 'error' && (
          <button
            type="button"
            onClick={() => {
              void session.save();
            }}
            title={state.errorMessage ?? undefined}
          >
            重試
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="版本歷史"
          aria-pressed={showHistory}
          title="版本歷史"
          onClick={() => {
            setShowHistory((v) => !v);
          }}
        >
          <Icon name="history" />
        </button>
      </header>

      {state.status === 'conflict' && (
        <div className="conflict" role="alert">
          <span className="conflict__text">伺服器有較新版本，你的修改未儲存</span>
          <button type="button" disabled={busy} onClick={() => void showDiff()}>
            查看差異
          </button>
          <button type="button" disabled={busy} onClick={() => void keepBoth()}>
            另存新作品
          </button>
          <button type="button" disabled={busy} onClick={() => void reload()}>
            重新載入
          </button>
        </div>
      )}

      <div className="editor__body">
        {diff !== null && serverVersion !== null ? (
          <section className="diff" aria-label="差異">
            <div className="diff__header">
              <span className="diff__legend diff__legend--removed">伺服器</span>
              <span className="diff__legend diff__legend--added">我的</span>
              {serverVersion.title !== state.draft.title && (
                <span>
                  標題：{serverVersion.title} → {state.draft.title}
                </span>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="關閉差異"
                onClick={() => {
                  setServerVersion(null);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
            <pre className="diff__body">
              {diff.map((line, i) => (
                <div key={i} className={`diff__line diff__line--${line.kind}`}>
                  <span className="diff__mark" aria-hidden="true">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </span>
                  {line.text}
                </div>
              ))}
            </pre>
          </section>
        ) : (
          <MarkdownEditor
            key={`${work.id}:${editorKey}`}
            markdown={state.draft.markdown}
            onChange={(markdown) => {
              session.edit({ markdown });
            }}
            onCompositionChange={(composing) => {
              session.setComposing(composing);
            }}
          />
        )}

        {showHistory && (
          <aside className="history" aria-label="版本歷史">
            <h2 className="history__title">版本歷史</h2>
            {revisions === null ? (
              <div className="list-state">載入中</div>
            ) : (
              <ol className="history__list">
                {revisions.map((r) => (
                  <li
                    key={r.revision_id}
                    className="history__item"
                    aria-current={r.revision_id === state.baseRevision ? 'true' : undefined}
                  >
                    <span>{REVISION_SOURCE_LABEL[r.source]}</span>
                    <time dateTime={r.created_at}>{formatTime(r.created_at)}</time>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
