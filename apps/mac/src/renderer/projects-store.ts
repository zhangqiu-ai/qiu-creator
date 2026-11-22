import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import { PROJECT_NAME_MAX_CHARS, type Project, type ProjectSummary } from '@qiu-creator/contracts';
import type { MessageKey } from '@qiu-creator/i18n';

/**
 * Projects in the works library (QC-062, PT-20261121-003): the list the
 * sidebar, 作品庫 and the editor share, kept fresh by SSE `project` and
 * `work` events. Membership lives only in the service's database (never in a
 * work's file); a work may be in several projects, so dragging, the menu and
 * the batch bar only ever add or remove, never move.
 */

/** The eight low-saturation colours of the board, by `color` index. */
export const PROJECT_COLORS: readonly string[] = [
  '#5B6B7F',
  '#3E63C9',
  '#2C8A80',
  '#4C8A3F',
  '#B8862B',
  '#C4622D',
  '#B83E3E',
  '#8A4FA0',
];

export const COLOR_NAME: readonly MessageKey[] = [
  'projects.color0',
  'projects.color1',
  'projects.color2',
  'projects.color3',
  'projects.color4',
  'projects.color5',
  'projects.color6',
  'projects.color7',
];

export function projectColor(color: number): string {
  return PROJECT_COLORS[color] ?? PROJECT_COLORS[0] ?? '#5B6B7F';
}

/** Trimmed name within the limit, or null when it cannot be a project name. */
export function projectName(typed: string): string | null {
  const name = typed.trim();
  if (name === '' || Array.from(name).length > PROJECT_NAME_MAX_CHARS) return null;
  return name;
}

/** Whether every, some or none of the works are in the project (tri-state checkbox). */
export function membership(
  works: readonly { project_ids?: readonly string[] | undefined }[],
  projectId: string,
): 'all' | 'some' | 'none' {
  let inIt = 0;
  for (const w of works) if (w.project_ids?.includes(projectId) === true) inIt += 1;
  if (inIt === 0) return 'none';
  return inIt === works.length ? 'all' : 'some';
}

/**
 * The colour a new project gets (QC-069): the n-th project takes the n-th of
 * the eight colours, so projects made one after another can be told apart.
 * Existing projects keep their colour.
 */
export function nextProjectColor(projects: readonly Project[]): number {
  return projects.length % PROJECT_COLORS.length;
}

/**
 * A card's project label (QC-069): its live projects other than the one being
 * viewed; the first is named, the rest count as +N, and every name goes in
 * the tooltip. Null when there is none to show.
 */
export function projectLabel(
  projectIds: readonly string[] | undefined,
  projects: readonly Project[],
  currentId: string | null,
): { first: Project; others: Project[] } | null {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const shown = (projectIds ?? [])
    .map((id) => byId.get(id))
    .filter((p): p is Project => p !== undefined && !p.archived && p.id !== currentId);
  const [first, ...others] = shown;
  return first === undefined ? null : { first, others };
}

/** The order after moving `id` by `step` (⌥↑/⌥↓, 上移／下移); unchanged at an end. */
export function moveInOrder(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

export interface ProjectsState {
  projects: Project[] | null;
  /** 全部作品 and 未分類 counts (works not in 最近刪除). */
  allCount: number | null;
  unassignedCount: number | null;
  /** Works in 最近刪除, for its row at the foot of the sidebar (QC-069). */
  trashCount: number | null;
  failed: boolean;
}

export class ProjectsStore {
  private state: ProjectsState = {
    projects: null,
    allCount: null,
    unassignedCount: null,
    trashCount: null,
    failed: false,
  };
  private readonly listeners = new Set<() => void>();
  private request = 0;

  constructor(private readonly client: CreatorHubClient) {}

  getSnapshot = (): ProjectsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ProjectsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  find(id: string | null): Project | null {
    if (id === null) return null;
    return this.state.projects?.find((p) => p.id === id) ?? null;
  }

  async load(): Promise<void> {
    const n = ++this.request;
    try {
      const [list, all, unassigned, trash] = await Promise.all([
        this.client.projects.list(),
        this.client.works.list({ limit: 1 }),
        this.client.works.list({ limit: 1, unassigned: '1' }),
        this.client.works.list({ limit: 1, scope: 'trash' }),
      ]);
      if (n !== this.request) return;
      this.set({
        projects: list.items,
        allCount: all.total,
        unassignedCount: unassigned.total,
        trashCount: trash.total,
        failed: false,
      });
    } catch {
      if (n === this.request) this.set({ failed: true });
    }
  }

  /** A new project; without a colour it takes the next of the eight in turn (QC-069). */
  async create(name: string, color?: number): Promise<Project> {
    const project = await this.client.projects.create({
      name,
      color: color ?? nextProjectColor(this.state.projects ?? []),
    });
    await this.load();
    return project;
  }

  /** Rename, recolour, archive; a project changed elsewhere is reloaded and the change refused. */
  async patch(
    project: Project,
    change: { name?: string; color?: number; archived?: boolean },
  ): Promise<Project | null> {
    try {
      const next = await this.client.projects.patch(project.id, {
        base_revision: project.revision,
        ...change,
      });
      await this.load();
      return next;
    } catch (err) {
      await this.load();
      if (err instanceof ApiError && err.status === 409) return null;
      throw err;
    }
  }

  async reorder(ids: string[]): Promise<void> {
    // Show the new order at once; the service's answer (or a reload) settles it.
    const byId = new Map((this.state.projects ?? []).map((p) => [p.id, p]));
    const optimistic = ids.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined);
    if (optimistic.length === ids.length) this.set({ projects: optimistic });
    try {
      const res = await this.client.projects.reorder(ids);
      this.set({ projects: res.items });
    } catch {
      await this.load();
    }
  }

  /** Every live project's id in sidebar order (what reorder needs). */
  get order(): string[] {
    return (this.state.projects ?? []).map((p) => p.id);
  }

  async remove(id: string): Promise<void> {
    await this.client.projects.remove(id);
    await this.load();
  }

  async restore(id: string): Promise<void> {
    await this.client.projects.restore(id);
    await this.load();
  }

  summary(id: string): Promise<ProjectSummary> {
    return this.client.projects.summary(id);
  }

  /**
   * Add works to or remove them from one project; returns the ids that
   * changed (works in 最近刪除 or gone are skipped by the service).
   */
  async setMembership(
    projectId: string,
    workIds: readonly string[],
    add: boolean,
  ): Promise<string[]> {
    if (workIds.length === 0) return [];
    const res = await this.client.projects.batchWorks({
      work_ids: [...workIds],
      ...(add ? { add: [projectId] } : { remove: [projectId] }),
    });
    await this.load();
    return res.results.filter((r) => r.ok).map((r) => r.id);
  }
}
