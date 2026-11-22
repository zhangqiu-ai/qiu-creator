import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  charCount,
  type AssetRecord,
  type Platform,
  type Revision,
  type WorkDetail,
  type WorkMediaItem,
  type WorkStatus,
} from '@qiu-creator/contracts';
import { buildPreviewModel, PLATFORMS } from '@qiu-creator/platform-preview';
import { PlatformPreview } from '@qiu-creator/platform-preview/react';
import '@qiu-creator/platform-preview/style.css';
import { formatShortDate } from '@qiu-creator/i18n';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'motion/react';
import { thumbnailUrl } from '../shared/bridge.js';
import { dropAnimationFor, sortTransition, useDragSensors, type Landing } from './dnd-motion.js';
import { springOf } from './motion.js';
import { useMotionMode, type MotionMode } from './motion-mode.js';
import { Chip } from './Chip.js';
import { SaveChip } from './SaveChip.js';
import { Dialog } from './Dialog.js';
import { sessionHandle, type EditorTabHandle } from './tab-handle.js';
import { imageFiles, InsertSession, type InsertState, type InsertWhere } from './editor-insert.js';
import { useChangeEvents } from './events.js';
import { SAVE_STATUS, WORK_STATUS } from './format.js';
import { HistoryPanel } from './HistoryPanel.js';
import { codeText, t, useLocale } from './i18n.js';
import { Icon } from './Icon.js';
import { useToast } from './toasts.js';
import {
  coverAssetId,
  DESCRIPTION_LIMIT,
  imageCounts,
  insertImage,
  moveImageTo,
  nudgeImage,
  platformsOverAt,
  removeImage,
  replaceImage,
  shortPlatform,
  titleCounts,
  type PlatformCount,
} from './image-post.js';
import { ASSET_DRAG_TYPE, AssetDrawer } from './InsertUI.js';
import { externalSource, useMounts } from './mounts.js';
import type { TabPanel, TabStatusPatch, TabView } from './tabs.js';
import { TagEditor } from './TagEditor.js';
import { ProjectTags } from './ProjectTags.js';
import { WorkSession, type Draft, type DraftCover, type SaveError } from './work-session.js';

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];
const EMPTY_INSERT: InsertState = { pending: [], notice: null };
/** Crops shown when choosing a cover (PT-20261121-001): 3:4, 1:1, 2.35:1. */
const COVER_CROPS = [
  { key: '3:4', ratio: '3 / 4' },
  { key: '1:1', ratio: '1 / 1' },
  { key: '2.35:1', ratio: '2.35 / 1' },
] as const;

export interface ImagePostEditorProps {
  client: CreatorHubClient;
  work: WorkDetail;
  userHome: string | null;
  onBack: () => void;
  onPreview?: () => void;
  active?: boolean;
  initialView?: TabView;
  initialDraft?: Draft | null;
  onTabStatus?: (patch: TabStatusPatch) => void;
  onViewChange?: (view: TabView) => void;
  onHandle?: (handle: EditorTabHandle | null) => void;
}

function saveErrorText(error: SaveError | null): string {
  if (error === null) return t('editor.saveFailed');
  if (error.kind === 'title_blank') return t('editor.titleRequired');
  if (error.kind === 'offline') return t('editor.saveOffline');
  return codeText(error.code);
}

/**
 * 貼圖編輯 (QC-045, PT-20261121-001 「v3 · 貼圖編輯」): an image grid (3:4
 * tiles, numbers, cover badge, drag or ⌥←→ to reorder, ⌫ to remove with 復原),
 * images from the library, upload, ⌘V or Finder (the QC-039 insert flow),
 * per-platform limits that only warn, a cover dialog with crop previews, the
 * title with each platform's count, a short description, topics, status,
 * history and a simulated platform preview at the side. Saves go through the
 * same `WorkSession` as articles: revisions, 409 and autosave.
 */
export function ImagePostEditor(props: ImagePostEditorProps) {
  const { client, work, onHandle } = props;
  const [session, setSession] = useState<WorkSession | null>(null);
  const initialDraft = useRef(props.initialDraft ?? null);
  useEffect(() => {
    const s = new WorkSession(client, work);
    let discarded = false;
    const back = initialDraft.current;
    initialDraft.current = null;
    if (back !== null) s.edit(back);
    setSession(s);
    onHandle?.(
      sessionHandle(s, () => {
        discarded = true;
      }),
    );
    return () => {
      onHandle?.(null);
      if (!discarded) s.close();
    };
  }, [client, work, onHandle]);
  if (session === null) return <main className="page" aria-busy="true" />;
  return <PostEditor {...props} session={session} />;
}

