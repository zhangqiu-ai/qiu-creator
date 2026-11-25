import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  Mount,
  Work,
  WorkDetail,
  WorkListItem,
  WorkStatus,
  WorkType,
  WorkRef,
} from '@qiu-creator/contracts';
import { WORK_TRASH_RETENTION_DAYS } from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Chip } from './Chip.js';
import { anchorOf, ContextMenu, type MenuAnchor, type MenuEntry } from './ContextMenu.js';
import {
  clickSelect,
  contextTargets,
  EMPTY_SELECTION,
  keepShown,
  type Selection,
} from './library-select.js';
import {
  statusCounts as countByStatus,
  typeCounts as countByType,
  type ByTypeStatus,
} from './library-counts.js';
import { LibraryFeed } from './library-feed.js';
import { Highlight, HitLine, SearchHighlight } from './Highlight.js';
import { ActiveFilters, FilterMenu, type StatusFilter, type TypeFilter } from './LibraryFilter.js';
import { LoadMore } from './LoadMore.js';
import { RenameField } from './RenameField.js';
import { useToast, type ToastAction } from './toasts.js';
import {
  batchWorks,
  changeWork,
  freshRevisions,
  restoreWorks,
  trashWorks,
  type EditorHandles,
} from './work-actions.js';
import { useChangeEvents, useRefreshOn } from './events.js';
import { MembershipCache, MembershipContext, WorkProjectLabel } from './agent-assign.js';
import {
  LiveAction,
  LiveAgentCell,
  LiveCardLayer,
  LiveHeader,
  useLive,
  useWorkLive,
} from './AgentLive.js';
import { formatWhen, sourceLabel, WORK_STATUS, WORK_TYPE } from './format.js';
import { CardCover } from './WorkCover.js';
import { CardFrameQueue } from './card-frames.js';
import { DeleteDialog, TagsDialog } from './LibraryDialogs.js';
import { TrashView } from './LibraryTrash.js';
import { tagUndoGroups, unionTags } from './library-trash.js';
import {
  Animated,
  AnimatedItem,
  ExitFade,
  focusAfterRemoval,
  hasOpenLayer,
  LAYOUT_LIMIT,
  Presence,
  presetVariants,
  SettleIn,
  useSkeletonGate,
} from './motion.js';
import { moves, useMotionMode } from './motion-mode.js';
import { motion } from 'motion/react';
import { codeText, errorText, t } from './i18n.js';
import { Icon } from './Icon.js';
import { externalSource, useMounts } from './mounts.js';
import { projectEntries, useProjectAssetCount } from './LibraryProjects.js';
import { DragWorksButton } from './projects-dnd.js';
import { removeFromProject, renameProject, useNotice } from './project-actions.js';
import { NewProjectDialog, useProjectMenu } from './project-menu.js';
import {
  nextProjectColor,
  projectColor,
  projectLabel,
  type ProjectsState,
  type ProjectsStore,
} from './projects-store.js';
import type { LibraryScope } from './SidebarProjects.js';

type View = 'grid' | 'list';

/** What 新建 can make (QC-045; video since QC-046). */
export const NEW_TYPES: readonly { type: WorkType; enabled: boolean }[] = [
  { type: 'article', enabled: true },
  { type: 'image', enabled: true },
  { type: 'video', enabled: true },
];
const VIEW_KEY = 'qc.library.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function writeView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // per-viewer convenience only
  }
}

export interface LibraryPageProps {
  client: CreatorHubClient;
  /** For showing mount folders as `~/…`. */
  userHome: string | null;
  onOpen: (id: string) => void;
  onCreated: (work: WorkDetail) => void;
  /** 在新分頁開啟: add a tab without leaving 作品庫 (QC-052). */
  onOpenInBackground: (work: Pick<Work, 'id' | 'type' | 'title'>) => void;
  /** Editors open in tabs: renaming or re-statusing an open work goes through its editor. */
  handles: EditorHandles;
  /** A work was renamed here, so its tab (if any) shows the new title. */
  onRenamed: (id: string, title: string) => void;
  /** Works moved to 回收站 here: their tabs close. */
  onTrashed: (ids: readonly string[]) => void;
  /** 全部作品, 未分類 or one project (QC-062). */
  scope?: LibraryScope;
  projects?: ProjectsStore | null;
  projectsState?: ProjectsState;
  onScope?: (scope: LibraryScope) => void;
  /** 用到的素材 › of a project. */
  onOpenProjectAssets?: (projectId: string) => void;
  /** QC-097: 審閱提案 on a card waiting for you. */
  onOpenProposals?: () => void;
  /** QC-097: 重試 on a card whose agent hit an error (the failed jobs are in 匯入任務). */
  onOpenImports?: () => void;
}

const ALL: LibraryScope = { kind: 'all' };

/** A click on a card title waits this long for a second click (rename) before opening. */
/**
 * A work as selection and batch actions see it (QC-067): a loaded card, or
 * the lighter ref ⌘A fetches for works not loaded yet.
 */
type LibraryWork = Omit<WorkRef, 'project_ids'> & { project_ids?: string[] | undefined };

const OPEN_DELAY_MS = 260;

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];

type Notice =
  | { kind: 'text'; message: string; tone: 'ok' | 'bad' | 'neutral' }
  | { kind: 'undo'; message: string; undo: () => void };

type Confirm =
  | { kind: 'delete'; works: readonly LibraryWork[] }
  | { kind: 'tags'; mode: 'add' | 'remove'; works: readonly LibraryWork[] };

/** True when an external work's file is gone or its folder unmounted (PT-20261117-001). */
export function isMissing(work: Pick<Work, 'external_state'>): boolean {
  return work.external_state === 'missing' || work.external_state === 'unmounted';
}

/**
 * 作品庫 from the approved prototype: search, type/status filters, grid or
 * list. Refreshes live from SSE work events; external works show their mount
 * and a 檔案遺失 chip when the file is gone (PT-20261117-001).
 */
