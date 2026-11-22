import type { CreatorHubClient } from '@qiu-creator/api-client';
import { WORK_TRASH_RETENTION_DAYS, type WorkListItem } from '@qiu-creator/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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
  selectAll,
  type Selection,
} from './library-select.js';
import { daysLeft } from './library-trash.js';
import { useToast } from './toasts.js';
import { purgeWorks, restoreWorks } from './work-actions.js';
import { CardCover } from './WorkCover.js';

type Notice = { message: string; tone: 'ok' | 'bad' };
type Purge = { works: readonly WorkListItem[]; empty: boolean };

/**
 * 最近刪除 in 作品庫 (QC-052 on the QC-051 API): works deleted in the last
 * 30 days, newest first. 還原 brings a work back with its revision and
 * history; 永久刪除 and 清空 ask first and cannot be undone. A click selects
 * (there is nothing to open), with ⌘ / ⇧ / ⌘A as in the library.
 */
export function TrashView({
  client,
  query,
  onBack,
  onCount,
}: {
  client: CreatorHubClient;
  /** The library's search, applied here too. */
  query: string;
  onBack: () => void;
  onCount: (count: number) => void;
}) {
  const [works, setWorks] = useState<readonly WorkListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; ids: readonly string[] } | null>(null);
  const [purge, setPurge] = useState<Purge | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setFailed(false);
    const q = query.trim();
    client.works
      .list({ scope: 'trash', limit: 200, ...(q === '' ? {} : { q }) })
      .then((res) => {
        if (id !== request.current) return;
        setWorks(res.items);
        if (q === '') onCount(res.total);
      })
      .catch(() => {
        if (id === request.current) setFailed(true);
      });
  }, [client, query, onCount]);
  useEffect(load, [load]);
  useRefreshOn(['work'], load, 300);

  const order = useMemo(() => (works ?? []).map((w) => w.id), [works]);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
    setSelection((sel) => keepShown(sel, order));
  }, [order]);
  const selected = (works ?? []).filter((w) => selection.ids.has(w.id));

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

  const restore = async (targets: readonly WorkListItem[]) => {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      const res = await restoreWorks(client, targets);
      const back = new Set(res.ok.map((w) => w.id));
      setWorks((ws) => ws?.filter((w) => !back.has(w.id)) ?? ws);
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
        setWorks([]);
        setNotice({ tone: 'ok', message: t('workActions.purged', { count: res.purged.length }) });
      } else {
        const res = await purgeWorks(
          client,
          targets.map((w) => w.id),
        );
        const gone = new Set(res.purged);
        setWorks((ws) => ws?.filter((w) => !gone.has(w.id)) ?? ws);
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
      if (document.querySelector('[aria-modal="true"], .ctx-menu') !== null) return;
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection(selectAll(orderRef.current));
      } else if (e.metaKey && e.key === 'Backspace' && selectedRef.current.length > 0) {
        e.preventDefault();
        setPurge({ works: selectedRef.current, empty: false });
      } else if (e.key === 'Escape' && !e.metaKey) {
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
    const targets = (works ?? []).filter((w) => ids.includes(w.id));
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
  const menuTargets = menu === null ? [] : (works ?? []).filter((w) => menu.ids.includes(w.id));
  const firstMenuTarget = menuTargets[0];

  return (
    <>
      <div className="filters trash-bar">
        <button type="button" className="btn btn--small btn--ghost" onClick={onBack}>
          <Icon name="back" size={14} />
          {t('workActions.backToLibrary')}
        </button>
        <h2 className="trash-bar__title">
          <Icon name="trash" size={16} />
          {t('workActions.trash')}
        </h2>
        <span className="trash-bar__hint">
          {t('workActions.trashHint', { days: WORK_TRASH_RETENTION_DAYS })}
        </span>
        <button
          type="button"
          className="btn btn--small btn--danger"
          disabled={busy || works === null || works.length === 0}
          onClick={() => {
            setPurge({ works: [], empty: true });
          }}
        >
          {t('workActions.emptyTrash')}
        </button>
      </div>

      {selected.length > 0 && (
        <div
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
        </div>
      )}

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
            {works.map((w) => {
              const days = daysLeft(w.purge_at);
              const isSelected = selection.ids.has(w.id);
              return (
                <li key={w.id}>
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
                        ids: contextTargets(selection, w.id, orderRef.current),
                      });
                    }}
                  >
                    <CardCover work={w} imageUrl={(rel) => client.media.absoluteUrl(rel)} />
                    <span className="wcard__body">
                      <span className="wcard__title">{w.title}</span>
                      <span className="wcard__meta">
                        <span className="chip chip--warn">
                          {days === null || days === 0
                            ? t('workActions.purgeToday')
                            : t('workActions.daysLeft', { count: days })}
                        </span>
                        <span className="wcard__type">{WORK_TYPE[w.type].label}</span>
                      </span>
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
                      <span className="wcard__check" aria-hidden="true">
                        <Icon name="check" size={12} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
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
