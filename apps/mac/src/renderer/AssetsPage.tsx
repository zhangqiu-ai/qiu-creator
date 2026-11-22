import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AssetKind,
  AssetOrigin,
  AssetRecord,
  AssetReferences,
  AssetWorkItem,
  Mount,
  Project,
  WorkAssetRole,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type MouseEvent,
} from 'react';
import {
  AssetEditor,
  assetErrorText,
  batchInUseReferences,
  brokenLinkTitles,
  deletedToast,
  deleteImpact,
  deleteImpactText,
  type DeleteImpact,
  daysLeft,
  displayName,
  FIELD_LABEL,
  fileExt,
  inUseReferences,
  isExternal,
  referencingTitles,
  type EditorState,
  type SaveStatus,
} from './asset-session.js';
import { formatStamp } from './backups.js';
import { Dialog } from './Dialog.js';
import { projectColor } from './projects-store.js';
import { TagEditor } from './TagEditor.js';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { Chip } from './Chip.js';
import { useRefreshOn } from './events.js';
import { useMounts } from './mounts.js';
import {
  ASSET_KIND,
  assetName,
  type ChipTone,
  formatBytes,
  formatDimensions,
  formatDuration,
  shortHash,
  tildePath,
} from './format.js';
import { useToast } from './toasts.js';
import { Highlight, SearchHighlight } from './Highlight.js';
import { Lightbox, type LightboxItem } from './Lightbox.js';
import type { Rect } from './lightbox-math.js';
import { Icon } from './Icon.js';
import { formatDateTime, formatNumber, t } from './i18n.js';

type KindFilter = 'all' | AssetKind;
const KIND_FILTERS: readonly KindFilter[] = ['all', 'image', 'video', 'audio', 'markdown', 'other'];
const PAGE_SIZE = 100;

const ORIGIN_LABEL: Readonly<Record<AssetOrigin, string>> = {
  get upload() {
    return t('assets.originUpload');
  },
  get url() {
    return t('assets.originUrl');
  },
  get folder() {
    return t('assets.originFolder');
  },
  api: 'Agent API',
  get manual() {
    return t('assets.originManual');
  },
};

const ROLE_LABEL: Readonly<Record<WorkAssetRole, string>> = {
  get cover() {
    return t('assets.roleCover');
  },
  get body() {
    return t('assets.roleBody');
  },
  get video() {
    return t('assets.roleVideo');
  },
};

export interface AssetGroup {
  key: string;
  /** null for the managed library. */
  mount: Mount | null;
  items: AssetRecord[];
}

/** Managed assets first, then one group per mount (QC-010 indexes mounted files in place). */
export function groupAssets(
  items: readonly AssetRecord[],
  mounts: ReadonlyMap<string, Mount>,
): AssetGroup[] {
  const managed: AssetRecord[] = [];
  const byMount = new Map<string, AssetRecord[]>();
  for (const a of items) {
    const id = a.mount_id ?? null;
    if (id === null) managed.push(a);
    else byMount.set(id, [...(byMount.get(id) ?? []), a]);
  }
  const groups: AssetGroup[] =
    managed.length > 0 ? [{ key: 'managed', mount: null, items: managed }] : [];
  for (const [id, list] of byMount) {
    const mount = mounts.get(id) ?? null;
    groups.push({ key: id, mount, items: list });
  }
  return groups;
}

interface Listing {
  items: AssetRecord[];
  total: number;
}

type Scope = 'active' | 'unreferenced' | 'trash';
const SCOPES: readonly Scope[] = ['active', 'unreferenced', 'trash'];

function scopeLabel(scope: Scope): string {
  if (scope === 'active') return t('assets.all');
  return scope === 'unreferenced' ? t('assets.scopeUnreferenced') : t('assets.scopeTrash');
}

interface Toast {
  message: string;
  /** Asset ids to bring back with 復原 (⌘Z). */
  undo: string[] | null;
  tone?: 'ok' | 'bad';
}

type DeleteDialog =
  | { kind: 'referenced'; asset: AssetRecord; refs: AssetReferences }
  | { kind: 'external'; asset: AssetRecord }
  | { kind: 'batch'; ids: string[] }
  | { kind: 'purge'; asset: AssetRecord }
  | { kind: 'empty'; count: number }
  | { kind: 'tags'; ids: string[] };

/**
 * 素材庫 v2 (PT-20261119-001 「v2 · 素材庫：刪除與編輯」, QC-037): scopes
 * 全部／未引用／回收站, ⌘-click multi-select with batch tags and delete,
 * an inspector that edits name, tags, alt text and note with autosave, and
 * delete rules by case: unreferenced managed assets go to 回收站 at once
 * with 復原, referenced ones confirm with the works, external files leave the
 * library only unless the user opts in to the system Trash.
 */
