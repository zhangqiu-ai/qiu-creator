import { useDndMonitor, useDraggable, useDroppable, type DragMoveEvent } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import {
  PROJECT_GROUP_NAME_MAX_CHARS,
  type ProjectGroup,
  type WorkListItem,
} from '@qiu-creator/contracts';
import { useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';
import type { MenuEntry } from './ContextMenu.js';
import { Dialog } from './Dialog.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import {
  EXPAND_ON_HOVER_MS,
  dropChanges,
  insertionIndex,
  nextEpisode,
  positionAt,
  UNGROUPED,
  type Box,
  type Section,
} from './project-groups.js';
import { isGroupTarget, useDragHint, type DragData, type GroupTarget } from './projects-dnd.js';
import { RenameField } from './RenameField.js';
import type { ProjectGroupsApi } from './use-project-groups.js';
import './project-groups.css';

/**
 * A project page cut into groups (QC-114, PT-20261126-002 option A): section
 * headers (collapse, name, count, 系列 chip, Agent mark, ⋯), drop targets
 * for works and headers, the collapsed one-line view, and the dialogs for a
 * new group and deleting one.
 */

/** Trimmed group name within the limit, or null. */
export function groupName(typed: string): string | null {
  const name = typed.trim();
  if (name === '' || Array.from(name).length > PROJECT_GROUP_NAME_MAX_CHARS) return null;
  return name;
}

export function sectionName(group: ProjectGroup | null): string {
  return group === null ? t('groups.ungrouped') : group.name;
}

// ---- Drop state ----

/** Where a drag over the page's groups would land. */
export type GroupDrop =
  | {
      kind: 'works';
      key: string;
      groupId: string | null;
      /** 1-based place in a series; undefined: at the end (or not a series). */
      position: number | undefined;
      /** The insertion index among the section's shown items (a series), else null. */
      index: number | null;
      /** The insertion line inside the section, relative to it; null when there is none. */
      line: { x: number; y: number; length: number; vertical: boolean } | null;
    }
  | { kind: 'group'; key: string; to: number; before: boolean };

function sameDrop(a: GroupDrop | null, b: GroupDrop | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === 'group' && b.kind === 'group') return a.to === b.to;
  if (a.kind === 'works' && b.kind === 'works')
    return (
      a.position === b.position &&
      a.index === b.index &&
      a.line?.x === b.line?.x &&
      a.line?.y === b.line?.y &&
      a.line?.length === b.line?.length
    );
  return false;
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * Follow a drag over the project page: which section it is over, where in a
 * series it would go (the insertion line), the label riding with it, a
 * collapsed group opening after resting on it, and the drop itself.
 */
