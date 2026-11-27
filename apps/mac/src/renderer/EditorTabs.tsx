import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type { WorkDetail } from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEventHandler,
} from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'motion/react';
import type { TabCommand } from '../shared/bridge.js';
import { dropAnimationFor, sortTransition, useDragSensors, type Landing } from './dnd-motion.js';
import { springOf, tween, ExitFade, hasOpenLayer } from './motion.js';
import { moves, useMotionMode } from './motion-mode.js';
import { anchorOf, ContextMenu, type MenuAnchor } from './ContextMenu.js';
import { Dialog } from './Dialog.js';
import { RenameField } from './RenameField.js';
import { EditorPage } from './EditorPage.js';
import { SideStore, type SideTab } from './editor-side.js';
import { SideContext } from './EditorSide.js';
import { LiveDot, useWorkLive } from './AgentLive.js';
import type { EditorTabHandle } from './tab-handle.js';
import { changeWork, type EditorHandles } from './work-actions.js';
import { ImagePostEditor } from './ImagePostEditor.js';
import { VideoWorkEditor } from './VideoWorkEditor.js';
import { WORK_TYPE } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { useToast } from './toasts.js';
import type { Draft } from './work-session.js';
import type { Tab, TabsModel, TabStatusPatch, TabView } from './tabs.js';

/** Tabs only slide sideways while dragged. */
const alongTheBar: Modifier = ({ transform }) => ({ ...transform, y: 0 });

type Notice =
  | { kind: 'closed'; title: string }
  | { kind: 'already'; title: string }
  | { kind: 'renameFailed'; message: string };

const NOTICE_MS = 8000;

function tabTitle(tab: Pick<Tab, 'title'>): string {
  return tab.title.trim() === '' ? t('tabs.untitled') : tab.title;
}

/** The states a tab shows, in words (tooltip, all-tabs menu, accessible name). */
function tabStates(tab: Tab): string[] {
  const states: string[] = [];
  if (tab.missing) states.push(t('tabs.missing'));
  if (tab.conflict) states.push(t('tabs.conflict'));
  if (tab.unsaved) states.push(t('tabs.unsaved'));
  if (tab.aiCandidate) states.push(t('tabs.aiCandidate'));
  if (!tab.loaded) states.push(t('tabs.notLoaded'));
  return states;
}

/** ⌘1–⌘8 for the first eight tabs, ⌘9 for the last one. */
function shortcutFor(index: number, count: number): string | null {
  if (index < 8) return `⌘${String(index + 1)}`;
  if (index === count - 1) return '⌘9';
  return null;
}

export interface EditorTabsProps {
  model: TabsModel;
  /** Shared with 作品庫 (QC-052); this component registers each mounted editor here. */
  handles: EditorHandles;
  client: CreatorHubClient;
  userHome: string | null;
  /** The editor area is the page in front (not 作品庫, 設定, …). */
  visible: boolean;
  /** Works fetched by whoever opened them, so the first load needs no second request. */
  preloaded: Map<string, WorkDetail>;
  /** Bumped when the active tab should take the caret (a click, ⌘1–9, …). */
  focusToken: number;
  onFocusEditor: () => void;
  onBack: () => void;
  onOpenSettings: () => void;
  /** 管理 Prompt from the toolbar's prompt picker (QC-075). */
  onOpenPrompts: () => void;
  /** QC-097: 活動記錄 in an editor's live agent bar. */
  onOpenAgentActivity?: () => void;
  /** Bring a sidebar tab forward (QC-091: a work opened from the Agent 提案 inbox shows 提案); `n` makes each ask new. */
  sideAsk?: { tab: SideTab; n: number };
}

/**
 * The editor area with tabs (QC-047, PT-20261121-001 「多分頁編輯」): a tab bar
 * above the work's header, one mounted editor per loaded tab (the ones in the
 * background are hidden, not unmounted, so drafts, caret, scroll, mode and
 * side panel stay as they were), the all-tabs menu, the close-unsaved dialog
 * and the tab notices (重新開啟, a tab already open past the edge of the bar, a
 * failed rename). Any kind of editor can sit in a tab.
 */