export function LibraryPage({
  client,
  userHome,
  onOpen,
  onCreated,
  onOpenInBackground,
  handles,
  onRenamed,
  onTrashed,
  scope: libraryScope = ALL,
  projects: store = null,
  projectsState,
  onScope,
  onOpenProjectAssets,
  onOpenProposals,
  onOpenImports,
}: LibraryPageProps) {
  const projectList = projectsState?.projects ?? [];
  const project =
    libraryScope.kind === 'project'
      ? (projectList.find((p) => p.id === libraryScope.id) ?? null)
      : null;
  const projectId = libraryScope.kind === 'project' ? libraryScope.id : null;
  const unassigned = libraryScope.kind === 'unassigned';
  /** 回收站, opened from the foot of the sidebar (QC-069). */
  const inTrash = libraryScope.kind === 'trash';
  const notifyProject = useNotice();
  // QC-097: agents at work in this scope (the page header).
  const live = useLive();
  // QC-091: who put each work in its projects (an agent or a rule gets a mark on the card).
  const [memberships] = useState(
    () => new MembershipCache((id) => client.projects.workMemberships(id).then((r) => r.items)),
  );
  const membershipCtx = useMemo(
    () => ({
      cache: memberships,
      client,
      notify: (message: string, tone?: 'bad') => {
        notifyProject(tone === undefined ? { message } : { message, tone });
      },
    }),
    [memberships, client, notifyProject],
  );
  useChangeEvents((event) => {
    if (event.entity === 'work' && event.action === 'work.projects_changed') {
      memberships.invalidate(event.entity_id);
    }
  });
  // 作品庫分頁 (QC-067): the works matching the filter, a page at a time.
  const [feed] = useState(
    () =>
      new LibraryFeed<WorkListItem>(() =>
        Promise.resolve({ items: [], next_cursor: null, total: 0 }),
      ),
  );
  const feedState = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const works = feedState.items;
  /** Counts for the type and status filters: the service's totals for the whole filter. */
  const [facets, setFacets] = useState<ByTypeStatus>({});
  const [createFailed, setFailed] = useState(false);
  const failed = createFailed || (feedState.failed && works === null);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  /** What the loaded works mark as hits: every keystroke, never mid-composition (QC-068). */
  const [highlight, setHighlight] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  /** Where 回收站 puts its 清空 button (the header's tool area). */
  const [trashTools, setTrashTools] = useState<HTMLDivElement | null>(null);
  /** Works in the scope before searching or filtering (「共 M 個」, QC-069). */
  const [scopeTotal, setScopeTotal] = useState<number | null>(null);
  const trashRef = useRef(inTrash);
  useEffect(() => {
    trashRef.current = inTrash;
  }, [inTrash]);
  const searchRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  /** The filter as the service reads it: type and status filter on the service now. */
  const listQuery = useMemo(() => {
    const q = appliedQuery.trim();
    return {
      ...(q === '' ? {} : { q }),
      ...(projectId === null ? {} : { project_id: projectId }),
      ...(unassigned ? { unassigned: '1' as const } : {}),
      ...(type === 'all' ? {} : { type }),
      ...(status === 'all' ? {} : { status }),
    };
  }, [appliedQuery, projectId, unassigned, type, status]);

  /**
   * The filter's counts (these follow every change): works per type and
   * status among the search results, and how many the scope holds in all.
   */
  const loadCounts = useCallback(() => {
    const id = request.current;
    const q = appliedQuery.trim();
    const inScope = {
      ...(projectId === null ? {} : { project_id: projectId }),
      ...(unassigned ? { unassigned: '1' as const } : {}),
    };
    client.works
      .facets({ ...(q === '' ? {} : { q }), ...inScope })
      .then((res) => {
        if (id !== request.current) return;
        setFacets(res.by_type_status);
        if (q === '') setScopeTotal(res.total);
      })
      .catch(() => undefined);
    if (q !== '')
      client.works
        .facets(inScope)
        .then((res) => {
          if (id === request.current) setScopeTotal(res.total);
        })
        .catch(() => undefined);
  }, [client, appliedQuery, projectId, unassigned]);

  /** A new filter: start again from its first page. */
  const load = useCallback(() => {
    ++request.current;
    setFailed(false);
    setAllRefs(null);
    void feed.reset((cursor, limit) =>
      client.works
        .list({ ...listQuery, limit, ...(cursor === null ? {} : { cursor }) })
        .then((res) => ({ items: res.items, next_cursor: res.next_cursor, total: res.total })),
    );
    loadCounts();
  }, [client, feed, listQuery, loadCounts]);

  /** Something changed (here, elsewhere, on another device): read again as far as loaded. */
  const refresh = useCallback(() => {
    void feed.refresh();
    loadCounts();
  }, [feed, loadCounts]);

  useEffect(load, [load]);
  useRefreshOn(['work', 'project'], refresh, 300);

  // Card images (QC-061): signed URLs from the list; video frames the service could not
  // take are grabbed off-screen one at a time and uploaded, then the list is read again.
  const loadRef = useRef(refresh);
  useEffect(() => {
    loadRef.current = refresh;
  }, [refresh]);
  const [frames] = useState(
    () =>
      new CardFrameQueue(
        async (job, frame) => {
          const res = await window.creatorhub?.putCardFrame(
            job.workId,
            new Uint8Array(await frame.arrayBuffer()),
            { version: job.version, source: job.path, timeSeconds: job.timeSeconds },
          );
          if (res?.ok !== true) throw new Error(res?.code ?? 'frame upload failed');
        },
        undefined,
        (_job, ok) => {
          if (ok) loadRef.current();
        },
      ),
  );
  const imageUrl = useCallback((relative: string) => client.media.absoluteUrl(relative), [client]);
  const onNeedsFrame = useCallback(
    (w: WorkListItem) => {
      const card = w.card_image ?? null;
      const from = card?.frame_source;
      if (card === null || from === undefined) return;
      frames.enqueue({
        workId: w.id,
        version: card.version,
        assetId: from.asset_id,
        path: from.path,
        timeSeconds: from.time_seconds,
      });
    },
    [frames],
  );
  const mounts = useMounts(client);

  // Search is debounced and never runs while the IME is still composing.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = (value: string, composing: boolean) => {
    setQuery(value);
    if (timer.current !== null) clearTimeout(timer.current);
    if (composing) return;
    setHighlight(value);
    timer.current = setTimeout(() => {
      setAppliedQuery(value);
    }, 250);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const create = useCallback(
    (kind: WorkType = 'article') => {
      if (creating) return;
      setCreating(true);
      setMenuOpen(false);
      // The service never invents a title (QC-043): it is sent in the interface language.
      // Made inside a project: it starts in that project (QC-062).
      const inProject = projectId === null ? {} : { project_ids: [projectId] };
      client.works
        .create(
          kind === 'article'
            ? { title: t('library.untitledWork'), markdown: '', source: 'mac-app', ...inProject }
            : { title: t('library.untitledWork'), type: kind, source: 'mac-app', ...inProject },
        )
        .then(onCreated)
        .catch(() => {
          setFailed(true);
        })
        .finally(() => {
          setCreating(false);
        });
    },
    [client, creating, onCreated, projectId],
  );

  // ⌘N new work, ⌘F search; ignored during IME composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        setMenuOpen(true);
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
  }, []);

  // The service filters by type and status; what is loaded is what is shown.
  const shown = useMemo(() => works ?? [], [works]);
  // Faceted (QC-069): the type counts follow the chosen status, the status counts the
  // chosen type, and both count only what the search found.
  const typeCounts = useMemo(
    () => countByType(facets, status === 'all' ? null : status),
    [facets, status],
  );
  const counts = useMemo(() => countByStatus(facets, type), [facets, type]);
  const assetCount = useProjectAssetCount(store, project, works);

  // ---- Selection, rename, right-click menu (QC-052) ----
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; ids: readonly string[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const order = useMemo(() => shown.map((w) => w.id), [shown]);
  /**
   * ⌘A (QC-067): every work matching the filter, not only those loaded. The
   * service lists them all (`works.refs`); the selection holds their ids and
   * batch actions work on these refs.
   */
  const [allRefs, setAllRefs] = useState<readonly LibraryWork[] | null>(null);
  const allRefsRef = useRef(allRefs);
  allRefsRef.current = allRefs;
  const loadedById = useMemo(() => new Map(shown.map((w) => [w.id, w])), [shown]);
  const allRefsById = useMemo(() => new Map((allRefs ?? []).map((r) => [r.id, r])), [allRefs]);
  /** A work by id: its loaded card if there is one, else what ⌘A fetched. */
  const refById = (id: string): LibraryWork | undefined =>
    loadedById.get(id) ?? allRefsById.get(id);
  const latest = useRef({
    order,
    works,
    askDelete: (): void => undefined,
    selectAll: (): void => undefined,
  });
  useEffect(() => {
    latest.current = { ...latest.current, order, works };
    // With ⌘A the selection reaches past what is loaded: keep it.
    if (allRefsRef.current === null) setSelection((sel) => keepShown(sel, order));
  }, [order, works]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(
      () => {
        setNotice(null);
      },
      notice.kind === 'undo' ? 8000 : 5000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  const undoAction: ToastAction[] =
    notice?.kind === 'undo'
      ? [{ label: t('workActions.undo'), onClick: notice.undo, shortcut: undefined }]
      : [];
  useToast(
    notice === null
      ? null
      : {
          message: notice.message,
          tone: notice.kind === 'undo' ? 'ok' : notice.tone,
          actions: undoAction,
          onClose: () => {
            setNotice(null);
          },
        },
  );

  const patchLocal = useCallback(
    (id: string, change: Partial<WorkListItem>) => {
      feed.patch(id, change);
    },
    [feed],
  );
  /** Take what the service returned for changed works (new revisions, status, tags). */
  const applyServer = (changed: readonly Work[]) => {
    for (const w of changed) {
      patchLocal(w.id, {
        title: w.title,
        status: w.status,
        tags: w.tags,
        current_revision_id: w.current_revision_id,
        updated_at: w.updated_at,
      });
    }
  };
  const focusWork = (id: string) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-work-id="${id}"]`)?.focus();
    });
  };

  const rename = (w: WorkListItem, title: string) => {
    setRenaming(null);
    focusWork(w.id);
    patchLocal(w.id, { title });
    onRenamed(w.id, title);
    void changeWork(client, w, { title }, handles).then(({ outcome, work }) => {
      if (work !== null) {
        patchLocal(w.id, {
          current_revision_id: work.current_revision_id,
          updated_at: work.updated_at,
        });
      }
      if (outcome === 'saved' || outcome === 'pending') return;
      patchLocal(w.id, { title: w.title });
      onRenamed(w.id, w.title);
      setNotice({
        kind: 'text',
        tone: 'bad',
        message: t(
          outcome === 'conflict' ? 'workActions.renameConflict' : 'workActions.renameFailed',
          {
            title: w.title,
          },
        ),
      });
      load();
    });
  };

  /** Change the status of one or more works; 復原 puts each back (QC-052). */
  const changeStatus = async (
    targets: readonly LibraryWork[],
    status: WorkStatus,
    undoing = false,
  ) => {
    const changing = targets.filter((w) => w.status !== status);
    if (changing.length === 0) return;
    for (const w of changing) patchLocal(w.id, { status });
    // The newest revision this page knows of (a rename or an undo may have moved it).
    const current = changing.map((w) => latest.current.works?.find((x) => x.id === w.id) ?? w);
    const done: LibraryWork[] = [];
    const failed: { work: LibraryWork; reason: string }[] = [];
    const only = current[0];
    if (current.length === 1 && only !== undefined) {
      const { outcome, work } = await changeWork(client, only, { status }, handles);
      if (outcome === 'saved' || outcome === 'pending') {
        done.push(changing[0] ?? only);
        if (work !== null) applyServer([work]);
      } else {
        failed.push({ work: only, reason: t('workActions.statusFailed', { title: only.title }) });
      }
    } else {
      const ready = await freshRevisions(client, current, handles);
      const res = await batchWorks(client, { action: 'set_status', status }, ready);
      applyServer(res.ok);
      const bad = new Map(res.failed.map((f) => [f.id, f.code]));
      for (const w of changing) {
        if (bad.has(w.id)) failed.push({ work: w, reason: codeText(bad.get(w.id)) });
        else done.push(w);
      }
    }
    for (const f of failed) {
      const before = changing.find((w) => w.id === f.work.id);
      if (before !== undefined) patchLocal(before.id, { status: before.status });
    }
    const firstFailed = failed[0];
    if (firstFailed !== undefined) {
      setNotice({
        kind: 'text',
        tone: 'bad',
        message:
          done.length + failed.length === 1
            ? firstFailed.reason
            : t('workActions.partial', {
                done: done.length,
                failed: failed.length,
                reason: firstFailed.reason,
              }),
      });
      load();
      return;
    }
    if (undoing) {
      setNotice({ kind: 'text', tone: 'ok', message: t('workActions.undone') });
      return;
    }
    const first = done[0];
    if (first === undefined) return;
    const label = WORK_STATUS[status].label;
    setNotice({
      kind: 'undo',
      message:
        done.length === 1
          ? t('workActions.statusChanged', { title: first.title, status: label })
          : t('workActions.statusChangedMany', { count: done.length, status: label }),
      undo: () => {
        setNotice(null);
        void (async () => {
          // Each work goes back to its own earlier status.
          for (const previous of STATUS_ORDER) {
            const back = done.filter((w) => w.status === previous);
            if (back.length > 0)
              await changeStatus(
                back.map((w) => ({ ...w, status })),
                previous,
                true,
              );
          }
        })();
      },
    });
  };

  // ---- 刪除、標籤 (QC-052 on the QC-051 API) ----
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  /** Move works to 回收站; the notice's 復原 brings them back. */
  const deleteWorks = async (targets: readonly LibraryWork[], moveOriginal: boolean) => {
    setConfirm(null);
    setBusy(true);
    try {
      const ready = await freshRevisions(client, targets, handles);
      const res = await trashWorks(client, ready, { moveOriginal });
      const gone = new Set(res.ok.map((w) => w.id));
      // Focus moves on to the next card (or the one before), not back to the page.
      const next = focusAfterRemoval(latest.current.order, gone);
      feed.remove(gone);
      setAllRefs(null);
      if (next !== null) focusWork(next);
      setSelection(EMPTY_SELECTION);
      if (gone.size > 0) onTrashed([...gone]);
      const firstFailed = res.failed[0];
      if (firstFailed !== undefined) {
        setNotice({
          kind: 'text',
          tone: 'bad',
          message:
            targets.length === 1
              ? codeText(firstFailed.code)
              : t('workActions.partial', {
                  done: gone.size,
                  failed: res.failed.length,
                  reason: codeText(firstFailed.code),
                }),
        });
        load();
        return;
      }
      const trashed = res.ok;
      const first = trashed[0];
      if (first === undefined) return;
      setNotice({
        kind: 'undo',
        message:
          trashed.length === 1
            ? t('workActions.deleted', { title: first.title })
            : t('workActions.deletedMany', { count: trashed.length }),
        undo: () => {
          setNotice(null);
          void restoreWorks(client, trashed).then((back) => {
            const failedBack = back.failed[0];
            setNotice(
              failedBack === undefined
                ? { kind: 'text', tone: 'ok', message: t('workActions.undone') }
                : { kind: 'text', tone: 'bad', message: codeText(failedBack.code) },
            );
            load();
          });
        },
      });
    } finally {
      setBusy(false);
    }
  };

  /** 加標籤／移除標籤 on the selection; 復原 undoes only what really changed on each work. */
  const changeTags = async (
    targets: readonly LibraryWork[],
    mode: 'add' | 'remove',
    tags: readonly string[],
    undoing = false,
  ) => {
    setConfirm(null);
    if (tags.length === 0 || targets.length === 0) return;
    setBusy(true);
    try {
      const before = targets.map((w) => latest.current.works?.find((x) => x.id === w.id) ?? w);
      const ready = await freshRevisions(client, before, handles);
      const res = await batchWorks(
        client,
        { action: mode === 'add' ? 'add_tags' : 'remove_tags', tags: [...tags] },
        ready,
      );
      applyServer(res.ok);
      const firstFailed = res.failed[0];
      if (firstFailed !== undefined) {
        setNotice({
          kind: 'text',
          tone: 'bad',
          message: t('workActions.partial', {
            done: res.ok.length,
            failed: res.failed.length,
            reason: codeText(firstFailed.code),
          }),
        });
        load();
        return;
      }
      if (undoing) {
        setNotice({ kind: 'text', tone: 'ok', message: t('workActions.undone') });
        return;
      }
      const groups = tagUndoGroups(before, tags, mode);
      setNotice({
        kind: 'undo',
        message: t(mode === 'add' ? 'workActions.tagsAdded' : 'workActions.tagsRemoved', {
          count: res.ok.length,
        }),
        undo: () => {
          setNotice(null);
          void (async () => {
            for (const g of groups) {
              const back = g.ids
                .map((id) => latest.current.works?.find((w) => w.id === id) ?? refById(id))
                .filter((w): w is LibraryWork => w !== undefined);
              await changeTags(back, mode === 'add' ? 'remove' : 'add', g.tags, true);
            }
          })();
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  useEffect(() => cancelOpen, []);
  /** ⌘/⇧ select; a plain click opens (on the title, after a moment, so a double-click can rename). */
  const onItemClick = (e: ReactMouseEvent, w: WorkListItem, onTitle: boolean) => {
    cancelOpen();
    if (e.metaKey || e.shiftKey) {
      e.preventDefault();
      // ⇧ alone replaces the selection with a range of shown works: a ⌘A selection ends.
      if (!e.metaKey) setAllRefs(null);
      setSelection((sel) => clickSelect(sel, w.id, order, { meta: e.metaKey, shift: e.shiftKey }));
      return;
    }
    // The second click of a double-click: the first one already decided.
    if (e.detail > 1) return;
    if (onTitle && e.detail === 1 && !isMissing(w)) {
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        onOpen(w.id);
      }, OPEN_DELAY_MS);
      return;
    }
    onOpen(w.id);
  };
  const onTitleDoubleClick = (e: ReactMouseEvent, w: WorkListItem) => {
    if (e.metaKey || e.shiftKey || isMissing(w)) return;
    e.preventDefault();
    e.stopPropagation();
    cancelOpen();
    setRenaming(w.id);
  };
  const onItemMenu = (e: ReactMouseEvent<HTMLElement>, w: WorkListItem) => {
    e.preventDefault();
    cancelOpen();
    // On a work that is part of a ⌘A selection: every selected work, loaded or not.
    const ids =
      allRefs !== null && selection.ids.has(w.id)
        ? allRefs.filter((r) => selection.ids.has(r.id)).map((r) => r.id)
        : contextTargets(selection, w.id, order);
    setMenu({ anchor: anchorOf(e), ids });
  };

  // ⌘A selects every work shown, esc clears; never while typing or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isEditable(e.target) || trashRef.current) return;
      if (hasOpenLayer(true)) return;
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        latest.current.selectAll();
      } else if (e.metaKey && e.key === 'Backspace') {
        // ⌘⌫ as in Finder: delete the selection, after the confirmation.
        e.preventDefault();
        latest.current.askDelete();
      } else if (e.key === 'Escape' && !e.metaKey) {
        setAllRefs(null);
        setSelection((sel) => (sel.ids.size === 0 ? sel : EMPTY_SELECTION));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const menuItems = (ids: readonly string[]): MenuEntry[] => {
    const targets = ids.map(refById).filter((w): w is LibraryWork => w !== undefined);
    const editable = targets.filter((w) => !isMissing(w));
    const statusMenu: MenuEntry = {
      kind: 'sub',
      id: 'status',
      label: t('workActions.changeStatus'),
      disabled: editable.length === 0,
      items: STATUS_ORDER.map((st) => ({
        kind: 'item',
        id: `status-${st}`,
        label: WORK_STATUS[st].label,
        checked: editable.length > 0 && editable.every((w) => w.status === st),
        onSelect: () => {
          void changeStatus(editable, st);
        },
      })),
    };
    const deleteItem: MenuEntry = {
      kind: 'item',
      id: 'delete',
      label: t('workActions.deleteItem'),
      danger: true,
      hint: '⌘⌫',
      onSelect: () => {
        setConfirm({ kind: 'delete', works: targets });
      },
    };
    const one = targets.length === 1 ? targets[0] : undefined;
    if (one === undefined) {
      return [
        statusMenu,
        ...projectItems(targets),
        {
          kind: 'item',
          id: 'add-tags',
          label: t('workActions.addTags'),
          disabled: editable.length === 0,
          onSelect: () => {
            setConfirm({ kind: 'tags', mode: 'add', works: editable });
          },
        },
        {
          kind: 'item',
          id: 'remove-tags',
          label: t('workActions.removeTags'),
          disabled: unionTags(editable).length === 0,
          onSelect: () => {
            setConfirm({ kind: 'tags', mode: 'remove', works: editable });
          },
        },
        { kind: 'sep', id: 'sep-del' },
        deleteItem,
      ];
    }
    // Its folder and file path are on the loaded card (a right-clicked work always is).
    const oneLoaded = loadedById.get(one.id);
    const file = oneLoaded === undefined ? null : externalFile(oneLoaded, mounts);
    return [
      {
        kind: 'item',
        id: 'open',
        label: t('workActions.open'),
        onSelect: () => {
          onOpen(one.id);
        },
      },
      {
        kind: 'item',
        id: 'open-tab',
        label: t('workActions.openInNewTab'),
        onSelect: () => {
          onOpenInBackground(one);
          setNotice({
            kind: 'text',
            tone: 'ok',
            message: t('workActions.openedInBackground', { title: one.title }),
          });
        },
      },
      { kind: 'sep', id: 'sep-1' },
      {
        kind: 'item',
        id: 'rename',
        label: t('workActions.rename'),
        disabled: isMissing(one),
        onSelect: () => {
          setRenaming(one.id);
        },
      },
      statusMenu,
      ...projectItems(targets),
      ...(file === null
        ? []
        : ([
            { kind: 'sep', id: 'sep-2' },
            {
              kind: 'item',
              id: 'copy-path',
              label: t('workActions.copyPath'),
              onSelect: () => {
                void window.creatorhub?.copyText(file).then(() => {
                  setNotice({ kind: 'text', tone: 'ok', message: t('workActions.pathCopied') });
                });
              },
            },
            {
              kind: 'item',
              id: 'reveal',
              label: t('common.revealInFinder'),
              disabled: isMissing(one),
              onSelect: () => {
                void window.creatorhub?.reveal({ kind: 'work', id: one.id });
              },
            },
          ] satisfies MenuEntry[])),
      { kind: 'sep', id: 'sep-del' },
      deleteItem,
    ];
  };
  const menuTargets =
    menu === null ? [] : menu.ids.map(refById).filter((w): w is LibraryWork => w !== undefined);
  // The selection as works: loaded cards where there are any, the service's refs beyond.
  const selectedWorks: readonly LibraryWork[] =
    allRefs !== null
      ? allRefs.filter((r) => selection.ids.has(r.id)).map((r) => loadedById.get(r.id) ?? r)
      : shown.filter((w) => selection.ids.has(w.id));
  useEffect(() => {
    latest.current.askDelete = () => {
      if (selectedWorks.length > 0) setConfirm({ kind: 'delete', works: selectedWorks });
    };
    latest.current.selectAll = () => {
      // Every work matching the filter (QC-067), not just the pages loaded so far.
      void client.works
        .refs(listQuery)
        .then((res) => {
          setAllRefs(res.items);
          setSelection({ ids: new Set(res.items.map((r) => r.id)), anchor: order[0] ?? null });
        })
        .catch((err: unknown) => {
          setNotice({ kind: 'text', tone: 'bad', message: errorText(err) });
        });
    };
  });
  const [barMenu, setBarMenu] = useState<MenuAnchor | null>(null);

  // ---- 項目 (QC-062) ----
  const [projectBar, setProjectBar] = useState<MenuAnchor | null>(null);
  const [newProjectFor, setNewProjectFor] = useState<readonly LibraryWork[] | null>(null);
  const [renamingProject, setRenamingProject] = useState(false);
  const projectMenu = useProjectMenu({
    store,
    notify: notifyProject,
    onRename: () => {
      setRenamingProject(true);
    },
    onGone: () => {
      onScope?.(ALL);
    },
  });
  const projectItems = (targets: readonly LibraryWork[]): MenuEntry[] =>
    store === null
      ? []
      : [
          {
            kind: 'sub',
            id: 'projects',
            label: t('projects.projectButton'),
            disabled: targets.length === 0,
            items: projectEntries({
              store,
              projects: projectList,
              works: targets,
              notify: notifyProject,
              onNew: () => {
                setNewProjectFor(targets);
              },
              after: load,
            }),
          },
          ...(project === null
            ? []
            : [
                {
                  kind: 'item' as const,
                  id: 'remove-from-project',
                  label: t('projects.removeFrom', { name: project.name }),
                  onSelect: () => {
                    void removeFromProject(store, project, targets, notifyProject, load);
                  },
                },
              ]),
        ];
  const createProjectWith = async (
    targets: readonly LibraryWork[],
    name: string,
    color: number,
  ) => {
    setNewProjectFor(null);
    if (store === null) return;
    try {
      const created = await store.create(name, color);
      const added = await store.setMembership(
        created.id,
        targets.map((w) => w.id),
        true,
      );
      load();
      notifyProject({
        message:
          added.length > 0
            ? t('projects.createdAdded', { name: created.name })
            : t('projects.created', { name: created.name }),
      });
    } catch {
      notifyProject({ message: t('common.cannotConnect'), tone: 'bad' });
    }
  };
  const renameCurrentProject = (typed: string) => {
    setRenamingProject(false);
    if (store !== null && project !== null)
      void renameProject(store, project, typed, notifyProject);
  };
  const dragWorks = (w: WorkListItem): readonly LibraryWork[] =>
    selection.ids.has(w.id) ? selectedWorks : [w];

  const filtering = appliedQuery.trim() !== '' || type !== 'all' || status !== 'all';
  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    setType('all');
    setStatus('all');
  };

  const motionMode = useMotionMode();
  // Few enough cards to move one by one; the grid's identity depends only on this, so
  // turning Reduce Motion on or off never redraws it.
  const fewCards = shown.length <= LAYOUT_LIMIT;
  const animateCards = moves(motionMode) && fewCards;
  const gridKey = `${type}|${status}|${appliedQuery}|${libraryScope.kind}|${projectId ?? ''}`;
  const loadView = useSkeletonGate(works === null && !failed);

  return (
    <MembershipContext.Provider value={membershipCtx}>
      <SearchHighlight query={highlight}>
        <main className="page" aria-label={t('library.library')}>
          <header className="page__header">
            {project !== null ? (
              <h1 className="page__title proj-title">
                <span
                  className="proj-title__chip"
                  style={{ background: projectColor(project.color) }}
                />
                {renamingProject ? (
                  <RenameField
                    value={project.name}
                    label={t('workActions.renameField', { title: project.name })}
                    className="rename--title"
                    onCommit={(name) => {
                      renameCurrentProject(name);
                    }}
                    onCancel={() => {
                      setRenamingProject(false);
                    }}
                  />
                ) : (
                  <span
                    className="proj-title__name"
                    onDoubleClick={() => {
                      setRenamingProject(true);
                    }}
                  >
                    {project.name}
                  </span>
                )}
              </h1>
            ) : (
              <h1 className="page__title">
                {inTrash
                  ? t('shell.navTrash')
                  : unassigned
                    ? t('projects.unassigned')
                    : t('shell.navAllWorks')}
              </h1>
            )}
            <span className="page__sub" role="status" aria-live="polite">
              {inTrash ? (
                t('workActions.trashHint', { days: WORK_TRASH_RETENTION_DAYS })
              ) : feedState.total === null ? null : filtering ? (
                t('library.resultsOf', { count: feedState.total, total: scopeTotal ?? '–' })
              ) : (
                <>
                  {t('projects.worksCount', { count: feedState.total })}
                  <LiveHeader
                    count={
                      project !== null
                        ? (live.byProject[project.id] ?? 0)
                        : unassigned
                          ? 0
                          : live.working
                    }
                  />
                  {project !== null && assetCount !== null && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <button
                        type="button"
                        className="page__sub-link"
                        onClick={() => {
                          onOpenProjectAssets?.(project.id);
                        }}
                      >
                        {t('library.assetsCount', { count: assetCount })}
                      </button>
                    </>
                  )}
                </>
              )}
            </span>
            {project !== null && (
              <button
                type="button"
                className="btn btn--icon btn--ghost proj-title__more"
                aria-label={t('projects.projectOptions')}
                aria-haspopup="menu"
                aria-expanded={projectMenu.openId === project.id}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  projectMenu.open(project, { x: r.left, y: r.bottom + 4 });
                }}
              >
                <Icon name="more" />
              </button>
            )}
            {inTrash && <div className="page__tools" ref={setTrashTools} />}
            {!inTrash && (
              <div className="page__tools">
                <label className="search">
                  <Icon name="search" />
                  <span className="visually-hidden">{t('library.searchWorks')}</span>
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder={t('common.search')}
                    value={query}
                    aria-keyshortcuts="Meta+F"
                    onChange={(e) => {
                      onQuery(e.target.value, (e.nativeEvent as InputEvent).isComposing);
                    }}
                    onCompositionEnd={(e) => {
                      onQuery(e.currentTarget.value, false);
                    }}
                  />
                  <kbd>⌘F</kbd>
                </label>
                <FilterMenu
                  type={type}
                  status={status}
                  typeCounts={typeCounts}
                  statusCounts={counts}
                  onType={setType}
                  onStatus={setStatus}
                />
                <div className="seg" role="group" aria-label={t('library.view')}>
                  {(['grid', 'list'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-label={v === 'grid' ? t('library.viewGrid') : t('library.viewList')}
                      aria-pressed={view === v}
                      onClick={() => {
                        setView(v);
                        writeView(v);
                      }}
                    >
                      <Icon name={v} />
                    </button>
                  ))}
                </div>
                <NewMenu
                  open={menuOpen}
                  busy={creating}
                  onOpenChange={setMenuOpen}
                  onCreate={create}
                />
              </div>
            )}
          </header>

          {inTrash ? (
            <TrashView client={client} projects={projectList} tools={trashTools} />
          ) : (
            <>
              {(type !== 'all' || status !== 'all') && (
                <ActiveFilters type={type} status={status} onType={setType} onStatus={setStatus} />
              )}

              <Presence>
                {selectedWorks.length > 0 && (
                  <Animated
                    key="batch-bar"
                    preset={{ kind: 'toast' }}
                    className="batch-bar"
                    role="toolbar"
                    aria-label={t('workActions.selected', { count: selectedWorks.length })}
                  >
                    <span className="batch-bar__count" aria-live="polite">
                      {t('workActions.selected', { count: selectedWorks.length })}
                    </span>
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-haspopup="menu"
                      aria-expanded={barMenu !== null}
                      disabled={selectedWorks.every(isMissing)}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setBarMenu({ x: r.left, y: r.bottom + 4 });
                      }}
                    >
                      {t('workActions.changeStatus')}
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy || selectedWorks.every(isMissing)}
                      onClick={() => {
                        setConfirm({
                          kind: 'tags',
                          mode: 'add',
                          works: selectedWorks.filter((w) => !isMissing(w)),
                        });
                      }}
                    >
                      {t('workActions.addTags')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={
                        busy || unionTags(selectedWorks.filter((w) => !isMissing(w))).length === 0
                      }
                      onClick={() => {
                        setConfirm({
                          kind: 'tags',
                          mode: 'remove',
                          works: selectedWorks.filter((w) => !isMissing(w)),
                        });
                      }}
                    >
                      {t('workActions.removeTags')}
                    </button>
                    {store !== null && (
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-haspopup="menu"
                        aria-expanded={projectBar !== null}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setProjectBar({ x: r.left, y: r.bottom + 4 });
                        }}
                      >
                        {t('projects.projectButton')}
                        <Icon name="chevronDown" size={14} />
                      </button>
                    )}
                    {store !== null && project !== null && (
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => {
                          void removeFromProject(
                            store,
                            project,
                            selectedWorks,
                            notifyProject,
                            load,
                          );
                        }}
                      >
                        {t('projects.removeFromThis')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      disabled={busy}
                      aria-keyshortcuts="Meta+Backspace"
                      onClick={() => {
                        setConfirm({ kind: 'delete', works: selectedWorks });
                      }}
                    >
                      <Icon name="trash" size={14} />
                      {t('workActions.deleteItem')}
                    </button>
                    <span className="batch-bar__hint">{t('workActions.selectHint')}</span>
                    <button
                      type="button"
                      className="btn btn--small btn--ghost batch-bar__clear"
                      onClick={() => {
                        setSelection(EMPTY_SELECTION);
                      }}
                    >
                      {t('workActions.clearSelection')}
                      <kbd>esc</kbd>
                    </button>
                  </Animated>
                )}
              </Presence>

              <section
                className="page__body"
                aria-label={t('library.works')}
                aria-busy={works === null && !failed}
              >
                {failed ? (
                  <div className="state-card" role="alert">
                    <Icon name="offline" size={28} />
                    <span className="state-card__title">{t('common.serviceDown')}</span>
                    <button type="button" className="btn btn--primary" onClick={load}>
                      {t('common.retry')}
                    </button>
                  </div>
                ) : works === null ? (
                  loadView !== 'skeleton' ? null : (
                    <div className="card-grid" aria-label={t('common.loading')}>
                      {Array.from({ length: 8 }, (_, i) => (
                        <div key={i} className="wcard wcard--skeleton">
                          <div className="skel wcard__cover" />
                          <div className="skel skel--line" style={{ width: '80%' }} />
                          <div className="skel skel--line" style={{ width: '50%' }} />
                        </div>
                      ))}
                    </div>
                  )
                ) : works.length === 0 && !filtering && project !== null ? (
                  <div className="state-card state-card--dashed">
                    <span
                      className="proj-title__chip proj-title__chip--big"
                      style={{ background: projectColor(project.color) }}
                    />
                    <span className="state-card__title">{t('projects.emptyProject')}</span>
                    <span className="state-card__detail">{t('projects.dragHint')}</span>
                    <div className="state-card__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => {
                          setMenuOpen(true);
                        }}
                      >
                        {t('library.new')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          onScope?.(ALL);
                        }}
                      >
                        {t('projects.goAll')}
                      </button>
                    </div>
                  </div>
                ) : works.length === 0 && !filtering && unassigned ? (
                  <div className="state-card state-card--dashed">
                    <Icon name="inbox" size={28} />
                    <span className="state-card__title">{t('projects.emptyUnassigned')}</span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        onScope?.(ALL);
                      }}
                    >
                      {t('projects.goAll')}
                    </button>
                  </div>
                ) : works.length === 0 && !filtering ? (
                  <div className="state-card state-card--dashed">
                    <Icon name="library" size={28} />
                    <span className="state-card__title">{t('library.empty')}</span>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => {
                        setMenuOpen(true);
                      }}
                    >
                      {t('library.new')}
                    </button>
                  </div>
                ) : type !== 'all' &&
                  status === 'all' &&
                  shown.length === 0 &&
                  appliedQuery.trim() === '' ? (
                  <TypeEmpty type={type} busy={creating} onCreate={create} />
                ) : shown.length === 0 && appliedQuery.trim() !== '' ? (
                  // Nothing found (QC-069): the search and filters stay; clear the search, or
                  // look for the same words in every work.
                  <div className="state-card state-card--dashed">
                    <Icon name="search" size={28} />
                    <span className="state-card__title">
                      {t('library.noMatchQuery', { query: appliedQuery.trim() })}
                    </span>
                    <div className="state-card__actions">
                      <button type="button" className="btn" onClick={clearFilters}>
                        {t('library.clearSearch')}
                      </button>
                      {libraryScope.kind !== 'all' && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            onScope?.(ALL);
                          }}
                        >
                          {t('library.searchAll')}
                        </button>
                      )}
                    </div>
                  </div>
                ) : shown.length === 0 ? (
                  <div className="state-card state-card--dashed">
                    <Icon name="filter" size={28} />
                    <span className="state-card__title">{t('library.noMatchFilter')}</span>
                    <button type="button" className="btn" onClick={clearFilters}>
                      {t('library.clearFilter')}
                    </button>
                  </div>
                ) : view === 'grid' ? (
                  <motion.ul
                    // Few cards: each slides to its new place. Many: the grid is drawn
                    // anew and fades in once (DESIGN.md 動效 · 重排、篩選切換).
                    key={fewCards ? 'cards' : gridKey}
                    className="card-grid"
                    aria-multiselectable="true"
                    variants={presetVariants({ kind: 'fade' }, motionMode)}
                    initial={fewCards ? false : 'initial'}
                    animate="animate"
                  >
                    <Presence popLayout>
                      {shown.map((w) => (
                        <AnimatedItem key={w.id} layout={animateCards} quiet={!animateCards}>
                          <WorkCard
                            work={w}
                            selected={selection.ids.has(w.id)}
                            menuTarget={menu?.ids.includes(w.id) === true}
                            renaming={renaming === w.id}
                            source={externalSource(w, mounts, userHome)}
                            imageUrl={imageUrl}
                            onNeedsFrame={onNeedsFrame}
                            label={
                              <WorkProjectLabel
                                workId={w.id}
                                title={w.title}
                                projectIds={w.project_ids}
                                projects={projectList}
                                currentId={projectId}
                              />
                            }
                            dragWorks={store === null ? undefined : dragWorks(w)}
                            onReview={onOpenProposals}
                            onRetry={onOpenImports}
                            onClick={(e, onTitle) => {
                              onItemClick(e, w, onTitle);
                            }}
                            onTitleDoubleClick={(e) => {
                              onTitleDoubleClick(e, w);
                            }}
                            onMenu={(e) => {
                              onItemMenu(e, w);
                            }}
                            onRename={(title) => {
                              rename(w, title);
                            }}
                            onRenameCancel={() => {
                              setRenaming(null);
                              focusWork(w.id);
                            }}
                          />
                        </AnimatedItem>
                      ))}
                    </Presence>
                  </motion.ul>
                ) : (
                  <div className="table-wrap">
                    <table className="tbl" aria-multiselectable="true">
                      <thead>
                        <tr>
                          <th scope="col">{t('library.colTitle')}</th>
                          <th scope="col">{t('live.agentColumn')}</th>
                          <th scope="col">{t('library.colProject')}</th>
                          <th scope="col">{t('library.colType')}</th>
                          <th scope="col">{t('library.colStatus')}</th>
                          <th scope="col">{t('library.colSource')}</th>
                          <th scope="col">{t('library.colTags')}</th>
                          <th scope="col" className="tbl__right">
                            {t('library.colUpdated')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((w) => (
                          <tr
                            key={w.id}
                            className={[
                              selection.ids.has(w.id) ? 'tbl__row--selected' : '',
                              menu?.ids.includes(w.id) === true ? 'tbl__row--menu' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            aria-selected={selection.ids.has(w.id)}
                            onContextMenu={(e) => {
                              onItemMenu(e, w);
                            }}
                          >
                            <td>
                              <span className="tbl__title">
                                {renaming === w.id ? (
                                  <span className="tbl__open tbl__open--renaming">
                                    <RowThumb work={w} />
                                    <RenameField
                                      value={w.title}
                                      label={t('workActions.renameField', { title: w.title })}
                                      className="rename--row"
                                      onCommit={(title) => {
                                        rename(w, title);
                                      }}
                                      onCancel={() => {
                                        setRenaming(null);
                                        focusWork(w.id);
                                      }}
                                    />
                                  </span>
                                ) : (
                                  <DragWorksButton
                                    dragId={w.id}
                                    works={dragWorks(w)}
                                    disabled={store === null}
                                    className="tbl__open"
                                    data-work-id={w.id}
                                    onClick={(e) => {
                                      onItemClick(e, w, false);
                                    }}
                                  >
                                    <RowThumb work={w} />
                                    <span
                                      className="tbl__name"
                                      title={isMissing(w) ? undefined : t('workActions.renameTip')}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onItemClick(e, w, true);
                                      }}
                                      onDoubleClick={(e) => {
                                        onTitleDoubleClick(e, w);
                                      }}
                                    >
                                      <Highlight text={w.title} />
                                    </span>
                                    <HitLine
                                      title={w.title}
                                      tags={w.tags}
                                      excerpt={w.match_excerpt}
                                      className="hitline hitline--row"
                                    />
                                    {selection.ids.has(w.id) && (
                                      <span className="visually-hidden">
                                        {t('workActions.isSelected')}
                                      </span>
                                    )}
                                  </DragWorksButton>
                                )}
                                {w.storage_mode === 'external' && (
                                  <span
                                    className="src-ext src-ext--small"
                                    title={externalSource(w, mounts, userHome)?.folder ?? undefined}
                                  >
                                    <Icon name="folder" size={11} />
                                    {t('library.externalBadge')}
                                  </span>
                                )}
                                {isMissing(w) && <MissingChip />}
                              </span>
                            </td>
                            <LiveAgentCell workId={w.id} />
                            <td className="tbl__proj">
                              <WorkProjectLabel
                                workId={w.id}
                                title={w.title}
                                projectIds={w.project_ids}
                                projects={projectList}
                                currentId={projectId}
                              />
                              {projectLabel(w.project_ids, projectList, projectId) === null && (
                                <span className="faint" aria-hidden="true">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="muted">{WORK_TYPE[w.type].label}</td>
                            <td>
                              <Chip tone={WORK_STATUS[w.status].tone}>
                                {WORK_STATUS[w.status].label}
                              </Chip>
                            </td>
                            <td className="muted">
                              {externalSource(w, mounts, userHome)?.label ?? sourceLabel(w)}
                            </td>
                            <td className="faint">{w.tags.map((tag) => `#${tag}`).join(' ')}</td>
                            <td className="faint tbl__right">{formatWhen(w.updated_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {works !== null && works.length > 0 && (
                  // The rest of the works load as the end of the list comes near (QC-067).
                  <LoadMore
                    hasMore={feedState.hasMore}
                    loading={feedState.loading}
                    failed={feedState.failed}
                    onMore={() => {
                      // After a failure (a stale cursor, the service away) read again from the top.
                      void (feedState.failed ? feed.refresh() : feed.loadMore());
                    }}
                  />
                )}
              </section>
            </>
          )}

          {menu !== null && menuTargets.length > 0 && (
            <ContextMenu
              anchor={menu.anchor}
              label={
                menuTargets.length === 1
                  ? t('workActions.menuFor', { title: menuTargets[0]?.title ?? '' })
                  : t('workActions.menuForMany', { count: menuTargets.length })
              }
              items={menuItems(menu.ids)}
              onClose={() => {
                setMenu(null);
              }}
            />
          )}
          {barMenu !== null && selectedWorks.length > 0 && (
            <ContextMenu
              anchor={barMenu}
              label={t('workActions.changeStatus')}
              items={STATUS_ORDER.map((st) => ({
                kind: 'item',
                id: `bar-status-${st}`,
                label: WORK_STATUS[st].label,
                checked: selectedWorks.every((w) => w.status === st),
                onSelect: () => {
                  void changeStatus(
                    selectedWorks.filter((w) => !isMissing(w)),
                    st,
                  );
                },
              }))}
              onClose={() => {
                setBarMenu(null);
              }}
            />
          )}
          {projectBar !== null && selectedWorks.length > 0 && store !== null && (
            <ContextMenu
              anchor={projectBar}
              label={t('projects.projectButton')}
              items={projectEntries({
                store,
                projects: projectList,
                works: selectedWorks,
                notify: notifyProject,
                onNew: () => {
                  setNewProjectFor(selectedWorks);
                },
                after: load,
              })}
              onClose={() => {
                setProjectBar(null);
              }}
            />
          )}
          {newProjectFor !== null && (
            <NewProjectDialog
              initialColor={nextProjectColor(projectList)}
              onCancel={() => {
                setNewProjectFor(null);
              }}
              onCreate={(name, color) => {
                void createProjectWith(newProjectFor, name, color);
              }}
            />
          )}
          {projectMenu.node}
          {confirm?.kind === 'delete' && (
            <DeleteDialog
              works={confirm.works}
              onCancel={() => {
                setConfirm(null);
              }}
              onConfirm={(moveOriginal) => {
                void deleteWorks(confirm.works, moveOriginal);
              }}
            />
          )}
          {confirm?.kind === 'tags' && (
            <TagsDialog
              mode={confirm.mode}
              works={confirm.works}
              onCancel={() => {
                setConfirm(null);
              }}
              onApply={(tags) => {
                void changeTags(confirm.works, confirm.mode, tags);
              }}
            />
          )}
        </main>
      </SearchHighlight>
    </MembershipContext.Provider>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The full path of an external work's file, for 複製路徑; null for managed works. */
function externalFile(
  work: Pick<Work, 'storage_mode' | 'mount_id' | 'external_path'>,
  mounts: ReadonlyMap<string, Mount>,
): string | null {
  if (work.storage_mode !== 'external' || work.mount_id == null || work.external_path == null)
    return null;
  const mount = mounts.get(work.mount_id);
  if (mount === undefined) return null;
  return `${mount.root_path.replace(/\/+$/, '')}/${work.external_path}`;
}

function RowThumb({ work }: { work: WorkListItem }) {
  return (
    <span
      className={isMissing(work) ? 'tbl__thumb tbl__thumb--missing' : 'tbl__thumb'}
      aria-hidden="true"
    >
      <Icon name={WORK_TYPE[work.type].icon} size={14} />
    </span>
  );
}

/**
 * A compact card (QC-052: 5–6 to a row at 1440 wide): picture, title (two
 * lines), status and when. The source moves to the tooltip.
 */
function WorkCard({
  work,
  selected,
  menuTarget,
  renaming,
  source,
  onClick,
  onTitleDoubleClick,
  onMenu,
  onRename,
  onRenameCancel,
  imageUrl,
  onNeedsFrame,
  label,
  dragWorks,
  onReview,
  onRetry,
}: {
  work: WorkListItem;
  /** QC-097: what 審閱提案 and 重試 on a live card open. */
  onReview?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  /** The work's projects as a label: colour, first name, +N (QC-069). */
  label?: ReactNode;
  /** What dragging this card onto a sidebar project adds; undefined: not draggable. */
  dragWorks?: readonly LibraryWork[] | undefined;
  selected: boolean;
  /** The right-click menu is open for it. */
  menuTarget: boolean;
  renaming: boolean;
  source: ReturnType<typeof externalSource>;
  onClick: (e: ReactMouseEvent, onTitle: boolean) => void;
  onTitleDoubleClick: (e: ReactMouseEvent) => void;
  onMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  onRename: (title: string) => void;
  onRenameCancel: () => void;
  imageUrl: (relative: string) => string;
  onNeedsFrame: (work: WorkListItem) => void;
}) {
  // QC-097: an agent at work on it (ring, tag, skeleton; 審閱提案／重試 when it needs you).
  const live = useWorkLive(work.id);
  const className = [
    'wcard',
    live === undefined ? '' : `wcard--live-${live.state}`,
    isMissing(work) ? 'wcard--missing' : '',
    selected ? 'wcard--selected' : '',
    menuTarget ? 'wcard--menu' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const meta = (
    <span className="wcard__meta">
      <Chip tone={WORK_STATUS[work.status].tone}>{WORK_STATUS[work.status].label}</Chip>
      {isMissing(work) ? (
        <MissingChip />
      ) : (
        <span className="wcard__type">{WORK_TYPE[work.type].label}</span>
      )}
      {work.storage_mode === 'external' && (
        <span className="wcard__ext" title={source?.label ?? undefined}>
          <Icon name="folder" size={11} />
        </span>
      )}
      <span className="wcard__proj">{label}</span>
      {live !== undefined && (live.state === 'needs_attention' || live.state === 'error') ? (
        <LiveAction
          v={live}
          onReview={() => {
            onReview?.();
          }}
          onRetry={() => {
            onRetry?.();
          }}
        />
      ) : (
        <span className="wcard__when">{formatWhen(work.updated_at)}</span>
      )}
    </span>
  );
  const tooltip = [work.title, source?.file ?? source?.label ?? sourceLabel(work)].join('\n');
  if (renaming) {
    return (
      <div
        className={`${className} wcard--renaming`}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        <CardCover work={work} imageUrl={imageUrl} onNeedsFrame={onNeedsFrame} />
        <span className="wcard__body">
          <RenameField
            value={work.title}
            label={t('workActions.renameField', { title: work.title })}
            className="rename--card"
            onCommit={onRename}
            onCancel={onRenameCancel}
          />
          {meta}
        </span>
      </div>
    );
  }
  return (
    <DragWorksButton
      dragId={work.id}
      works={dragWorks ?? []}
      disabled={dragWorks === undefined}
      className={className}
      data-work-id={work.id}
      title={tooltip}
      onClick={(e) => {
        onClick(e, false);
      }}
      onContextMenu={onMenu}
    >
      <CardCover work={work} imageUrl={imageUrl} onNeedsFrame={onNeedsFrame} />
      {live !== undefined && (
        <LiveCardLayer v={live} hasCover={(work.card_image?.url ?? null) !== null} />
      )}
      <span className="wcard__body">
        <span
          className="wcard__title"
          onClick={(e) => {
            e.stopPropagation();
            onClick(e, true);
          }}
          onDoubleClick={onTitleDoubleClick}
        >
          <Highlight text={work.title} />
        </span>
        <HitLine
          title={work.title}
          tags={work.tags}
          excerpt={work.match_excerpt}
          inCover={work.type === 'article' && (work.card_image?.url ?? null) === null}
        />
        {meta}
      </span>
      {selected && <span className="visually-hidden">{t('workActions.isSelected')}</span>}
      {selected && (
        <SettleIn className="wcard__check">
          <Icon name="check" size={12} />
        </SettleIn>
      )}
    </DragWorksButton>
  );
}

function MissingChip() {
  return (
    <span className="chip chip--bad">
      <Icon name="fileMissing" size={12} />
      {t('library.fileMissing')}
    </span>
  );
}

const TYPE_EMPTY_KEY = {
  article: 'library.emptyArticle',
  image: 'library.emptyImage',
  video: 'library.emptyVideo',
  mixed: 'library.emptyArticle',
} as const;
const TYPE_NEW_KEY = {
  article: 'library.newArticle',
  image: 'library.newImage',
  video: 'library.newVideo',
  mixed: 'library.newArticle',
} as const;

const TYPE_HINT_KEY = {
  article: 'library.newArticleHint',
  image: 'library.newImageHint',
  video: 'library.newVideoHint',
  mixed: 'library.newArticleHint',
} as const;

/**
 * 新建 with a type menu (PT-20261121-001 「v3 · 新建」): 文章／貼圖／視頻, ↑↓ to
 * move, 1–3 to pick, ↩ to create, esc to close; ⌘N opens it.
 */
function NewMenu({
  open,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (type: WorkType) => void;
}) {
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setAt(0);
    requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target) !== true)
        onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);
  const focusAt = (i: number) => {
    setAt(i);
    root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[i]?.focus();
  };
  const pick = (i: number) => {
    const item = NEW_TYPES[i];
    if (item?.enabled === true) onCreate(item.type);
  };
  return (
    <div className="new-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn--primary"
        aria-keyshortcuts="Meta+N"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        <Icon name="plus" />
        {t('library.new')}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <ExitFade>
          <div
            className="pop new-menu__pop"
            role="menu"
            aria-label={t('library.newMenu')}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                onOpenChange(false);
                button.current?.focus();
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = NEW_TYPES.length;
                focusAt((at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
              } else if (/^[1-3]$/.test(e.key)) {
                e.preventDefault();
                pick(Number(e.key) - 1);
              }
            }}
          >
            {NEW_TYPES.map((item, i) => (
              <button
                key={item.type}
                type="button"
                role="menuitem"
                className="pop__item new-menu__item"
                aria-disabled={!item.enabled}
                tabIndex={i === at ? 0 : -1}
                onFocus={() => {
                  setAt(i);
                }}
                onClick={() => {
                  pick(i);
                }}
              >
                <Icon name={WORK_TYPE[item.type].icon} size={16} />
                <span className="new-menu__text">
                  <span>{WORK_TYPE[item.type].label}</span>
                  <span className="new-menu__hint">{t(TYPE_HINT_KEY[item.type])}</span>
                </span>
                <kbd>{i + 1}</kbd>
              </button>
            ))}
            <div className="pop__sep" />
            <div className="pop__keys">
              <span>{t('library.newKeysMove')}</span>
              <span>{t('library.newKeysPick')}</span>
            </div>
          </div>
        </ExitFade>
      )}
    </div>
  );
}

/** A type with no works yet: say so and offer to make one (video waits for QC-046). */
function TypeEmpty({
  type,
  busy,
  onCreate,
}: {
  type: WorkType;
  busy: boolean;
  onCreate: (type: WorkType) => void;
}) {
  const enabled = NEW_TYPES.find((n) => n.type === type)?.enabled === true;
  return (
    <div className="state-card state-card--dashed">
      <Icon name={WORK_TYPE[type].icon} size={28} />
      <span className="state-card__title">{t(TYPE_EMPTY_KEY[type])}</span>
      <span className="state-card__detail">{t(TYPE_HINT_KEY[type])}</span>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!enabled || busy}
        onClick={() => {
          onCreate(type);
        }}
      >
        <Icon name="plus" />
        {t(TYPE_NEW_KEY[type])}
      </button>
    </div>
  );
}