export function useGroupDrop({
  projectId,
  groups,
  sections,
  layout,
  collapsed,
  onExpand,
  api,
}: {
  projectId: string | null;
  groups: readonly ProjectGroup[] | null;
  sections: readonly Section<WorkListItem>[];
  layout: 'grid' | 'list';
  collapsed: ReadonlySet<string>;
  onExpand: (key: string) => void;
  api: ProjectGroupsApi;
}): GroupDrop | null {
  const [drop, setDrop] = useState<GroupDrop | null>(null);
  const dropRef = useRef<GroupDrop | null>(null);
  const setHint = useDragHint();
  const expandTimer = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef({ groups, sections, layout, collapsed, onExpand, api, projectId });
  latest.current = { groups, sections, layout, collapsed, onExpand, api, projectId };

  const show = (next: GroupDrop | null) => {
    if (sameDrop(dropRef.current, next)) return;
    dropRef.current = next;
    setDrop(next);
  };
  const stopExpand = () => {
    if (expandTimer.current !== null) clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
  };
  const clear = () => {
    stopExpand();
    show(null);
    setHint(null);
  };
  useEffect(() => stopExpand, []);

  const follow = (e: DragMoveEvent) => {
    const {
      groups: list,
      sections: secs,
      layout: how,
      collapsed: shut,
      projectId: pid,
    } = latest.current;
    const active: unknown = e.active.data.current;
    const target: unknown = e.over?.data.current;
    if (pid === null || list === null || !isGroupTarget(target) || target.projectId !== pid) {
      clear();
      return;
    }
    const key = target.groupId ?? UNGROUPED;
    // Resting on a collapsed group opens it (prototype: 0.6 s).
    if (shut.has(key)) {
      if (expandTimer.current?.key !== key) {
        stopExpand();
        expandTimer.current = {
          key,
          timer: setTimeout(() => {
            expandTimer.current = null;
            latest.current.onExpand(key);
          }, EXPAND_ON_HOVER_MS),
        };
      }
    } else stopExpand();

    const data = active as DragData | undefined;
    if (data?.type === 'group') {
      const ordered = [...list].sort((a, b) => a.sort_order - b.sort_order);
      const from = ordered.findIndex((g) => g.id === data.group.id);
      const to = ordered.findIndex((g) => g.id === target.groupId);
      if (target.groupId === null || from < 0 || to < 0 || from === to) {
        show(null);
        setHint(null);
        return;
      }
      show({ kind: 'group', key, to, before: to < from });
      setHint({ label: t('groups.dragGroupHere', { name: data.group.name }), landing: 'sort' });
      return;
    }
    if (data?.type !== 'works') {
      clear();
      return;
    }
    const ids = data.works.map((w) => w.id);
    const group = target.groupId === null ? null : list.find((g) => g.id === target.groupId);
    if (group === undefined) {
      clear();
      return;
    }
    let position: number | undefined;
    let insertAt: number | null = null;
    let line: Extract<GroupDrop, { kind: 'works' }>['line'] = null;
    const section = secs.find((s) => s.key === key);
    const el = document.querySelector(`[data-group-section="${CSS.escape(key)}"]`);
    if (group?.ordered === true && section !== undefined && el !== null && !shut.has(key)) {
      const items = [...el.querySelectorAll('[data-group-item]')];
      const boxes = items.map(boxOf);
      const start = getEventCoordinates(e.activatorEvent);
      if (start !== null && boxes.length > 0) {
        const pointer = { x: start.x + e.delta.x, y: start.y + e.delta.y };
        const index = insertionIndex(pointer, boxes, how);
        const shownIds = items.map((i) => i.getAttribute('data-group-item') ?? '');
        position = positionAt(shownIds, index, ids);
        insertAt = index;
        const frame = el.getBoundingClientRect();
        const at = boxes[Math.min(index, boxes.length - 1)];
        if (at !== undefined) {
          const after = index >= boxes.length;
          line =
            how === 'grid'
              ? {
                  x: (after ? at.left + at.width + 6 : at.left - 6) - frame.left,
                  y: at.top - frame.top,
                  length: at.height,
                  vertical: true,
                }
              : {
                  x: at.left - frame.left,
                  y: (after ? at.top + at.height : at.top) - frame.top,
                  length: at.width,
                  vertical: false,
                };
        }
      }
    }
    if (!dropChanges(list, ids, target.groupId, position)) {
      show(null);
      setHint(null);
      return;
    }
    show({ kind: 'works', key, groupId: target.groupId, position, index: insertAt, line });
    const name = sectionName(group);
    setHint({
      label:
        group?.ordered === true
          ? t('groups.dragToEpisode', { name, n: position ?? nextEpisode(group, ids) })
          : t('groups.dragTo', { name }),
      landing: group?.ordered === true ? 'sort' : 'into',
    });
  };

  useDndMonitor({
    onDragMove: follow,
    onDragOver: follow,
    onDragEnd: (e) => {
      const at = dropRef.current;
      const data = e.active.data.current as DragData | undefined;
      const { api: groupsApi, groups: list } = latest.current;
      clear();
      if (at === null || e.over === null || !isGroupTarget(e.over.data.current)) return;
      if (at.kind === 'works' && data?.type === 'works') {
        void groupsApi.assign(
          data.works.map((w) => w.id),
          at.groupId,
          at.position,
        );
      } else if (at.kind === 'group' && data?.type === 'group') {
        const group = list?.find((g) => g.id === data.group.id) ?? data.group;
        void groupsApi.move(group, at.to);
      }
    },
    onDragCancel: clear,
  });
  return drop;
}

