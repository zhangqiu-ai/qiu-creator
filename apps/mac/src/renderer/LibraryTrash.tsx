import type { CreatorHubClient } from '@qiu-creator/api-client';
import {
  WORK_TRASH_RETENTION_DAYS,
  type Project,
  type WorkListItem,
  type WorkRef,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { anchorOf, ContextMenu, type MenuAnchor, type MenuEntry } from './ContextMenu.js';
import { useRefreshOn } from './events.js';
import { WORK_TYPE } from './format.js';
import { codeText, errorText, t } from './i18n.js';
import { Icon } from './Icon.js';
import { PurgeDialog } from './LibraryDialogs.js';
import {
  clickSelect,
  contextTargets,
  EMPTY_SELECTION,
  keepShown,
  type Selection,
} from './library-select.js';
import { daysLeft } from './library-trash.js';
import { LibraryFeed } from './library-feed.js';
import { Highlight } from './Highlight.js';
import { LoadMore } from './LoadMore.js';
import { useToast } from './toasts.js';
import { purgeWorks, restoreWorks } from './work-actions.js';
import { CardCover } from './WorkCover.js';
import {
  Animated,
  AnimatedItem,
  hasOpenLayer,
  LAYOUT_LIMIT,
  Presence,
  SettleIn,
} from './motion.js';

type Notice = { message: string; tone: 'ok' | 'bad' };
/** A deleted work as selection and actions see it: a loaded card or a ⌘A ref (QC-067). */
type TrashWork = Pick<
  WorkRef,
  'id' | 'title' | 'tags' | 'current_revision_id' | 'storage_mode' | 'external_state'
>;
type Purge = { works: readonly TrashWork[]; empty: boolean };

/**
 * 回收站 in 作品庫 (QC-052 on the QC-051 API): works deleted in the last
 * 30 days, newest first. 還原 brings a work back with its revision and
 * history; 永久刪除 and 清空 ask first and cannot be undone. A click selects
 * (there is nothing to open), with ⌘ / ⇧ / ⌘A as in the library.
 */
export function TrashView({
  client,
  query = '',
  projects = [],
  tools = null,
}: {
  client: CreatorHubClient;
  /** To say which projects a deleted work was in (QC-062); 還原 puts it back in them. */
  projects?: readonly Project[];
  /** A search to apply (none since 回收站 opens from the sidebar, QC-069). */
  query?: string;
  /** The page header's tool area, where 清空回收站 goes. */
  tools?: HTMLElement | null;
}) {
  // Paged like 作品庫 (QC-067), so a long 回收站 shows every deleted work.
  const [feed] = useState(
    () =>
      new LibraryFeed<WorkListItem>(() =>
        Promise.resolve({ items: [], next_cursor: null, total: 0 }),
      ),
  );
  const feedState = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const works = feedState.items;
  /** ⌘A: every deleted work matching the search, loaded or not. */
  const [allRefs, setAllRefs] = useState<readonly TrashWork[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; ids: readonly string[] } | null>(null);
  const [purge, setPurge] = useState<Purge | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(() => {
    ++request.current;
    setFailed(false);
    setAllRefs(null);
    const q = query.trim();
    void feed.reset((cursor, limit) =>
      client.works
        .list({
          scope: 'trash',
          limit,
          ...(q === '' ? {} : { q }),
          ...(cursor === null ? {} : { cursor }),
        })
        .then((res) => ({ items: res.items, next_cursor: res.next_cursor, total: res.total })),
    );
  }, [client, feed, query]);
  const refresh = useCallback(() => {
    void feed.refresh();
  }, [feed]);
  useEffect(load, [load]);
  useRefreshOn(['work'], refresh, 300);

  const order = useMemo(() => (works ?? []).map((w) => w.id), [works]);
  const orderRef = useRef(order);
  const allRefsRef = useRef(allRefs);
  allRefsRef.current = allRefs;
  useEffect(() => {
    orderRef.current = order;
    if (allRefsRef.current === null) setSelection((sel) => keepShown(sel, order));
  }, [order]);
  const byId = useMemo(() => {
    const m = new Map<string, TrashWork>((allRefs ?? []).map((r) => [r.id, r]));
    for (const w of works ?? []) m.set(w.id, w);
    return m;
  }, [works, allRefs]);
  const selected: readonly TrashWork[] =
    allRefs !== null
      ? allRefs.filter((r) => selection.ids.has(r.id)).map((r) => byId.get(r.id) ?? r)
      : (works ?? []).filter((w) => selection.ids.has(w.id));

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, 6000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);
  useToast(
    notice === null
      ? null
      : {
          message: notice.message,
          tone: notice.tone,
          onClose: () => {
            setNotice(null);
          },
        },
  );

  const restore = async (targets: readonly TrashWork[]) => {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      const res = await restoreWorks(client, targets);
      const back = new Set(res.ok.map((w) => w.id));
      feed.remove(back);
      setAllRefs(null);
      setSelection(EMPTY_SELECTION);
      const firstFailed = res.failed[0];
      if (firstFailed !== undefined) {
        const work = targets.find((w) => w.id === firstFailed.id);
        const reason =
          firstFailed.code === 'source_missing' && work !== undefined
            ? t('workActions.restoreSourceMissing', { title: work.title })
            : codeText(firstFailed.code);
        setNotice({
          tone: 'bad',
          message:
            targets.length === 1
              ? reason
              : t('workActions.partial', { done: back.size, failed: res.failed.length, reason }),
        });
      } else {
        const first = res.ok[0];
        setNotice({
          tone: 'ok',
          message:
            res.ok.length === 1 && first !== undefined
              ? t('workActions.restored', { title: first.title })
              : t('workActions.restoredMany', { count: res.ok.length }),
        });
      }
      load();
    } finally {
      setBusy(false);
    }
  };

  const purgeNow = async ({ works: targets, empty }: Purge) => {
    setPurge(null);
    setBusy(true);
    try {
      if (empty) {
        const res = await client.works.emptyTrash();
        feed.remove(new Set((works ?? []).map((w) => w.id)));
        setNotice({ tone: 'ok', message: t('workActions.purged', { count: res.purged.length }) });
      } else {
        const res = await purgeWorks(
          client,
          targets.map((w) => w.id),
        );
        const gone = new Set(res.purged);
        feed.remove(gone);
        const firstFailed = res.failed[0];
        setNotice(
          firstFailed === undefined
            ? { tone: 'ok', message: t('workActions.purged', { count: res.purged.length }) }
            : {
                tone: 'bad',
                message: t('workActions.partial', {
                  done: res.purged.length,
                  failed: res.failed.length,
                  reason: codeText(firstFailed.code),
                }),
              },
        );
      }
      setSelection(EMPTY_SELECTION);
      setAllRefs(null);
    } catch (err) {
      setNotice({ tone: 'bad', message: errorText(err) });
    } finally {
      setBusy(false);
      load();
    }
  };

  // ⌘A selects every deleted work, esc clears, ⌘⌫ asks to delete the selection for good.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (hasOpenLayer(true)) return;
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        // Every deleted work matching the search (QC-067), not only those loaded.
        const q = queryRef.current.trim();
        void client.works
          .refs({ scope: 'trash', ...(q === '' ? {} : { q }) })
          .then((res) => {
            setAllRefs(res.items);
            setSelection({
              ids: new Set(res.items.map((r) => r.id)),
              anchor: orderRef.current[0] ?? null,
            });
          })
          .catch((err: unknown) => {
            setNotice({ tone: 'bad', message: errorText(err) });
          });
      } else if (e.metaKey && e.key === 'Backspace' && selectedRef.current.length > 0) {
        e.preventDefault();
        setPurge({ works: selectedRef.current, empty: false });
      } else if (e.key === 'Escape' && !e.metaKey) {
        setAllRefs(null);
        setSelection((sel) => (sel.ids.size === 0 ? sel : EMPTY_SELECTION));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const onCardClick = (e: MouseEvent, w: WorkListItem) => {
    setSelection((sel) =>
      clickSelect(sel, w.id, orderRef.current, { meta: e.metaKey, shift: e.shiftKey }),
    );
  };
  const menuItems = (ids: readonly string[]): MenuEntry[] => {
    const targets = ids.map((id) => byId.get(id)).filter((w): w is TrashWork => w !== undefined);
    return [
      {
        kind: 'item',
        id: 'restore',
        label: t('workActions.restore'),
        onSelect: () => {
          void restore(targets);
        },
      },
      { kind: 'sep', id: 'sep' },
      {
        kind: 'item',
        id: 'purge',
        label: t('workActions.purgeItem'),
        danger: true,
        hint: '⌘⌫',
        onSelect: () => {
          setPurge({ works: targets, empty: false });
        },
      },
    ];
  };
  const menuTargets =
    menu === null
      ? []
      : menu.ids.map((id) => byId.get(id)).filter((w): w is TrashWork => w !== undefined);
  const firstMenuTarget = menuTargets[0];

  return (
    <>
      {/* The title and the 30-day note are in the page header, and 清空 joins them there (QC-069). */}
      {tools !== null &&
        createPortal(
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || works === null || works.length === 0}
            onClick={() => {
              setPurge({ works: [], empty: true });
            }}
          >
            {t('workActions.emptyTrash')}
          </button>,
          tools,
        )}

      <Presence>
        {selected.length > 0 && (
          <Animated
            key="batch-bar"
            preset={{ kind: 'toast' }}
            className="batch-bar"
            role="toolbar"
            aria-label={t('workActions.selected', { count: selected.length })}
          >
            <span className="batch-bar__count" aria-live="polite">
              {t('workActions.selected', { count: selected.length })}
            </span>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => {
                void restore(selected);
              }}
            >
              {t('workActions.restore')}
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger"
              disabled={busy}
              onClick={() => {
                setPurge({ works: selected, empty: false });
              }}
            >
              {t('workActions.purgeItem')}
            </button>
            <span className="batch-bar__hint">{t('workActions.selectHint')}</span>
            <button
              type="button"
              className="btn btn--small btn--ghost batch-bar__clear"
              onClick={() => {
                setSelection(EMPTY_SELECTION);
              }}
            >
              {t('workActions.clearSelection')}
              <kbd>esc</kbd>
            </button>
          </Animated>
        )}
      </Presence>

      <section
        className="page__body"
        aria-label={t('workActions.trashList')}
        aria-busy={works === null && !failed}
      >
        {failed ? (
          <div className="state-card" role="alert">
            <Icon name="offline" size={28} />
            <span className="state-card__title">{t('common.serviceDown')}</span>
            <button type="button" className="btn btn--primary" onClick={load}>
              {t('common.retry')}
            </button>
          </div>
        ) : works === null ? null : works.length === 0 ? (
          <div className="state-card state-card--dashed">
            <Icon name="trash" size={28} />
            <span className="state-card__title">{t('workActions.trashEmpty')}</span>
            <span className="state-card__detail">
              {t('workActions.trashEmptyHint', { days: WORK_TRASH_RETENTION_DAYS })}
            </span>
          </div>
        ) : (
          <ul className="card-grid" aria-multiselectable="true">
            <Presence popLayout>
              {works.map((w) => {
                const days = daysLeft(w.purge_at);
                const isSelected = selection.ids.has(w.id);
                return (
                  <AnimatedItem key={w.id} layout={works.length <= LAYOUT_LIMIT}>
                    <button
                      type="button"
                      className={[
                        'wcard',
                        'wcard--trashed',
                        isSelected ? 'wcard--selected' : '',
                        menu?.ids.includes(w.id) === true ? 'wcard--menu' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-work-id={w.id}
                      aria-pressed={isSelected}
                      title={w.title}
                      onClick={(e) => {
                        onCardClick(e, w);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          anchor: anchorOf(e),
                          ids:
                            allRefs !== null && selection.ids.has(w.id)
                              ? allRefs.filter((r) => selection.ids.has(r.id)).map((r) => r.id)
                              : contextTargets(selection, w.id, orderRef.current),
                        });
                      }}
                    >
                      <CardCover work={w} imageUrl={(rel) => client.media.absoluteUrl(rel)} />
                      <span className="wcard__body">
                        <span className="wcard__title">
                          <Highlight text={w.title} />
                        </span>
                        <span className="wcard__meta">
                          <span className="chip chip--warn">
                            {days === null || days === 0
                              ? t('workActions.purgeToday')
                              : t('workActions.daysLeft', { count: days })}
                          </span>
                          <span className="wcard__type">{WORK_TYPE[w.type].label}</span>
                        </span>
                        <TrashFrom projectIds={w.project_ids} projects={projects} />
                        {w.removal === 'unindexed' || w.removal === 'original_trashed' ? (
                          <span className="wcard__meta wcard__meta--muted">
                            <Icon name="folder" size={11} />
                            {t(
                              w.removal === 'unindexed'
                                ? 'workActions.removalUnindexed'
                                : 'workActions.removalOriginalTrashed',
                            )}
                          </span>
                        ) : null}
                      </span>
                      {isSelected && (
                        <SettleIn className="wcard__check">
                          <Icon name="check" size={12} />
                        </SettleIn>
                      )}
                    </button>
                  </AnimatedItem>
                );
              })}
            </Presence>
          </ul>
        )}
        {works !== null && works.length > 0 && (
          <LoadMore
            hasMore={feedState.hasMore}
            loading={feedState.loading}
            failed={feedState.failed}
            onMore={() => {
              void (feedState.failed ? feed.refresh() : feed.loadMore());
            }}
          />
        )}
      </section>

      {menu !== null && firstMenuTarget !== undefined && (
        <ContextMenu
          anchor={menu.anchor}
          label={
            menuTargets.length === 1
              ? t('workActions.menuFor', { title: firstMenuTarget.title })
              : t('workActions.menuForMany', { count: menuTargets.length })
          }
          items={menuItems(menu.ids)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
      {purge !== null && (
        <PurgeDialog
          works={purge.works}
          empty={purge.empty}
          count={works?.length ?? 0}
          onCancel={() => {
            setPurge(null);
          }}
          onConfirm={() => {
            void purgeNow(purge);
          }}
        />
      )}
    </>
  );
}

/** 原本在：… — the projects a deleted work was in (skipping ones since deleted). */
function TrashFrom({
  projectIds,
  projects,
}: {
  projectIds: readonly string[] | undefined;
  projects: readonly Project[];
}) {
  const names = (projectIds ?? [])
    .map((id) => projects.find((p) => p.id === id)?.name)
    .filter((n): n is string => n !== undefined);
  if (names.length === 0) return null;
  return (
    <span className="wcard__meta wcard__meta--muted wcard__from">
      {t('projects.trashFrom', { names: names.join('、') })}
    </span>
  );
}
