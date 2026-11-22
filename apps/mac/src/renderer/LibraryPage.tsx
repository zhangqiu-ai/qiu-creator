import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  Mount,
  Work,
  WorkDetail,
  WorkListItem,
  WorkStatus,
  WorkType,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  selectAll,
  type Selection,
} from './library-select.js';
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
import { useRefreshOn } from './events.js';
import { formatWhen, sourceLabel, WORK_STATUS, WORK_TYPE } from './format.js';
import { CardCover } from './WorkCover.js';
import { CardFrameQueue } from './card-frames.js';
import { DeleteDialog, TagsDialog } from './LibraryDialogs.js';
import { TrashView } from './LibraryTrash.js';
import { tagUndoGroups, unionTags } from './library-trash.js';
import { ExitFade } from './motion.js';
import { codeText, t } from './i18n.js';
import { Icon } from './Icon.js';
import { externalSource, useMounts } from './mounts.js';
import { ProjectDots, ProjectOverview, projectEntries } from './LibraryProjects.js';
import { DragWorksButton } from './projects-dnd.js';
import { removeFromProject, renameProject, useNotice } from './project-actions.js';
import { NewProjectDialog, useProjectMenu } from './project-menu.js';
import { projectColor, type ProjectsState, type ProjectsStore } from './projects-store.js';
import type { LibraryScope } from './SidebarProjects.js';

type View = 'grid' | 'list';
type TypeFilter = 'all' | WorkType;
type StatusFilter = 'all' | WorkStatus;

// 混合 works keep their label but only show under 全部 (PT-20261121-001 decision).
const TYPE_FILTERS: readonly TypeFilter[] = ['all', 'article', 'image', 'video'];

/** What 新建 can make (QC-045; video since QC-046). */
export const NEW_TYPES: readonly { type: WorkType; enabled: boolean }[] = [
  { type: 'article', enabled: true },
  { type: 'image', enabled: true },
  { type: 'video', enabled: true },
];
const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'drafting',
  'in_review',
  'ready',
  'published',
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
  /** Works moved to 最近刪除 here: their tabs close. */
  onTrashed: (ids: readonly string[]) => void;
  /** 全部作品, 未分類 or one project (QC-062). */
  scope?: LibraryScope;
  projects?: ProjectsStore | null;
  projectsState?: ProjectsState;
  onScope?: (scope: LibraryScope) => void;
  /** 用到的素材 › of a project. */
  onOpenProjectAssets?: (projectId: string) => void;
}

const ALL: LibraryScope = { kind: 'all' };

/** A click on a card title waits this long for a second click (rename) before opening. */
const OPEN_DELAY_MS = 260;

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];

type Notice =
  | { kind: 'text'; message: string; tone: 'ok' | 'bad' | 'neutral' }
  | { kind: 'undo'; message: string; undo: () => void };

