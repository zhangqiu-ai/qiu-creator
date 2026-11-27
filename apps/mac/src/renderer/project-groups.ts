import type { ProjectGroup, WorkProjectGroup } from '@qiu-creator/contracts';

/**
 * Groups and series inside a project page (QC-114, PT-20261126-002 option A):
 * the page is cut into sections, 未分組 first, then the project's groups in
 * their order. A series (`ordered`) lists its works by episode. Everything
 * here is plain data so it can be tested without a window.
 */

/** The key of 未分組 among section keys (group ids are never this). */
export const UNGROUPED = 'ungrouped';

/** How long a drag has to rest on a collapsed group before it opens (prototype: 0.6 s). */
export const EXPAND_ON_HOVER_MS = 600;

export interface Section<W> {
  /** `UNGROUPED` or the group's id. */
  key: string;
  /** null for 未分組. */
  group: ProjectGroup | null;
  /** The loaded works shown in it, in display order (a series by episode). */
  works: W[];
  /** How many works it holds: the service's count, or what the filter shows. */
  count: number;
}

/**
 * Cut the loaded works of a project into sections. 未分組 is first and only
 * there when it has works; named groups always show unless a filter is on,
 * when only groups with matching works do. A series is in episode order;
 * other groups keep the page's order.
 */
export function sectionWorks<W extends { id: string }>(
  works: readonly W[],
  groups: readonly ProjectGroup[],
  options: {
    /** A search or filter is on: counts are what it shows, empty groups hide. */
    filtering: boolean;
    /** The project's works in all (the list's total), for 未分組's count; null before it is known. */
    total: number | null;
  },
): Section<W>[] {
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const id of g.work_ids) groupOf.set(id, g.id);
  const ungrouped: W[] = [];
  const byGroup = new Map<string, W[]>();
  for (const w of works) {
    const g = groupOf.get(w.id);
    if (g === undefined) ungrouped.push(w);
    else {
      const list = byGroup.get(g) ?? [];
      list.push(w);
      byGroup.set(g, list);
    }
  }
  const sections: Section<W>[] = [];
  const grouped = groups.reduce((n, g) => n + g.work_count, 0);
  const ungroupedCount = options.filtering
    ? ungrouped.length
    : Math.max(ungrouped.length, (options.total ?? 0) - grouped);
  if (ungroupedCount > 0) {
    sections.push({ key: UNGROUPED, group: null, works: ungrouped, count: ungroupedCount });
  }
  for (const g of [...groups].sort((a, b) => a.sort_order - b.sort_order)) {
    const list = byGroup.get(g.id) ?? [];
    if (options.filtering && list.length === 0) continue;
    if (g.ordered) {
      const at = new Map(g.work_ids.map((id, i) => [id, i]));
      list.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
    }
    sections.push({
      key: g.id,
      group: g,
      works: list,
      count: options.filtering ? list.length : g.work_count,
    });
  }
  return sections;
}

/** The work's episode in a series (1-based), or null when the group is not one or lacks it. */
export function episodeOf(group: ProjectGroup | null, workId: string): number | null {
  if (group?.ordered !== true) return null;
  const i = group.work_ids.indexOf(workId);
  return i < 0 ? null : i + 1;
}

/** The group a work is in, or null for 未分組. */
export function groupOfWork(groups: readonly ProjectGroup[], workId: string): ProjectGroup | null {
  return groups.find((g) => g.work_ids.includes(workId)) ?? null;
}

/**
 * The groups after putting `workIds` in `groupId` (null: 未分組) at
 * `position` (1-based among the group's other works) or at the end, as the
 * service does it, so the page can show the move before it answers.
 */
export function assignLocally(
  groups: readonly ProjectGroup[],
  workIds: readonly string[],
  groupId: string | null,
  position?: number,
): ProjectGroup[] {
  const moving = new Set(workIds);
  return groups.map((g) => {
    const rest = g.work_ids.filter((id) => !moving.has(id));
    if (g.id !== groupId) {
      return rest.length === g.work_ids.length
        ? g
        : { ...g, work_ids: rest, work_count: rest.length };
    }
    const at =
      position === undefined ? rest.length : Math.min(Math.max(position - 1, 0), rest.length);
    const ids = [...rest.slice(0, at), ...workIds, ...rest.slice(at)];
    return { ...g, work_ids: ids, work_count: ids.length };
  });
}

