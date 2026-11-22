import type { Project } from '@qiu-creator/contracts';
import { useEffect, useState } from 'react';
import { t } from './i18n.js';
import { projectName, type ProjectsStore } from './projects-store.js';
import { useToast } from './toasts.js';

/**
 * Adding works to and removing them from a project (QC-062), shared by the
 * sidebar (drop), 作品庫 (menu, batch bar) and the editor. Membership is a
 * value, so it applies at once and the notice offers 復原 (undo puts back
 * exactly the works that changed).
 */

export interface Notice {
  message: string;
  tone?: 'ok' | 'bad' | 'neutral';
  /** Resolves once the change is undone (so callers and tests can wait for it). */
  undo?: () => void | Promise<void>;
}

/** A notice in the shared toast queue, with 復原 when it can be undone; it goes after 8 s. */
export function useNotice(): (notice: Notice | null) => void {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(
      () => {
        setNotice(null);
      },
      notice.undo === undefined ? 5000 : 8000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  useToast(
    notice === null
      ? null
      : {
          message: notice.message,
          tone: notice.tone ?? 'ok',
          actions:
            notice.undo === undefined
              ? []
              : [
                  {
                    label: t('workActions.undo'),
                    onClick: () => {
                      const undo = notice.undo;
                      setNotice(null);
                      void undo?.();
                    },
                  },
                ],
          onClose: () => {
            setNotice(null);
          },
        },
  );
  return setNotice;
}

/** A work as the project actions see it: id, title (for the drag image) and memberships. */
export type Member = {
  id: string;
  title?: string;
  project_ids?: readonly string[] | undefined;
};

/** Add works to a project; the notice undoes only those that were not in it yet. */
export async function addToProject(
  store: ProjectsStore,
  project: Project,
  works: readonly Member[],
  notify: (notice: Notice | null) => void,
): Promise<void> {
  const fresh = works.filter((w) => w.project_ids?.includes(project.id) !== true).map((w) => w.id);
  if (fresh.length === 0) {
    notify({ message: t('projects.already', { name: project.name }), tone: 'neutral' });
    return;
  }
  try {
    const done = await store.setMembership(project.id, fresh, true);
    notify({
      message:
        works.length === 1
          ? t('projects.added', { name: project.name })
          : t('projects.addedMany', { count: done.length, name: project.name }),
      undo: async () => {
        await store.setMembership(project.id, done, false);
      },
    });
  } catch {
    notify({ message: t('common.cannotConnect'), tone: 'bad' });
  }
}

/** Remove works from a project; the notice puts back those that were in it. */
export async function removeFromProject(
  store: ProjectsStore,
  project: Project,
  works: readonly Member[],
  notify: (notice: Notice | null) => void,
  after?: () => void,
): Promise<void> {
  const members = works
    .filter((w) => w.project_ids?.includes(project.id) === true)
    .map((w) => w.id);
  if (members.length === 0) return;
  try {
    const done = await store.setMembership(project.id, members, false);
    after?.();
    notify({
      message:
        members.length === 1
          ? t('projects.removed', { name: project.name })
          : t('projects.removedMany', { count: done.length, name: project.name }),
      undo: async () => {
        await store.setMembership(project.id, done, true);
        after?.();
      },
    });
  } catch {
    notify({ message: t('common.cannotConnect'), tone: 'bad' });
  }
}

/**
 * Rename a project from the sidebar or its page: a blank or unchanged name
 * sends nothing, one over 60 characters says so, and a project changed
 * elsewhere (409) keeps its new name and says to try again.
 */
export async function renameProject(
  store: ProjectsStore,
  project: Project,
  typed: string,
  notify: (notice: Notice | null) => void,
): Promise<void> {
  if (typed.trim() === '' || typed.trim() === project.name) return;
  const name = projectName(typed);
  if (name === null) {
    notify({ message: t('projects.nameTaken'), tone: 'bad' });
    return;
  }
  try {
    const done = await store.patch(project, { name });
    if (done === null) {
      notify({ message: t('workActions.renameConflict', { title: project.name }), tone: 'bad' });
    }
  } catch {
    notify({ message: t('workActions.renameFailed', { title: project.name }), tone: 'bad' });
  }
}