export function EditorTabs(props: EditorTabsProps) {
  const { model, visible, onFocusEditor } = props;
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const handles = useRef(props.handles);
  /** Drafts handed back by 重新開啟, consumed by the editor that mounts next for that work. */
  const reopenDrafts = useRef(new Map<string, Draft>());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; failedAgain: boolean } | null>(null);
  /** A tab closed with AI candidates not yet kept (QC-070): ask before they are dropped. */
  const [confirmCandidates, setConfirmCandidates] = useState<string | null>(null);
  /** The right sidebar's tab, width and open state belong to the window, not to a work (QC-085). */
  const [side] = useState(() => {
    let storage: Storage | null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    return new SideStore(storage);
  });
  const sideAsk = props.sideAsk;
  useEffect(() => {
    if (sideAsk !== undefined) side.show(sideAsk.tab);
  }, [sideAsk, side]);
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      side.measure(el.clientWidth);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [side]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
      if (notice.kind === 'closed') model.dismissClosed();
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, model]);

  // Opening a work that is already open flashes its tab; words only when the tab
  // was out of sight (QC-115).
  const sayAlreadyOpen = useCallback(
    (id: string) => {
      const tab = model.find(id);
      if (tab !== null) setNotice({ kind: 'already', title: tabTitle(tab) });
    },
    [model],
  );

  const finishClose = useCallback(
    (id: string, draft: Draft | null) => {
      const tab = model.find(id);
      if (tab === null) return;
      model.close(id, draft);
      setNotice({ kind: 'closed', title: tabTitle(tab) });
      if (model.active !== null) onFocusEditor();
    },
    [model, onFocusEditor],
  );

  /** ⌘W, the tab's ×, the all-tabs menu: save first; if that fails, ask. */
  const requestClose = useCallback(
    async (id: string) => {
      const tab = model.find(id);
      if (tab === null) return;
      const handle = handles.current.get(id);
      if (handle !== undefined && (tab.unsaved || tab.conflict)) {
        const clean = await handle.flush();
        if (!clean) {
          model.activate(id);
          setConfirm({ id, failedAgain: false });
          return;
        }
      }
      if (tab.aiCandidate) {
        model.activate(id);
        setConfirmCandidates(id);
        return;
      }
      finishClose(id, null);
    },
    [model, finishClose],
  );

  // ⌘1–9, ⌘⇧[ ], ⌘W from the keyboard and from the menu bar.
  const run = useCallback(
    (command: TabCommand): boolean => {
      // 設定… is the App's; the tab bar leaves it alone.
      if (command === 'settings') return false;
      if (confirm !== null || confirmCandidates !== null || hasOpenLayer()) return false;
      if (command === 'close') {
        const active = model.active;
        if (!visible || active === null) return false;
        void requestClose(active.id);
        return true;
      }
      if (command === 'side-toggle' || command === 'side-preview' || command === 'side-assets') {
        if (!visible || model.active === null) return false;
        if (command === 'side-toggle') side.toggle();
        else side.toggleTab(command === 'side-preview' ? 'preview' : 'assets');
        return true;
      }
      if (model.tabs.length === 0) return false;
      if (command === 'next' || command === 'previous') model.step(command === 'next' ? 1 : -1);
      else model.jump(Number(command.slice('jump-'.length)));
      onFocusEditor();
      return true;
    },
    [confirm, confirmCandidates, model, visible, requestClose, onFocusEditor, side],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.isComposing) return;
      let command: TabCommand | null = null;
      // ⌥⌘0 (the key, whatever ⌥ makes of it).
      if (e.altKey) {
        if (!e.shiftKey && e.code === 'Digit0') command = 'side-toggle';
      } else if (e.shiftKey && e.code === 'KeyP') command = 'side-preview';
      else if (e.shiftKey && e.code === 'KeyI') command = 'side-assets';
      else if (!e.shiftKey && e.key.toLowerCase() === 'w') command = 'close';
      else if (e.shiftKey && e.code === 'BracketRight') command = 'next';
      else if (e.shiftKey && e.code === 'BracketLeft') command = 'previous';
      else if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        command = `jump-${e.code.slice(5)}` as TabCommand;
      }
      if (command !== null && run(command)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const off = window.creatorhub?.onTabCommand((command) => {
      // ⌘W with no tab in front closes the window, as before tabs existed.
      if (!run(command) && command === 'close') window.close();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      off?.();
    };
  }, [run]);

  /**
   * Double-click or 重新命名 on a tab (QC-052): an open editor renames through
   * its session; a tab that is not loaded patches the work's latest revision.
   */
  const renameTab = useCallback(
    (id: string, title: string) => {
      const tab = model.find(id);
      if (tab === null) return;
      const before = tab.title;
      model.update(id, { title });
      const handle = handles.current.get(id);
      const run =
        handle !== undefined
          ? handle.change({ title })
          : props.client.works
              .get(id)
              .then((work) => changeWork(props.client, work, { title }, handles.current))
              .then((r) => r.outcome)
              .catch(() => 'failed' as const);
      void run.then((outcome) => {
        if (outcome === 'saved' || outcome === 'pending') return;
        model.update(id, { title: before });
        setNotice({
          kind: 'renameFailed',
          message: t(
            outcome === 'conflict' ? 'workActions.renameConflict' : 'workActions.renameFailed',
            {
              title: before,
            },
          ),
        });
      });
    },
    [model, props.client],
  );

  const loaded = useMemo(
    // A stable order, so reordering tabs never moves a mounted editor in the DOM.
    () => state.tabs.filter((tab) => tab.loaded).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [state.tabs],
  );
  const confirmTab = confirm === null ? null : model.find(confirm.id);

  // Tab notices go through the shared queue (QC-045), shown while the editor area is in front.
  const closeNotice = () => {
    if (notice?.kind === 'closed') model.dismissClosed();
    setNotice(null);
  };
  useToast(
    !visible || notice === null
      ? null
      : {
          message:
            notice.kind === 'closed'
              ? t('tabs.closedTab', { title: notice.title })
              : notice.kind === 'already'
                ? t('tabs.alreadyOpen', { title: notice.title })
                : notice.message,
          tone:
            notice.kind === 'already' ? 'neutral' : notice.kind === 'renameFailed' ? 'bad' : 'ok',
          actions:
            notice.kind === 'closed' && state.closed !== null
              ? [
                  {
                    label: t('tabs.reopen'),
                    onClick: () => {
                      const closed = model.reopen();
                      if (closed !== null && closed.draft !== null) {
                        reopenDrafts.current.set(closed.tab.id, closed.draft as Draft);
                      }
                      setNotice(null);
                      onFocusEditor();
                    },
                  },
                ]
              : [],
          onClose: closeNotice,
        },
  );

  return (
    <SideContext.Provider value={side}>
      <div ref={area} className="tabs-area" hidden={!visible}>
        <TabBar
          model={model}
          tabs={state.tabs}
          activeId={state.activeId}
          flashId={state.flashId}
          flashSeq={state.flashSeq}
          onActivate={(id, focus) => {
            model.activate(id);
            if (focus) onFocusEditor();
          }}
          onClose={(id) => {
            void requestClose(id);
          }}
          onCloseOthers={(id) => {
            // The bar shows what closed. 重新開啟 is gone with it, so its notice goes too.
            if (model.closeOthers(id) > 0) {
              setNotice((n) => (n?.kind === 'closed' ? null : n));
            }
            onFocusEditor();
          }}
          onRename={renameTab}
          onOpenedOutOfView={sayAlreadyOpen}
        />
        {loaded.map((tab) => (
          <TabPane
            key={tab.id}
            {...props}
            tab={tab}
            active={visible && tab.id === state.activeId}
            shown={tab.id === state.activeId}
            handles={handles.current}
            reopenDrafts={reopenDrafts.current}
          />
        ))}

        {confirmCandidates !== null && (
          <Dialog
            title={t('tabs.candidateTitle', {
              title: tabTitle(model.find(confirmCandidates) ?? { title: '' }),
            })}
            onClose={() => {
              setConfirmCandidates(null);
            }}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    const id = confirmCandidates;
                    setConfirmCandidates(null);
                    finishClose(id, null);
                  }}
                >
                  {t('tabs.discardCandidatesClose')}
                </button>
                <button
                  type="button"
                  className="btn dialog__primary"
                  data-autofocus
                  onClick={() => {
                    setConfirmCandidates(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </>
            }
          >
            <p>{t('tabs.candidateBody')}</p>
          </Dialog>
        )}
        {confirm !== null && confirmTab !== null && (
          <Dialog
            title={t('tabs.unsavedTitle', { title: tabTitle(confirmTab) })}
            onClose={() => {
              setConfirm(null);
            }}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    const draft = handles.current.get(confirm.id)?.discard() ?? null;
                    setConfirm(null);
                    finishClose(confirm.id, draft);
                  }}
                >
                  {t('tabs.discardClose')}
                </button>
                <button
                  type="button"
                  className="btn dialog__primary"
                  data-autofocus
                  onClick={() => {
                    setConfirm(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    const handle = handles.current.get(confirm.id);
                    if (handle === undefined) return;
                    void handle.flush().then((clean) => {
                      if (clean) {
                        setConfirm(null);
                        finishClose(confirm.id, null);
                      } else {
                        setConfirm({ id: confirm.id, failedAgain: true });
                      }
                    });
                  }}
                >
                  {t('tabs.retrySave')}
                </button>
              </>
            }
          >
            <p>{t(confirmTab.conflict ? 'tabs.conflictBody' : 'tabs.unsavedBody')}</p>
            {confirm.failedAgain && (
              <p className="dialog__warn" role="alert">
                {t('tabs.stillUnsaved')}
              </p>
            )}
          </Dialog>
        )}
      </div>
    </SideContext.Provider>
  );
}