type Confirm =
  | { kind: 'delete'; works: readonly WorkListItem[] }
  | { kind: 'tags'; mode: 'add' | 'remove'; works: readonly WorkListItem[] };

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
}: LibraryPageProps) {
  const projectList = projectsState?.projects ?? [];
  const project =
    libraryScope.kind === 'project'
      ? (projectList.find((p) => p.id === libraryScope.id) ?? null)
      : null;
  const projectId = libraryScope.kind === 'project' ? libraryScope.id : null;
  const unassigned = libraryScope.kind === 'unassigned';
  const notifyProject = useNotice();
  const [works, setWorks] = useState<readonly WorkListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<'active' | 'trash'>('active');
  const [trashCount, setTrashCount] = useState(0);
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const searchRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setFailed(false);
    const q = appliedQuery.trim();
    // All types at once: the type filter shows a count for each and filters here.
    client.works
      .list({
        limit: 200,
        ...(q === '' ? {} : { q }),
        ...(projectId === null ? {} : { project_id: projectId }),
        ...(unassigned ? { unassigned: '1' as const } : {}),
      })
      .then((res) => {
        if (id === request.current) setWorks(res.items);
      })
      .catch(() => {
        if (id === request.current) setFailed(true);
      });
    // How many works 最近刪除 holds, for its entry in the filter row.
    client.works
      .list({ scope: 'trash', limit: 1 })
      .then((res) => {
        if (id === request.current) setTrashCount(res.total);
      })
      .catch(() => undefined);
  }, [client, appliedQuery, projectId, unassigned]);

  useEffect(load, [load]);
  useRefreshOn(['work', 'project'], load, 300);
  // A new scope starts with nothing chosen and its own loading state.
  const scopeKey = `${libraryScope.kind}:${projectId ?? ''}`;
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  if (loadedScope !== scopeKey) {
    setLoadedScope(scopeKey);
    setWorks(null);
  }

  // Card images (QC-061): signed URLs from the list; video frames the service could not
  // take are grabbed off-screen one at a time and uploaded, then the list is read again.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
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

  const ofType = useMemo(
    () => (works ?? []).filter((w) => type === 'all' || w.type === type),
    [works, type],
  );
  const shown = useMemo(
    () => ofType.filter((w) => status === 'all' || w.status === status),
    [ofType, status],
  );
  const typeCounts = useMemo(() => {
    const c: Record<TypeFilter, number> = { all: 0, article: 0, image: 0, video: 0, mixed: 0 };
    for (const w of works ?? []) {
      c.all++;
      c[w.type]++;
    }
    return c;
  }, [works]);
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      drafting: 0,
      in_review: 0,
      ready: 0,
      published: 0,
    };
    for (const w of ofType) {
      c.all++;
      c[w.status]++;
    }
    return c;
  }, [ofType]);

  // ---- Selection, rename, right-click menu (QC-052) ----
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; ids: readonly string[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const order = useMemo(() => shown.map((w) => w.id), [shown]);
  const latest = useRef({ order, works, askDelete: (): void => undefined });
  useEffect(() => {
    latest.current = { ...latest.current, order, works };
    setSelection((sel) => keepShown(sel, order));
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

  const patchLocal = useCallback((id: string, change: Partial<WorkListItem>) => {
    setWorks((ws) => ws?.map((w) => (w.id === id ? { ...w, ...change } : w)) ?? ws);
  }, []);
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
    targets: readonly WorkListItem[],
    status: WorkStatus,
    undoing = false,
  ) => {
    const changing = targets.filter((w) => w.status !== status);
    if (changing.length === 0) return;
    for (const w of changing) patchLocal(w.id, { status });
    // The newest revision this page knows of (a rename or an undo may have moved it).
    const current = changing.map((w) => latest.current.works?.find((x) => x.id === w.id) ?? w);
    const done: WorkListItem[] = [];
    const failed: { work: WorkListItem; reason: string }[] = [];
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

  /** Move works to 最近刪除; the notice's 復原 brings them back. */
  const deleteWorks = async (targets: readonly WorkListItem[], moveOriginal: boolean) => {
    setConfirm(null);
    setBusy(true);
    try {
      const ready = await freshRevisions(client, targets, handles);
      const res = await trashWorks(client, ready, { moveOriginal });
      const gone = new Set(res.ok.map((w) => w.id));
      setWorks((ws) => ws?.filter((w) => !gone.has(w.id)) ?? ws);
      setTrashCount((n) => n + gone.size);
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
            setTrashCount((n) => Math.max(0, n - back.ok.length));
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
    targets: readonly WorkListItem[],
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
                .map((id) => latest.current.works?.find((w) => w.id === id))
                .filter((w): w is WorkListItem => w !== undefined);
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
    setMenu({ anchor: anchorOf(e), ids: contextTargets(selection, w.id, order) });
  };

  // ⌘A selects every work shown, esc clears; never while typing or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isEditable(e.target) || scopeRef.current !== 'active') return;
      if (document.querySelector('[aria-modal="true"], .ctx-menu') !== null) return;
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection(selectAll(latest.current.order));
      } else if (e.metaKey && e.key === 'Backspace') {
        // ⌘⌫ as in Finder: delete the selection, after the confirmation.
        e.preventDefault();
        latest.current.askDelete();
      } else if (e.key === 'Escape' && !e.metaKey) {
        setSelection((sel) => (sel.ids.size === 0 ? sel : EMPTY_SELECTION));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const menuItems = (ids: readonly string[]): MenuEntry[] => {
    const targets = shown.filter((w) => ids.includes(w.id));
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
    const file = externalFile(one, mounts);
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
  const menuTargets = menu === null ? [] : shown.filter((w) => menu.ids.includes(w.id));
  const selectedWorks = shown.filter((w) => selection.ids.has(w.id));
  useEffect(() => {
    latest.current.askDelete = () => {
      if (selectedWorks.length > 0) setConfirm({ kind: 'delete', works: selectedWorks });
    };
  });
  const [barMenu, setBarMenu] = useState<MenuAnchor | null>(null);

  // ---- 項目 (QC-062) ----
  const [projectBar, setProjectBar] = useState<MenuAnchor | null>(null);
  const [newProjectFor, setNewProjectFor] = useState<readonly WorkListItem[] | null>(null);
  const [renamingProject, setRenamingProject] = useState(false);
  const projectMenu = useProjectMenu({
    store,
    client,
    notify: notifyProject,
    onRename: () => {
      setRenamingProject(true);
    },
    onGone: () => {
      onScope?.(ALL);
    },
  });
  const projectItems = (targets: readonly WorkListItem[]): MenuEntry[] =>
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
    targets: readonly WorkListItem[],
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
  const dragWorks = (w: WorkListItem): readonly WorkListItem[] =>
    selection.ids.has(w.id) ? selectedWorks : [w];

  const filtering = appliedQuery.trim() !== '' || type !== 'all' || status !== 'all';
  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    setType('all');
    setStatus('all');
  };

  return (
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
            {unassigned ? t('projects.unassigned') : t('library.library')}
          </h1>
        )}
        <span className="page__count">
          {scope === 'trash' ? trashCount : works === null ? '' : shown.length}
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
        <NewMenu open={menuOpen} busy={creating} onOpenChange={setMenuOpen} onCreate={create} />
      </header>

      {scope === 'trash' ? (
        <TrashView
          client={client}
          query={appliedQuery}
          onBack={() => {
            setScope('active');
            load();
          }}
          onCount={setTrashCount}
          projects={projectList}
        />
      ) : (
        <>
          {project !== null && store !== null && (
            <ProjectOverview
              store={store}
              project={project}
              refresh={works}
              onOpenAssets={() => {
                onOpenProjectAssets?.(project.id);
              }}
            />
          )}
          <div className="filters">
            <div className="seg" role="group" aria-label={t('library.type')}>
              {TYPE_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={type === f}
                  onClick={() => {
                    setType(f);
                  }}
                >
                  {f === 'all' ? t('library.all') : WORK_TYPE[f].label}
                  <span className="fchip__n">{typeCounts[f]}</span>
                </button>
              ))}
            </div>
            <span className="filters__divider" aria-hidden="true" />
            <div className="filters__chips" role="group" aria-label={t('library.status')}>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="fchip"
                  aria-pressed={status === s}
                  onClick={() => {
                    setStatus(s);
                  }}
                >
                  {s === 'all' ? t('library.all') : WORK_STATUS[s].label}
                  <span className="fchip__n">{counts[s]}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="fchip filters__trash"
              onClick={() => {
                setSelection(EMPTY_SELECTION);
                setScope('trash');
              }}
            >
              <Icon name="trash" size={14} />
              {t('workActions.trash')}
              <span className="fchip__n">{trashCount}</span>
            </button>
          </div>

          {selectedWorks.length > 0 && (
            <div
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
                    void removeFromProject(store, project, selectedWorks, notifyProject, load);
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
            </div>
          )}

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
              <div className="card-grid" aria-label={t('common.loading')}>
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="wcard wcard--skeleton">
                    <div className="skel wcard__cover" />
                    <div className="skel skel--line" style={{ width: '80%' }} />
                    <div className="skel skel--line" style={{ width: '50%' }} />
                  </div>
                ))}
              </div>
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
            ) : type !== 'all' && ofType.length === 0 && appliedQuery.trim() === '' ? (
              <TypeEmpty type={type} busy={creating} onCreate={create} />
            ) : shown.length === 0 ? (
              <div className="state-card state-card--dashed">
                <Icon name="search" size={28} />
                <span className="state-card__title">{t('library.noMatches')}</span>
                <button type="button" className="btn" onClick={clearFilters}>
                  {t('library.clearFilters')}
                </button>
              </div>
            ) : view === 'grid' ? (
              <ul className="card-grid" aria-multiselectable="true">
                {shown.map((w) => (
                  <li key={w.id}>
                    <WorkCard
                      work={w}
                      selected={selection.ids.has(w.id)}
                      menuTarget={menu?.ids.includes(w.id) === true}
                      renaming={renaming === w.id}
                      source={externalSource(w, mounts, userHome)}
                      imageUrl={imageUrl}
                      onNeedsFrame={onNeedsFrame}
                      dots={
                        <ProjectDots
                          projectIds={w.project_ids}
                          projects={projectList}
                          currentId={projectId}
                        />
                      }
                      dragWorks={store === null ? undefined : dragWorks(w)}
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
                  </li>
                ))}
              </ul>
            ) : (
              <div className="table-wrap">
                <table className="tbl" aria-multiselectable="true">
                  <thead>
                    <tr>
                      <th scope="col">{t('library.colTitle')}</th>
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
                                  {w.title}
                                </span>
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
                            <ProjectDots
                              projectIds={w.project_ids}
                              projects={projectList}
                              currentId={projectId}
                            />
                          </span>
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
  dots,
  dragWorks,
}: {
  work: WorkListItem;
  /** The work's other projects as colour dots (QC-062). */
  dots?: ReactNode;
  /** What dragging this card onto a sidebar project adds; undefined: not draggable. */
  dragWorks?: readonly WorkListItem[] | undefined;
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
  const className = [
    'wcard',
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
      <span className="wcard__when">{formatWhen(work.updated_at)}</span>
      {dots}
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
      <span className="wcard__body">
        <span
          className="wcard__title"
          onClick={(e) => {
            e.stopPropagation();
            onClick(e, true);
          }}
          onDoubleClick={onTitleDoubleClick}
        >
          {work.title}
        </span>
        {meta}
      </span>
      {selected && <span className="visually-hidden">{t('workActions.isSelected')}</span>}
      {selected && (
        <span className="wcard__check" aria-hidden="true">
          <Icon name="check" size={12} />
        </span>
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
