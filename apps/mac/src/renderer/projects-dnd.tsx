import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  useDraggable,
  type Announcements,
  type Modifier,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { getEventCoordinates, type Transform } from '@dnd-kit/utilities';
import type { Project, ProjectGroup } from '@qiu-creator/contracts';
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { dropAnimationFor, useDragSensors, type Landing } from './dnd-motion.js';
import { t } from './i18n.js';
import { useMotionMode } from './motion-mode.js';
import { addToProject, useNotice, type Member } from './project-actions.js';
import { projectColor, type ProjectsStore } from './projects-store.js';

/**
 * Dragging in 作品庫 with dnd-kit (QC-062, motion per DESIGN.md 動效 · 拖放):
 * works dragged from a card or list row onto a sidebar project are added to
 * it (never moved; 未分類 takes no drops), and project rows are dragged to a
 * new place. One context wraps the sidebar and the page so both can meet.
 */

export type DragData =
  | { type: 'works'; works: readonly Member[] }
  | { type: 'project'; project: Project }
  /** QC-114: a group's header, dragged to reorder the project's groups. */
  | { type: 'group'; group: ProjectGroup };

/** QC-114: a section of a project page that takes works (and, for named groups, headers). */
export interface GroupTarget {
  type: 'group-target';
  projectId: string;
  /** null for 未分組. */
  groupId: string | null;
  name: string;
}

export function isGroupTarget(value: unknown): value is GroupTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'group-target'
  );
}

/**
 * What a drag over a project page's groups shows on the floating copy
 * (「移到 X · 第 N 集」) and how the copy lands; set by the page while it
 * owns the drop (QC-114).
 */
export interface DragHint {
  label: string;
  landing: Landing;
}

const DragHintContext = createContext<(hint: DragHint | null) => void>(() => undefined);

/** Set (or clear) the label riding with the dragged works. */
export function useDragHint(): (hint: DragHint | null) => void {
  return useContext(DragHintContext);
}

export type DropAction =
  | { kind: 'add'; project: Project; works: readonly Member[] }
  | { kind: 'reorder'; ids: string[] }
  | null;

function isDragData(value: unknown): value is DragData {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'works' || type === 'project' || type === 'group';
}

/**
 * What a drop does: works on a live project add the ones not in it yet; a
 * project row on another reorders the live projects (archived ones stay
 * after them). Anything else does nothing.
 */
export function dropAction(active: unknown, over: unknown, order: readonly Project[]): DropAction {
  if (!isDragData(active) || !isDragData(over) || over.type !== 'project') return null;
  if (over.project.archived) return null;
  if (active.type === 'group') return null;
  if (active.type === 'works') {
    return active.works.length === 0
      ? null
      : { kind: 'add', project: over.project, works: active.works };
  }
  if (active.project.id === over.project.id || active.project.archived) return null;
  const live = order.filter((p) => !p.archived).map((p) => p.id);
  const from = live.indexOf(active.project.id);
  const to = live.indexOf(over.project.id);
  if (from < 0 || to < 0) return null;
  return {
    kind: 'reorder',
    ids: [...arrayMove(live, from, to), ...order.filter((p) => p.archived).map((p) => p.id)],
  };
}

/** How far below and right of the pointer the 「N 個作品」 copy rides. */
const POINTER_GAP = 12;

/**
 * The works copy rides just below-right of the pointer, as in Finder; without
 * this it keeps the grabbed card's top-left corner, up and away from the hand.
 */
export function besidePointerAt(
  at: { x: number; y: number },
  rect: { left: number; top: number },
  transform: Transform,
): Transform {
  return {
    ...transform,
    x: transform.x + at.x - rect.left + POINTER_GAP,
    y: transform.y + at.y - rect.top + POINTER_GAP,
  };
}

export const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (draggingNodeRect === null || activatorEvent === null) return transform;
  const at = getEventCoordinates(activatorEvent);
  return at === null ? transform : besidePointerAt(at, draggingNodeRect, transform);
};

/**
 * Rows under the pointer for works (a precise drop); the nearest project row
 * while sorting projects, and the nearest named group while sorting groups.
 */
const collision: CollisionDetection = (args) => {
  const data: unknown = args.active.data.current;
  if (!isDragData(data) || data.type === 'works') return pointerWithin(args);
  const droppableContainers = args.droppableContainers.filter((c) => {
    const target: unknown = c.data.current;
    if (data.type === 'project') return isDragData(target) && target.type === 'project';
    return (
      isGroupTarget(target) && target.groupId !== null && target.projectId === data.group.project_id
    );
  });
  return closestCenter({ ...args, droppableContainers });
};

function describe(data: unknown): string {
  if (!isDragData(data)) return '';
  if (data.type === 'project') return data.project.name;
  if (data.type === 'group') return data.group.name;
  return data.works.length === 1
    ? (data.works[0]?.title ?? '')
    : t('projects.dragCount', { count: data.works.length });
}

