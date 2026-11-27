import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { ChangeEvent, ProjectGroup } from '@qiu-creator/contracts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useChangeEvents } from './events.js';
import { errorText } from './i18n.js';
import { assignLocally, moveLocally } from './project-groups.js';

/**
 * A project's groups (QC-114 on the QC-113 API): read with the project,
 * kept fresh by `project.groups_changed`, and changed optimistically (the
 * page shows a move at once; the service's answer settles it). A failure,
 * including a 409 for a group changed elsewhere, reads the groups again and
 * reports the reason through `onError`.
 */
export interface ProjectGroupsApi {
  /** null until read (or for no project). */
  groups: ProjectGroup[] | null;
  reload: () => void;
  create: (name: string, ordered: boolean) => Promise<ProjectGroup | null>;
  rename: (group: ProjectGroup, name: string) => Promise<boolean>;
  setOrdered: (group: ProjectGroup, ordered: boolean) => Promise<boolean>;
  /** Move a group to place `to` (0-based) among the project's groups. */
  move: (group: ProjectGroup, to: number) => Promise<boolean>;
  remove: (group: ProjectGroup) => Promise<boolean>;
  /** Put works in a group (null: 未分組), at `position` (1-based) or the end. */
  assign: (
    workIds: readonly string[],
    groupId: string | null,
    position?: number,
  ) => Promise<boolean>;
}

