import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Revision, WorkDetail, WorkStatus } from '@qiu-creator/contracts';
import {
  blockNumbers,
  MarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
  type MarkdownRange,
} from '@qiu-creator/markdown-editor-web';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AiPanel, type AiSelection } from './AiPanel.js';
import { AiProviders, RewriteSession, TitleSession } from './ai-session.js';
import { Chip } from './Chip.js';
import { ConflictDialog } from './ConflictDialog.js';
import { useChangeEvents, useEventStatus } from './events.js';
import { countWords, SAVE_STATUS, WORK_STATUS } from './format.js';
import { HistoryPanel } from './HistoryPanel.js';
import { Icon } from './Icon.js';
import { WorkMediaResolver } from './media.js';
import { externalSource, useMounts } from './mounts.js';
import { TagEditor } from './TagEditor.js';
import { WorkSession, type RemoteChange } from './work-session.js';

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];

const REMOTE_LABEL: Readonly<Record<RemoteChange['source'], string>> = {
  external: '外部編輯器',
  edit: '其他視窗或 Agent',
  restore: '其他視窗恢復版本',
  other: '其他來源',
};

export interface EditorPageProps {
  client: CreatorHubClient;
  work: WorkDetail;
  /** For showing mount folders as `~/…`. */
  userHome: string | null;
  onBack: () => void;
  /** Open 平台預覽 for this work (⌘P). */
  onPreview?: () => void;
  /** 「前往設定」 from the AI panel when no key or consent is set. */
  onOpenSettings?: () => void;
}