/** The groups after moving `id` to place `to` (0-based), as 上移／下移 and dragging a header do. */
export function moveLocally(
  groups: readonly ProjectGroup[],
  id: string,
  to: number,
): ProjectGroup[] {
  const ordered = [...groups].sort((a, b) => a.sort_order - b.sort_order);
  const from = ordered.findIndex((g) => g.id === id);
  if (from < 0) return [...groups];
  const [moved] = ordered.splice(from, 1);
  if (moved === undefined) return [...groups];
  ordered.splice(Math.min(Math.max(to, 0), ordered.length), 0, moved);
  return ordered.map((g, i) => (g.sort_order === i ? g : { ...g, sort_order: i }));
}

/** A box on screen. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a drop at `pointer` goes among items laid out in reading order: the
 * index of the first item the pointer is before (0..n). In a grid, the
 * pointer is before an item above its row, or in its row left of its middle;
 * in a list, above its middle.
 */
export function insertionIndex(
  pointer: { x: number; y: number },
  boxes: readonly Box[],
  layout: 'grid' | 'list',
): number {
  for (let i = 0; i < boxes.length; i += 1) {
    const b = boxes[i];
    if (b === undefined) continue;
    if (layout === 'list') {
      if (pointer.y < b.top + b.height / 2) return i;
    } else if (
      pointer.y < b.top ||
      (pointer.y <= b.top + b.height && pointer.x < b.left + b.width / 2)
    ) {
      return i;
    }
  }
  return boxes.length;
}

/**
 * The 1-based place for the service from an insertion index among the shown
 * works (which still include the ones being moved): only the others count.
 */
export function positionAt(
  shownIds: readonly string[],
  index: number,
  moving: readonly string[],
): number {
  const set = new Set(moving);
  let before = 0;
  for (let i = 0; i < Math.min(index, shownIds.length); i += 1) {
    const id = shownIds[i];
    if (id !== undefined && !set.has(id)) before += 1;
  }
  return before + 1;
}

/** The episode works dropped at the end of a series get: after the others. */
export function nextEpisode(group: ProjectGroup, moving: readonly string[]): number {
  const set = new Set(moving);
  return group.work_ids.filter((id) => !set.has(id)).length + 1;
}

/**
 * Whether putting the works in the target changes anything: not when they
 * are all already there (a series still takes a new place for them).
 */
export function dropChanges(
  groups: readonly ProjectGroup[],
  workIds: readonly string[],
  target: string | null,
  position?: number,
): boolean {
  if (workIds.length === 0) return false;
  const inTarget = workIds.every((id) => (groupOfWork(groups, id)?.id ?? null) === target);
  if (!inTarget) return true;
  const group = target === null ? null : groups.find((g) => g.id === target);
  if (group?.ordered !== true || position === undefined) return false;
  const after = assignLocally(groups, workIds, target, position).find((g) => g.id === target);
  return after !== undefined && after.work_ids.join() !== group.work_ids.join();
}

// ---- Collapsed sections (remembered per viewer) ----

const COLLAPSED_KEY = 'qc.projectGroups.collapsed';

function sectionId(projectId: string, key: string): string {
  return `${projectId}:${key}`;
}

/** The project's collapsed sections, from this Mac's storage. */
export function readCollapsed(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const all: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(all)) return new Set();
    const prefix = `${projectId}:`;
    return new Set(
      all
        .filter((v): v is string => typeof v === 'string' && v.startsWith(prefix))
        .map((v) => v.slice(prefix.length)),
    );
  } catch {
    return new Set();
  }
}

/** Remember the project's collapsed sections (a per-viewer convenience: failures are ignored). */
export function writeCollapsed(projectId: string, keys: ReadonlySet<string>): void {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const all: unknown = raw === null ? [] : JSON.parse(raw);
    const prefix = `${projectId}:`;
    const others = Array.isArray(all)
      ? all.filter((v): v is string => typeof v === 'string' && !v.startsWith(prefix))
      : [];
    localStorage.setItem(
      COLLAPSED_KEY,
      JSON.stringify([...others, ...[...keys].map((k) => sectionId(projectId, k))]),
    );
  } catch {
    // per-viewer convenience only
  }
}

/** The group shown after a card's project name in 全部作品: 「› 分組 #集數」. */
export function workGroupIn(
  groups: readonly WorkProjectGroup[] | undefined,
  projectId: string,
): { name: string; episode: number | null } | null {
  const g = groups?.find((x) => x.project_id === projectId);
  return g === undefined ? null : { name: g.group_name, episode: g.episode };
}