// ---- One tab's editor ------------------------------------------------------------------------

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; work: WorkDetail }
  | { state: 'missing' }
  | {
      state: 'failed';
    };

function TabPane({
  model,
  client,
  userHome,
  preloaded,
  focusToken,
  onBack,
  onOpenSettings,
  onOpenPrompts,
  onOpenAgentActivity,
  tab,
  active,
  shown,
  handles,
  reopenDrafts,
}: EditorTabsProps & {
  tab: Tab;
  active: boolean;
  shown: boolean;
  handles: Map<string, EditorTabHandle>;
  reopenDrafts: Map<string, Draft>;
}) {
  const id = tab.id;
  const [loaded, setLoaded] = useState<Loaded>(() => {
    const work = preloaded.get(id);
    return work === undefined ? { state: 'loading' } : { state: 'ready', work };
  });
  useEffect(() => {
    preloaded.delete(id);
  }, [preloaded, id]);
  const needsLoad = loaded.state === 'loading';
  useEffect(() => {
    if (!needsLoad) return;
    let cancelled = false;
    client.works
      .get(id)
      .then((work) => {
        if (cancelled) return;
        setLoaded({ state: 'ready', work });
        model.update(id, { title: work.title, kind: work.type, missing: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const missing = err instanceof ApiError && err.status === 404;
        setLoaded({ state: missing ? 'missing' : 'failed' });
        if (missing) model.update(id, { missing: true });
      });
    return () => {
      cancelled = true;
    };
    // Loaded once per mount (and on 重試); later changes arrive through the editor's session.
  }, [needsLoad, client, id, model]);
  const [initialDraft] = useState(() => {
    const draft = reopenDrafts.get(id) ?? null;
    reopenDrafts.delete(id);
    return draft;
  });
  // The view this tab had when it was unloaded or restored; read once, when the editor mounts.
  const [initialView] = useState<TabView>(tab.view);

  const onTabStatus = useCallback(
    (patch: TabStatusPatch) => {
      model.update(id, patch);
    },
    [model, id],
  );
  const onViewChange = useCallback(
    (view: TabView) => {
      model.saveView(id, view);
    },
    [model, id],
  );
  const onHandle = useCallback(
    (handle: EditorTabHandle | null) => {
      if (handle === null) handles.delete(id);
      else handles.set(id, handle);
    },
    [handles, id],
  );

  return (
    <div
      className="tab-pane"
      id={`tab-pane-${id}`}
      role="tabpanel"
      aria-labelledby={`tab-${id}`}
      hidden={!shown}
    >
      {loaded.state === 'ready' && loaded.work.type === 'image' ? (
        <ImagePostEditor
          client={client}
          work={loaded.work}
          userHome={userHome}
          active={active}
          initialView={initialView}
          initialDraft={initialDraft}
          onTabStatus={onTabStatus}
          onViewChange={onViewChange}
          onHandle={onHandle}
          onBack={onBack}
          onOpenAgentActivity={onOpenAgentActivity}
        />
      ) : loaded.state === 'ready' && loaded.work.type === 'video' ? (
        <VideoWorkEditor
          client={client}
          work={loaded.work}
          userHome={userHome}
          active={active}
          initialView={initialView}
          initialDraft={initialDraft}
          onTabStatus={onTabStatus}
          onViewChange={onViewChange}
          onHandle={onHandle}
          onBack={onBack}
          onOpenAgentActivity={onOpenAgentActivity}
          onOpenSettings={onOpenSettings}
        />
      ) : loaded.state === 'ready' ? (
        <EditorPage
          client={client}
          work={loaded.work}
          userHome={userHome}
          active={active}
          focusToken={focusToken}
          initialView={initialView}
          initialDraft={initialDraft}
          onTabStatus={onTabStatus}
          onViewChange={onViewChange}
          onHandle={onHandle}
          onBack={onBack}
          onOpenAgentActivity={onOpenAgentActivity}
          onOpenSettings={onOpenSettings}
          onOpenPrompts={onOpenPrompts}
        />
      ) : loaded.state === 'loading' ? (
        <main className="page page--center" aria-busy="true" />
      ) : (
        <main className="page page--center">
          <div className="state-card" role="alert">
            <Icon name="alert" size={28} />
            <span className="state-card__title">
              {t(loaded.state === 'missing' ? 'tabs.missing' : 'tabs.loadFailed')}
            </span>
            {loaded.state === 'missing' ? (
              <span className="state-card__detail">{t('tabs.missingHint')}</span>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setLoaded({ state: 'loading' });
                }}
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

// ---- Tab bar --------------------------------------------------------------------------------

function TabBar({
  model,
  tabs,
  activeId,
  flashId,
  flashSeq,
  onActivate,
  onClose,
  onCloseOthers,
  onRename,
  onOpenedOutOfView,
}: {
  model: TabsModel;
  tabs: readonly Tab[];
  activeId: string | null;
  flashId: string | null;
  flashSeq: number;
  onActivate: (id: string, focusEditor: boolean) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** An already open work was opened again while its tab was past the edge of the bar. */
  onOpenedOutOfView: (id: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const menuTab = menu === null ? null : (tabs.find((tab) => tab.id === menu.id) ?? null);
  const [fade, setFade] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (el === null) return;
    setFade({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);
  /** Scroll the active tab into view, noting the width of the bar it was done for. */
  const revealedAt = useRef(0);
  const reveal = useCallback((id: string) => {
    revealedAt.current = strip.current?.clientWidth ?? 0;
    document.getElementById(`tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  const activeNow = useRef(activeId);
  activeNow.current = activeId;
  useEffect(() => {
    const el = strip.current;
    if (el === null) return;
    measure();
    const observer = new ResizeObserver(() => {
      // A new editor's sidebar narrows the bar after the tab was scrolled to.
      const width = el.clientWidth;
      if (width > 0 && width !== revealedAt.current && activeNow.current !== null) {
        reveal(activeNow.current);
      }
      measure();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [measure, reveal, tabs.length]);
  // Opened again: was the tab in sight (at least half of it)? A layout effect,
  // so this is measured before the effect below scrolls it into view.
  const measuredFlash = useRef(flashSeq);
  useLayoutEffect(() => {
    if (measuredFlash.current === flashSeq) return;
    measuredFlash.current = flashSeq;
    const bar = strip.current;
    const tab = flashId === null ? null : document.getElementById(`tab-${flashId}`);
    if (flashId === null || bar === null || tab === null) return;
    const view = bar.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    if (middle < view.left || middle > view.right) onOpenedOutOfView(flashId);
  }, [flashSeq, flashId, onOpenedOutOfView]);
  // Keep the active tab in view, also when it is opened again.
  useEffect(() => {
    if (activeId !== null) reveal(activeId);
  }, [activeId, flashSeq, reveal]);

  // Drag to reorder (QC-065, DESIGN.md 動效 · 編輯分頁): dnd-kit sortable along the bar;
  // the other tabs move aside (`base`), the dropped tab settles, Esc puts it back.
  const mode = useMotionMode();
  const sensors = useDragSensors();
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing>('cancel');
  const dragTab = dragId === null ? null : (tabs.find((tab) => tab.id === dragId) ?? null);
  const onDragStart = (e: DragStartEvent) => {
    setDragId(String(e.active.id));
    setLanding('cancel');
  };
  const onDragOver = (e: DragOverEvent) => {
    setLanding(e.over === null || e.over.id === e.active.id ? 'cancel' : 'sort');
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (e.over === null) return;
    const from = tabs.findIndex((tab) => tab.id === e.active.id);
    const to = tabs.findIndex((tab) => tab.id === e.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    // TabsModel.move puts the tab before the one at the index it is given.
    model.move(String(e.active.id), to > from ? to + 1 : to);
  };
  // Tabs there when the bar first showed appear as they are; later ones fade in.
  const [firstIds] = useState(() => new Set(tabs.map((tab) => tab.id)));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.altKey || e.ctrlKey) return;
    const i = tabs.findIndex((tab) => tab.id === activeId);
    let next: Tab | undefined;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') {
      if (activeId !== null) onActivate(activeId, true);
      e.preventDefault();
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    // Arrow keys switch tabs but keep focus on the bar.
    onActivate(next.id, false);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="tabbar">
      <div
        ref={strip}
        className={[
          'tabbar__strip',
          fade.left ? 'tabbar__strip--fade-left' : '',
          fade.right ? 'tabbar__strip--fade-right' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="tablist"
        aria-label={t('tabs.barLabel')}
        onScroll={measure}
        onKeyDown={onKeyDown}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[alongTheBar]}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragId(null);
            setLanding('cancel');
          }}
          accessibility={{ restoreFocus: false }}
        >
          <SortableContext
            items={tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab, i) => (
              // Opening or closing a tab: the others slide into place (`snappy`); a new tab fades in.
              // Only the count drives this, so a drag's new order is not animated twice.
              <motion.div
                key={tab.id}
                role="presentation"
                className="tab-slot"
                layout={moves(mode) ? 'position' : false}
                layoutDependency={tabs.length}
                transition={springOf('snappy')}
                initial={firstIds.has(tab.id) || !moves(mode) ? false : { opacity: 0 }}
                animate={{ opacity: 1, transition: tween('fast') }}
              >
                <TabItem
                  key={tab.id}
                  tab={tab}
                  index={i}
                  count={tabs.length}
                  active={tab.id === activeId}
                  flash={tab.id === flashId ? flashSeq : null}
                  dragging={dragId === tab.id}
                  sortTransitionMode={mode}
                  renaming={renaming === tab.id}
                  menuOpen={menu?.id === tab.id}
                  onActivate={onActivate}
                  onClose={onClose}
                  onStartRename={() => {
                    setRenaming(tab.id);
                  }}
                  onRename={(title) => {
                    setRenaming(null);
                    if (title !== null) onRename(tab.id, title);
                    document.getElementById(`tab-${tab.id}`)?.focus();
                  }}
                  onMenu={(e) => {
                    e.preventDefault();
                    setMenu({ id: tab.id, anchor: anchorOf(e) });
                  }}
                />
              </motion.div>
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={dropAnimationFor(landing, mode)} modifiers={[alongTheBar]}>
            {dragTab === null ? null : (
              <div className="drag-ghost drag-ghost--tab">
                <Icon name={WORK_TYPE[dragTab.kind].icon} size={14} />
                {tabTitle(dragTab)}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
      {menu !== null && menuTab !== null && (
        <ContextMenu
          anchor={menu.anchor}
          label={t('workActions.tabMenu', { title: tabTitle(menuTab) })}
          items={[
            {
              kind: 'item',
              id: 'rename',
              label: t('workActions.rename'),
              disabled: menuTab.missing,
              onSelect: () => {
                setRenaming(menuTab.id);
              },
            },
            { kind: 'sep', id: 'sep' },
            {
              kind: 'item',
              id: 'close',
              label: t('workActions.closeTab'),
              hint: '⌘W',
              onSelect: () => {
                onClose(menuTab.id);
              },
            },
            {
              kind: 'item',
              id: 'close-others',
              label: t('tabs.closeOthers'),
              disabled: tabs.length < 2,
              onSelect: () => {
                onCloseOthers(menuTab.id);
              },
            },
          ]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      <AllTabsMenu
        tabs={tabs}
        activeId={activeId}
        onActivate={(id) => {
          onActivate(id, true);
        }}
        onCloseOthers={onCloseOthers}
      />
    </div>
  );
}

function TabItem({
  tab,
  index,
  count,
  active,
  flash,
  dragging,
  renaming,
  menuOpen,
  onActivate,
  onClose,
  onStartRename,
  onRename,
  onMenu,
  sortTransitionMode,
}: {
  tab: Tab;
  index: number;
  count: number;
  active: boolean;
  /** Non-null to flash; a new number flashes again. */
  flash: number | null;
  dragging: boolean;
  renaming: boolean;
  /** Its right-click menu is open. */
  menuOpen: boolean;
  onActivate: (id: string, focusEditor: boolean) => void;
  onClose: (id: string) => void;
  onStartRename: () => void;
  /** The new title, or null when the rename was cancelled. */
  onRename: (title: string | null) => void;
  onMenu: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** How the other tabs move aside while one is dragged. */
  sortTransitionMode: ReturnType<typeof useMotionMode>;
}) {
  const liveWorking = useWorkLive(tab.id)?.state === 'working';
  const ref = useRef<HTMLDivElement>(null);
  const sortable = useSortable({
    id: tab.id,
    disabled: renaming,
    transition: sortTransition(sortTransitionMode),
  });
  const { setNodeRef } = sortable;
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useEffect(() => {
    const el = ref.current;
    if (flash === null || el === null) return;
    el.classList.remove('tab--flash');
    // Restart the animation: force a layout between removing and adding the class.
    el.getBoundingClientRect();
    el.classList.add('tab--flash');
  }, [flash]);
  const title = tabTitle(tab);
  const states = tabStates(tab);
  const shortcut = shortcutFor(index, count);
  const tooltip = [title, ...states].join(' · ') + (shortcut === null ? '' : ` (${shortcut})`);
  const icon = WORK_TYPE[tab.kind].icon;
  return (
    <div
      ref={setRefs}
      id={`tab-${tab.id}`}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      onPointerDown={sortable.listeners?.['onPointerDown'] as PointerEventHandler<HTMLDivElement>}
      className={[
        'tab',
        active ? 'tab--active' : '',
        tab.loaded ? '' : 'tab--unloaded',
        tab.unsaved ? 'tab--unsaved' : '',
        tab.missing ? 'tab--missing' : '',
        dragging ? 'tab--dragging' : '',
        renaming ? 'tab--renaming' : '',
        menuOpen ? 'tab--menu' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="tab"
      aria-selected={active}
      aria-controls={tab.loaded ? `tab-pane-${tab.id}` : undefined}
      aria-description={states.join(', ') || undefined}
      tabIndex={active ? 0 : -1}
      title={renaming ? undefined : tooltip}
      onContextMenu={onMenu}
      onDoubleClick={(e) => {
        if (tab.missing || e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        onStartRename();
      }}
      onMouseDown={(e) => {
        // Middle click closes, as in browsers.
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      onClick={() => {
        onActivate(tab.id, true);
      }}
    >
      {liveWorking ? (
        // QC-097: an agent is working on this work (breathing in full motion).
        <LiveDot label={t('live.tabWorking')} />
      ) : (
        <Icon name={icon} size={14} />
      )}
      {renaming ? (
        <RenameField
          value={tab.title}
          label={t('workActions.renameField', { title })}
          className="rename--tab"
          onCommit={onRename}
          onCancel={() => {
            onRename(null);
          }}
        />
      ) : (
        <span className="tab__title">{title}</span>
      )}
      {tab.conflict && (
        <span className="tab__conflict" aria-hidden="true">
          <Icon name="alert" size={12} />
        </span>
      )}
      {tab.aiCandidate && (
        <span className="tab__ai" aria-hidden="true">
          <Icon name="spark" size={12} />
        </span>
      )}
      <span className="tab__end">
        {tab.unsaved && <span className="tab__dot" aria-hidden="true" />}
        <button
          type="button"
          className="tab__close"
          tabIndex={-1}
          aria-label={t('tabs.close', { title })}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    </div>
  );
}

function AllTabsMenu({
  tabs,
  activeId,
  onActivate,
  onCloseOthers,
}: {
  tabs: readonly Tab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onCloseOthers: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || root.current?.contains(e.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  const q = query.trim().toLowerCase();
  const shown = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => q === '' || tabTitle(tab).toLowerCase().includes(q));
  const close = () => {
    setOpen(false);
    setQuery('');
    button.current?.focus();
  };
  const pick = (id: string) => {
    setOpen(false);
    setQuery('');
    onActivate(id);
  };
  return (
    <div className="tabbar__all" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn--ghost btn--small tabbar__all-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('tabs.allTabsButton', { count: tabs.length })}
        title={t('tabs.allTabs')}
        onClick={() => {
          setOpen((v) => !v);
          setCursor(
            Math.max(
              0,
              tabs.findIndex((tab) => tab.id === activeId),
            ),
          );
        }}
      >
        <span className="tabbar__count">{tabs.length}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <ExitFade>
          <div
            className="pop tabbar__pop"
            role="dialog"
            aria-label={t('tabs.allTabs')}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = shown.length;
                if (n > 0) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
              } else if (e.key === 'Enter') {
                const hit = shown[Math.min(cursor, shown.length - 1)];
                if (hit !== undefined) {
                  e.preventDefault();
                  pick(hit.tab.id);
                }
              }
            }}
          >
            <input
              className="input tabbar__search"
              type="search"
              // The menu exists to find a tab: typing goes straight into the search.
              autoFocus
              placeholder={t('tabs.search')}
              aria-label={t('tabs.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
            />
            <div className="tabbar__list" role="listbox" aria-label={t('tabs.allTabs')}>
              {shown.length === 0 && <div className="pop__empty">{t('tabs.noMatch')}</div>}
              {shown.map(({ tab, index }, i) => {
                const states = tabStates(tab);
                const shortcut = shortcutFor(index, tabs.length);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="option"
                    aria-selected={i === Math.min(cursor, shown.length - 1)}
                    aria-current={tab.id === activeId ? 'true' : undefined}
                    className={[
                      'pop__item',
                      'tabbar__item',
                      tab.loaded ? '' : 'tabbar__item--unloaded',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => {
                      setCursor(i);
                    }}
                    onClick={() => {
                      pick(tab.id);
                    }}
                  >
                    <Icon name={WORK_TYPE[tab.kind].icon} size={14} />
                    <span className="tabbar__item-title">{tabTitle(tab)}</span>
                    <span className="tabbar__item-state">{states.join(' · ')}</span>
                    {shortcut === null ? <span /> : <kbd>{shortcut}</kbd>}
                  </button>
                );
              })}
            </div>
            <div className="pop__sep" />
            <button
              type="button"
              className="pop__item"
              disabled={activeId === null || tabs.length < 2}
              onClick={() => {
                setOpen(false);
                setQuery('');
                if (activeId !== null) onCloseOthers(activeId);
              }}
            >
              <Icon name="close" size={14} />
              {t('tabs.closeOthers')}
              <span className="pop__item-hint">{t('tabs.closeOthersHint')}</span>
            </button>
          </div>
        </ExitFade>
      )}
    </div>
  );
}
