import {
  closestCenter,
  DndContext,
  DragOverlay,
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
import type { Project } from '@qiu-creator/contracts';
import {
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
  { type: 'works'; works: readonly Member[] } | { type: 'project'; project: Project };

export type DropAction =
  | { kind: 'add'; project: Project; works: readonly Member[] }
  | { kind: 'reorder'; ids: string[] }
  | null;

function isDragData(value: unknown): value is DragData {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'works' || type === 'project';
}

/**
 * What a drop does: works on a live project add the ones not in it yet; a
 * project row on another reorders the live projects (archived ones stay
 * after them). Anything else does nothing.
 */
export function dropAction(active: unknown, over: unknown, order: readonly Project[]): DropAction {
  if (!isDragData(active) || !isDragData(over) || over.type !== 'project') return null;
  if (over.project.archived) return null;
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

/** Rows under the pointer for works (a precise drop); nearest row while sorting projects. */
const collision: CollisionDetection = (args) => {
  const data: unknown = args.active.data.current;
  return isDragData(data) && data.type === 'project' ? closestCenter(args) : pointerWithin(args);
};

function describe(data: unknown): string {
  if (!isDragData(data)) return '';
  if (data.type === 'project') return data.project.name;
  return data.works.length === 1
    ? (data.works[0]?.title ?? '')
    : t('projects.dragCount', { count: data.works.length });
}

/** Spoken at each step of a pointer drag, in the interface language (keyboard: SidebarProjects). */
const announcements: Announcements = {
  onDragStart: ({ active }) => t('projects.dndPicked', { name: describe(active.data.current) }),
  onDragOver: ({ active, over }) =>
    over === null || !isDragData(over.data.current) || over.data.current.type !== 'project'
      ? t('projects.dndNowhere', { name: describe(active.data.current) })
      : t('projects.dndOver', {
          name: describe(active.data.current),
          target: over.data.current.project.name,
        }),
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

  const onStart = (e: DragStartEvent) => {
    const data: unknown = e.active.data.current;
    setActive(isDragData(data) ? data : null);
    setLanding('cancel');
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
    if (store === null) return;
    const action = dropAction(
      e.active.data.current,
      e.over?.data.current,
      store.getSnapshot().projects ?? [],
    );
    if (action?.kind === 'add') void addToProject(store, action.project, action.works, notify);
    else if (action?.kind === 'reorder') void store.reorder(action.ids);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onStart}
      onDragOver={onOver}
      onDragEnd={onEnd}
      onDragCancel={() => {
        setActive(null);
        setLanding('cancel');
      }}
      accessibility={{
        restoreFocus: true,
        announcements,
      }}
    >
      {children}
      <DragOverlay
        dropAnimation={dropAnimationFor(landing, mode, () => overRect.current)}
        modifiers={active?.type === 'works' ? [besidePointer] : []}
      >
        {active?.type === 'works' ? (
          <div className="drag-ghost">
            {active.works.length === 1
              ? active.works[0]?.title
              : t('projects.dragCount', { count: active.works.length })}
          </div>
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