/**
 * 編輯頁 from the approved prototype plus PT-20261117-001: live
 * external-change notice, missing-file read-only state, external source
 * label, status and tags, Markdown images, history with restore, and the AI
 * panel (QC-024), which history replaces while open.
 */
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
  userHome,
  onBack,
  onPreview,
  onOpenSettings,
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

  // AI panel (QC-024): sessions live as long as this editor.
  const [ai, setAi] = useState<{ rewrite: RewriteSession; titles: TitleSession } | null>(null);
  useEffect(() => {
    const providers = new AiProviders(client);
    const rewrite = new RewriteSession(client, session, providers);
    const titles = new TitleSession(client, work.id, providers);
    setAi({ rewrite, titles });
    void rewrite.loadProvider();
    return () => {
      rewrite.dispose();
      titles.dispose();
    };
  }, [client, session, work.id]);
  const [selectionRange, setSelectionRange] = useState<MarkdownRange | null>(null);
  useEffect(() => {
    setSelectionRange(null);
  }, [state.epoch, editorKey]);
  const aiSelection = useMemo((): AiSelection => {
    const md = state.draft.markdown;
    const range =
      selectionRange !== null &&
      selectionRange.end <= md.length &&
      selectionRange.end > selectionRange.start
        ? selectionRange
        : null;
    if (range === null) return { range: null, label: '全文', words: countWords(md) };
    const n = blockNumbers(md, range);
    const label =
      n === null
        ? '全文'
        : n.first === n.last
          ? `第 ${String(n.first)} 段`
          : `第 ${String(n.first)}–${String(n.last)} 段`;
    return { range, label, words: countWords(md.slice(range.start, range.end)) };
  }, [selectionRange, state.draft.markdown]);

  const mounts = useMounts(client);
  const source = externalSource(work, mounts, userHome);

  const media = useMemo(
    () =>
      new WorkMediaResolver({
        load: () => client.works.media(work.id),
        absolute: (relative) => client.media.absoluteUrl(relative),
        // A newly typed image only resolves after the Markdown that names it is saved.
        beforeLookup: () => session.save(),
      }),
    [client, work.id, session],
  );
  const resolveImage = useCallback((src: string) => media.resolve(src), [media]);

  // Live changes to this work from the shared SSE channel.
  useChangeEvents((event) => {
    if (event.entity === 'job' && event.action.startsWith('ai_job.')) {
      void ai?.rewrite.jobChanged(event.entity_id);
      void ai?.titles.jobChanged(event.entity_id);
      return;
    }
    if (event.entity !== 'work' || event.entity_id !== work.id) return;
    const rid = typeof event.data['revision_id'] === 'string' ? event.data['revision_id'] : null;
    switch (event.action) {
      case 'work.external_revision':
        media.invalidate();
        if (rid !== null) void session.remoteRevision(rid, 'external');
        loadRevisions();
        break;
      case 'work.updated': {
        media.invalidate();
        const src = event.data['source'];
        if (rid !== null) {
          void session.remoteRevision(
            rid,
            src === 'edit' || src === 'restore' || src === 'external' ? src : 'other',
          );
        }
        loadRevisions();
        break;
      }
      case 'work.assets_changed':
        media.invalidate();
        break;
      case 'work.source_missing':
      case 'work.source_restored':
        session
          .refreshExternalState()
          .then(loadRevisions)
          .catch(() => undefined);
        break;
      default:
        break;
    }
  });
  // After a dropped connection, catch up with whatever happened meanwhile.
  const eventStatus = useEventStatus();
  const previousStatus = useRef(eventStatus);
  useEffect(() => {
    if (previousStatus.current === 'reconnecting' && eventStatus === 'open') {
      void session
        .refreshExternalState()
        .then(() =>
          client.works
            .get(work.id)
            .then((w) => session.remoteRevision(w.current_revision_id, 'other')),
        );
      loadRevisions();
    }
    previousStatus.current = eventStatus;
  }, [eventStatus, session, client, work.id, loadRevisions]);

  useEffect(() => {
    const m = editor.current?.getMode();
    if (m !== undefined) setMode(m);
  }, [editorKey, state.epoch]);

  // ⌘S save now, ⌘/ switch mode; never during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.isComposing || session.isComposing()) return;
      if (!e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void session.save();
      } else if (!e.shiftKey && e.key.toLowerCase() === 'p' && onPreview !== undefined) {
        e.preventDefault();
        void session.save().finally(onPreview);
      } else if (e.key === '/') {
        e.preventDefault();
        editor.current?.requestMode(editor.current.getMode() === 'visual' ? 'source' : 'visual');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [session, onPreview]);

  const readOnly = state.readOnly !== null;
  const save = readOnly ? { label: '唯讀', tone: 'neutral' as const } : SAVE_STATUS[state.status];
  const rev = numbers.get(state.baseRevision);
  const words = useMemo(() => countWords(state.draft.markdown), [state.draft.markdown]);
  const conflict = state.status === 'conflict';
  // The dialog opens on a 409 and stays open after resolving, until 返回編輯.
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (conflict) setDialogOpen(true);
  }, [conflict]);
  const offline = state.status === 'error' && state.errorMessage === '無法連線到服務';
  const remoteN = state.remote === null ? undefined : numbers.get(state.remote.revisionId);

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
            readOnly={readOnly}
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
          {source !== null && (
            <span className="src-ext" title={source.file ?? undefined}>
              <Icon name="folder" size={12} />
              {source.folder === null ? (
                source.label
              ) : (
                <>
                  外部掛載 · <span className="mono">{source.folder}</span>
                </>
              )}
            </span>
          )}
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
            {onPreview !== undefined && (
              <button
                type="button"
                className="btn"
                aria-keyshortcuts="Meta+P"
                onClick={() => {
                  void session.save().finally(onPreview);
                }}
              >
                <Icon name="phone" />
                預覽
              </button>
            )}
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

        <div className="editor__meta">
          <label className="meta-field">
            <span className="faint">狀態</span>
            <select
              className="select"
              value={state.draft.status}
              disabled={readOnly}
              onChange={(e) => {
                session.edit({ status: e.target.value as WorkStatus });
              }}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {WORK_STATUS[s].label}
                </option>
              ))}
            </select>
          </label>
          <TagEditor
            tags={state.draft.tags}
            disabled={readOnly}
            onChange={(tags) => {
              session.edit({ tags });
            }}
          />
        </div>

        {state.readOnly !== null && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text banner__text--wrap">
              <span>
                {state.readOnly === 'missing' ? '找不到原檔，唯讀' : '資料夾已卸載，唯讀'}
              </span>
              {source?.file != null && <span className="mono banner__path">{source.file}</span>}
              <span className="banner__hint">
                {state.readOnly === 'missing'
                  ? '放回原處後自動恢復'
                  : '在設定重新掛載這個資料夾後恢復'}
                {session.hasUnsavedChanges() && '；這個視窗的修改會保留，恢復後再儲存'}
              </span>
            </span>
            {state.readOnly === 'missing' && work.mount_id != null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (work.mount_id != null) {
                    void window.creatorhub?.reveal({ kind: 'mount', id: work.mount_id });
                  }
                }}
              >
                在 Finder 顯示資料夾
              </button>
            )}
          </div>
        )}

        {state.remote !== null && (
          <div className="banner banner--warn" role="alert">
            <Icon name="alert" />
            <span className="banner__text">
              檔案已在外部修改 · {REMOTE_LABEL[state.remote.source]}
              {remoteN !== undefined && ` · r${remoteN}`}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.compareRemote();
              }}
            >
              比對並合併
            </button>
            <button
              type="button"
              className="btn btn--ghost banner__warn-action"
              onClick={() => {
                session.reloadFromServer().catch(() => undefined);
              }}
            >
              捨棄我的修改並重新載入
            </button>
          </div>
        )}

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
          <section
            className={readOnly ? 'editor__doc editor__doc--readonly' : 'editor__doc'}
            aria-label="正文"
          >
            <MarkdownEditor
              key={`${work.id}:${editorKey}:${state.epoch}`}
              ref={editor}
              markdown={state.draft.markdown}
              readOnly={readOnly}
              resolveImage={resolveImage}
              showModeSwitch={false}
              onModeChange={setMode}
              onChange={(markdown) => {
                session.edit({ markdown });
              }}
              onCompositionChange={(composing) => {
                session.setComposing(composing);
              }}
              onSelectionChange={setSelectionRange}
            />
          </section>

          {!historyOpen && ai !== null && (
            <AiPanel
              rewrite={ai.rewrite}
              titles={ai.titles}
              selection={aiSelection}
              readOnly={readOnly}
              revisionNumber={(id) => numbers.get(id)}
              onOpenSettings={() => {
                void session.save().finally(() => onOpenSettings?.());
              }}
            />
          )}

          {historyOpen && (
            <HistoryPanel
              client={client}
              workId={work.id}
              revisions={revisions}
              numbers={numbers}
              currentRevision={state.baseRevision}
              currentMarkdown={state.saved.markdown}
              currentTitle={state.saved.title}
              readOnly={readOnly}
              onRestore={(rid) => session.restore(rid)}
              onClose={() => {
                setHistoryOpen(false);
              }}
            />
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