// ---- A section ----

export function GroupSection({
  projectId,
  section,
  drop,
  as = 'section',
  children,
  header,
}: {
  projectId: string;
  section: Section<WorkListItem>;
  drop: GroupDrop | null;
  /** `tbody` in the list. */
  as?: 'section' | 'tbody';
  header: ReactNode;
  children: ReactNode;
}) {
  const target: GroupTarget = {
    type: 'group-target',
    projectId,
    groupId: section.group?.id ?? null,
    name: sectionName(section.group),
  };
  const { setNodeRef } = useDroppable({ id: `group-target:${section.key}`, data: target });
  const over = drop !== null && drop.key === section.key;
  const className = [
    'pgroup',
    as === 'tbody' ? 'pgroup--rows' : '',
    over && drop.kind === 'works' ? 'pgroup--over' : '',
    over && drop.kind === 'group' ? (drop.before ? 'pgroup--before' : 'pgroup--after') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const line =
    over && drop.kind === 'works' && drop.line !== null ? (
      <span
        className={drop.line.vertical ? 'pgroup__line' : 'pgroup__line pgroup__line--h'}
        aria-hidden="true"
        style={
          drop.line.vertical
            ? { left: drop.line.x - 1, top: drop.line.y, height: drop.line.length }
            : { left: drop.line.x, top: drop.line.y - 1, width: drop.line.length }
        }
      />
    ) : null;
  if (as === 'tbody') {
    return (
      <tbody ref={setNodeRef} className={className} data-group-section={section.key}>
        {header}
        {children}
      </tbody>
    );
  }
  return (
    <section
      ref={setNodeRef}
      className={className}
      data-group-section={section.key}
      aria-label={sectionName(section.group)}
    >
      {header}
      {children}
      {line}
    </section>
  );
}

/**
 * A section's header: collapse, name (inline rename), count, 系列 chip,
 * Agent mark, 未分組's hint, the drop hint while a drag is over it, and ⋯.
 * Named groups can be dragged by it to a new place.
 */
export function GroupHeader({
  section,
  collapsed,
  onToggle,
  renaming,
  onRename,
  onRenameCancel,
  dropName,
  menuOpen,
  onMenu,
  draggable,
}: {
  section: Section<WorkListItem>;
  collapsed: boolean;
  onToggle: () => void;
  renaming: boolean;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
  /** The drag over this section would move works here. */
  dropName: string | null;
  menuOpen: boolean;
  onMenu: (anchor: { x: number; y: number }) => void;
  draggable: boolean;
}) {
  const group = section.group;
  const name = sectionName(group);
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `group:${section.key}`,
    data: group === null ? undefined : ({ type: 'group', group } satisfies DragData),
    disabled: group === null || !draggable || renaming,
  });
  const agent =
    group?.created_by.kind === 'agent' ? (group.created_by.token_name ?? 'Agent') : null;
  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'pgroup__head is-dragging' : 'pgroup__head'}
      onPointerDown={listeners?.['onPointerDown'] as PointerEventHandler<HTMLDivElement>}
      title={group === null || !draggable ? undefined : t('groups.reorderHint')}
    >
      <button
        type="button"
        className="btn btn--icon btn--ghost pgroup__toggle"
        aria-expanded={!collapsed}
        aria-label={t('groups.toggle', { name })}
        onClick={onToggle}
      >
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
      </button>
      {group === null && <Icon name="inbox" size={14} />}
      {renaming && group !== null ? (
        <RenameField
          value={group.name}
          label={t('workActions.renameField', { title: group.name })}
          className="rename--group"
          onCommit={onRename}
          onCancel={onRenameCancel}
        />
      ) : (
        <h2 className="pgroup__name">{name}</h2>
      )}
      <span className="pgroup__count num">{section.count}</span>
      {group?.ordered === true && (
        <span className="pgroup__series">
          <Icon name="series" size={12} />
          {t('groups.seriesChip', { count: group.work_count })}
        </span>
      )}
      {agent !== null && (
        <span className="pgroup__agent" title={t('groups.agentMadeTip', { name: agent })}>
          <Icon name="robot" size={11} />
          {t('groups.agentMade', { name: agent })}
        </span>
      )}
      {group === null && <span className="pgroup__hint">{t('groups.ungroupedHint')}</span>}
      <span className="pgroup__drop" aria-live="polite">
        {dropName === null ? '' : t('groups.dropHere', { name: dropName })}
      </span>
      {group !== null && (
        <button
          type="button"
          className="btn btn--icon btn--ghost pgroup__more"
          aria-label={t('groups.options', { name })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ x: r.right - 220, y: r.bottom + 4 });
          }}
        >
          <Icon name="more" />
        </button>
      )}
    </div>
  );
}