/** Spoken at each step of a pointer drag, in the interface language (keyboard: SidebarProjects). */
const announcements: Announcements = {
  onDragStart: ({ active }) => t('projects.dndPicked', { name: describe(active.data.current) }),
  onDragOver: ({ active, over }) => {
    const target: unknown = over?.data.current;
    if (isGroupTarget(target))
      return t('projects.dndOver', { name: describe(active.data.current), target: target.name });
    return !isDragData(target) || target.type !== 'project'
      ? t('projects.dndNowhere', { name: describe(active.data.current) })
      : t('projects.dndOver', { name: describe(active.data.current), target: target.project.name });
  },
  onDragEnd: ({ active, over }) =>
    over === null
      ? t('projects.dndCancelled', { name: describe(active.data.current) })
      : t('projects.dndDropped', { name: describe(active.data.current) }),
  onDragCancel: ({ active }) => t('projects.dndCancelled', { name: describe(active.data.current) }),
};

export function ProjectsDnd({
  store,
  children,
}: {
  store: ProjectsStore | null;
  children: ReactNode;
}) {
  const mode = useMotionMode();
  const sensors = useDragSensors();
  const notify = useNotice();
  const [active, setActive] = useState<DragData | null>(null);
  const [landing, setLanding] = useState<Landing>('cancel');
  /** QC-114: a project page's groups own this drop (label and landing). */
  const [hint, setHint] = useState<DragHint | null>(null);

  const onStart = (e: DragStartEvent) => {
    const data: unknown = e.active.data.current;
    setActive(isDragData(data) ? data : null);
    setLanding('cancel');
    setHint(null);
  };
  /** The row a works drop is over, so the copy can fly into it. */
  const overRect = useRef<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const onOver = (e: DragOverEvent) => {
    overRect.current = e.over?.rect ?? null;
    const action = dropAction(
      e.active.data.current,
      e.over?.data.current,
      store?.getSnapshot().projects ?? [],
    );
    setLanding(action === null ? 'cancel' : action.kind === 'add' ? 'into' : 'sort');
  };
  const onEnd = (e: DragEndEvent) => {
    setActive(null);
    setHint(null);
    if (store === null) return;
    const action = dropAction(
      e.active.data.current,
      e.over?.data.current,
      store.getSnapshot().projects ?? [],
    );
    if (action?.kind === 'add') void addToProject(store, action.project, action.works, notify);
    else if (action?.kind === 'reorder') void store.reorder(action.ids);
  };

  const setHintStable = useMemo(
    () => (next: DragHint | null) => {
      setHint((was) => (was?.label === next?.label && was?.landing === next?.landing ? was : next));
    },
    [],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      // A collapsed group opens under a drag (QC-114): targets are measured as the page changes.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onStart}
      onDragOver={onOver}
      onDragEnd={onEnd}
      onDragCancel={() => {
        setActive(null);
        setLanding('cancel');
        setHint(null);
      }}
      accessibility={{
        restoreFocus: true,
        announcements,
      }}
    >
      <DragHintContext.Provider value={setHintStable}>{children}</DragHintContext.Provider>
      <DragOverlay
        dropAnimation={dropAnimationFor(hint?.landing ?? landing, mode, () => overRect.current)}
        modifiers={active?.type === 'works' ? [besidePointer] : []}
      >
        {active?.type === 'works' ? (
          <div className="drag-stack">
            <div className="drag-ghost">
              {active.works.length === 1
                ? active.works[0]?.title
                : t('projects.dragCount', { count: active.works.length })}
            </div>
            {hint !== null && <div className="drag-hint">{hint.label}</div>}
          </div>
        ) : active?.type === 'group' ? (
          <div className="drag-ghost drag-ghost--project">{active.group.name}</div>
        ) : active?.type === 'project' ? (
          <div className="drag-ghost drag-ghost--project">
            <span
              className="sb-proj__chip"
              style={{ background: projectColor(active.project.color) }}
            />
            {active.project.name}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * A work's card or list-row button that can be dragged onto a sidebar
 * project, carrying `works` (the selection when the work is part of it).
 */
export function DragWorksButton({
  dragId,
  works,
  disabled,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  dragId: string;
  works: readonly Member[];
  disabled: boolean;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `works:${dragId}`,
    data: { type: 'works', works } satisfies DragData,
    disabled,
  });
  return (
    <button
      type="button"
      {...rest}
      ref={setNodeRef}
      className={isDragging ? `${className ?? ''} is-dragging`.trim() : className}
      // Pointer only: Space and ↩ keep opening the work; 項目 ▸ is the keyboard route.
      onPointerDown={listeners?.['onPointerDown'] as PointerEventHandler<HTMLButtonElement>}
    >
      {children}
    </button>
  );
}
