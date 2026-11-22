import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Project } from '@qiu-creator/contracts';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { anchorOf } from './ContextMenu.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { renameProject, useNotice } from './project-actions.js';
import { sortTransition, type DragData } from './projects-dnd.js';
import { useMotionMode } from './motion-mode.js';
import { useProjectMenu } from './project-menu.js';
import {
  moveInOrder,
  projectColor,
  projectName,
  type ProjectsState,
  type ProjectsStore,
} from './projects-store.js';
import { RenameField } from './RenameField.js';

/** Which works 作品庫 shows (QC-062). */
export type LibraryScope =
  { kind: 'all' } | { kind: 'unassigned' } | { kind: 'project'; id: string };

const SECTION_KEY = 'qc.sidebar.projects';

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? '1' : '0');
  } catch {
    // a per-viewer convenience only
  }
}

/**
 * 未分類 and the 項目 section of the sidebar (QC-062, PT-20261121-003): rows
 * with a colour block, name and count; click to open, double-click or F2 to
 * rename, right-click for the project menu, drag to reorder (or ⌥↑/⌥↓), and
 * drop works on a row to add them (never to move them). Archived projects
 * sit in a folded group; in the 56 px rail only the colour blocks remain.
 */
export function SidebarProjects({
  store,
  s,
  client,
  rail,
  scope,
  active,
  onOpen,
}: {
  store: ProjectsStore;
  s: ProjectsState;
  client: CreatorHubClient;
  rail: boolean;
  scope: LibraryScope;
  /** 作品庫 is the page in front (so the scope's row is the current one). */
  active: boolean;
  onOpen: (scope: LibraryScope) => void;
}) {
  const notify = useNotice();
  const [open, setOpen] = useState(() => readOpen(SECTION_KEY, true));
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** A row picked up with Space (keyboard reorder): its order before, and the order shown now. */
  const [lifted, setLifted] = useState<{ id: string; from: string[]; order: string[] } | null>(
    null,
  );
  const [spoken, setSpoken] = useState('');
  const hintId = useId();

  const projects = s.projects ?? [];
  const stored = projects.filter((p) => !p.archived);
  // While a row is picked up, show the order it would land in.
  const live =
    lifted === null
      ? stored
      : lifted.order
          .map((id) => stored.find((p) => p.id === id))
          .filter((p): p is Project => p !== undefined);
  const archived = projects.filter((p) => p.archived);
  const isCurrent = (id: string) => active && scope.kind === 'project' && scope.id === id;

  const rename = (p: Project, typed: string) => {
    setRenaming(null);
    void renameProject(store, p, typed, notify);
  };

  const create = async (typed: string) => {
    setCreating(false);
    const name = projectName(typed);
    if (name === null) return;
    try {
      const p = await store.create(name);
      notify({ message: t('projects.created', { name: p.name }) });
      onOpen({ kind: 'project', id: p.id });
    } catch {
      notify({ message: t('common.cannotConnect'), tone: 'bad' });
    }
  };

  const move = (p: Project, step: -1 | 1) => {
    void store.reorder(moveInOrder(store.order, p.id, step));
  };

  const menu = useProjectMenu({
    store,
    client,
    notify,
    onRename: (p) => {
      if (p.archived) setArchivedOpen(true);
      setRenaming(p.id);
    },
    onGone: (p) => {
      if (isCurrent(p.id)) onOpen({ kind: 'all' });
    },
  });

  const focusRow = (id: string) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-project-row="${id}"]`)?.focus();
    });
  };

  /**
   * Keyboard reorder (DESIGN.md 動效 · 拖放：鍵盤): Space picks the row up, ↑/↓
   * move it, Space puts it down, Esc (or leaving the row) puts everything back.
   * Each step is spoken. Returns true when the key was used.
   */
  const liftKey = (e: KeyboardEvent<HTMLButtonElement>, p: Project): boolean => {
    if (p.archived) return false;
    if (e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return true;
      if (lifted?.id === p.id) {
        const changed = lifted.order.join() !== lifted.from.join();
        setLifted(null);
        if (changed) void store.reorder([...lifted.order, ...archived.map((x) => x.id)]);
        setSpoken(t('projects.dndDropped', { name: p.name }));
      } else {
        const ids = stored.map((x) => x.id);
        setLifted({ id: p.id, from: ids, order: ids });
        setSpoken(t('projects.dndPicked', { name: p.name }));
      }
      return true;
    }
    if (lifted?.id !== p.id) return false;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
      e.preventDefault();
      const order = moveInOrder(lifted.order, p.id, e.key === 'ArrowUp' ? -1 : 1);
      setLifted({ ...lifted, order });
      setSpoken(
        t('projects.dndPosition', {
          name: p.name,
          position: order.indexOf(p.id) + 1,
          total: order.length,
        }),
      );
      focusRow(p.id);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setLifted(null);
      setSpoken(t('projects.dndCancelled', { name: p.name }));
      return true;
    }
    return false;
  };

  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, p: Project) => {
    if (e.nativeEvent.isComposing) return;
    if (liftKey(e, p)) return;
    if (e.key === 'F2') {
      e.preventDefault();
      setRenaming(p.id);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(p, e.key === 'ArrowUp' ? -1 : 1);
      focusRow(p.id);
    }
  };

  const row = (p: Project, dnd: RowDnd | null) => {
    const current = isCurrent(p.id);
    const dropping = dnd?.dropping === true;
    if (renaming === p.id) {
      return (
        <div key={p.id} className="sb__nav sb-proj__row sb-proj__row--edit">
          <span className="sb-proj__chip" style={{ background: projectColor(p.color) }} />
          <RenameField
            value={p.name}
            label={t('workActions.renameField', { title: p.name })}
            className="rename--sidebar"
            onCommit={(name) => {
              rename(p, name);
            }}
            onCancel={() => {
              setRenaming(null);
            }}
          />
        </div>
      );
    }
    return (
      <button
        key={p.id}
        type="button"
        className={[
          'sb__nav',
          'sb-proj__row',
          dropping ? 'sb-proj__row--drop' : '',
          dnd?.dragging === true ? 'sb-proj__row--dragging' : '',
          dnd?.insert === 'before' ? 'sb-proj__row--insert-before' : '',
          dnd?.insert === 'after' ? 'sb-proj__row--insert-after' : '',
          p.archived ? 'sb-proj__row--archived' : '',
          menu.openId === p.id ? 'sb-proj__row--menu' : '',
          lifted?.id === p.id ? 'sb-proj__row--lifted' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-project-row={p.id}
        data-archived={p.archived ? 'true' : undefined}
        aria-current={current ? 'page' : undefined}
        aria-label={`${p.name} ${t('projects.worksCount', { count: p.work_count })}`}
        aria-keyshortcuts="F2 Alt+ArrowUp Alt+ArrowDown Space"
        aria-describedby={p.archived ? undefined : hintId}
        aria-pressed={lifted?.id === p.id ? true : undefined}
        data-tip={p.name}
        title={rail ? undefined : p.name}
        ref={dnd?.ref}
        style={dnd?.style}
        onPointerDown={dnd?.onPointerDown}
        onClick={() => {
          onOpen({ kind: 'project', id: p.id });
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          setRenaming(p.id);
        }}
        onKeyDown={(e) => {
          onRowKey(e, p);
        }}
        onBlur={() => {
          // Leaving a picked-up row puts it back (a reorder is only kept with Space).
          if (lifted?.id === p.id) {
            requestAnimationFrame(() => {
              if (document.activeElement?.getAttribute('data-project-row') !== p.id) {
                setLifted(null);
                setSpoken(t('projects.dndCancelled', { name: p.name }));
              }
            });
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.open(p, anchorOf(e));
        }}
      >
        <span className="sb-proj__chip" style={{ background: projectColor(p.color) }} />
        <span className="sb__label">{p.name}</span>
        <span className="sb__count num">{p.work_count}</span>
      </button>
    );
  };

  return (
    <div className="sb-proj">
      <span id={hintId} className="visually-hidden">
        {t('projects.dndInstructions')}
      </span>
      <span className="visually-hidden" aria-live="assertive">
        {spoken}
      </span>
      <button
        type="button"
        className="sb__nav"
        aria-current={active && scope.kind === 'unassigned' ? 'page' : undefined}
        aria-label={t('projects.unassigned')}
        data-tip={t('projects.unassigned')}
        onClick={() => {
          onOpen({ kind: 'unassigned' });
        }}
      >
        <Icon name="inbox" />
        <span className="sb__label">{t('projects.unassigned')}</span>
        {s.unassignedCount !== null && <span className="sb__count num">{s.unassignedCount}</span>}
      </button>

      {!rail && (
        <div className="sb-proj__head">
          <button
            type="button"
            className="sb-proj__toggle"
            aria-expanded={open}
            aria-label={t('projects.sectionToggle')}
            onClick={() => {
              setOpen(!open);
              writeOpen(SECTION_KEY, !open);
            }}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
            {t('projects.projects')}
          </button>
          <button
            type="button"
            className="sb-proj__add"
            aria-label={t('projects.newProject')}
            title={t('projects.newProject')}
            onClick={() => {
              setOpen(true);
              setCreating(true);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      )}

      {(open || rail) && (
        <div className="sb-proj__list">
          <SortableContext items={live.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {live.map((p) => (
              <SortableRow key={p.id} project={p}>
                {(dnd) => row(p, dnd)}
              </SortableRow>
            ))}
          </SortableContext>
          {creating && !rail && (
            <div className="sb__nav sb-proj__row sb-proj__row--edit">
              <span className="sb-proj__chip" style={{ background: projectColor(0) }} />
              <RenameField
                value=""
                label={t('projects.projectName')}
                className="rename--sidebar"
                onCommit={(name) => {
                  void create(name);
                }}
                onCancel={() => {
                  setCreating(false);
                }}
              />
            </div>
          )}
          {live.length === 0 && !creating && !rail && (
            <button
              type="button"
              className="sb__nav sb-proj__new"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Icon name="plus" size={14} />
              <span className="sb__label">{t('projects.newProject')}</span>
            </button>
          )}
          {archived.length > 0 && !rail && (
            <>
              <button
                type="button"
                className="sb-proj__toggle sb-proj__toggle--archived"
                aria-expanded={archivedOpen}
                onClick={() => {
                  setArchivedOpen(!archivedOpen);
                }}
              >
                <Icon name={archivedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                {t('projects.archivedCount', { count: archived.length })}
              </button>
              {archivedOpen && archived.map((p) => row(p, null))}
            </>
          )}
        </div>
      )}

      {menu.node}
    </div>
  );
}

interface RowDnd {
  ref: (node: HTMLElement | null) => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  style: CSSProperties;
  dragging: boolean;
  /** Works are being dragged over this row (a drop adds them). */
  dropping: boolean;
  /** Where the insertion line shows while another row is dragged over this one. */
  insert: 'before' | 'after' | null;
}

const NO_HANDLER = (): void => undefined;

/** A live project row: drag it to a new place, or drop works on it (dnd-kit). */
function SortableRow({
  project,
  children,
}: {
  project: Project;
  children: (dnd: RowDnd) => ReactNode;
}) {
  const mode = useMotionMode();
  const sortable = useSortable({
    id: project.id,
    data: { type: 'project', project } satisfies DragData,
    transition: sortTransition(mode),
  });
  const { setNodeRef, listeners, transform, transition, isDragging, isOver, active } = sortable;
  const kind = (active?.data.current as DragData | undefined)?.type;
  const { index, activeIndex, overIndex } = sortable;
  const insert =
    kind === 'project' && !isDragging && overIndex === index && activeIndex >= 0
      ? activeIndex > index
        ? 'before'
        : 'after'
      : null;
  return children({
    ref: setNodeRef,
    onPointerDown:
      (listeners?.['onPointerDown'] as PointerEventHandler<HTMLButtonElement> | undefined) ??
      NO_HANDLER,
    style: { transform: CSS.Translate.toString(transform), transition },
    dragging: isDragging,
    dropping: isOver && kind === 'works',
    insert,
  });
}