/** A collapsed group: one line of small covers and its first two titles. */
export function CollapsedRow({
  works,
  imageUrl,
}: {
  works: readonly WorkListItem[];
  imageUrl: (relative: string) => string;
}) {
  if (works.length === 0) return null;
  const titles = works
    .slice(0, 2)
    .map((w) => w.title)
    .join('、');
  return (
    <div className="pgroup__collapsed">
      <span className="pgroup__thumbs" aria-hidden="true">
        {works.slice(0, 4).map((w) => {
          const url = w.card_image?.url ?? null;
          return (
            <span key={w.id} className="pgroup__thumb">
              {url === null ? <Icon name="doc" size={12} /> : <img src={imageUrl(url)} alt="" />}
            </span>
          );
        })}
      </span>
      <span className="pgroup__titles">
        {works.length > 2 ? t('groups.collapsedTitles', { titles }) : titles}
      </span>
    </div>
  );
}

/** A named group with no works yet: where to drop them. */
export function EmptyGroup() {
  return <div className="pgroup__empty">{t('groups.emptyGroup')}</div>;
}

// ---- Menus ----

/** The ⋯ menu of a named group. */
export function groupMenuItems({
  group,
  index,
  total,
  onRename,
  onCollapseOthers,
  onDelete,
  api,
}: {
  group: ProjectGroup;
  /** Its place among the project's groups (0-based). */
  index: number;
  total: number;
  onRename: () => void;
  onCollapseOthers: () => void;
  onDelete: () => void;
  api: ProjectGroupsApi;
}): MenuEntry[] {
  return [
    { kind: 'item', id: 'group-rename', label: t('groups.rename'), onSelect: onRename },
    {
      kind: 'item',
      id: 'group-series',
      label: t('groups.asSeries'),
      checkbox: group.ordered,
      onSelect: () => {
        void api.setOrdered(group, !group.ordered);
      },
    },
    { kind: 'sep', id: 'group-sep-1' },
    {
      kind: 'item',
      id: 'group-up',
      label: t('groups.moveUp'),
      disabled: index <= 0,
      onSelect: () => {
        void api.move(group, index - 1);
      },
    },
    {
      kind: 'item',
      id: 'group-down',
      label: t('groups.moveDown'),
      disabled: index >= total - 1,
      onSelect: () => {
        void api.move(group, index + 1);
      },
    },
    {
      kind: 'item',
      id: 'group-collapse-others',
      label: t('groups.collapseOthers'),
      onSelect: onCollapseOthers,
    },
    { kind: 'sep', id: 'group-sep-2' },
    {
      kind: 'item',
      id: 'group-delete',
      label: t('groups.deleteGroup'),
      danger: true,
      hint: t('groups.deleteHint'),
      onSelect: onDelete,
    },
  ];
}

/**
 * 移到分組 ▸ for works on a project page: 未分組, every group (a series says
 * which episode they become), and ＋ 新分組… that makes one and puts them in it.
 */