export function AssetsPage({
  client,
  home,
  userHome,
  focusAssetId,
  startAt,
  onOpenWork,
  onOpenImports,
  onOpenSettings,
  project = null,
  onClearProject,
  onBackToProject,
}: {
  client: CreatorHubClient;
  /** Only the assets this project's works use (用到的素材, QC-062). */
  project?: Project | null;
  onClearProject?: () => void;
  onBackToProject?: (projectId: string) => void;
  home: string | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  /** Select this asset on open (e.g. 開啟 from the task list), even if it is not on the first page. */
  focusAssetId?: string | null;
  /** Start the focused video at this second (from an AI result's time point). */
  startAt?: number | null;
  onOpenImports: () => void;
  onOpenSettings: () => void;
}) {
  const [scope, setScope] = useState<Scope>('active');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [trashTotal, setTrashTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusAssetId ?? null);
  const [picks, setPicks] = useState<readonly string[]>([]);
  const [focused, setFocused] = useState<AssetRecord | null>(null);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<DeleteDialog | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const limit = useRef(PAGE_SIZE);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setFailed(false);
    const q = appliedQuery.trim();
    client.assets
      .list({
        scope,
        kind: kind === 'all' || scope === 'trash' ? undefined : kind,
        q: q === '' ? undefined : q,
        limit: Math.min(limit.current, 200),
        ...(project === null || scope === 'trash' ? {} : { project_id: project.id }),
      })
      .then((res) => {
        if (id !== request.current) return;
        setListing({ items: res.items, total: res.total });
        if (scope === 'trash') setTrashTotal(res.total);
      })
      .catch(() => {
        if (id !== request.current) return;
        setFailed(true);
      });
    if (scope !== 'trash') {
      client.assets
        .list({ scope: 'trash', limit: 1 })
        .then((res) => {
          setTrashTotal(res.total);
        })
        .catch(() => undefined);
    }
  }, [client, kind, appliedQuery, scope, project]);

  useEffect(() => {
    limit.current = PAGE_SIZE;
    setListing(null);
    load();
  }, [load]);

  useRefreshOn(['asset'], load);
  const mounts = useMounts(client);

  useEffect(() => {
    if (focusAssetId === undefined || focusAssetId === null) return;
    setSelectedId(focusAssetId);
    let alive = true;
    client.assets
      .get(focusAssetId)
      .then((asset) => {
        if (alive) setFocused(asset);
      })
      .catch(() => {
        // The grid still loads; the inspector just stays closed.
      });
    return () => {
      alive = false;
    };
  }, [client, focusAssetId]);

  // A toast stays 6 s, long enough to reach 復原.
  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => {
      setToast(null);
    }, 6000);
    return () => {
      clearTimeout(t);
    };
  }, [toast]);

  const items = listing?.items ?? [];
  const selected =
    picks.length > 0
      ? null
      : (items.find((a) => a.id === selectedId) ?? (focused?.id === selectedId ? focused : null));
  const filtering = kind !== 'all' || appliedQuery.trim() !== '' || scope === 'unreferenced';
  const picked = items.filter((a) => picks.includes(a.id));

  // ---- 大圖預覽 (QC-077) ----
  const [lightbox, setLightbox] = useState<{ id: string; origin: Rect | null } | null>(null);
  /** The assets in the order the grid shows them, so ← → follow what the person sees. */
  const ordered = useMemo(
    () => groupAssets(items, mounts).flatMap((g) => g.items),
    [items, mounts],
  );
  const returnFocusTo = useRef<string | null>(null);
  const openLightbox = (id: string, from?: Element | null) => {
    const el = from ?? document.querySelector(`[data-asset-id="${id}"] .atile__thumb`);
    const r = el?.getBoundingClientRect();
    setSelectedId(id);
    setLightbox({
      id,
      origin:
        r === undefined ? null : { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  };
  // Closing puts focus back on the card of the asset that was showing.
  useEffect(() => {
    if (lightbox !== null || returnFocusTo.current === null) return;
    const id = returnFocusTo.current;
    returnFocusTo.current = null;
    document.querySelector<HTMLElement>(`[data-asset-id="${id}"]`)?.focus();
  }, [lightbox]);
  // Space on the selected asset opens it, wherever focus is in the page (not in a field or control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.isComposing || selectedId === null || lightbox !== null) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, select, [contenteditable="true"], button, a, video, audio, [role="dialog"], [aria-modal="true"]',
        ) !== null
      ) {
        return;
      }
      if (!ordered.some((a) => a.id === selectedId)) return;
      e.preventDefault();
      openLightbox(selectedId);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  });

  const queued = (count: number) => {
    if (count > 0) setQueuedNote(t('assets.queued', { count }));
  };
  const pick = () => {
    void window.creatorhub?.pickAndUpload().then(queued);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length > 0) void window.creatorhub?.uploadFiles(files).then(queued);
  };

  const afterRemoval = (ids: readonly string[]) => {
    setPicks([]);
    if (selectedId !== null && ids.includes(selectedId)) setSelectedId(null);
    load();
  };

  /** 移到回收站 / 移出素材庫 for one asset, following the delete rules. */
  const deleteOne = (asset: AssetRecord) => {
    if (isExternal(asset)) {
      setDialog({ kind: 'external', asset });
      return;
    }
    client.assets
      .trash(asset.id)
      .then(() => {
        afterRemoval([asset.id]);
        setToast({ message: t('assets.movedToTrash'), undo: [asset.id] });
      })
      .catch((err: unknown) => {
        const refs = inUseReferences(err);
        if (refs !== null) setDialog({ kind: 'referenced', asset, refs });
        else setToast({ message: assetErrorText(err), undo: null, tone: 'bad' });
      });
  };

  const undo = (ids: readonly string[]) => {
    setToast(null);
    void Promise.all(ids.map((id) => client.assets.restore(id)))
      .then(() => {
        if (ids.length === 1 && ids[0] !== undefined) setSelectedId(ids[0]);
        load();
      })
      .catch((err: unknown) => {
        setToast({ message: assetErrorText(err), undo: null, tone: 'bad' });
      });
  };

  // ⌘⌫ deletes the selection, esc clears the multi-selection, ⌘Z takes back the last delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog !== null || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (e.key === 'Escape' && picks.length > 0) {
        e.preventDefault();
        setPicks([]);
      } else if (!typing && e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (scope === 'trash') return;
        e.preventDefault();
        if (picks.length > 0) setDialog({ kind: 'batch', ids: [...picks] });
        else if (selected !== null) deleteOne(selected);
      } else if (!typing && e.metaKey && e.key.toLowerCase() === 'z' && toast?.undo != null) {
        e.preventDefault();
        undo(toast.undo);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const togglePick = (id: string) => {
    setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  // QC-045: through the shared queue, so it never covers another notice.
  useToast(
    toast === null
      ? null
      : {
          message: toast.message,
          tone: toast.tone === 'bad' ? 'bad' : 'ok',
          closeLabel: t('assets.dismissNotice'),
          actions:
            toast.undo === null
              ? []
              : [
                  {
                    label: t('common.undo'),
                    shortcut: 'Meta+Z',
                    onClick: () => {
                      if (toast.undo !== null) undo(toast.undo);
                    },
                  },
                ],
          onClose: () => {
            setToast(null);
          },
        },
  );

  return (
    <SearchHighlight query={appliedQuery}>
      <main
        className="page page--split"
        aria-label={t('assets.title')}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="page__main">
          <header className="page__header">
            <h1 className="page__title">{t('assets.title')}</h1>
            <span className="page__count">
              {listing === null ? '' : formatNumber(listing.total)}
            </span>
            {picks.length > 0 ? (
              <div className="batchbar" role="toolbar" aria-label={t('assets.batchActions')}>
                <span className="batchbar__count">
                  {t('assets.picked', { count: picks.length })}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setDialog({ kind: 'tags', ids: [...picks] });
                  }}
                >
                  <Icon name="tag" size={14} />
                  {t('assets.addTags')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setDialog({ kind: 'batch', ids: [...picks] });
                  }}
                >
                  <Icon name="trash" size={14} />
                  {t('assets.moveToTrash')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setPicks([]);
                  }}
                >
                  {t('common.cancel')}
                  <kbd>esc</kbd>
                </button>
              </div>
            ) : (
              <>
                <label className="search">
                  <Icon name="search" />
                  <span className="visually-hidden">{t('assets.searchAssets')}</span>
                  <input
                    type="search"
                    placeholder={t('assets.searchPlaceholder')}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (!(e.nativeEvent as InputEvent).isComposing)
                        setAppliedQuery(e.target.value);
                    }}
                    onCompositionEnd={(e) => {
                      setAppliedQuery(e.currentTarget.value);
                    }}
                  />
                </label>
                <div className="seg" role="group" aria-label={t('assets.scopeGroup')}>
                  {SCOPES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={scope === s}
                      onClick={() => {
                        setScope(s);
                        setPicks([]);
                        setSelectedId(null);
                      }}
                    >
                      {scopeLabel(s)}
                      {s === 'trash' && trashTotal > 0 && (
                        <span className="seg__n">{formatNumber(trashTotal)}</span>
                      )}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn btn--primary" onClick={pick}>
                  <Icon name="upload" />
                  {t('assets.upload')}
                </button>
              </>
            )}
          </header>

          {project !== null && scope !== 'trash' && (
            <div className="proj-filter" role="status">
              <span className="fchip proj-filter__chip" aria-pressed="true">
                <span
                  className="proj-filter__dot"
                  style={{ background: projectColor(project.color) }}
                />
                {t('projects.usedIn', { name: project.name })}
                <button
                  type="button"
                  className="proj-filter__clear"
                  aria-label={t('projects.clearFilter')}
                  onClick={onClearProject}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  onBackToProject?.(project.id);
                }}
              >
                <Icon name="back" size={14} />
                {t('projects.backTo', { name: project.name })}
              </button>
            </div>
          )}

          {queuedNote !== null && (
            <div className="notice" role="status">
              <Icon name="check" />
              <span>{queuedNote}</span>
              <button type="button" className="btn btn--ghost btn--small" onClick={onOpenImports}>
                {t('assets.viewImports')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={t('assets.dismissNotice')}
                onClick={() => {
                  setQueuedNote(null);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}

          {scope === 'trash' ? (
            <TrashView
              client={client}
              listing={listing}
              failed={failed}
              home={home}
              mounts={mounts}
              userHome={userHome}
              onReload={load}
              onPurge={(asset) => {
                setDialog({ kind: 'purge', asset });
              }}
              onEmpty={() => {
                setDialog({ kind: 'empty', count: listing?.total ?? 0 });
              }}
              onToast={setToast}
            />
          ) : (
            <section
              className="page__body"
              aria-label={t('assets.grid')}
              aria-busy={listing === null && !failed}
            >
              <div className="asset-toolbar">
                <div className="seg" role="group" aria-label={t('assets.kindGroup')}>
                  {KIND_FILTERS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={kind === k}
                      onClick={() => {
                        setKind(k);
                      }}
                    >
                      {k === 'all' ? t('assets.all') : ASSET_KIND[k].label}
                    </button>
                  ))}
                </div>
                <span className="asset-toolbar__hint faint">{t('assets.multiHint')}</span>
              </div>
              {failed ? (
                <div className="state-card" role="alert">
                  <Icon name="offline" size={28} />
                  <span className="state-card__title">{t('assets.loadFailed')}</span>
                  <button type="button" className="btn btn--primary" onClick={load}>
                    {t('common.retry')}
                  </button>
                </div>
              ) : listing === null ? (
                <div className="asset-grid" aria-label={t('assets.loading')}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <div key={i} className="atile atile--skeleton" aria-hidden="true">
                      <span className="skel atile__thumb" />
                      <span className="skel skel--line" style={{ width: '70%' }} />
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                filtering ? (
                  <div className="state-card">
                    <Icon name="search" size={28} />
                    <span className="state-card__title">
                      {scope === 'unreferenced'
                        ? t('assets.emptyUnreferenced')
                        : t('assets.emptyFiltered')}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setKind('all');
                        setQuery('');
                        setAppliedQuery('');
                        setScope('active');
                      }}
                    >
                      {t('assets.clearFilters')}
                    </button>
                  </div>
                ) : (
                  <div className="state-card state-card--dashed">
                    <Icon name="assets" size={32} />
                    <span className="state-card__title">{t('assets.emptyTitle')}</span>
                    <span className="muted">{t('assets.emptyHint')}</span>
                    <div className="state-card__actions">
                      <button type="button" className="btn btn--primary" onClick={pick}>
                        {t('assets.upload')}
                      </button>
                      <button type="button" className="btn" onClick={onOpenSettings}>
                        {t('assets.linkFolder')}
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <>
                  {groupAssets(items, mounts).map((g) => {
                    const offline = g.mount !== null && g.mount.status !== 'active';
                    const headId = `asset-group-${g.key}`;
                    return (
                      <section key={g.key} className="asset-section" aria-labelledby={headId}>
                        <div className="asset-section__head">
                          <Icon name={g.mount === null ? 'library' : 'folder'} />
                          <h2 id={headId} className="asset-section__title">
                            {g.mount === null
                              ? t('assets.managed')
                              : t('assets.groupExternal', { name: g.mount.name })}
                          </h2>
                          <span className="mono faint">
                            {g.mount === null
                              ? home === null
                                ? ''
                                : `${home}/library`
                              : tildePath(g.mount.root_path, userHome)}
                          </span>
                          <span className="asset-section__chip">
                            {g.mount === null ? (
                              <Chip>{t('assets.chipRestorable')}</Chip>
                            ) : offline ? (
                              <Chip tone="bad">{t('assets.chipMissingFolder')}</Chip>
                            ) : (
                              <Chip tone="warn">{t('assets.chipOriginalStays')}</Chip>
                            )}
                          </span>
                        </div>
                        <div className={offline ? 'asset-grid asset-grid--offline' : 'asset-grid'}>
                          {g.items.map((a) => (
                            <AssetTile
                              key={a.id}
                              asset={a}
                              selected={picks.length === 0 && a.id === selectedId}
                              picked={picks.includes(a.id)}
                              multi={picks.length > 0}
                              onOpen={() => {
                                openLightbox(a.id);
                              }}
                              onSelect={(e) => {
                                // The second click of a double-click keeps the selection.
                                if (e.detail >= 2) return;
                                if (e.metaKey || e.ctrlKey || e.shiftKey || picks.length > 0) {
                                  togglePick(a.id);
                                } else {
                                  setSelectedId(a.id === selectedId ? null : a.id);
                                }
                              }}
                              onTogglePick={() => {
                                togglePick(a.id);
                              }}
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })}
                  {listing.total > items.length && (
                    <div className="asset-more">
                      <span className="faint">
                        {t('assets.showing', { shown: items.length, total: listing.total })}
                      </span>
                      {limit.current < 200 && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            limit.current = 200;
                            load();
                          }}
                        >
                          {t('assets.loadMore')}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>

        {scope !== 'trash' && picks.length > 0 && <MultiInspector assets={picked} />}

        {scope !== 'trash' && selected !== null && (
          <AssetInspector
            key={selected.id}
            client={client}
            asset={selected}
            home={home}
            mount={
              selected.mount_id === null || selected.mount_id === undefined
                ? null
                : (mounts.get(selected.mount_id) ?? null)
            }
            userHome={userHome}
            onOpenWork={onOpenWork}
            startAt={selected.id === focusAssetId ? (startAt ?? null) : null}
            onPreview={(el) => {
              openLightbox(selected.id, el);
            }}
            onSaved={(saved) => {
              setListing((l) =>
                l === null
                  ? l
                  : { ...l, items: l.items.map((a) => (a.id === saved.id ? saved : a)) },
              );
            }}
            onDelete={() => {
              deleteOne(selected);
            }}
            onClose={() => {
              setSelectedId(null);
            }}
          />
        )}

        {lightbox !== null &&
          scope !== 'trash' &&
          (() => {
            const at = ordered.findIndex((a) => a.id === lightbox.id);
            if (at < 0) return null;
            return (
              <Lightbox
                items={ordered.map(toLightboxItem)}
                index={at}
                origin={lightbox.origin}
                onIndex={(i) => {
                  const next = ordered[i];
                  if (next === undefined) return;
                  setSelectedId(next.id);
                  setLightbox({ id: next.id, origin: null });
                }}
                onClose={() => {
                  returnFocusTo.current = lightbox.id;
                  setLightbox(null);
                }}
                extra={(item) => (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void window.creatorhub?.reveal({ kind: 'asset', id: item.id });
                    }}
                  >
                    {t('common.revealInFinder')}
                  </button>
                )}
              />
            );
          })()}

        {dialog !== null && (
          <AssetDialogs
            client={client}
            dialog={dialog}
            items={items}
            home={home}
            mounts={mounts}
            userHome={userHome}
            onOpenWork={onOpenWork}
            onClose={() => {
              setDialog(null);
            }}
            onDone={(ids, t) => {
              setDialog(null);
              afterRemoval(ids);
              if (t !== null) setToast(t);
            }}
          />
        )}

        {dragging && (
          <div className="dropzone" aria-hidden="true">
            <Icon name="upload" size={28} />
            <span>{t('assets.dropToUpload')}</span>
          </div>
        )}
      </main>
    </SearchHighlight>
  );
}

/** Where an asset's file lives, as the user knows it. */
function assetLocation(
  asset: AssetRecord,
  home: string | null,
  mounts: ReadonlyMap<string, Mount>,
  userHome: string | null,
): string {
  if (!isExternal(asset)) return home === null ? asset.path : `${home}/${asset.path}`;
  const mount = mounts.get(asset.mount_id ?? '') ?? null;
  return mount === null ? asset.path : `${tildePath(mount.root_path, userHome)}/${asset.path}`;
}

function Thumb({ asset, size }: { asset: AssetRecord; size: number }) {
  const [broken, setBroken] = useState(false);
  const showImage = asset.kind === 'image' && asset.thumbnail_status !== 'failed' && !broken;
  if (showImage) {
    return (
      <img
        className="thumb__img"
        src={thumbnailUrl(asset.id)}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => {
          setBroken(true);
        }}
      />
    );
  }
  return (
    <span className="thumb__icon">
      <Icon name={ASSET_KIND[asset.kind].icon} size={size} />
    </span>
  );
}

/**
 * Viewer preview: the original image, a video or an audio player. Media URLs
 * come only from `assetMediaUrl`, so the way they are authorized can change
 * without touching this component. Formats Chromium cannot decode (e.g. some
 * HEVC .mov files) fall back to an icon with a note instead of a broken player.
 */
function MediaPreview({
  asset,
  startAt,
  onPreview,
}: {
  asset: AssetRecord;
  startAt: number | null;
  onPreview: (from: Element) => void;
}) {
  const [failed, setFailed] = useState(false);
  const onError = () => {
    setFailed(true);
  };
  const playable = asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio';
  if (!playable || failed) {
    return (
      <div className="viewer__preview">
        <Thumb asset={asset} size={36} />
        {failed && (
          <span className="viewer__preview-note" role="status">
            {asset.kind === 'image'
              ? t('assets.previewImageFailed')
              : t('assets.previewFormatFailed')}
          </span>
        )}
      </div>
    );
  }
  const name = assetName(asset);
  return (
    <div className={`viewer__preview viewer__preview--${asset.kind}`}>
      {asset.kind === 'image' ? (
        <img
          className="thumb__img"
          src={assetMediaUrl(asset.id)}
          alt={name}
          role="button"
          tabIndex={0}
          title={t('assets.openLarge')}
          onClick={(e) => {
            onPreview(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onPreview(e.currentTarget);
          }}
          onError={onError}
        />
      ) : asset.kind === 'video' ? (
        <video
          className="viewer__media"
          src={assetMediaUrl(asset.id)}
          controls
          preload="metadata"
          aria-label={name}
          onError={onError}
          onLoadedMetadata={(e) => {
            if (startAt === null) return;
            const video = e.currentTarget;
            video.currentTime = Math.min(startAt, video.duration || startAt);
            void video.play().catch(() => undefined);
          }}
        />
      ) : (
        <audio
          className="viewer__audio"
          src={assetMediaUrl(asset.id)}
          controls
          preload="metadata"
          aria-label={name}
          onError={onError}
        />
      )}
    </div>
  );
}

function toLightboxItem(asset: AssetRecord): LightboxItem {
  const kind =
    asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio'
      ? asset.kind
      : 'other';
  return {
    id: asset.id,
    kind,
    name: displayName(asset),
    width: asset.width,
    height: asset.height,
    thumbSrc:
      asset.kind === 'image' && asset.thumbnail_status !== 'failed' ? thumbnailUrl(asset.id) : null,
    src: kind === 'other' ? null : assetMediaUrl(asset.id),
    info: formatDimensions(asset.width, asset.height),
    icon: ASSET_KIND[asset.kind].icon,
  };
}

function AssetTile({
  asset,
  selected,
  picked,
  multi,
  onSelect,
  onTogglePick,
  onOpen,
}: {
  asset: AssetRecord;
  selected: boolean;
  picked: boolean;
  multi: boolean;
  onSelect: (e: MouseEvent) => void;
  onTogglePick: () => void;
  onOpen: () => void;
}) {
  const name = displayName(asset);
  return (
    <div
      className={`atile-wrap${multi ? ' atile-wrap--multi' : ''}${picked ? ' atile-wrap--picked' : ''}`}
    >
      <button
        type="button"
        className="atile"
        data-asset-id={asset.id}
        aria-pressed={selected}
        aria-label={t('assets.tileLabel', { name, kind: ASSET_KIND[asset.kind].label })}
        onClick={(e) => {
          onSelect(e);
        }}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          // Space opens the large preview (Quick Look); the button's own click is held back.
          if (e.key === ' ' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onOpen();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
      >
        <span className="atile__thumb">
          <Thumb asset={asset} size={28} />
          {asset.duration !== null && (asset.kind === 'video' || asset.kind === 'audio') && (
            <span className="atile__dur">{formatDuration(asset.duration)}</span>
          )}
        </span>
        <span className="atile__name">
          <Highlight text={name} />
        </span>
      </button>
      <input
        type="checkbox"
        className="atile__check"
        aria-label={t('assets.selectAsset', { name })}
        checked={picked}
        onChange={onTogglePick}
      />
    </div>
  );
}

function metadataNote(asset: AssetRecord): string | null {
  if (asset.metadata_status === 'pending') return t('assets.metaPending');
  if (asset.metadata_status === 'unavailable') return t('assets.metaUnavailable');
  if (asset.metadata_status === 'failed') return t('assets.metaFailed');
  return null;
}

function AssetRefs({
  client,
  assetId,
  onOpenWork,
}: {
  client: CreatorHubClient;
  assetId: string;
  onOpenWork: (workId: string) => void;
}) {
  const [refs, setRefs] = useState<AssetWorkItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    client.assets
      .works(assetId)
      .then((res) => {
        setFailed(false);
        setRefs(res.items);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [client, assetId]);
  useEffect(() => {
    setRefs(null);
    load();
  }, [load]);
  // Linking or unlinking arrives as work.assets_changed.
  useRefreshOn(['work'], load, 400);

  return (
    <div className="viewer__refs">
      <span className="faint">{t('assets.refsLabel')}</span>
      {failed ? (
        <span className="muted">{t('assets.refsFailed')}</span>
      ) : refs === null ? (
        <span className="skel skel--line" aria-busy="true" />
      ) : refs.length === 0 ? (
        <span className="muted">{t('assets.refsNone')}</span>
      ) : (
        <ul className="refs">
          {refs.map((r) => (
            <li key={`${r.work_id}:${r.role}`}>
              <button
                type="button"
                className="ref"
                onClick={() => {
                  onOpenWork(r.work_id);
                }}
              >
                <Icon name="library" size={14} />
                <span className="ref__title">{r.title}</span>
                <span className="faint">{ROLE_LABEL[r.role]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SAVE_LABEL: Readonly<Record<SaveStatus, { label: string; tone: ChipTone }>> = {
  saved: {
    get label() {
      return t('format.saveSaved');
    },
    tone: 'ok',
  },
  pending: {
    get label() {
      return t('format.saveDirty');
    },
    tone: 'neutral',
  },
  saving: {
    get label() {
      return t('format.saveSaving');
    },
    tone: 'neutral',
  },
  error: {
    get label() {
      return t('format.saveError');
    },
    tone: 'bad',
  },
  conflict: {
    get label() {
      return t('assets.saveConflict');
    },
    tone: 'warn',
  },
};

function useEditor(editor: AssetEditor): EditorState {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot);
}

/**
 * The inspector of one asset (replaces the read-only viewer): edit 名稱、
 * 標籤、替代文字、備註 with autosave; 檔案資訊 folds away; Finder and delete
 * at the bottom.
 */
function AssetInspector({
  client,
  asset,
  home,
  mount,
  userHome,
  onOpenWork,
  onClose,
  onSaved,
  onDelete,
  startAt,
  onPreview,
}: {
  client: CreatorHubClient;
  asset: AssetRecord;
  startAt: number | null;
  home: string | null;
  mount: Mount | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onClose: () => void;
  onSaved: (asset: AssetRecord) => void;
  onDelete: () => void;
  onPreview: (from: Element) => void;
}) {
  // Created in the effect: StrictMode would dispose an instance made during render (QC-025).
  const [editor, setEditor] = useState<AssetEditor | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const initial = useRef(asset);
  useEffect(() => {
    const e = new AssetEditor(client, initial.current, (saved) => {
      onSavedRef.current(saved);
    });
    setEditor(e);
    return () => {
      // Leaving the asset saves what was typed, then lets go.
      void e.flush().finally(() => {
        e.dispose();
      });
    };
  }, [client]);
  if (editor === null) return null;
  return (
    <InspectorBody
      client={client}
      editor={editor}
      asset={asset}
      home={home}
      mount={mount}
      userHome={userHome}
      onOpenWork={onOpenWork}
      onClose={onClose}
      onDelete={onDelete}
      startAt={startAt}
      onPreview={onPreview}
    />
  );
}

function InspectorBody({
  client,
  editor,
  asset,
  home,
  mount,
  userHome,
  onOpenWork,
  onClose,
  onDelete,
  startAt,
  onPreview,
}: {
  client: CreatorHubClient;
  editor: AssetEditor;
  asset: AssetRecord;
  startAt: number | null;
  home: string | null;
  mount: Mount | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onClose: () => void;
  onDelete: () => void;
  onPreview: (from: Element) => void;
}) {
  const state = useEditor(editor);
  const [copied, setCopied] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName(asset));
  useEffect(() => {
    editor.adopt(asset);
  }, [editor, asset]);

  const current = state.asset;
  const name = displayName(current);
  const dims = formatDimensions(current.width, current.height);
  const note = metadataNote(current);
  const timed = current.kind === 'video' || current.kind === 'audio';
  const save = SAVE_LABEL[state.status];
  const external = isExternal(current);

  return (
    <aside className="viewer inspector" aria-label={t('assets.inspector')}>
      <div className="inspector__scroll">
        <MediaPreview
          key={`${asset.id}:${String(startAt)}`}
          asset={asset}
          startAt={startAt}
          onPreview={onPreview}
        />
        <div className="inspector__name">
          <label className="visually-hidden" htmlFor="asset-name">
            {t('assets.name')}
          </label>
          <input
            id="asset-name"
            className="inline-input"
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              const v = e.target.value.trim();
              // An empty name goes back to the original file name.
              editor.change('display_name', v === '' || v === assetName(current) ? null : v);
            }}
            onBlur={() => {
              void editor.flush();
              if (nameDraft.trim() === '') setNameDraft(assetName(current));
            }}
          />
          {fileExt(current) !== '' && <Chip>{fileExt(current)}</Chip>}
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label={t('assets.closeInspector')}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="viewer__chips">
          <Chip>{ASSET_KIND[current.kind].label}</Chip>
          {external ? (
            <Chip tone="warn">{t('format.sourceExternal')}</Chip>
          ) : (
            <Chip>{t('assets.managed')}</Chip>
          )}
          <span className="inspector__save" role="status">
            <Chip tone={save.tone}>{save.label}</Chip>
          </span>
        </div>
        {state.error !== null && (
          <p className="ln__err" role="alert">
            {state.error}
          </p>
        )}
        {state.conflict !== null && (
          <div className="inspector__conflict" role="alert">
            <span>
              {t('assets.conflictFields', {
                fields: state.conflict.fields
                  .map((f) => FIELD_LABEL[f])
                  .join(t('common.listSeparator')),
              })}
            </span>
            <div className="inspector__conflict-actions">
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  void editor.resolve('theirs');
                  setNameDraft(displayName(state.conflict?.theirs ?? current));
                }}
              >
                {t('assets.useTheirs')}
              </button>
              <button
                type="button"
                className="btn btn--small btn--primary"
                onClick={() => {
                  void editor.resolve('mine');
                }}
              >
                {t('assets.useMine')}
              </button>
            </div>
          </div>
        )}
        {note !== null && (
          <p className="viewer__note" role="status">
            {note}
          </p>
        )}
        <div className="field-block">
          <span className="field-block__label">{t('assets.tags')}</span>
          <TagEditor
            tags={editor.value('tags') ?? []}
            disabled={state.status === 'conflict'}
            onChange={(tags) => {
              editor.change('tags', tags);
              void editor.flush();
            }}
          />
        </div>
        <div className="field-block">
          <label className="field-block__label" htmlFor="asset-alt">
            {t('assets.altText')}
          </label>
          <input
            id="asset-alt"
            className="input"
            placeholder={t('assets.altPlaceholder')}
            value={editor.value('alt_text') ?? ''}
            onChange={(e) => {
              editor.change('alt_text', e.target.value === '' ? null : e.target.value);
            }}
            onBlur={() => {
              void editor.flush();
            }}
          />
        </div>
        <div className="field-block">
          <label className="field-block__label" htmlFor="asset-note">
            {t('assets.note')}
          </label>
          <textarea
            id="asset-note"
            className="input inspector__note"
            placeholder={t('assets.notePlaceholder')}
            value={editor.value('note') ?? ''}
            onChange={(e) => {
              editor.change('note', e.target.value === '' ? null : e.target.value);
            }}
            onBlur={() => {
              void editor.flush();
            }}
          />
        </div>
        <AssetRefs client={client} assetId={asset.id} onOpenWork={onOpenWork} />
        <details className="inspector__details">
          <summary>{t('assets.fileInfo')}</summary>
          <dl className="kv">
            <dt>{t('assets.fileName')}</dt>
            <dd className="mono">{assetName(current)}</dd>
            <dt>{t('assets.dimensions')}</dt>
            <dd>{dims ?? '—'}</dd>
            {timed && (
              <>
                <dt>{t('assets.duration')}</dt>
                <dd>{current.duration === null ? '—' : formatDuration(current.duration)}</dd>
              </>
            )}
            <dt>{t('assets.codec')}</dt>
            <dd>{current.codec ?? current.mime_type}</dd>
            <dt>{t('assets.size')}</dt>
            <dd>{formatBytes(current.bytes)}</dd>
            <dt>SHA-256</dt>
            <dd className="mono kv__hash">
              <span title={current.sha256}>{shortHash(current.sha256)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--tiny"
                aria-label={t('assets.copyHash')}
                onClick={() => {
                  void window.creatorhub?.copyText(current.sha256).then(() => {
                    setCopied(true);
                  });
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} />
              </button>
              {copied && (
                <span className="visually-hidden" role="status">
                  {t('common.copied')}
                </span>
              )}
            </dd>
            <dt>{t('assets.location')}</dt>
            <dd className="mono">
              {external
                ? mount === null
                  ? current.path
                  : `${tildePath(mount.root_path, userHome)}/${current.path}`
                : home === null
                  ? current.path
                  : `${home}/${current.path}`}
            </dd>
            <dt>{t('assets.origin')}</dt>
            <dd>{ORIGIN_LABEL[current.origin]}</dd>
            <dt>{t('assets.added')}</dt>
            <dd>{formatDateTime(new Date(current.created_at))}</dd>
          </dl>
        </details>
        <span className="visually-hidden">{name}</span>
      </div>
      <div className="inspector__foot">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            void window.creatorhub?.reveal({ kind: 'asset', id: current.id }).then((ok) => {
              setRevealFailed(!ok);
            });
          }}
        >
          <Icon name="folder" size={14} />
          {t('common.revealInFinder')}
        </button>
        {revealFailed && (
          <span className="viewer__error" role="alert">
            {t('assets.revealFailed')}
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--danger btn--small inspector__delete"
          aria-keyshortcuts="Meta+Backspace"
          onClick={() => {
            void editor.flush().then(onDelete);
          }}
        >
          {external ? t('assets.removeFromLibrary') : t('assets.moveToTrash')}
        </button>
      </div>
    </aside>
  );
}

function MultiInspector({ assets }: { assets: readonly AssetRecord[] }) {
  const bytes = assets.reduce((n, a) => n + a.bytes, 0);
  const external = assets.filter(isExternal).length;
  return (
    <aside className="viewer inspector" aria-label={t('assets.inspector')}>
      <div className="inspector__scroll">
        <div className="inspector__picks">
          {assets.slice(0, 6).map((a) => (
            <span key={a.id} className="inspector__pick">
              <Thumb asset={a} size={20} />
            </span>
          ))}
        </div>
        <h2 className="inspector__title">{t('assets.pickedAssets', { count: assets.length })}</h2>
        <dl className="kv">
          <dt>{t('assets.size')}</dt>
          <dd>{formatBytes(bytes)}</dd>
          <dt>{t('format.sourceExternal')}</dt>
          <dd>{external === 0 ? t('assets.none') : t('assets.countItems', { count: external })}</dd>
        </dl>
        <p className="faint">{t('assets.multiHintFields')}</p>
      </div>
    </aside>
  );
}

function TrashView({
  client,
  listing,
  failed,
  home,
  mounts,
  userHome,
  onReload,
  onPurge,
  onEmpty,
  onToast,
}: {
  client: CreatorHubClient;
  listing: Listing | null;
  failed: boolean;
  home: string | null;
  mounts: ReadonlyMap<string, Mount>;
  userHome: string | null;
  onReload: () => void;
  onPurge: (asset: AssetRecord) => void;
  onEmpty: () => void;
  onToast: (t: Toast) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const items = listing?.items ?? [];
  return (
    <section
      className="page__body trash"
      aria-label={t('assets.scopeTrash')}
      aria-busy={listing === null && !failed}
    >
      <div className="trash__head">
        <Icon name="history" size={16} />
        <span className="muted">{t('assets.trashHint')}</span>
        <button
          type="button"
          className="btn btn--ghost btn--danger btn--small trash__empty"
          disabled={items.length === 0}
          onClick={onEmpty}
        >
          {t('assets.emptyTrash')}
        </button>
      </div>
      {failed ? (
        <div className="state-card" role="alert">
          <Icon name="offline" size={28} />
          <span className="state-card__title">{t('assets.trashLoadFailed')}</span>
          <button type="button" className="btn btn--primary" onClick={onReload}>
            {t('common.retry')}
          </button>
        </div>
      ) : listing === null ? (
        <div className="card" aria-busy="true">
          <div className="ln">
            <span className="skel skel--line" style={{ width: '60%' }} />
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="state-card">
          <Icon name="trash" size={28} />
          <span className="state-card__title">{t('assets.trashEmpty')}</span>
        </div>
      ) : (
        <ul className="card trash__list" aria-label={t('assets.trashList')}>
          {items.map((a) => {
            const left = daysLeft(a.purge_at);
            return (
              <li key={a.id} className="trash__row">
                <span className="trash__thumb">
                  <Thumb asset={a} size={20} />
                </span>
                <div className="trash__main">
                  <span className="trash__name">{displayName(a)}</span>
                  <span className="mono faint trash__from">
                    {assetLocation(a, home, mounts, userHome)}
                  </span>
                  {rowError?.id === a.id && (
                    <span className="ln__err" role="alert">
                      {rowError.message}
                    </span>
                  )}
                </div>
                <span className="faint trash__when">
                  {a.deleted_at == null
                    ? ''
                    : t('assets.deletedWhen', { when: formatStamp(a.deleted_at) })}
                </span>
                {a.removal === 'trashed' && left !== null ? (
                  <Chip tone={left <= 7 ? 'warn' : 'neutral'}>
                    {t('assets.daysLeft', { count: left })}
                  </Chip>
                ) : (
                  <Chip tone="warn">
                    {a.removal === 'original_trashed'
                      ? t('assets.originalInTrash')
                      : t('assets.removedChip')}
                  </Chip>
                )}
                <div className="trash__actions">
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy === a.id}
                    onClick={() => {
                      setBusy(a.id);
                      setRowError(null);
                      client.assets
                        .restore(a.id)
                        .then(() => {
                          setBusy(null);
                          onToast({ message: t('assets.restored'), undo: null });
                          onReload();
                        })
                        .catch((err: unknown) => {
                          setBusy(null);
                          setRowError({ id: a.id, message: assetErrorText(err) });
                        });
                    }}
                  >
                    <Icon name="undo" size={14} />
                    {t('common.restore')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger btn--small"
                    onClick={() => {
                      onPurge(a);
                    }}
                  >
                    {t('assets.purge')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function WorkList({
  refs,
  onOpenWork,
}: {
  refs: readonly { work_id: string; title: string }[];
  onOpenWork: (workId: string) => void;
}) {
  return (
    <ul className="refs">
      {refs.map((r) => (
        <li key={r.work_id}>
          <button
            type="button"
            className="ref"
            onClick={() => {
              onOpenWork(r.work_id);
            }}
          >
            <Icon name="library" size={14} />
            <span className="ref__title">{r.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The confirmations of the approved board, each with a specific verb and 取消 focused first. */
function AssetDialogs({
  client,
  dialog,
  items,
  home,
  mounts,
  userHome,
  onOpenWork,
  onClose,
  onDone,
}: {
  client: CreatorHubClient;
  dialog: DeleteDialog;
  items: readonly AssetRecord[];
  home: string | null;
  mounts: ReadonlyMap<string, Mount>;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onClose: () => void;
  onDone: (removedIds: string[], toast: Toast | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveOriginal, setMoveOriginal] = useState(false);
  const [tagText, setTagText] = useState('');
  const [batchRefs, setBatchRefs] = useState<{ count: number; impact: DeleteImpact } | null>(null);

  const run = (p: Promise<unknown>, then: () => void) => {
    setBusy(true);
    setError(null);
    p.then(() => {
      setBusy(false);
      then();
    }).catch((err: unknown) => {
      setBusy(false);
      setError(assetErrorText(err));
    });
  };

  const cancel = (
    <button
      type="button"
      className="btn btn--ghost dialog__primary"
      data-autofocus
      onClick={onClose}
    >
      {t('common.cancel')}
    </button>
  );
  const errorLine =
    error === null ? null : (
      <p className="ln__err" role="alert">
        {error}
      </p>
    );

  if (dialog.kind === 'referenced') {
    const works = referencingTitles(dialog.refs);
    const impact = deleteImpact([dialog.refs]);
    return (
      <Dialog
        title={t('assets.confirmTrashTitle')}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button
              type="button"
              className="btn btn--danger-solid"
              disabled={busy}
              onClick={() => {
                run(client.assets.trash(dialog.asset.id, { confirm: true }), () => {
                  onDone([dialog.asset.id], {
                    message: deletedToast(impact),
                    undo: [dialog.asset.id],
                  });
                });
              }}
            >
              {t('assets.moveToTrash')}
            </button>
          </>
        }
      >
        <div className="form">
          <p>
            {t('assets.referencedBy', {
              name: displayName(dialog.asset),
              count: works.length,
              impact: deleteImpactText(impact),
            })}
          </p>
          {impact.breaking.length > 0 && impact.safe.length > 0 ? (
            <>
              <span className="dialog__group dialog__group--bad">{t('assets.groupBreaking')}</span>
              <WorkList refs={impact.breaking} onOpenWork={onOpenWork} />
              <span className="dialog__group">{t('assets.groupSafe')}</span>
              <WorkList refs={impact.safe} onOpenWork={onOpenWork} />
            </>
          ) : (
            <WorkList refs={works} onOpenWork={onOpenWork} />
          )}
          {errorLine}
        </div>
      </Dialog>
    );
  }

  if (dialog.kind === 'external') {
    return (
      <Dialog
        title={t('assets.externalTitle')}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button
              type="button"
              className={moveOriginal ? 'btn btn--danger-solid' : 'btn btn--primary'}
              disabled={busy}
              onClick={() => {
                run(
                  client.assets.trash(dialog.asset.id, {
                    confirm: true,
                    move_original_to_trash: moveOriginal,
                  }),
                  () => {
                    onDone([dialog.asset.id], {
                      message: moveOriginal
                        ? t('assets.externalTrashed')
                        : t('assets.externalKept'),
                      undo: null,
                    });
                  },
                );
              }}
            >
              {moveOriginal ? t('assets.moveToSystemTrash') : t('assets.removeOnly')}
            </button>
          </>
        }
      >
        <div className="form">
          <p className="mono faint dialog__path">
            {assetLocation(dialog.asset, home, mounts, userHome)}
          </p>
          <fieldset className="optcards">
            <legend className="visually-hidden">{t('assets.originalLegend')}</legend>
            <label className="optcard">
              <input
                type="radio"
                name="ext-original"
                checked={!moveOriginal}
                onChange={() => {
                  setMoveOriginal(false);
                }}
              />
              <span>
                <span className="optcard__title">{t('assets.optRemoveOnlyTitle')}</span>
                <span className="faint">{t('assets.optRemoveOnlyHint')}</span>
              </span>
            </label>
            <label className="optcard">
              <input
                type="radio"
                name="ext-original"
                checked={moveOriginal}
                onChange={() => {
                  setMoveOriginal(true);
                }}
              />
              <span>
                <span className="optcard__title">{t('assets.optTrashTitle')}</span>
                <span className="faint">{t('assets.optTrashHint')}</span>
              </span>
            </label>
          </fieldset>
          {errorLine}
        </div>
      </Dialog>
    );
  }

  if (dialog.kind === 'batch') {
    const chosen = items.filter((a) => dialog.ids.includes(a.id));
    const external = chosen.filter(isExternal).length;
    const managed = chosen.length - external;
    return (
      <Dialog
        title={t('assets.batchTitle', { count: dialog.ids.length })}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button
              type="button"
              className="btn btn--danger-solid"
              disabled={busy}
              onClick={() => {
                // First without confirm: the answer says how many are referenced.
                setBusy(true);
                setError(null);
                const go = (confirm: boolean) =>
                  client.assets.batch({ action: 'trash', ids: dialog.ids, confirm });
                go(batchRefs !== null)
                  .then(() => {
                    setBusy(false);
                    onDone(dialog.ids, {
                      message:
                        batchRefs === null
                          ? t('assets.batchRemoved', { count: dialog.ids.length })
                          : batchRefs.impact.breaking.length === 0
                            ? t('assets.batchRemovedSafe', { count: dialog.ids.length })
                            : t('assets.batchRemovedBreaking', { count: dialog.ids.length }),
                      undo: chosen.filter((a) => !isExternal(a)).map((a) => a.id),
                    });
                  })
                  .catch((err: unknown) => {
                    setBusy(false);
                    if (err instanceof ApiError && err.code === 'asset_in_use') {
                      const refs = batchInUseReferences(err);
                      setBatchRefs({ count: Math.max(refs.length, 1), impact: deleteImpact(refs) });
                    } else {
                      setError(assetErrorText(err));
                    }
                  });
              }}
            >
              {batchRefs === null ? t('common.remove') : t('assets.stillRemove')}
            </button>
          </>
        }
      >
        <div className="form">
          <dl className="kv">
            <dt>{t('assets.moveToTrash')}</dt>
            <dd>{t('assets.countItems', { count: managed })}</dd>
            <dt>{t('format.sourceExternal')}</dt>
            <dd>
              {external === 0
                ? t('assets.none')
                : t('assets.batchExternalNote', { count: external })}
            </dd>
          </dl>
          {batchRefs !== null && (
            <p className="dialog__warn" role="alert">
              {t('assets.batchRefWarn', {
                count: batchRefs.count,
                impact: deleteImpactText(batchRefs.impact),
              })}
            </p>
          )}
          {errorLine}
        </div>
      </Dialog>
    );
  }

  if (dialog.kind === 'tags') {
    const tags = tagText
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter((t) => t !== '');
    return (
      <Dialog
        title={t('assets.tagsTitle', { count: dialog.ids.length })}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || tags.length === 0}
              onClick={() => {
                run(client.assets.batch({ action: 'add_tags', ids: dialog.ids, tags }), () => {
                  onDone([], {
                    message: t('assets.tagsAdded', { count: dialog.ids.length }),
                    undo: null,
                  });
                });
              }}
            >
              {t('assets.tagsApply')}
            </button>
          </>
        }
      >
        <div className="form">
          <label className="field-block">
            <span className="field-block__label">{t('assets.tagsField')}</span>
            <input
              className="input"
              value={tagText}
              onChange={(e) => {
                setTagText(e.target.value);
              }}
            />
          </label>
          {errorLine}
        </div>
      </Dialog>
    );
  }

  if (dialog.kind === 'purge') {
    return (
      <Dialog
        title={t('assets.purgeTitle')}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button
              type="button"
              className="btn btn--danger-solid"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                client.trash
                  .purge(dialog.asset.id)
                  .then((res) => {
                    setBusy(false);
                    const broken = brokenLinkTitles([res]);
                    onDone([dialog.asset.id], {
                      message:
                        broken.length === 0
                          ? t('assets.purged')
                          : t('assets.purgedBroken', {
                              works: broken.join(t('common.listSeparator')),
                            }),
                      undo: null,
                      tone: broken.length === 0 ? 'ok' : 'bad',
                    });
                  })
                  .catch((err: unknown) => {
                    setBusy(false);
                    setError(assetErrorText(err));
                  });
              }}
            >
              {t('assets.purge')}
            </button>
          </>
        }
      >
        <div className="form">
          <p>{t('assets.purgeBody', { name: displayName(dialog.asset) })}</p>
          {errorLine}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('assets.emptyTrashTitle', { count: dialog.count })}
      onClose={onClose}
      footer={
        <>
          {cancel}
          <button
            type="button"
            className="btn btn--danger-solid"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              client.trash
                .empty()
                .then((res) => {
                  setBusy(false);
                  const broken = brokenLinkTitles(res.purged);
                  onDone(
                    res.purged.map((p) => p.id),
                    {
                      message:
                        broken.length === 0
                          ? t('assets.emptied', { count: res.purged.length })
                          : t('assets.emptiedBroken', {
                              works: broken.join(t('common.listSeparator')),
                            }),
                      undo: null,
                      tone: broken.length === 0 ? 'ok' : 'bad',
                    },
                  );
                })
                .catch((err: unknown) => {
                  setBusy(false);
                  setError(assetErrorText(err));
                });
            }}
          >
            {t('assets.purge')}
          </button>
        </>
      }
    >
      <div className="form">
        <p>{t('assets.emptyTrashBody')}</p>
        {errorLine}
      </div>
    </Dialog>
  );
}
