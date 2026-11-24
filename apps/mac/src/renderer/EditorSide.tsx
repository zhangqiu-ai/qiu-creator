import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  shownTab,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  SIDE_STEP,
  SIDE_TABS,
  SideStore,
  type SideTab,
} from './editor-side.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';
import { hasOpenLayer } from './motion.js';
import './editor-side.css';

/** One store per window, given by the tab area to every editor. */
export const SideContext = createContext<SideStore | null>(null);

/** Editors outside the tab area (tests, a lone editor) get a store of their own. */
const fallback = new SideStore(null);

export function useSideStore(): SideStore {
  return useContext(SideContext) ?? fallback;
}

const ICON: Readonly<Record<SideTab, IconName>> = {
  preview: 'phone',
  ai: 'spark',
  history: 'history',
  assets: 'image',
};

const LABEL = {
  preview: 'editorSide.preview',
  ai: 'editorSide.ai',
  history: 'editorSide.history',
  assets: 'editorSide.assets',
} as const;

export interface EditorSideProps {
  workId: string;
  /** The tabs this editor offers, with their content (null while it loads). */
  panels: Partial<Record<SideTab, ReactNode>>;
  /** This editor's tab is in front (Esc and outside clicks close the drawer only then). */
  active: boolean;
  /** A dialog of the editor is open: the sidebar takes no input meanwhile. */
  inert?: boolean;
}

/**
 * The work editor's full-height right sidebar (QC-085, PT-20261123-002 A).
 * Each editor renders its own (so panels keep their state per work), but
 * which tab is in front, open or collapsed, and the width belong to the
 * window ({@link SideStore}). Tabs are 預覽, AI, 歷史, 素材; an editor offers
 * the ones it has. Collapsed, it is a 44 px icon rail; in a narrow window
 * it opens as a drawer over the text. Visited panels stay mounted while
 * hidden, so switching tabs never loses a half-written instruction.
 */