export function moveToGroupMenu({
  groups,
  workIds,
  onNew,
  api,
}: {
  groups: readonly ProjectGroup[];
  workIds: readonly string[];
  onNew: () => void;
  api: ProjectGroupsApi;
}): MenuEntry {
  const ordered = [...groups].sort((a, b) => a.sort_order - b.sort_order);
  const inGroup = (id: string | null) =>
    workIds.every((w) => (ordered.find((g) => g.work_ids.includes(w))?.id ?? null) === id);
  return {
    kind: 'sub',
    id: 'move-to-group',
    label: t('groups.moveTo'),
    disabled: workIds.length === 0,
    items: [
      {
        kind: 'item',
        id: 'group-to-none',
        label: t('groups.ungrouped'),
        checked: inGroup(null),
        onSelect: () => {
          void api.assign(workIds, null);
        },
      },
      ...ordered.map((g): MenuEntry => ({
        kind: 'item',
        id: `group-to-${g.id}`,
        label: g.name,
        checked: inGroup(g.id),
        ...(g.ordered && !inGroup(g.id)
          ? { hint: t('groups.putAt', { n: nextEpisode(g, workIds) }) }
          : {}),
        onSelect: () => {
          void api.assign(workIds, g.id);
        },
      })),
      { kind: 'sep', id: 'group-to-sep' },
      { kind: 'item', id: 'group-to-new', label: t('groups.newGroupDots'), onSelect: onNew },
    ],
  };
}

/** 往前一集／往後一集 for one work in a series (the keyboard's way to renumber). */
export function episodeItems(
  group: ProjectGroup | null,
  workId: string,
  api: ProjectGroupsApi,
): MenuEntry[] {
  if (group?.ordered !== true) return [];
  const at = group.work_ids.indexOf(workId);
  if (at < 0) return [];
  return [
    {
      kind: 'item',
      id: 'episode-earlier',
      label: t('groups.episodeEarlier'),
      disabled: at === 0,
      onSelect: () => {
        void api.assign([workId], group.id, at);
      },
    },
    {
      kind: 'item',
      id: 'episode-later',
      label: t('groups.episodeLater'),
      disabled: at >= group.work_ids.length - 1,
      onSelect: () => {
        void api.assign([workId], group.id, at + 2);
      },
    },
  ];
}

// ---- Dialogs ----

export function NewGroupDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string, ordered: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [ordered, setOrdered] = useState(false);
  const valid = groupName(name) !== null;
  const submit = () => {
    const n = groupName(name);
    if (n !== null) onCreate(n, ordered);
  };
  return (
    <Dialog
      title={t('groups.newGroup')}
      onClose={onCancel}
      width={400}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary dialog__primary"
            disabled={!valid}
            onClick={submit}
          >
            {t('groups.create')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">{t('groups.groupName')}</span>
        <input
          className="input"
          data-autofocus
          value={name}
          maxLength={PROJECT_GROUP_NAME_MAX_CHARS * 2}
          onChange={(e) => {
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
      {name.trim() !== '' && !valid && <p className="field__error">{t('groups.nameInvalid')}</p>}
      <label className="lib-dialog__opt">
        <input
          type="checkbox"
          checked={ordered}
          onChange={(e) => {
            setOrdered(e.target.checked);
          }}
        />
        <span>
          <span>{t('groups.seriesOption')}</span>
          <span className="faint">{t('groups.seriesOptionHint')}</span>
        </span>
      </label>
    </Dialog>
  );
}

export function DeleteGroupDialog({
  group,
  onCancel,
  onConfirm,
}: {
  group: ProjectGroup;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={t('groups.deleteTitle', { name: group.name })}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button type="button" className="btn" data-autofocus onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--danger dialog__primary" onClick={onConfirm}>
            {t('groups.deleteAction')}
          </button>
        </>
      }
    >
      <p>
        {group.work_count === 0
          ? t('groups.deleteEmpty')
          : t('groups.deleteBody', { count: group.work_count })}
      </p>
    </Dialog>
  );
}