/** The groups of the project being shown, outside React so they can be tested on a real service. */
export class ProjectGroupsStore {
  private projectId: string | null = null;
  private groups: ProjectGroup[] | null = null;
  /** Bumped by every read and change: a read that comes back after a newer one is dropped. */
  private request = 0;
  private readonly listeners = new Set<() => void>();
  private refetch: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: CreatorHubClient,
    private readonly hooks: {
      onError: (message: string) => void;
      /** Works changed group or episode: the list reads them again. */
      onAssigned?: () => void;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProjectGroup[] | null => this.groups;

  /** Show another project's groups (null: none). */
  open(projectId: string | null): Promise<void> {
    if (projectId === this.projectId) return Promise.resolve();
    this.projectId = projectId;
    this.show(null);
    return this.reload();
  }

  reload = (): Promise<void> => {
    const id = this.projectId;
    if (id === null) return Promise.resolve();
    const n = ++this.request;
    return this.client.projects
      .get(id)
      .then((p) => {
        if (n === this.request && id === this.projectId) this.set(p.groups ?? []);
      })
      .catch(() => undefined);
  };

  /** A change event: groups changed here, by an agent or on another device. */
  onEvent(event: ChangeEvent): void {
    if (
      this.projectId === null ||
      event.entity !== 'project' ||
      event.entity_id !== this.projectId ||
      event.action !== 'project.groups_changed'
    )
      return;
    if (this.refetch !== null) clearTimeout(this.refetch);
    this.refetch = setTimeout(() => {
      this.refetch = null;
      void this.reload();
    }, 150);
  }

  dispose(): void {
    if (this.refetch !== null) clearTimeout(this.refetch);
    this.refetch = null;
  }

  async create(name: string, ordered: boolean): Promise<ProjectGroup | null> {
    const id = this.projectId;
    if (id === null) return null;
    try {
      const group = await this.client.projects.createGroup(id, { name, ordered });
      if (id === this.projectId) this.set([...this.list().filter((g) => g.id !== group.id), group]);
      return group;
    } catch (err) {
      this.failed(err);
      return null;
    }
  }

  rename(group: ProjectGroup, name: string): Promise<boolean> {
    if (name === group.name) return Promise.resolve(true);
    return this.patch(group, { name }, (g) => ({ ...g, name }));
  }

  setOrdered(group: ProjectGroup, ordered: boolean): Promise<boolean> {
    if (ordered === group.ordered) return Promise.resolve(true);
    // Episode labels on cards (and 全部作品) change with it.
    return this.patch(group, { ordered }, (g) => ({ ...g, ordered }), true);
  }

  async move(group: ProjectGroup, to: number): Promise<boolean> {
    const id = this.projectId;
    if (id === null) return false;
    const revision = this.revisionOf(group);
    this.set(moveLocally(this.list(), group.id, to));
    try {
      await this.client.projects.patchGroup(id, group.id, {
        base_revision: revision,
        sort_order: to,
      });
      // The others moved too: read them all again.
      await this.reload();
      return true;
    } catch (err) {
      this.failed(err);
      return false;
    }
  }

  async remove(group: ProjectGroup): Promise<boolean> {
    const id = this.projectId;
    if (id === null) return false;
    this.set(this.list().filter((g) => g.id !== group.id));
    try {
      const p = await this.client.projects.removeGroup(id, group.id);
      if (id === this.projectId) this.set(p.groups ?? []);
      this.hooks.onAssigned?.();
      return true;
    } catch (err) {
      this.failed(err);
      return false;
    }
  }

  async assign(
    workIds: readonly string[],
    groupId: string | null,
    position?: number,
  ): Promise<boolean> {
    const id = this.projectId;
    if (id === null || workIds.length === 0) return false;
    this.set(assignLocally(this.list(), workIds, groupId, position));
    try {
      const p = await this.client.projects.assignGroup(id, {
        work_ids: [...workIds],
        group_id: groupId,
        ...(position === undefined ? {} : { position }),
      });
      if (id === this.projectId) this.set(p.groups ?? []);
      this.hooks.onAssigned?.();
      return true;
    } catch (err) {
      this.failed(err);
      return false;
    }
  }

  // ---- Internals ----

  private list(): ProjectGroup[] {
    return this.groups ?? [];
  }

  /** The newest revision this page has of the group (an earlier change may have moved it). */
  private revisionOf(group: ProjectGroup): number {
    return this.list().find((g) => g.id === group.id)?.revision ?? group.revision;
  }

  private async patch(
    group: ProjectGroup,
    change: { name?: string; ordered?: boolean },
    local: (g: ProjectGroup) => ProjectGroup,
    assigned = false,
  ): Promise<boolean> {
    const id = this.projectId;
    if (id === null) return false;
    const revision = this.revisionOf(group);
    this.set(this.list().map((g) => (g.id === group.id ? local(g) : g)));
    try {
      const next = await this.client.projects.patchGroup(id, group.id, {
        base_revision: revision,
        ...change,
      });
      if (id === this.projectId) this.set(this.list().map((g) => (g.id === next.id ? next : g)));
      if (assigned) this.hooks.onAssigned?.();
      return true;
    } catch (err) {
      this.failed(err);
      return false;
    }
  }

  private failed(err: unknown): void {
    this.hooks.onError(errorText(err));
    void this.reload();
  }

  /** Show these groups now; any read still on its way is older. */
  private set(groups: ProjectGroup[]): void {
    ++this.request;
    this.show(groups);
  }

  private show(groups: ProjectGroup[] | null): void {
    this.groups = groups;
    for (const l of this.listeners) l();
  }
}

/** The groups of `projectId` for a page, as `ProjectGroupsApi`. */
export function useProjectGroups(
  client: CreatorHubClient,
  projectId: string | null,
  onError: (message: string) => void,
  onAssigned?: () => void,
): ProjectGroupsApi {
  const hooks = useRef({ onError, onAssigned });
  hooks.current = { onError, onAssigned };
  const [store] = useState(
    () =>
      new ProjectGroupsStore(client, {
        onError: (message) => {
          hooks.current.onError(message);
        },
        onAssigned: () => {
          hooks.current.onAssigned?.();
        },
      }),
  );
  useEffect(() => {
    void store.open(projectId);
  }, [store, projectId]);
  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );
  useChangeEvents((event) => {
    store.onEvent(event);
  });
  const groups = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo<ProjectGroupsApi>(
    () => ({
      groups,
      reload: () => {
        void store.reload();
      },
      create: (name, ordered) => store.create(name, ordered),
      rename: (group, name) => store.rename(group, name),
      setOrdered: (group, ordered) => store.setOrdered(group, ordered),
      move: (group, to) => store.move(group, to),
      remove: (group) => store.remove(group),
      assign: (workIds, groupId, position) => store.assign(workIds, groupId, position),
    }),
    [store, groups],
  );
}
