import type { Project } from '@qiu-creator/contracts';
import { useState, type ReactNode } from 'react';
import { ContextMenu, type MenuAnchor, type MenuEntry } from './ContextMenu.js';
import { Dialog } from './Dialog.js';
import { t } from './i18n.js';
import type { Notice } from './project-actions.js';
import { ProjectRulesDialog } from './ProjectRulesDialog.js';
import {
  COLOR_NAME,
  moveInOrder,
  PROJECT_COLORS,
  projectColor,
  projectName,
  type ProjectsStore,
} from './projects-store.js';

/**
 * The project menu (QC-062): 重新命名, 顏色 ▸, 上移／下移, 項目設定… (QC-091), 封存, 刪除項目… —
 * the same entries from a sidebar row's right-click and from the ⋯ button
 * in a project's 作品庫 header. Deleting asks first, says how many works
 * become 未分類, and the notice offers 復原.
 */
export function useProjectMenu({
  store,
  notify,
  onRename,
  onGone,
}: {
  /** Null before the project list exists: the menu then never opens. */
  store: ProjectsStore | null;
  notify: (notice: Notice | null) => void;
  onRename: (project: Project) => void;
  /** The project was archived or deleted (so a page showing it goes back to 全部作品). */
  onGone: (project: Project) => void;
}): {
  open: (project: Project, anchor: MenuAnchor) => void;
  /** The project whose menu is open, for the row's highlight. */
  openId: string | null;
  node: ReactNode;
} {
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const [deleting, setDeleting] = useState<{
    project: Project;
    count: number;
    unsorted: number;
  } | null>(null);
  /** 項目設定… (QC-091): description and rules, with a trial. */
  const [settings, setSettings] = useState<string | null>(null);

  const move = (store: ProjectsStore, p: Project, step: -1 | 1) => {
    void store.reorder(moveInOrder(store.order, p.id, step));
  };

  const archive = async (store: ProjectsStore, p: Project, archivedNext: boolean) => {
    const done = await store.patch(p, { archived: archivedNext }).catch(() => null);
    if (done === null) return;
    if (archivedNext) onGone(p);
    notify({
      message: t(archivedNext ? 'projects.archivedToast' : 'projects.unarchivedToast', {
        name: p.name,
      }),
      undo: () => {
        void store.patch(done, { archived: !archivedNext });
      },
    });
  };

  const askDelete = async (p: Project) => {
    // The service counts both, however many works the project has (QC-067).
    const summary = await store?.summary(p.id).catch(() => null);
    setDeleting({
      project: p,
      count: summary?.project.work_count ?? p.work_count,
      unsorted: summary?.sole_count ?? 0,
    });
  };

  const remove = async (p: Project) => {
    setDeleting(null);
    if (store === null) return;
    try {
      await store.remove(p.id);
      onGone(p);
      notify({
        message: t('projects.deleted', { name: p.name }),
        undo: () => {
          void store.restore(p.id);
        },
      });
    } catch {
      notify({ message: t('common.cannotConnect'), tone: 'bad' });
    }
  };

  const items = (store: ProjectsStore, p: Project): MenuEntry[] => {
    const at = store.order.indexOf(p.id);
    return [
      {
        kind: 'item',
        id: 'rename',
        label: t('workActions.rename'),
        hint: 'F2',
        onSelect: () => {
          onRename(p);
        },
      },
      {
        kind: 'sub',
        id: 'color',
        label: t('projects.color'),
        items: PROJECT_COLORS.map((hex, i) => ({
          kind: 'item' as const,
          id: `color-${String(i)}`,
          label: t(COLOR_NAME[i] ?? 'projects.color0'),
          swatch: hex,
          checked: p.color === i,
          onSelect: () => {
            void store.patch(p, { color: i });
          },
        })),
      },
      { kind: 'sep', id: 'sep-1' },
      {
        kind: 'item',
        id: 'up',
        label: t('projects.moveUp'),
        hint: '⌥↑',
        disabled: p.archived || at <= 0,
        onSelect: () => {
          move(store, p, -1);
        },
      },
      {
        kind: 'item',
        id: 'down',
        label: t('projects.moveDown'),
        hint: '⌥↓',
        disabled: p.archived || at < 0 || at >= store.order.length - 1,
        onSelect: () => {
          move(store, p, 1);
        },
      },
      { kind: 'sep', id: 'sep-2' },
      {
        kind: 'item',
        id: 'settings',
        label: t('agents.projSettings'),
        onSelect: () => {
          setSettings(p.id);
        },
      },
      {
        kind: 'item',
        id: 'archive',
        label: p.archived ? t('projects.unarchive') : t('projects.archive'),
        onSelect: () => {
          void archive(store, p, !p.archived);
        },
      },
      {
        kind: 'item',
        id: 'delete',
        label: t('projects.deleteProject'),
        danger: true,
        onSelect: () => {
          void askDelete(p);
        },
      },
    ];
  };

  const project = menu === null || store === null ? null : store.find(menu.id);
  const settingsProject = settings === null || store === null ? null : store.find(settings);
  const node = (
    <>
      {menu !== null && project !== null && store !== null && (
        <ContextMenu
          anchor={menu.anchor}
          label={t('workActions.menuFor', { title: project.name })}
          items={items(store, project)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {settingsProject !== null && store !== null && (
        <ProjectRulesDialog
          store={store}
          project={settingsProject}
          onSaved={(message) => {
            notify({ message });
          }}
          onClose={() => {
            setSettings(null);
          }}
        />
      )}
      {deleting !== null && (
        <Dialog
          title={t('projects.deleteTitle', { name: deleting.project.name })}
          onClose={() => {
            setDeleting(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn dialog__primary"
                data-autofocus
                onClick={() => {
                  setDeleting(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--danger-solid"
                onClick={() => {
                  void remove(deleting.project);
                }}
              >
                {t('projects.deleteProjectAction')}
              </button>
            </>
          }
        >
          <p>
            {deleting.count === 0
              ? t('projects.deleteEmpty')
              : t('projects.deleteBody', { count: deleting.count })}
          </p>
          {deleting.unsorted > 0 && (
            <p className="faint">{t('projects.deleteUnsorted', { count: deleting.unsorted })}</p>
          )}
        </Dialog>
      )}
    </>
  );

  return {
    open: (p, anchor) => {
      setMenu({ id: p.id, anchor });
    },
    openId: menu?.id ?? null,
    node,
  };
}

/** 新建項目…: a name and one of the eight colours (the next in turn to start, QC-069); ↩ creates. */
export function NewProjectDialog({
  initialName = '',
  initialColor = 0,
  onCancel,
  onCreate,
}: {
  initialName?: string;
  initialColor?: number;
  onCancel: () => void;
  onCreate: (name: string, color: number) => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const valid = projectName(name) !== null;
  const submit = () => {
    const n = projectName(name);
    if (n !== null) onCreate(n, color);
  };
  return (
    <Dialog
      title={t('projects.newProject')}
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
            {t('projects.newProject')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">{t('projects.projectName')}</span>
        <input
          className="input"
          data-autofocus
          value={name}
          maxLength={120}
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
      <div className="proj-colors" role="radiogroup" aria-label={t('projects.color')}>
        {PROJECT_COLORS.map((_, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={color === i}
            aria-label={t(COLOR_NAME[i] ?? 'projects.color0')}
            className="proj-colors__swatch"
            style={{ background: projectColor(i) }}
            onClick={() => {
              setColor(i);
            }}
          />
        ))}
      </div>
    </Dialog>
  );
}
