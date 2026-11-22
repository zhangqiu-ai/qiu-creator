import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { Project } from '@qiu-creator/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useChangeEvents } from './events.js';
import { ExitFade } from './motion.js';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { addToProject, removeFromProject, useNotice } from './project-actions.js';
import {
  projectColor,
  projectName,
  type ProjectsState,
  type ProjectsStore,
} from './projects-store.js';

/** The App's project list, for the editors (QC-062); null before the service answers. */
export const ProjectsContext = createContext<ProjectsStore | null>(null);

const NONE = (): (() => void) => () => undefined;
const EMPTY: ProjectsState = {
  projects: null,
  allCount: null,
  unassignedCount: null,
  trashCount: null,
  failed: false,
};
const EMPTY_STATE = () => EMPTY;

/** Live projects matching the typed text, and whether 新建「…」 is offered. */
export function filterProjects(
  projects: readonly Project[],
  query: string,
): { matches: Project[]; canCreate: boolean } {
  const q = query.trim().toLocaleLowerCase();
  const live = projects.filter((p) => !p.archived);
  const matches = q === '' ? live : live.filter((p) => p.name.toLocaleLowerCase().includes(q));
  const exact = live.some((p) => p.name.toLocaleLowerCase() === q);
  return { matches, canCreate: projectName(query) !== null && !exact };
}

/**
 * 所屬項目 in the editor's meta row: the work's projects as colour tags
 * (× takes it out of one), and 項目 opens a searchable checklist (↑↓ ↩, esc)
 * that applies at once, with 新建「…」 for a name not yet used.
 */
export function ProjectTags({
  client,
  workId,
  title,
  initial,
}: {
  client: CreatorHubClient;
  workId: string;
  title: string;
  initial: readonly string[] | undefined;
}) {
  const store = useContext(ProjectsContext);
  const s = useSyncExternalStore(store?.subscribe ?? NONE, store?.getSnapshot ?? EMPTY_STATE);
  const notify = useNotice();
  const [ids, setIds] = useState<readonly string[]>(initial ?? []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const reread = () => {
    void client.works
      .get(workId)
      .then((w) => {
        setIds([...new Set(w.project_ids ?? [])]);
      })
      .catch(() => undefined);
  };
  // Changed from 作品庫, the sidebar or another device.
  useChangeEvents((event) => {
    if (event.entity === 'work' && event.entity_id === workId) {
      if (event.action === 'work.projects_changed') reread();
    } else if (event.entity === 'project') reread();
  });

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const projects = s.projects ?? [];
  const mine = ids
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined && !p.archived);
  const { matches, canCreate } = useMemo(() => filterProjects(projects, query), [projects, query]);
  const rows = matches.length + (canCreate ? 1 : 0);
  const me = { id: workId, title, project_ids: ids };

  if (store === null) return null;

  const toggle = (p: Project) => {
    if (ids.includes(p.id)) {
      setIds((x) => x.filter((id) => id !== p.id));
      void removeFromProject(store, p, [me], notify, reread);
    } else {
      setIds((x) => (x.includes(p.id) ? x : [...x, p.id]));
      void addToProject(store, p, [me], notify).then(reread);
    }
  };
  const create = async () => {
    const name = projectName(query);
    if (name === null) return;
    try {
      const p = await store.create(name);
      await store.setMembership(p.id, [workId], true);
      setIds((x) => (x.includes(p.id) ? x : [...x, p.id]));
      setQuery('');
      notify({ message: t('projects.createdAdded', { name: p.name }) });
    } catch {
      notify({ message: t('common.cannotConnect'), tone: 'bad' });
    }
  };
  const close = () => {
    setOpen(false);
    setQuery('');
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows === 0) return;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : rows - 1)) % rows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = matches[active];
      if (p !== undefined) toggle(p);
      else if (canCreate) void create();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="ptags" ref={box}>
      {mine.map((p) => (
        <span key={p.id} className="ptags__tag">
          <span className="ptags__dot" style={{ background: projectColor(p.color) }} />
          {p.name}
          <button
            type="button"
            className="ptags__x"
            aria-label={t('projects.removeFrom', { name: p.name })}
            onClick={() => {
              toggle(p);
            }}
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <button
        ref={button}
        type="button"
        className="btn btn--small btn--ghost ptags__add"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setActive(0);
        }}
      >
        <Icon name="plus" size={12} />
        {t('projects.projectButton')}
      </button>
      {open && (
        <ExitFade>
          <div className="ptags__pop" role="dialog" aria-label={t('projects.addToProject')}>
            <input
              ref={search}
              className="input ptags__search"
              placeholder={t('projects.searchProjects')}
              value={query}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows === 0 ? undefined : `${listId}-${String(active)}`}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
            <ul id={listId} className="ptags__list" role="listbox" aria-multiselectable="true">
              {matches.map((p, i) => (
                <li
                  key={p.id}
                  id={`${listId}-${String(i)}`}
                  role="option"
                  aria-selected={ids.includes(p.id)}
                  className={i === active ? 'ptags__opt ptags__opt--active' : 'ptags__opt'}
                  onMouseEnter={() => {
                    setActive(i);
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggle(p);
                  }}
                >
                  <span
                    className={`ctx-menu__box ctx-menu__box--${String(ids.includes(p.id))}`}
                    aria-hidden="true"
                  />
                  <span className="ptags__dot" style={{ background: projectColor(p.color) }} />
                  <span className="ptags__name">{p.name}</span>
                </li>
              ))}
              {canCreate && (
                <li
                  id={`${listId}-${String(matches.length)}`}
                  role="option"
                  aria-selected={false}
                  className={
                    active === matches.length ? 'ptags__opt ptags__opt--active' : 'ptags__opt'
                  }
                  onMouseEnter={() => {
                    setActive(matches.length);
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void create();
                  }}
                >
                  <Icon name="plus" size={12} />
                  <span className="ptags__name">
                    {t('projects.createNamed', { name: query.trim() })}
                  </span>
                </li>
              )}
              {rows === 0 && <li className="ptags__empty faint">{t('projects.noProjects')}</li>}
            </ul>
          </div>
        </ExitFade>
      )}
    </div>
  );
}
