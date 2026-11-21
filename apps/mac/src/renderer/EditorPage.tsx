import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord, Revision, WorkDetail, WorkStatus } from '@qiu-creator/contracts';
import {
  blockNumbers,
  MarkdownEditor,
  type EditorMode,
  type MarkdownEditorHandle,
  type MarkdownRange,
} from '@qiu-creator/markdown-editor-web';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { codeText, t, useLocale } from './i18n.js';
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
import {
  WorkSession,
  type ReadOnlyReason,
  type RemoteChange,
  type SaveError,
} from './work-session.js';
import { imageFiles, InsertSession, type InsertState, type InsertWhere } from './editor-insert.js';
import {
  ASSET_DRAG_TYPE,
  AssetDrawer,
  DropIndicator,
  dropFrame,
  dropScrollStep,
  type DropFrame,
  InsertMenu,
  PendingInserts,
  SlashMenu,
  type SlashCommand,
} from './InsertUI.js';

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];
const EMPTY_INSERT: InsertState = { pending: [], notice: null };

/** True when the caret sits in an empty block (where `/` opens the insert menu). */
function caretInEmptyBlock(root: Element | null, source: HTMLTextAreaElement | null): boolean {
  if (source !== null) {
    const v = source.value;
    const at = source.selectionStart;
    if (at !== source.selectionEnd) return false;
    const start = v.lastIndexOf('\n', at - 1) + 1;
    const end = v.indexOf('\n', at);
    return v.slice(start, end === -1 ? v.length : end).trim() === '';
  }
  const sel = window.getSelection();
  if (root === null || sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  let n: Node | null = sel.anchorNode;
  while (n !== null && n.parentNode !== root) n = n.parentNode;
  return n instanceof Element && n.textContent.trim() === '';
}

/**
 * Visual mode: the Markdown block boundary at the empty block holding the caret.
 * An empty paragraph is not in the Markdown, so count the non-empty blocks before it.
 */
function emptyBlockBoundary(root: Element | null): number | null {
  const sel = window.getSelection();
  if (root === null || sel === null || sel.rangeCount === 0) return null;
  let n: Node | null = sel.anchorNode;
  while (n !== null && n.parentNode !== root) n = n.parentNode;
  if (!(n instanceof Element)) return null;
  let count = 0;
  for (const child of Array.from(root.children)) {
    if (child === n) return count;
    const empty =
      child.tagName !== 'HR' &&
      child.textContent.trim() === '' &&
      Array.from(child.children).every((ch) => ch.tagName === 'BR');
    if (!empty) count += 1;
  }
  return null;
}

/** Where the caret is on screen, for the `/` menu. */
function caretPoint(source: HTMLTextAreaElement | null): { x: number; y: number } | null {
  if (source !== null) {
    const r = source.getBoundingClientRect();
    const style = getComputedStyle(source);
    const line = parseFloat(style.lineHeight) || 24;
    const before = source.value.slice(0, source.selectionStart).split('\n').length - 1;
    return {
      x: r.left + (parseFloat(style.paddingLeft) || 0),
      y: r.top + (parseFloat(style.paddingTop) || 0) + (before + 1) * line - source.scrollTop,
    };
  }
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const el =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    if (el === null) return null;
    rect = el.getBoundingClientRect();
  }
  return { x: rect.left, y: rect.bottom + 4 };
}

const REMOTE_LABEL: Readonly<Record<RemoteChange['source'], string>> = {
  get external() {
    return t('editor.remoteExternal');
  },
  get edit() {
    return t('editor.remoteEdit');
  },
  get restore() {
    return t('editor.remoteRestore');
  },
  get other() {
    return t('editor.remoteOther');
  },
};

/** What to do about a read-only work, plus the promise that unsaved edits are kept. */
function readOnlyHint(reason: ReadOnlyReason, session: WorkSession): string {
  const hint = t(
    reason === 'missing' ? 'editor.readOnlyMissingHint' : 'editor.readOnlyUnmountedHint',
  );
  return session.hasUnsavedChanges() ? t('editor.readOnlyHintKept', { hint }) : hint;
}

