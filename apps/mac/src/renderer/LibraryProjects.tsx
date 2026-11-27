import type { Project, WorkProjectGroup } from '@qiu-creator/contracts';
import { useEffect, useState } from 'react';
import type { MenuEntry } from './ContextMenu.js';
import { t } from './i18n.js';
import { addToProject, removeFromProject, type Notice } from './project-actions.js';
import { workGroupIn } from './project-groups.js';
import { membership, projectColor, projectLabel, type ProjectsStore } from './projects-store.js';

/** Works the project pieces of 作品庫 act on: ids, titles and memberships. */
export type Member = { id: string; title: string; project_ids?: readonly string[] | undefined };

/**
 * The project label on a card or a list row (QC-069, PT-20261122-001): the
 * colour and name of the work's first other live project, then +N for the
 * rest; the full names are in the tooltip and the accessible name. On a
 * project's own page that project is left out. Nothing when there is none.
 */
export function ProjectLabel({
  projectIds,
  projects,
  currentId,
  groups,
}: {
  projectIds: readonly string[] | undefined;
  projects: readonly Project[];
  currentId: string | null;
  /** QC-114: the work's groups, for 「› 分組 #集數」 after the first project's name. */
  groups?: readonly WorkProjectGroup[] | undefined;
}) {
  const label = projectLabel(projectIds, projects, currentId);
  if (label === null) return null;
  const { first, others } = label;
  const group = workGroupIn(groups, first.id);
  const names = [
    group === null ? first.name : groupedName(first.name, group),
    ...others.map((p) => p.name),
  ].join('、');
  return (
    <span className="plabel" title={names} aria-label={`${t('projects.inProjects')}：${names}`}>
      <span className="plabel__dot" style={{ background: projectColor(first.color) }} />
      <span className="plabel__name">{first.name}</span>
      {group !== null && <GroupSuffix group={group} />}
      {others.length > 0 && <span className="plabel__more num">+{others.length}</span>}
    </span>
  );
}

/** 「創作助手 › 京都秋季系列 #4」: a project name with the work's group in it (QC-114). */
export function groupedName(
  project: string,
  group: { name: string; episode: number | null },
): string {
  const inGroup = t('groups.inGroup', { project, group: group.name });
  return group.episode === null ? inGroup : `${inGroup} #${String(group.episode)}`;
}

/** The faint 「› 分組 #集數」 after a project's name on a card (QC-114). */
export function GroupSuffix({ group }: { group: { name: string; episode: number | null } }) {
  return (
    <span className="plabel__group" aria-hidden="true">
      <span className="plabel__sep">›</span>
      <span className="plabel__gname">{group.name}</span>
      {group.episode !== null && <span className="num">#{group.episode}</span>}
    </span>
  );
}

/**
 * How many assets a project's works use (the 「M 個素材」 link beside its
 * title, QC-069); null until the service has answered.
 */
export function useProjectAssetCount(
  store: ProjectsStore | null,
  project: Project | null,
  /** Changes whenever the list was read again, so the count follows. */
  refresh: unknown,
): number | null {
  const [count, setCount] = useState<{ id: string; n: number } | null>(null);
  const id = project?.id ?? null;
  useEffect(() => {
    if (store === null || id === null) return;
    let alive = true;
    store
      .summary(id)
      .then((s) => {
        if (alive) setCount({ id, n: s.asset_count });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [store, id, project?.revision, project?.work_count, refresh]);
  return count !== null && count.id === id ? count.n : null;
}

/**
 * 項目 ▸ for the chosen works: one checkbox per live project (mixed when only
 * some are in it) that applies at once, then 新建項目…. Checking adds the
 * works that were not in it; unchecking removes them all. Never a move.
 */
export function projectEntries({
  store,
  projects,
  works,
  notify,
  onNew,
  after,
}: {
  store: ProjectsStore;
  projects: readonly Project[];
  works: readonly Member[];
  notify: (notice: Notice | null) => void;
  onNew: () => void;
  after: () => void;
}): MenuEntry[] {
  const live = projects.filter((p) => !p.archived);
  return [
    ...live.map((p): MenuEntry => {
      const state = membership(works, p.id);
      return {
        kind: 'item',
        id: `project-${p.id}`,
        label: p.name,
        swatch: projectColor(p.color),
        checkbox: state === 'all' ? true : state === 'some' ? 'mixed' : false,
        onSelect: () => {
          if (state === 'all') void removeFromProject(store, p, works, notify, after);
          else void addToProject(store, p, works, notify).then(after);
        },
      };
    }),
    ...(live.length > 0 ? [{ kind: 'sep' as const, id: 'sep-projects' }] : []),
    { kind: 'item', id: 'project-new', label: t('projects.newProjectDots'), onSelect: onNew },
  ];
}
