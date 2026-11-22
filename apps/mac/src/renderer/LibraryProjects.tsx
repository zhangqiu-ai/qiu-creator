import type { Project, ProjectSummary, WorkStatus } from '@qiu-creator/contracts';
import { useEffect, useState } from 'react';
import type { MenuEntry } from './ContextMenu.js';
import { formatWhen, WORK_STATUS } from './format.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { addToProject, removeFromProject, type Notice } from './project-actions.js';
import { cardDots, membership, projectColor, type ProjectsStore } from './projects-store.js';

/** Works the project pieces of 作品庫 act on: ids, titles and memberships. */
export type Member = { id: string; title: string; project_ids?: readonly string[] | undefined };

const STATUS_ORDER: readonly WorkStatus[] = ['drafting', 'in_review', 'ready', 'published'];

function dotsWithNames(
  projectIds: readonly string[] | undefined,
  projects: readonly Project[],
  currentId: string | null,
): { dots: Project[]; more: number; names: string } {
  const { dots, more } = cardDots(projectIds, projects, currentId);
  const names = (projectIds ?? [])
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined && !p.archived && p.id !== currentId)
    .map((p) => p.name)
    .join('、');
  return { dots, more, names };
}

/** The colour dots on a card: its other live projects, at most two, then +N (QC-062). */
export function ProjectDots({
  projectIds,
  projects,
  currentId,
}: {
  projectIds: readonly string[] | undefined;
  projects: readonly Project[];
  currentId: string | null;
}) {
  const { dots, more, names } = dotsWithNames(projectIds, projects, currentId);
  if (dots.length === 0) return null;
  return (
    <span className="wcard__dots" title={names} aria-label={`${t('projects.inProjects')} ${names}`}>
      {dots.map((p) => (
        <span key={p.id} className="wcard__dot" style={{ background: projectColor(p.color) }} />
      ))}
      {more > 0 && <span className="wcard__more num">+{more}</span>}
    </span>
  );
}

/**
 * 項目概覽 under a project's header: how many works, by status, when one was
 * last changed, and 用到的素材 N › (the assets its works use).
 */
export function ProjectOverview({
  store,
  project,
  refresh,
  onOpenAssets,
}: {
  store: ProjectsStore;
  project: Project;
  /** Changes whenever the list was read again, so the summary follows. */
  refresh: unknown;
  onOpenAssets: () => void;
}) {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  useEffect(() => {
    let alive = true;
    store
      .summary(project.id)
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [store, project.id, project.revision, project.work_count, refresh]);
  return (
    <div className="proj-overview" role="group" aria-label={t('projects.overview')}>
      <span className="proj-overview__item">
        {t('projects.worksCount', { count: summary?.project.work_count ?? project.work_count })}
      </span>
      {STATUS_ORDER.map((st) => (
        <span key={st} className="proj-overview__item proj-overview__status">
          <span className={`proj-overview__dot proj-overview__dot--${WORK_STATUS[st].tone}`} />
          {WORK_STATUS[st].label}
          <span className="num">{summary?.by_status[st] ?? 0}</span>
        </span>
      ))}
      {summary?.last_updated_at != null && (
        <span className="proj-overview__item faint">
          {t('projects.updatedAt', { when: formatWhen(summary.last_updated_at) })}
        </span>
      )}
      <button type="button" className="proj-overview__assets" onClick={onOpenAssets}>
        {t('projects.usedAssets')}
        <span className="num">{summary?.asset_count ?? '–'}</span>
        <Icon name="chevronRight" size={12} />
      </button>
    </div>
  );
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