export function EditorSide({ workId, panels, active, inert = false }: EditorSideProps) {
  const store = useSideStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const offered = SIDE_TABS.filter((k) => k in panels);
  const tab = shownTab(state.prefs.tab, offered);
  const expanded = state.drawer ? state.drawerOpen : state.prefs.open;
  // 預覽 is always mounted: its limits drive the orange dot even while collapsed.
  const [visited, setVisited] = useState<ReadonlySet<SideTab>>(() => new Set(['preview', tab]));
  if (expanded && !visited.has(tab)) setVisited(new Set([...visited, tab]));

  // The drawer closes on Esc (when nothing inside took it) and on a click in the text.
  const drawerOut = state.drawer && state.drawerOpen && active;
  useEffect(() => {
    if (!drawerOut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || hasOpenLayer()) return;
      store.collapse();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      // Only a click in the editor column (menus and popovers live elsewhere and stay open).
      if (target instanceof Element && target.closest('.tab-pane > main') !== null) {
        store.collapse();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [drawerOut, store]);

  // A tab brought forward (⌘⇧I, 插入 → 從素材庫, a click) puts the caret in its search field,
  // if it has one. Switching work tabs is not bringing it forward.
  const shownKey = expanded ? tab : null;
  const lastKey = useRef(shownKey);
  const live = useRef(active);
  live.current = active;
  useEffect(() => {
    if (lastKey.current === shownKey) return;
    lastKey.current = shownKey;
    if (shownKey === null || !live.current) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`side-pane-${workId}-${shownKey}`)
        ?.querySelector<HTMLElement>('[data-side-focus]')
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [shownKey, workId]);

  const over = state.over.has(workId);
  const tabId = (k: SideTab) => `side-tab-${workId}-${k}`;
  const paneId = (k: SideTab) => `side-pane-${workId}-${k}`;
  const docked = !state.drawer;
  const cls = [
    'side',
    expanded ? 'side--open' : 'side--collapsed',
    state.drawer ? 'side--drawer' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      className={cls}
      aria-label={t('editorSide.label')}
      inert={inert}
      style={docked && expanded ? { width: state.prefs.width } : undefined}
    >
      {(!expanded || state.drawer) && (
        <div className="side__rail" role="toolbar" aria-label={t('editorSide.tabs')}>
          <button
            type="button"
            className="side__rail-btn"
            aria-label={t(expanded ? 'editorSide.collapse' : 'editorSide.expand')}
            data-tip={t(expanded ? 'editorSide.collapse' : 'editorSide.expand')}
            aria-keyshortcuts="Alt+Meta+0"
            aria-expanded={expanded}
            onClick={() => {
              store.toggle();
            }}
          >
            <Icon name="sideRight" size={16} />
          </button>
          {offered.map((k) => (
            <button
              key={k}
              type="button"
              className="side__rail-btn"
              aria-label={`${t(LABEL[k])}${k === 'preview' && over ? ` · ${t('editorSide.overLimit')}` : ''}`}
              data-tip={t(LABEL[k])}
              aria-pressed={expanded && k === tab}
              onClick={() => {
                store.show(k);
              }}
            >
              <Icon name={ICON[k]} size={16} />
              {k === 'preview' && over && <span className="side__dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
      <div className="side__panel" hidden={!expanded}>
        {docked && (
          <ResizeHandle
            width={state.prefs.width}
            onWidth={(w, from) => {
              store.resize(w, from);
            }}
          />
        )}
        <div className="side__head">
          <div
            className="side__tabs"
            role="tablist"
            aria-label={t('editorSide.tabs')}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = offered.indexOf(tab);
              const n = offered.length;
              const next = offered[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
              if (next === undefined) return;
              store.show(next);
              requestAnimationFrame(() => {
                document.getElementById(tabId(next))?.focus();
              });
            }}
          >
            {offered.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                id={tabId(k)}
                className="side__tab"
                aria-selected={k === tab}
                aria-controls={paneId(k)}
                tabIndex={k === tab ? 0 : -1}
                onClick={() => {
                  store.show(k);
                }}
              >
                <Icon name={ICON[k]} size={14} />
                {t(LABEL[k])}
                {k === 'preview' && over && (
                  <span className="side__dot" role="img" aria-label={t('editorSide.overLimit')} />
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small side__collapse"
            aria-label={t('editorSide.collapse')}
            title={`${t('editorSide.collapse')} ⌥⌘0`}
            aria-keyshortcuts="Alt+Meta+0"
            onClick={() => {
              store.collapse();
            }}
          >
            <Icon name="sideRight" size={16} />
          </button>
        </div>
        <div className="side__body">
          {offered
            .filter((k) => visited.has(k))
            .map((k) => (
              <div
                key={k}
                className="side__pane"
                role="tabpanel"
                id={paneId(k)}
                aria-labelledby={tabId(k)}
                hidden={k !== tab}
              >
                {panels[k]}
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

/** The sidebar's left edge: drag 400–760, double-click 520, ←/→ by 16 when focused. */
function ResizeHandle({
  width,
  onWidth,
}: {
  width: number;
  /** `from`: the width when a drag began (a snap shut keeps it). */
  onWidth: (w: number, from?: number) => void;
}) {
  return (
    <div
      className="side__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('editorSide.resize')}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        document.body.classList.add('is-resizing');
        const move = (ev: PointerEvent) => {
          onWidth(startW + (startX - ev.clientX), startW);
        };
        const up = () => {
          document.body.classList.remove('is-resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      onDoubleClick={() => {
        onWidth(SIDE_DEFAULT);
      }}
      onKeyDown={(e) => {
        // The handle is on the left: ← widens the sidebar.
        if (e.key === 'ArrowLeft') onWidth(Math.min(SIDE_MAX, width + SIDE_STEP));
        else if (e.key === 'ArrowRight') onWidth(Math.max(SIDE_MIN, width - SIDE_STEP));
        else if (e.key === 'Home') onWidth(SIDE_MIN);
        else if (e.key === 'End') onWidth(SIDE_MAX);
        else return;
        e.preventDefault();
      }}
    />
  );
}