/** Why the last save failed, in the user's words (never the service's own message). */
function saveErrorText(error: SaveError | null): string {
  if (error === null) return t('editor.saveFailed');
  if (error.kind === 'title_blank') return t('editor.titleRequired');
  if (error.kind === 'offline') return t('editor.saveOffline');
  return codeText(error.code);
}

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
  const locale = useLocale();
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );
  const editor = useRef<MarkdownEditorHandle>(null);
  /** Bumped when the draft is replaced from outside the editor, to remount it. */
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<EditorMode>('visual');
  const [historyOpen, setHistoryOpen] = useState(false);
  // QC-039: the asset drawer replaces the AI panel while open (⌘⇧I).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [slashAt, setSlashAt] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Where the next insert from the `/` menu goes (computed when `/` is pressed). */
  const pendingWhere = useRef<InsertWhere | null>(null);
  const takeWhere = (): InsertWhere => {
    const w = pendingWhere.current ?? 'caret';
    pendingWhere.current = null;
    return w;
  };
  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => {
      clearTimeout(t);
    };
  }, [notice]);
  const [drop, setDrop] = useState<{
    frame: DropFrame;
    y: number | null;
    label: string;
    where: InsertWhere;
  } | null>(null);
  const draggedAsset = useRef<AssetRecord | null>(null);
  const docRef = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [insert, setInsert] = useState<InsertSession | null>(null);
  useEffect(() => {
    // Created in the effect: StrictMode would dispose an instance made during render.
    const s = new InsertSession({
      client,
      workId: work.id,
      insert: (markdown, where) => {
        editor.current?.insertBlock(markdown, where);
      },
      bridge: window.creatorhub ?? null,
      createPreview: (blob) => URL.createObjectURL(blob),
      revokePreview: (url) => {
        URL.revokeObjectURL(url);
      },
    });
    setInsert(s);
    return () => {
      s.dispose();
    };
  }, [client, work.id]);
  const insertState = useSyncExternalStore(
    useCallback((cb: () => void) => insert?.subscribe(cb) ?? (() => undefined), [insert]),
    () => insert?.getSnapshot() ?? EMPTY_INSERT,
  );
  useEffect(() => {
    if (insertState.notice === null) return;
    const t = setTimeout(() => insert?.dismissNotice(), 5000);
    return () => {
      clearTimeout(t);
    };
  }, [insertState.notice, insert]);
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
  const [ai, setAi] = useState<{
    providers: AiProviders;
    rewrite: RewriteSession;
    titles: TitleSession;
  } | null>(null);
  useEffect(() => {
    const providers = new AiProviders(client);
    const rewrite = new RewriteSession(client, session, providers);
    const titles = new TitleSession(client, work.id, providers);
    setAi({ providers, rewrite, titles });
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
    if (range === null)
      return { range: null, label: t('editor.selectionAll'), words: countWords(md) };
    const n = blockNumbers(md, range);
    const label =
      n === null
        ? t('editor.selectionAll')
        : n.first === n.last
          ? t('editor.selectionParagraph', { n: n.first })
          : t('editor.selectionParagraphs', { first: n.first, last: n.last });
    return { range, label, words: countWords(md.slice(range.start, range.end)) };
  }, [selectionRange, state.draft.markdown, locale]);

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
      } else if (e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        setHistoryOpen(false);
      } else if (e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [session, onPreview]);

  const readOnly = state.readOnly !== null;
  // External works keep their images in their own folder; nothing is copied into it (QC-039).
  const insertBlocked: string | null = readOnly
    ? t('editor.insertBlockedReadOnly')
    : work.storage_mode === 'external'
      ? t('editor.insertBlockedExternal')
      : null;
  const openDrawer = () => {
    setHistoryOpen(false);
    setDrawerOpen(true);
  };
  const slashCommands: SlashCommand[] = [
    {
      key: 'library',
      label: t('editor.slashLibrary'),
      hint: '⌘⇧I',
      icon: 'assets',
      run: openDrawer,
    },
    {
      key: 'upload',
      label: t('editor.uploadImage'),
      hint: '⌘⇧U',
      icon: 'upload',
      run: () => {
        fileInput.current?.click();
      },
    },
    {
      key: 'divider',
      label: t('editor.slashDivider'),
      hint: '---',
      icon: 'lines',
      run: () => {
        editor.current?.insertBlock('---', takeWhere());
      },
    },
  ];
  const sourceArea = () =>
    docRef.current?.querySelector<HTMLTextAreaElement>('textarea.qc-md-editor__source') ?? null;
  const dropTarget = (clientY: number): { where: InsertWhere; y: number | null } => {
    const doc = docRef.current;
    const b = editor.current?.boundaryAt(clientY) ?? null;
    if (doc === null || b === null) return { where: 'caret', y: null };
    const top = doc.getBoundingClientRect().top;
    return { where: { beforeBlock: b.index }, y: b.y - top + doc.scrollTop };
  };
  const dragKind = (types: readonly string[]): 'asset' | 'files' | null =>
    types.includes(ASSET_DRAG_TYPE) ? 'asset' : types.includes('Files') ? 'files' : null;
  const save = readOnly
    ? { label: t('editor.readOnlyChip'), tone: 'neutral' as const }
    : SAVE_STATUS[state.status];
  const rev = numbers.get(state.baseRevision);
  const words = useMemo(() => countWords(state.draft.markdown), [state.draft.markdown]);
  const conflict = state.status === 'conflict';
  // The dialog opens on a 409 and stays open after resolving, until 返回編輯.
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (conflict) setDialogOpen(true);
  }, [conflict]);
  const remoteN = state.remote === null ? undefined : numbers.get(state.remote.revisionId);

  return (
    <>
      <main className="page editor" aria-label={t('editor.pageLabel')} inert={dialogOpen}>
        <header className="editor__bar">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('editor.backToLibrary')}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
          <input
            className="editor__title"
            aria-label={t('editor.titleLabel')}
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
                  {t('format.sourceExternal')} · <span className="mono">{source.folder}</span>
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
              {t('common.retry')}
            </button>
          )}
          {rev !== undefined && <Chip>r{rev}</Chip>}
          <span className="editor__words">{t('editor.wordCount', { count: words })}</span>
          <div className="editor__actions">
            <div className="seg" role="group" aria-label={t('editor.modeGroup')}>
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
                  {t(m === 'visual' ? 'editor.modeVisual' : 'editor.modeSource')}
                </button>
              ))}
            </div>
            <InsertMenu
              disabled={insertBlocked !== null}
              disabledReason={insertBlocked}
              onLibrary={openDrawer}
              onUpload={() => {
                fileInput.current?.click();
              }}
            />
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
                {t('editor.preview')}
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
              {t('editor.history')}
            </button>
          </div>
        </header>

        <div className="editor__meta">
          <label className="meta-field">
            <span className="faint">{t('editor.statusLabel')}</span>
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
                {t(
                  state.readOnly === 'missing'
                    ? 'editor.readOnlyMissing'
                    : 'editor.readOnlyUnmounted',
                )}
              </span>
              {source?.file != null && <span className="mono banner__path">{source.file}</span>}
              <span className="banner__hint">{readOnlyHint(state.readOnly, session)}</span>
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
                {t('editor.revealFolder')}
              </button>
            )}
          </div>
        )}

        {state.remote !== null && (
          <div className="banner banner--warn" role="alert">
            <Icon name="alert" />
            <span className="banner__text">
              {t('editor.remoteChanged', { source: REMOTE_LABEL[state.remote.source] })}
              {remoteN !== undefined && ` · r${remoteN}`}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.compareRemote();
              }}
            >
              {t('editor.compareMerge')}
            </button>
            <button
              type="button"
              className="btn btn--ghost banner__warn-action"
              onClick={() => {
                session.reloadFromServer().catch(() => undefined);
              }}
            >
              {t('editor.discardReload')}
            </button>
          </div>
        )}

        {state.status === 'error' && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">{saveErrorText(state.error)}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void session.save();
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        <div className="editor__body">
          <section
            ref={docRef}
            className={readOnly ? 'editor__doc editor__doc--readonly' : 'editor__doc'}
            aria-label={t('editor.docLabel')}
            onKeyDownCapture={(e) => {
              // `/` on an empty line opens the insert menu instead of typing a slash.
              if (
                e.key !== '/' ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey ||
                e.nativeEvent.isComposing
              ) {
                return;
              }
              if (insertBlocked !== null) return;
              const root = docRef.current?.querySelector('.qc-md-editor__content') ?? null;
              const source = sourceArea();
              if (
                !caretInEmptyBlock(
                  mode === 'source' ? null : root,
                  mode === 'source' ? source : null,
                )
              ) {
                return;
              }
              const at = caretPoint(mode === 'source' ? source : null);
              if (at === null) return;
              e.preventDefault();
              e.stopPropagation();
              const boundary = mode === 'source' ? null : emptyBlockBoundary(root);
              pendingWhere.current = boundary === null ? 'caret' : { beforeBlock: boundary };
              setSlashAt(at);
            }}
            onPasteCapture={(e) => {
              const images = imageFiles([...e.clipboardData.files]);
              if (images.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (insertBlocked !== null) return;
              for (const f of images) void insert?.pasteImage(f, 'caret');
            }}
            onDragOverCapture={(e) => {
              const kind = dragKind([...e.dataTransfer.types]);
              if (kind === null) return;
              e.preventDefault();
              e.stopPropagation();
              if (insertBlocked !== null) {
                e.dataTransfer.dropEffect = 'none';
                return;
              }
              e.dataTransfer.dropEffect = 'copy';
              const doc = e.currentTarget;
              // Near the top or bottom edge, scroll so the line can reach any block.
              const docTop = doc.getBoundingClientRect().top + doc.clientTop;
              const before = dropFrame(doc);
              const step = dropScrollStep(
                e.clientY,
                docTop + before.top - doc.scrollTop,
                docTop + before.top - doc.scrollTop + before.height,
              );
              if (step !== 0) doc.scrollTop += step;
              const frame = dropFrame(doc);
              const target = dropTarget(e.clientY);
              const n = [...e.dataTransfer.items].filter((i) => i.kind === 'file').length;
              const dragged = draggedAsset.current;
              const label =
                kind === 'asset'
                  ? t('editor.dropInsertAsset', {
                      name:
                        dragged === null
                          ? t('editor.assets')
                          : (dragged.display_name ?? dragged.original_name ?? t('editor.assets')),
                    })
                  : t('editor.dropInsertFiles', { count: Math.max(n, 1) });
              setDrop({ frame, y: target.y, label, where: target.where });
            }}
            onScroll={(e) => {
              // Keep the frame on the visible area while the content scrolls under it.
              const doc = e.currentTarget;
              setDrop((d) => (d === null ? d : { ...d, frame: dropFrame(doc) }));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDrop(null);
            }}
            onDropCapture={(e) => {
              const kind = dragKind([...e.dataTransfer.types]);
              if (kind === null) return;
              e.preventDefault();
              e.stopPropagation();
              // Where the pointer is now (the last dragover may not have rendered yet).
              const where = dropTarget(e.clientY).where;
              setDrop(null);
              if (insertBlocked !== null) return;
              if (kind === 'asset') {
                const asset = draggedAsset.current;
                draggedAsset.current = null;
                if (asset !== null) void insert?.insertAsset(asset, where);
                return;
              }
              const files = [...e.dataTransfer.files];
              const images = imageFiles(files);
              if (images.length < files.length) {
                setNotice(t('editor.onlyImages'));
              }
              void insert?.insertFiles(images, where);
            }}
          >
            <PendingInserts
              pending={insertState.pending}
              onRetry={(key) => {
                insert?.retry(key);
              }}
              onRemove={(key) => {
                insert?.remove(key);
              }}
            />
            {drop !== null && <DropIndicator frame={drop.frame} y={drop.y} label={drop.label} />}
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
              locale={locale}
            />
          </section>

          {!historyOpen && drawerOpen && (
            <AssetDrawer
              client={client}
              workId={work.id}
              disabledReason={insertBlocked}
              onInsert={(asset) => {
                void insert?.insertAsset(asset, takeWhere());
              }}
              onDragAsset={(asset) => {
                draggedAsset.current = asset;
              }}
              onClose={() => {
                setDrawerOpen(false);
                editor.current?.focus();
              }}
            />
          )}

          {!historyOpen && !drawerOpen && ai !== null && (
            <AiPanel
              providers={ai.providers}
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
        {slashAt !== null && (
          <SlashMenu
            at={slashAt}
            commands={slashCommands}
            onClose={(ran) => {
              if (!ran) pendingWhere.current = null;
              setSlashAt(null);
            }}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            const where = takeWhere();
            if (insertBlocked === null) void insert?.insertFiles(imageFiles(files), where);
          }}
        />
        {(insertState.notice !== null || notice !== null) && (
          <div
            className={
              (insertState.notice?.tone ?? 'bad') === 'bad' && notice === null
                ? 'toast toast--bad'
                : 'toast'
            }
            role="status"
          >
            <Icon
              name={insertState.notice?.tone === 'ok' && notice === null ? 'check' : 'alert'}
              size={16}
            />
            <span className="toast__msg">{notice ?? insertState.notice?.message}</span>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--small"
              aria-label={t('editor.dismissNotice')}
              onClick={() => {
                setNotice(null);
                insert?.dismissNotice();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
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