function PostEditor({
  client,
  work,
  userHome,
  onBack,
  onPreview,
  session,
  active = true,
  initialView,
  onTabStatus,
  onViewChange,
}: ImagePostEditorProps & { session: WorkSession }) {
  const locale = useLocale();
  const state = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.snapshot,
  );
  const draft = state.draft;
  const ids = useMemo(() => draft.images ?? [], [draft.images]);
  const cover = draft.cover ?? null;
  const readOnly = state.readOnly !== null;
  const mounts = useMounts(client);
  const source = externalSource(work, mounts, userHome);
  // External works keep their files in their own folder: nothing is copied in (QC-045/046 backend).
  const imagesLocked: string | null = readOnly
    ? t('editor.insertBlockedReadOnly')
    : work.storage_mode === 'external'
      ? t('imagePost.externalLocked')
      : null;

  const [panel, setPanel] = useState<TabPanel>(initialView?.panel ?? 'ai');
  const [platform, setPlatform] = useState<Platform>('xiaohongshu');
  const [coverOpen, setCoverOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<{
    label: string;
    images: string[];
    cover: DraftCover | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (undo === null && notice === null) return;
    const timer = setTimeout(() => {
      setUndo(null);
      setNotice(null);
    }, 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [undo, notice]);

  // ---- Media lookups ------------------------------------------------------------------------
  const itemFor = useMemo(() => {
    const map = new Map<string, WorkMediaItem>();
    for (const item of state.media?.images ?? []) {
      if (item.asset_id !== null) map.set(item.asset_id, item);
    }
    return map;
  }, [state.media]);
  /** Images without a library asset (external works): shown, not editable. */
  const loose = useMemo(
    () => (state.media?.images ?? []).filter((i) => i.asset_id === null),
    [state.media],
  );

  // ---- Edits ----------------------------------------------------------------------------------
  /** The missing image 重新指定 is replacing, and whether the next upload is the cover. */
  const replacingRef = useRef<string | null>(null);
  const coverUploadRef = useRef(false);
  const setImages = (images: string[], nextCover: DraftCover | null = cover) => {
    session.edit({ images, cover: nextCover });
  };
  const place = useCallback(
    (asset: AssetRecord, where: InsertWhere) => {
      const current = session.snapshot.draft.images ?? [];
      const target = replacingRef.current;
      if (target !== null) {
        replacingRef.current = null;
        session.edit({ images: replaceImage(current, target, asset.id) });
        return Promise.resolve();
      }
      if (coverUploadRef.current) {
        coverUploadRef.current = false;
        session.edit({ cover: { asset_id: asset.id } });
        return Promise.resolve();
      }
      const slot = typeof where === 'object' ? where.beforeBlock : 'end';
      session.edit({ images: insertImage(current, asset.id, slot) });
      return Promise.resolve();
    },
    [session],
  );
  const [insert, setInsert] = useState<InsertSession | null>(null);
  useEffect(() => {
    const s = new InsertSession({
      client,
      workId: work.id,
      insert: () => undefined,
      place,
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
  }, [client, work.id, place]);
  const insertState = useSyncExternalStore(
    useCallback((cb: () => void) => insert?.subscribe(cb) ?? (() => undefined), [insert]),
    () => insert?.getSnapshot() ?? EMPTY_INSERT,
  );
  useEffect(() => {
    if (insertState.notice === null) return;
    const timer = setTimeout(() => insert?.dismissNotice(), 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [insertState.notice, insert]);

  const remove = (id: string) => {
    const index = ids.indexOf(id);
    const before = { images: [...ids], cover };
    const next = removeImage(ids, cover, id);
    setImages(next.images, next.cover);
    setUndo({ label: t('imagePost.removed', { n: index + 1 }), ...before });
    setSelected(next.images[Math.min(index, next.images.length - 1)] ?? null);
  };

  // ---- Revisions and live changes -------------------------------------------------------------
  const [revisions, setRevisions] = useState<readonly Revision[]>([]);
  const loadRevisions = useCallback(() => {
    client.works
      .revisions(work.id)
      .then((r) => {
        setRevisions(r.items);
      })
      .catch(() => undefined);
  }, [client, work.id]);
  useEffect(loadRevisions, [loadRevisions, state.baseRevision]);
  const numbers = useMemo(
    () => new Map(revisions.map((r, i) => [r.revision_id, revisions.length - i])),
    [revisions],
  );
  useChangeEvents((event) => {
    if (event.entity !== 'work' || event.entity_id !== work.id) return;
    const rid = typeof event.data['revision_id'] === 'string' ? event.data['revision_id'] : null;
    if (event.action === 'work.updated' || event.action === 'work.external_revision') {
      const src = event.data['source'];
      if (rid !== null) {
        void session.remoteRevision(
          rid,
          event.action === 'work.external_revision'
            ? 'external'
            : src === 'edit' || src === 'restore' || src === 'external'
              ? src
              : 'other',
        );
      }
      loadRevisions();
    } else if (event.action === 'work.source_missing' || event.action === 'work.source_restored') {
      session
        .refreshExternalState()
        .then(loadRevisions)
        .catch(() => undefined);
    }
  });

  // ---- Tab: badges, view, shortcuts -----------------------------------------------------------
  useEffect(() => {
    onTabStatus?.({
      title: draft.title,
      unsaved: session.hasUnsavedChanges(),
      conflict: state.status === 'conflict' || state.remote !== null,
    });
  }, [state, draft.title, session, onTabStatus]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(initialView?.scrollTop ?? 0);
  const latest = useRef({ panel, onViewChange });
  latest.current = { panel, onViewChange };
  const reportView = useCallback(() => {
    latest.current.onViewChange?.({
      mode: null,
      selection: null,
      scrollTop: scrollTop.current,
      panel: latest.current.panel,
    });
  }, []);
  useEffect(() => {
    if (active) reportView();
  }, [panel, active, reportView]);
  // Leaving the front: read the scroll position before the pane is hidden (see EditorPage).
  useLayoutEffect(() => {
    if (!active) return;
    return () => {
      if (scrollRef.current !== null) scrollTop.current = scrollRef.current.scrollTop;
    };
  }, [active]);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) reportView();
    wasActive.current = active;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollTop.current;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, reportView]);
  useLayoutEffect(() => reportView, [reportView]);

  const fileInput = useRef<HTMLInputElement>(null);
  const upload = (opts: { cover?: boolean; replace?: string } = {}) => {
    coverUploadRef.current = opts.cover === true;
    replacingRef.current = opts.replace ?? null;
    fileInput.current?.click();
  };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.isComposing || session.isComposing()) return;
      const key = e.key.toLowerCase();
      if (!e.shiftKey && key === 's') {
        e.preventDefault();
        void session.save();
      } else if (!e.shiftKey && key === 'p' && onPreview !== undefined) {
        e.preventDefault();
        void session.save().finally(onPreview);
      } else if (e.shiftKey && key === 'i') {
        e.preventDefault();
        setPanel((p) => (p === 'assets' ? 'ai' : 'assets'));
      } else if (e.shiftKey && key === 'u') {
        e.preventDefault();
        if (imagesLocked === null) upload();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFiles([...(e.clipboardData?.files ?? [])]);
      if (files.length === 0) return;
      e.preventDefault();
      if (imagesLocked !== null) {
        setNotice(imagesLocked);
        return;
      }
      for (const f of files) void insert?.pasteImage(f, 'end');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [active, session, onPreview, insert, imagesLocked]);

  // ---- Grid drag and drop ---------------------------------------------------------------------
  const grid = useRef<HTMLDivElement>(null);
  const draggedAsset = useRef<AssetRecord | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; x: number; y: number; h: number } | null>(
    null,
  );
  const slotAt = (e: DragEvent<HTMLElement>) => {
    const root = grid.current;
    const tiles = [...(root?.querySelectorAll<HTMLElement>('[data-image-tile]') ?? [])];
    const box = root?.getBoundingClientRect();
    const ox = box?.left ?? 0;
    const oy = box?.top ?? 0;
    for (const [i, tile] of tiles.entries()) {
      const r = tile.getBoundingClientRect();
      if (e.clientY < r.bottom && e.clientX < r.left + r.width / 2) {
        return { index: i, x: r.left - ox - 5, y: r.top - oy, h: r.height };
      }
    }
    const last = tiles.at(-1)?.getBoundingClientRect();
    return last === undefined
      ? { index: 0, x: 0, y: 0, h: 0 }
      : { index: tiles.length, x: last.right - ox + 5, y: last.top - oy, h: last.height };
  };
  // Assets from the drawer and files from Finder still come in by HTML5 drag and drop.
  const dragKind = (types: readonly string[]) =>
    types.includes(ASSET_DRAG_TYPE) ? 'asset' : types.includes('Files') ? 'files' : null;

  // Reordering the images (QC-065): dnd-kit sortable across the grid; the other tiles make
  // room (`base`), the dropped one settles, Esc puts it back (DESIGN.md 動效 · 拖放).
  const motionMode = useMotionMode();
  const sensors = useDragSensors();
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing>('cancel');
  const onSortStart = (e: DragStartEvent) => {
    setDragId(String(e.active.id));
    setLanding('cancel');
  };
  const onSortOver = (e: DragOverEvent) => {
    setLanding(e.over === null || e.over.id === e.active.id ? 'cancel' : 'sort');
  };
  const onSortEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (e.over === null || imagesLocked !== null) return;
    const id = String(e.active.id);
    const from = ids.indexOf(id);
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0 || from === to) return;
    // moveImageTo puts the image before the one at the index it is given.
    setImages(moveImageTo(ids, id, to > from ? to + 1 : to));
  };

  // ---- Derived --------------------------------------------------------------------------------
  const save = readOnly
    ? { label: t('editor.readOnlyChip'), tone: 'neutral' as const }
    : SAVE_STATUS[state.status];
  const rev = numbers.get(state.baseRevision);
  const shownCover = coverAssetId(ids, cover);
  const counts = imageCounts(ids.length);
  const titles = titleCounts(draft.title);
  const over = counts.some((c) => c.over);
  const descLength = charCount(draft.markdown);
  const model = useMemo(
    () =>
      buildPreviewModel({
        platform,
        title: draft.title,
        body: draft.markdown,
        tags: draft.tags,
        coverUrl: shownCover === null ? null : thumbnailUrl(shownCover),
        imageUrls: ids.map(thumbnailUrl),
        workType: 'image',
        dateLabel: formatShortDate(locale, new Date(work.updated_at)),
        locale,
      }),
    [platform, draft.title, draft.markdown, draft.tags, shownCover, ids, locale, work.updated_at],
  );

  // Notices go through the shared queue (QC-045); a background tab shows none.
  const shownNotice = undo?.label ?? notice ?? insertState.notice?.message ?? null;
  useToast(
    !active || shownNotice === null
      ? null
      : {
          message: shownNotice,
          tone:
            undo !== null || (notice === null && insertState.notice?.tone === 'ok')
              ? 'ok'
              : notice !== null
                ? 'neutral'
                : 'bad',
          actions:
            undo === null
              ? []
              : [
                  {
                    label: t('imagePost.undo'),
                    onClick: () => {
                      setImages(undo.images, undo.cover);
                      setUndo(null);
                    },
                  },
                ],
          onClose: () => {
            setUndo(null);
            setNotice(null);
            insert?.dismissNotice();
          },
        },
  );

  const onTileKey = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (e.nativeEvent.isComposing || imagesLocked !== null) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setImages(nudgeImage(ids, id, e.key === 'ArrowLeft' ? -1 : 1));
      requestAnimationFrame(() => {
        document.getElementById(`post-img-${id}`)?.focus();
      });
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      remove(id);
    } else if (!e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const i = ids.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1);
      const next = ids[i];
      if (next !== undefined) document.getElementById(`post-img-${next}`)?.focus();
    }
  };

  return (
    <>
      <main
        className="page editor post"
        aria-label={t('imagePost.pageLabel')}
        inert={state.status === 'conflict'}
      >
        <header className="editor__bar">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t('editor.backToLibrary')}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
          <span className="post__kind">
            <Icon name="image" size={14} />
            {t('format.typeImage')}
          </span>
          {source !== null && (
            <span className="src-ext" title={source.file ?? undefined}>
              <Icon name="folder" size={12} />
              {source.label}
            </span>
          )}
          <span className="save-status" role="status" aria-live="polite">
            <SaveChip tone={save.tone} label={save.label} saving={state.status === 'saving'} />
          </span>
          {rev !== undefined && <Chip>r{rev}</Chip>}
          <div className="editor__actions">
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
              aria-expanded={panel === 'history'}
              onClick={() => {
                setPanel((p) => (p === 'history' ? 'ai' : 'history'));
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
              value={draft.status}
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
            tags={draft.tags}
            disabled={readOnly}
            onChange={(tags) => {
              session.edit({ tags });
            }}
          />
          <ProjectTags
            client={client}
            workId={work.id}
            title={draft.title}
            initial={work.project_ids}
          />
        </div>

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
        {state.remote !== null && (
          <div className="banner banner--warn" role="alert">
            <Icon name="alert" />
            <span className="banner__text">{t('imagePost.remoteChanged')}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.reloadFromServer().catch(() => undefined);
              }}
            >
              {t('editor.discardReload')}
            </button>
          </div>
        )}
        {state.readOnly !== null && (
          <div className="banner banner--bad" role="alert">
            <Icon name="alert" />
            <span className="banner__text">
              {t(
                state.readOnly === 'missing'
                  ? 'editor.readOnlyMissing'
                  : 'editor.readOnlyUnmounted',
              )}
            </span>
          </div>
        )}

        <div className="editor__body">
          <div
            ref={scrollRef}
            className="post__doc"
            onScroll={(e) => {
              if (active) scrollTop.current = e.currentTarget.scrollTop;
            }}
          >
            <section className="post__section" aria-label={t('imagePost.imagesLabel')}>
              <div className="post__head">
                <h2 className="post__h">
                  {t('imagePost.images')}
                  <span className="post__n">{ids.length + loose.length}</span>
                </h2>
                <div className="post__chips" aria-label={t('imagePost.platformCounts')}>
                  {counts.map((c) => (
                    <LimitChip key={c.platform} count={c} unit="images" />
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={imagesLocked !== null || (ids.length === 0 && cover === null)}
                  onClick={() => {
                    setCoverOpen(true);
                  }}
                >
                  <Icon name="image" size={14} />
                  {t('imagePost.setCover')}
                </button>
              </div>
              {over && (
                <p className="post__warn" role="status">
                  <Icon name="alert" size={14} />
                  {t('imagePost.overHint')}
                </p>
              )}
              {imagesLocked !== null && work.storage_mode === 'external' && (
                <p className="post__note">{imagesLocked}</p>
              )}

              <div
                ref={grid}
                className="post__grid"
                role="list"
                aria-label={t('imagePost.images')}
                onDragOver={(e) => {
                  const kind = dragKind([...e.dataTransfer.types]);
                  if (kind === null) return;
                  e.preventDefault();
                  if (imagesLocked !== null) {
                    e.dataTransfer.dropEffect = 'none';
                    return;
                  }
                  e.dataTransfer.dropEffect = 'copy';
                  setDropAt(slotAt(e));
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  setDropAt(null);
                }}
                onDrop={(e) => {
                  const kind = dragKind([...e.dataTransfer.types]);
                  if (kind === null) return;
                  e.preventDefault();
                  const slot = slotAt(e).index;
                  setDropAt(null);
                  if (imagesLocked !== null) return;
                  if (kind === 'asset') {
                    const asset = draggedAsset.current;
                    draggedAsset.current = null;
                    if (asset !== null) void insert?.insertAsset(asset, { beforeBlock: slot });
                  } else {
                    const files = [...e.dataTransfer.files];
                    const images = imageFiles(files);
                    if (images.length < files.length) setNotice(t('editor.onlyImages'));
                    void insert?.insertFiles(images, { beforeBlock: slot });
                  }
                }}
              >
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={onSortStart}
                  onDragOver={onSortOver}
                  onDragEnd={onSortEnd}
                  onDragCancel={() => {
                    setDragId(null);
                    setLanding('cancel');
                  }}
                  accessibility={{ restoreFocus: false }}
                >
                  <SortableContext items={[...ids]} strategy={rectSortingStrategy}>
                    {ids.map((id, i) => {
                      const item = itemFor.get(id);
                      const missing = item?.status === 'missing';
                      const overAt = platformsOverAt(i);
                      const isCover = shownCover === id;
                      const label = [
                        t('imagePost.imageN', { n: i + 1 }),
                        isCover ? t('imagePost.cover') : null,
                        missing ? t('imagePost.missing') : null,
                        overAt.length > 0
                          ? t('imagePost.overFor', {
                              platforms: overAt.map(shortPlatform).join('、'),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <SortableTile
                          key={id}
                          id={id}
                          disabled={imagesLocked !== null}
                          mode={motionMode}
                        >
                          {(sort) => (
                            <div
                              ref={sort.ref}
                              style={sort.style}
                              onPointerDown={sort.onPointerDown}
                              id={`post-img-${id}`}
                              role="listitem"
                              data-image-tile
                              tabIndex={0}
                              aria-label={label}
                              title={label}
                              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Backspace"
                              className={[
                                'post__tile',
                                selected === id ? 'post__tile--selected' : '',
                                overAt.length > 0 ? 'post__tile--over' : '',
                                missing ? 'post__tile--missing' : '',
                                sort.dragging ? 'post__tile--dragging' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onFocus={() => {
                                setSelected(id);
                              }}
                              onKeyDown={(e) => {
                                onTileKey(e, id);
                              }}
                            >
                              {missing ? (
                                <span className="post__missing">
                                  <Icon name="fileMissing" size={22} />
                                  <span>{t('imagePost.missing')}</span>
                                  <button
                                    type="button"
                                    className="btn btn--small"
                                    disabled={imagesLocked !== null}
                                    onClick={() => {
                                      replacingRef.current = id;
                                      setNotice(t('imagePost.repickHint', { n: i + 1 }));
                                      setPanel('assets');
                                    }}
                                  >
                                    {t('imagePost.repick')}
                                  </button>
                                </span>
                              ) : (
                                <img src={thumbnailUrl(id)} alt="" draggable={false} />
                              )}
                              {isCover && (
                                // A new cover: the badge slides over from the old one (snappy).
                                <motion.span
                                  layoutId={`post-cover-${work.id}`}
                                  transition={springOf('snappy')}
                                  className="post__badge"
                                >
                                  {t('imagePost.cover')}
                                </motion.span>
                              )}
                              <span className="post__num">{i + 1}</span>
                              {imagesLocked === null && (
                                <span className="post__hover">
                                  {!isCover && !missing && (
                                    <button
                                      type="button"
                                      className="btn btn--small"
                                      tabIndex={-1}
                                      onClick={() => {
                                        session.edit({ cover: { asset_id: id } });
                                      }}
                                    >
                                      {t('imagePost.makeCover')}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn--small"
                                    tabIndex={-1}
                                    aria-label={t('imagePost.removeN', { n: i + 1 })}
                                    onClick={() => {
                                      remove(id);
                                    }}
                                  >
                                    {t('common.remove')}
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </SortableTile>
                      );
                    })}
                  </SortableContext>
                  <DragOverlay dropAnimation={dropAnimationFor(landing, motionMode)}>
                    {dragId === null ? null : (
                      <div className="post__tile post__tile--lifted">
                        <img src={thumbnailUrl(dragId)} alt="" draggable={false} />
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>
                {loose.map((item, i) => (
                  <div
                    key={item.path}
                    role="listitem"
                    className={
                      item.status === 'missing'
                        ? 'post__tile post__tile--missing'
                        : 'post__tile post__tile--loose'
                    }
                    title={item.path}
                  >
                    <span className="post__missing">
                      <Icon name={item.status === 'missing' ? 'fileMissing' : 'image'} size={22} />
                      <span className="mono">{item.path}</span>
                    </span>
                    <span className="post__num">{ids.length + i + 1}</span>
                  </div>
                ))}
                {insertState.pending.map((p) => (
                  <div
                    key={p.key}
                    role="listitem"
                    className={
                      p.state === 'failed' ? 'post__tile post__tile--failed' : 'post__tile'
                    }
                    aria-label={
                      p.state === 'failed'
                        ? t('editor.uploadFailedWhy', {
                            error: p.error ?? t('editor.uploadFailed'),
                          })
                        : t('editor.uploadingLabel', { name: p.name })
                    }
                  >
                    {p.preview !== null && <img src={p.preview} alt="" />}
                    {p.state === 'failed' ? (
                      <span className="post__fail" role="alert">
                        <Icon name="alert" size={18} />
                        <span>{p.error ?? t('editor.uploadFailed')}</span>
                        <span className="post__fail-actions">
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => {
                              insert?.retry(p.key);
                            }}
                          >
                            {t('common.retry')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => {
                              insert?.remove(p.key);
                            }}
                          >
                            {t('common.remove')}
                          </button>
                        </span>
                      </span>
                    ) : (
                      <span
                        className="post__ring"
                        role="progressbar"
                        aria-valuenow={p.progress ?? undefined}
                      >
                        <svg viewBox="0 0 36 36" aria-hidden="true">
                          <circle cx="18" cy="18" r="15" className="post__ring-bg" />
                          <circle
                            cx="18"
                            cy="18"
                            r="15"
                            className="post__ring-fg"
                            strokeDasharray={`${String(((p.progress ?? 15) / 100) * 94.2)} 94.2`}
                          />
                        </svg>
                        <span>{p.state === 'attaching' ? '…' : `${String(p.progress ?? 0)}%`}</span>
                      </span>
                    )}
                  </div>
                ))}
                {imagesLocked === null && (
                  <AddTile
                    onLibrary={() => {
                      setPanel('assets');
                    }}
                    onUpload={() => {
                      upload();
                    }}
                  />
                )}
                {dropAt !== null && (
                  <span
                    className="post__insert"
                    style={{ left: dropAt.x, top: dropAt.y, height: dropAt.h }}
                    aria-hidden="true"
                  />
                )}
              </div>
              <p className="post__hint">{t('imagePost.addHint')}</p>
            </section>

            <section className="post__section">
              <label className="post__label" htmlFor={`post-title-${work.id}`}>
                {t('editor.titleLabel')}
              </label>
              <input
                id={`post-title-${work.id}`}
                className="input post__title"
                readOnly={readOnly}
                value={draft.title}
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
              <div className="post__chips" aria-label={t('imagePost.titleCounts')}>
                {titles.map((c) => (
                  <LimitChip key={c.platform} count={c} unit="chars" />
                ))}
              </div>
            </section>

            <section className="post__section">
              <div className="post__label">
                <label htmlFor={`post-desc-${work.id}`}>{t('imagePost.description')}</label>
                <span
                  className={
                    descLength > DESCRIPTION_LIMIT ? 'post__count post__count--over' : 'post__count'
                  }
                >
                  {t('imagePost.charsOf', { count: descLength, limit: DESCRIPTION_LIMIT })}
                </span>
              </div>
              <textarea
                id={`post-desc-${work.id}`}
                className="input post__desc"
                readOnly={readOnly}
                value={draft.markdown}
                placeholder={t('imagePost.descriptionPlaceholder')}
                onChange={(e) => {
                  session.edit({ markdown: e.target.value });
                }}
                onCompositionStart={() => {
                  session.setComposing(true);
                }}
                onCompositionEnd={() => {
                  session.setComposing(false);
                }}
              />
            </section>
          </div>

          {panel === 'history' ? (
            <HistoryPanel
              client={client}
              workId={work.id}
              revisions={revisions}
              numbers={numbers}
              currentRevision={state.baseRevision}
              currentMarkdown={state.file}
              currentTitle={state.saved.title}
              readOnly={readOnly}
              onRestore={(rid) => session.restore(rid)}
              onClose={() => {
                setPanel('ai');
              }}
            />
          ) : panel === 'assets' ? (
            <AssetDrawer
              client={client}
              workId={work.id}
              forPost
              disabledReason={imagesLocked}
              onInsert={(asset) => {
                void insert?.insertAsset(asset, 'end');
              }}
              onDragAsset={(asset) => {
                draggedAsset.current = asset;
              }}
              onClose={() => {
                replacingRef.current = null;
                setPanel('ai');
              }}
            />
          ) : (
            <aside className="panel post__side" aria-label={t('imagePost.sidePanel')}>
              <div className="ai__tabs">
                <div className="ai__tab-list" role="tablist" aria-label={t('imagePost.sidePanel')}>
                  <button type="button" role="tab" className="ai__tab" aria-selected>
                    {t('editor.preview')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className="ai__tab"
                    aria-selected={false}
                    aria-keyshortcuts="Meta+Shift+I"
                    onClick={() => {
                      setPanel('assets');
                    }}
                  >
                    {t('editor.assets')}
                  </button>
                </div>
              </div>
              <div className="post__preview">
                <div
                  className="seg post__platforms"
                  role="group"
                  aria-label={t('imagePost.previewPlatform')}
                >
                  {PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={platform === p}
                      onClick={() => {
                        setPlatform(p);
                      }}
                    >
                      {shortPlatform(p)}
                    </button>
                  ))}
                </div>
                <PlatformPreview model={model} locale={locale} />
                <p className="post__hint">{t('imagePost.previewHint')}</p>
              </div>
            </aside>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = imageFiles([...(e.target.files ?? [])]);
            e.target.value = '';
            if (imagesLocked === null) void insert?.insertFiles(files, 'end');
          }}
        />
      </main>

      {state.status === 'conflict' && (
        <Dialog
          title={t('imagePost.conflictTitle')}
          closable={false}
          onClose={() => undefined}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void session.keepBoth().catch(() => undefined);
                }}
              >
                {t('imagePost.keepMineAsCopy')}
              </button>
              <button
                type="button"
                className="btn btn--primary dialog__primary"
                data-autofocus
                onClick={() => {
                  session.reloadFromServer().catch(() => undefined);
                }}
              >
                {t('editor.discardReload')}
              </button>
            </>
          }
        >
          <p>{t('imagePost.conflictBody')}</p>
        </Dialog>
      )}

      {coverOpen && (
        <CoverDialog
          ids={ids}
          current={shownCover}
          explicit={cover !== null}
          onClose={() => {
            setCoverOpen(false);
          }}
          onPick={(id) => {
            session.edit({ cover: id === null ? null : { asset_id: id } });
            setCoverOpen(false);
          }}
          onUpload={() => {
            setCoverOpen(false);
            upload({ cover: true });
          }}
        />
      )}
    </>
  );
}

function LimitChip({ count, unit }: { count: PlatformCount; unit: 'images' | 'chars' }) {
  const text =
    count.limit === null
      ? t(unit === 'images' ? 'imagePost.countNoLimit' : 'imagePost.charsNoLimit', {
          platform: shortPlatform(count.platform),
          count: count.actual,
        })
      : t(unit === 'images' ? 'imagePost.countOfLimit' : 'imagePost.charsOfLimit', {
          platform: shortPlatform(count.platform),
          count: count.actual,
          limit: count.limit,
        });
  return <span className={count.over ? 'chip chip--warn' : 'chip'}>{text}</span>;
}

function AddTile({ onLibrary, onUpload }: { onLibrary: () => void; onUpload: () => void }) {
  return (
    <div className="post__tile post__add" role="listitem">
      <Icon name="plus" size={22} />
      <span className="post__add-label">{t('imagePost.addImages')}</span>
      <button
        type="button"
        className="btn btn--small"
        aria-keyshortcuts="Meta+Shift+I"
        onClick={onLibrary}
      >
        <Icon name="assets" size={14} />
        {t('imagePost.fromLibrary')}
      </button>
      <button
        type="button"
        className="btn btn--small"
        aria-keyshortcuts="Meta+Shift+U"
        onClick={onUpload}
      >
        <Icon name="upload" size={14} />
        {t('imagePost.upload')}
      </button>
    </div>
  );
}

function CoverDialog({
  ids,
  current,
  explicit,
  onClose,
  onPick,
  onUpload,
}: {
  ids: readonly string[];
  current: string | null;
  /** A cover was chosen (not just "the first image"). */
  explicit: boolean;
  onClose: () => void;
  onPick: (id: string | null) => void;
  onUpload: () => void;
}) {
  const [pick, setPick] = useState<string | null>(current);
  return (
    <Dialog
      title={t('imagePost.coverTitle')}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onUpload}>
            <Icon name="upload" size={14} />
            {t('imagePost.coverUpload')}
          </button>
          {explicit && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                onPick(null);
              }}
            >
              {t('imagePost.coverFirst')}
            </button>
          )}
          <button type="button" className="btn dialog__primary" data-autofocus onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pick === null}
            onClick={() => {
              onPick(pick);
            }}
          >
            {t('imagePost.useCover')}
          </button>
        </>
      }
    >
      <p className="post__hint">{t('imagePost.coverHint')}</p>
      <div
        className="post__cover-pick"
        role="radiogroup"
        aria-label={t('imagePost.coverFromImages')}
      >
        {ids.map((id, i) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={pick === id}
            aria-label={t('imagePost.imageN', { n: i + 1 })}
            className="post__cover-opt"
            onClick={() => {
              setPick(id);
            }}
          >
            <img src={thumbnailUrl(id)} alt="" />
          </button>
        ))}
        {pick !== null && !ids.includes(pick) && (
          <button type="button" role="radio" aria-checked className="post__cover-opt">
            <img src={thumbnailUrl(pick)} alt="" />
          </button>
        )}
      </div>
      {pick !== null && (
        <div className="post__crops" aria-label={t('imagePost.cropPreview')}>
          {COVER_CROPS.map((c) => (
            <figure key={c.key} className="post__crop">
              <span className="post__crop-box" style={{ aspectRatio: c.ratio }}>
                <img src={thumbnailUrl(pick)} alt="" />
              </span>
              <figcaption>{c.key}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** One image tile as a dnd-kit sortable item (QC-065). */
function SortableTile({
  id,
  disabled,
  mode,
  children,
}: {
  id: string;
  disabled: boolean;
  mode: MotionMode;
  children: (sort: {
    ref: (node: HTMLElement | null) => void;
    style: CSSProperties;
    onPointerDown: PointerEventHandler<HTMLDivElement> | undefined;
    dragging: boolean;
  }) => ReactNode;
}) {
  const sortable = useSortable({ id, disabled, transition: sortTransition(mode) });
  return children({
    ref: sortable.setNodeRef,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
    },
    onPointerDown: sortable.listeners?.['onPointerDown'] as
      PointerEventHandler<HTMLDivElement> | undefined,
    dragging: sortable.isDragging,
  });
}
