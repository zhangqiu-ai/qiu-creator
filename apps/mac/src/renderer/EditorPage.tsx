import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Revision, WorkDetail } from '@qiu-creator/contracts';
import {
  MarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
} from '@qiu-creator/markdown-editor-web';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Chip } from './Chip.js';
import { ConflictDialog } from './ConflictDialog.js';
import { countWords, formatWhen, REVISION_SOURCE_LABEL, SAVE_STATUS } from './format.js';
import { Icon } from './Icon.js';
import { WorkSession } from './work-session.js';

export interface EditorPageProps {
  client: CreatorHubClient;
  work: WorkDetail;
  onBack: () => void;
}

/** 編輯頁 from the approved prototype (the AI panel and 預覽 come with later tasks). */
export function EditorPage(props: EditorPageProps) {
  const { client, work } = props;
  const [session, setSession] = useState<WorkSession | null>(null);
  useEffect(() => {
    const s = new WorkSession(client, work);
    setSession(s);
    return () => {
      // Flush pending edits when leaving; a conflict stays unsaved (the dialog blocks leaving).
      s.close();
    };
  }, [client, work]);

  if (session === null) return <main className="page" aria-busy="true" />;
  return <SessionEditor {...props} session={session} />;
}

/** Revision number (r1, r2, …) for each revision id; the list comes newest first. */
function revisionNumbers(revisions: readonly Revision[]): Map<string, number> {
  return new Map(revisions.map((r, i) => [r.revision_id, revisions.length - i]));
}

function SessionEditor({
  client,
  work,
  onBack,
  session,
}: EditorPageProps & { session: WorkSession }) {
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );
  const editor = useRef<MarkdownEditorHandle>(null);
  /** Bumped when the draft is replaced from outside the editor, to remount it. */
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);

  const loadRevisions = useCallback(() => {
    client.works
      .revisions(work.id)
      .then((r) => {
        setRevisions(r.items);
      })
      .catch(() => {
        // history is informational; the save status already reports connectivity
      });
  }, [client, work.id]);
  useEffect(loadRevisions, [loadRevisions, state.baseRevision]);
  const numbers = useMemo(() => revisionNumbers(revisions), [revisions]);

  useEffect(() => {
    const m = editor.current?.getMode();
    if (m !== undefined) setMode(m);
  }, [editorKey]);

  // ⌘S save now, ⌘/ switch mode; never during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.isComposing || session.isComposing()) return;
      if (!e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void session.save();
      } else if (e.key === '/') {
        e.preventDefault();
        editor.current?.requestMode(editor.current.getMode() === 'visual' ? 'source' : 'visual');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [session]);

  const save = SAVE_STATUS[state.status];
  const rev = numbers.get(state.baseRevision);
  const words = useMemo(() => countWords(state.draft.markdown), [state.draft.markdown]);
  const conflict = state.status === 'conflict';
  // The dialog opens on a 409 and stays open after resolving, until 返回編輯.
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (conflict) setDialogOpen(true);
  }, [conflict]);
  const offline = state.status === 'error' && state.errorMessage === '無法連線到服務';

  return (
    <>
      <main className="page editor" aria-label="編輯作品" inert={dialogOpen}>
        <header className="editor__bar">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label="返回作品庫"
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
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
          <span className="save-status" role="status" aria-live="polite">
            <Chip tone={save.tone}>
              {state.status === 'saving' && <span className="pulse" aria-hidden="true" />}
              {save.label}
            </Chip>
          </span>
          {state.status === 'error' && (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void session.save();
              }}
            >
              重試
            </button>
          )}
          {rev !== undefined && <Chip>r{rev}</Chip>}
          <span className="editor__words">{words} 字</span>
          <div className="editor__actions">
            <div className="seg" role="group" aria-label="編輯模式">
              {(['visual', 'source'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  aria-keyshortcuts="Meta+/"
                  onClick={() => {
                    editor.current?.requestMode(m);
                  }}
                >
                  {m === 'visual' ? '視覺' : '原始碼'}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              aria-expanded={historyOpen}
              aria-controls="history-panel"
              onClick={() => {
                setHistoryOpen((v) => !v);
              }}
            >
              <Icon name="history" />
              歷史
            </button>
          </div>
        </header>

        {state.status === 'error' && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">
              {offline ? '服務未回應，修改保留在此視窗' : (state.errorMessage ?? '儲存失敗')}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.save();
              }}
            >
              重試
            </button>
          </div>
        )}

        <div className="editor__body">
          <section className="editor__doc" aria-label="正文">
            <MarkdownEditor
              key={`${work.id}:${editorKey}`}
              ref={editor}
              markdown={state.draft.markdown}
              showModeSwitch={false}
              onModeChange={setMode}
              onChange={(markdown) => {
                session.edit({ markdown });
              }}
              onCompositionChange={(composing) => {
                session.setComposing(composing);
              }}
            />
          </section>

          {historyOpen && (
            <aside
              id="history-panel"
              className="panel"
              aria-label="版本歷史"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setHistoryOpen(false);
              }}
            >
              <div className="panel__head">
                <span className="panel__title">版本歷史</span>
                <span className="faint">{revisions.length}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon panel__close"
                  aria-label="關閉歷史"
                  onClick={() => {
                    setHistoryOpen(false);
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
              <ol className="revs">
                {revisions.map((r) => (
                  <li
                    key={r.revision_id}
                    className="rev"
                    aria-current={r.revision_id === state.baseRevision ? 'true' : undefined}
                  >
                    <span className="mono rev__n">r{numbers.get(r.revision_id)}</span>
                    <span className="rev__src">{REVISION_SOURCE_LABEL[r.source]}</span>
                    <time className="rev__when" dateTime={r.created_at}>
                      {formatWhen(r.created_at)}
                    </time>
                  </li>
                ))}
              </ol>
            </aside>
          )}
        </div>
      </main>

      {dialogOpen && (
        <ConflictDialog
          session={session}
          revisionNumber={(id) => numbers.get(id)}
          onRevisionsChanged={loadRevisions}
          onClose={() => {
            setDialogOpen(false);
            setEditorKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}
