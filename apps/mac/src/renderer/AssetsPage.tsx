import { ApiError, type CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AssetKind,
  AssetOrigin,
  AssetRecord,
  AssetReferences,
  AssetWorkItem,
  Mount,
  WorkAssetRole,
} from '@qiu-creator/contracts';
import {
  useCallback,
  useEffect,
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
import { Icon } from './Icon.js';

type KindFilter = 'all' | AssetKind;
const KIND_FILTERS: readonly KindFilter[] = ['all', 'image', 'video', 'audio', 'markdown', 'other'];
const PAGE_SIZE = 100;

const ORIGIN_LABEL: Readonly<Record<AssetOrigin, string>> = {
  upload: '上傳',
  url: 'URL 匯入',
  folder: '資料夾匯入',
  api: 'Agent API',
  manual: '手動',
};

const ROLE_LABEL: Readonly<Record<WorkAssetRole, string>> = {
  cover: '封面',
  body: '正文',
  video: '影片',
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

const dateTime = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface Listing {
  items: AssetRecord[];
  total: number;
}

type Scope = 'active' | 'unreferenced' | 'trash';
const SCOPES: readonly { key: Scope; label: string }[] = [
  { key: 'active', label: '全部' },
  { key: 'unreferenced', label: '未引用' },
  { key: 'trash', label: '最近刪除' },
];

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
 * 全部／未引用／最近刪除, ⌘-click multi-select with batch tags and delete,
 * an inspector that edits name, tags, alt text and note with autosave, and
 * delete rules by case: unreferenced managed assets go to 最近刪除 at once
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
}: {
  client: CreatorHubClient;
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
  }, [client, kind, appliedQuery, scope]);

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

  const queued = (count: number) => {
    if (count > 0) setQueuedNote(`已加入 ${count} 個上傳`);
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

  /** 移到最近刪除 / 移出素材庫 for one asset, following the delete rules. */
  const deleteOne = (asset: AssetRecord) => {
    if (isExternal(asset)) {
      setDialog({ kind: 'external', asset });
      return;
    }
    client.assets
      .trash(asset.id)
      .then(() => {
        afterRemoval([asset.id]);
        setToast({ message: '已移到最近刪除', undo: [asset.id] });
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

  return (
    <main
      className="page page--split"
      aria-label="素材庫"
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
          <h1 className="page__title">素材庫</h1>
          <span className="page__count">{listing === null ? '' : listing.total}</span>
          {picks.length > 0 ? (
            <div className="batchbar" role="toolbar" aria-label="批次操作">
              <span className="batchbar__count">已選 {picks.length}</span>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setDialog({ kind: 'tags', ids: [...picks] });
                }}
              >
                <Icon name="tag" size={14} />
                加標籤
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setDialog({ kind: 'batch', ids: [...picks] });
                }}
              >
                <Icon name="trash" size={14} />
                移到最近刪除
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setPicks([]);
                }}
              >
                取消<kbd>esc</kbd>
              </button>
            </div>
          ) : (
            <>
              <label className="search">
                <Icon name="search" />
                <span className="visually-hidden">搜尋素材</span>
                <input
                  type="search"
                  placeholder="搜尋名稱"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (!(e.nativeEvent as InputEvent).isComposing) setAppliedQuery(e.target.value);
                  }}
                  onCompositionEnd={(e) => {
                    setAppliedQuery(e.currentTarget.value);
                  }}
                />
              </label>
              <div className="seg" role="group" aria-label="範圍">
                {SCOPES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={scope === s.key}
                    onClick={() => {
                      setScope(s.key);
                      setPicks([]);
                      setSelectedId(null);
                    }}
                  >
                    {s.label}
                    {s.key === 'trash' && trashTotal > 0 && (
                      <span className="seg__n">{trashTotal}</span>
                    )}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn--primary" onClick={pick}>
                <Icon name="upload" />
                上傳
              </button>
            </>
          )}
        </header>

        {queuedNote !== null && (
          <div className="notice" role="status">
            <Icon name="check" />
            <span>{queuedNote}</span>
            <button type="button" className="btn btn--ghost btn--small" onClick={onOpenImports}>
              查看匯入任務
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--small"
              aria-label="關閉提示"
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
          <section className="page__body" aria-label="素材" aria-busy={listing === null && !failed}>
            <div className="asset-toolbar">
              <div className="seg" role="group" aria-label="類型">
                {KIND_FILTERS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => {
                      setKind(k);
                    }}
                  >
                    {k === 'all' ? '全部' : ASSET_KIND[k].label}
                  </button>
                ))}
              </div>
              <span className="asset-toolbar__hint faint">⌘ 點選多選 · ⌘⌫ 刪除</span>
            </div>
            {failed ? (
              <div className="state-card" role="alert">
                <Icon name="offline" size={28} />
                <span className="state-card__title">無法載入素材</span>
                <button type="button" className="btn btn--primary" onClick={load}>
                  重試
                </button>
              </div>
            ) : listing === null ? (
              <div className="asset-grid" aria-label="載入中">
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
                    {scope === 'unreferenced' ? '沒有未引用的素材' : '沒有符合的素材'}
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
                    清除篩選
                  </button>
                </div>
              ) : (
                <div className="state-card state-card--dashed">
                  <Icon name="assets" size={32} />
                  <span className="state-card__title">還沒有素材</span>
                  <span className="muted">把檔案拖進這裡，或從下方上傳</span>
                  <div className="state-card__actions">
                    <button type="button" className="btn btn--primary" onClick={pick}>
                      上傳
                    </button>
                    <button type="button" className="btn" onClick={onOpenSettings}>
                      掛載資料夾
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
                          {g.mount === null ? '托管' : `外部掛載 · ${g.mount.name}`}
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
                            <Chip>刪除後可恢復</Chip>
                          ) : offline ? (
                            <Chip tone="bad">找不到資料夾</Chip>
                          ) : (
                            <Chip tone="warn">原檔不移動</Chip>
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
                            onSelect={(e) => {
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
                      顯示 {items.length} / {listing.total}
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
                        載入更多
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
          onSaved={(saved) => {
            setListing((l) =>
              l === null ? l : { ...l, items: l.items.map((a) => (a.id === saved.id ? saved : a)) },
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

      {toast !== null && (
        <div className={toast.tone === 'bad' ? 'toast toast--bad' : 'toast'} role="status">
          <Icon name={toast.tone === 'bad' ? 'alert' : 'check'} size={16} />
          <span className="toast__msg">{toast.message}</span>
          {toast.undo !== null && (
            <button
              type="button"
              className="btn btn--ghost btn--small toast__undo"
              aria-keyshortcuts="Meta+Z"
              onClick={() => {
                if (toast.undo !== null) undo(toast.undo);
              }}
            >
              復原
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--small"
            aria-label="關閉提示"
            onClick={() => {
              setToast(null);
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {dragging && (
        <div className="dropzone" aria-hidden="true">
          <Icon name="upload" size={28} />
          <span>放開即上傳</span>
        </div>
      )}
    </main>
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
function MediaPreview({ asset, startAt }: { asset: AssetRecord; startAt: number | null }) {
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
            {asset.kind === 'image' ? '無法顯示原圖' : '這個格式無法在 App 內播放'}
          </span>
        )}
      </div>
    );
  }
  const name = assetName(asset);
  return (
    <div className={`viewer__preview viewer__preview--${asset.kind}`}>
      {asset.kind === 'image' ? (
        <img className="thumb__img" src={assetMediaUrl(asset.id)} alt={name} onError={onError} />
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

function AssetTile({
  asset,
  selected,
  picked,
  multi,
  onSelect,
  onTogglePick,
}: {
  asset: AssetRecord;
  selected: boolean;
  picked: boolean;
  multi: boolean;
  onSelect: (e: MouseEvent) => void;
  onTogglePick: () => void;
}) {
  const name = displayName(asset);
  return (
    <div
      className={`atile-wrap${multi ? ' atile-wrap--multi' : ''}${picked ? ' atile-wrap--picked' : ''}`}
    >
      <button
        type="button"
        className="atile"
        aria-pressed={selected}
        aria-label={`${name}，${ASSET_KIND[asset.kind].label}`}
        onClick={(e) => {
          onSelect(e);
        }}
      >
        <span className="atile__thumb">
          <Thumb asset={asset} size={28} />
          {asset.duration !== null && (asset.kind === 'video' || asset.kind === 'audio') && (
            <span className="atile__dur">{formatDuration(asset.duration)}</span>
          )}
        </span>
        <span className="atile__name">{name}</span>
      </button>
      <input
        type="checkbox"
        className="atile__check"
        aria-label={`選取 ${name}`}
        checked={picked}
        onChange={onTogglePick}
      />
    </div>
  );
}

function metadataNote(asset: AssetRecord): string | null {
  if (asset.metadata_status === 'pending') return '正在讀取媒體資訊…';
  if (asset.metadata_status === 'unavailable')
    return '這台 Mac 沒有可用的媒體分析工具，部分資訊無法讀取。';
  if (asset.metadata_status === 'failed') return '讀取媒體資訊失敗。';
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
      <span className="faint">引用</span>
      {failed ? (
        <span className="muted">無法載入引用</span>
      ) : refs === null ? (
        <span className="skel skel--line" aria-busy="true" />
      ) : refs.length === 0 ? (
        <span className="muted">未引用</span>
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
  saved: { label: '已儲存', tone: 'ok' },
  pending: { label: '未儲存', tone: 'neutral' },
  saving: { label: '儲存中', tone: 'neutral' },
  error: { label: '儲存失敗', tone: 'bad' },
  conflict: { label: '有衝突', tone: 'warn' },
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
    <aside className="viewer inspector" aria-label="素材資訊">
      <div className="inspector__scroll">
        <MediaPreview key={`${asset.id}:${String(startAt)}`} asset={asset} startAt={startAt} />
        <div className="inspector__name">
          <label className="visually-hidden" htmlFor="asset-name">
            名稱
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
            aria-label="關閉素材資訊"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="viewer__chips">
          <Chip>{ASSET_KIND[current.kind].label}</Chip>
          {external ? <Chip tone="warn">外部掛載</Chip> : <Chip>托管</Chip>}
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
              {state.conflict.fields.map((f) => FIELD_LABEL[f]).join('、')}
              已在別處被修改。要保留哪一份？
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
                用最新的
              </button>
              <button
                type="button"
                className="btn btn--small btn--primary"
                onClick={() => {
                  void editor.resolve('mine');
                }}
              >
                用我的
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
          <span className="field-block__label">標籤</span>
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
            替代文字
          </label>
          <input
            id="asset-alt"
            className="input"
            placeholder="插入文章時的圖片說明"
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
            備註
          </label>
          <textarea
            id="asset-note"
            className="input inspector__note"
            placeholder="只給自己看"
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
          <summary>檔案資訊</summary>
          <dl className="kv">
            <dt>檔名</dt>
            <dd className="mono">{assetName(current)}</dd>
            <dt>尺寸</dt>
            <dd>{dims ?? '—'}</dd>
            {timed && (
              <>
                <dt>時長</dt>
                <dd>{current.duration === null ? '—' : formatDuration(current.duration)}</dd>
              </>
            )}
            <dt>編碼</dt>
            <dd>{current.codec ?? current.mime_type}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(current.bytes)}</dd>
            <dt>SHA-256</dt>
            <dd className="mono kv__hash">
              <span title={current.sha256}>{shortHash(current.sha256)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--tiny"
                aria-label="複製雜湊"
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
                  已複製
                </span>
              )}
            </dd>
            <dt>位置</dt>
            <dd className="mono">
              {external
                ? mount === null
                  ? current.path
                  : `${tildePath(mount.root_path, userHome)}/${current.path}`
                : home === null
                  ? current.path
                  : `${home}/${current.path}`}
            </dd>
            <dt>來源</dt>
            <dd>{ORIGIN_LABEL[current.origin]}</dd>
            <dt>加入</dt>
            <dd>{dateTime.format(new Date(current.created_at))}</dd>
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
          <Icon name="folder" size={14} />在 Finder 顯示
        </button>
        {revealFailed && (
          <span className="viewer__error" role="alert">
            找不到檔案
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
          {external ? '移出素材庫…' : '移到最近刪除'}
        </button>
      </div>
    </aside>
  );
}

function MultiInspector({ assets }: { assets: readonly AssetRecord[] }) {
  const bytes = assets.reduce((n, a) => n + a.bytes, 0);
  const external = assets.filter(isExternal).length;
  return (
    <aside className="viewer inspector" aria-label="素材資訊">
      <div className="inspector__scroll">
        <div className="inspector__picks">
          {assets.slice(0, 6).map((a) => (
            <span key={a.id} className="inspector__pick">
              <Thumb asset={a} size={20} />
            </span>
          ))}
        </div>
        <h2 className="inspector__title">已選 {assets.length} 個素材</h2>
        <dl className="kv">
          <dt>大小</dt>
          <dd>{formatBytes(bytes)}</dd>
          <dt>外部掛載</dt>
          <dd>{external === 0 ? '無' : `${String(external)} 個`}</dd>
        </dl>
        <p className="faint">批次：加標籤、移到最近刪除。名稱、替代文字與備註請逐一編輯。</p>
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
      aria-label="最近刪除"
      aria-busy={listing === null && !failed}
    >
      <div className="trash__head">
        <Icon name="history" size={16} />
        <span className="muted">30 天後自動永久刪除；恢復時回到原位置，作品引用一併復原。</span>
        <button
          type="button"
          className="btn btn--ghost btn--danger btn--small trash__empty"
          disabled={items.length === 0}
          onClick={onEmpty}
        >
          清空
        </button>
      </div>
      {failed ? (
        <div className="state-card" role="alert">
          <Icon name="offline" size={28} />
          <span className="state-card__title">無法載入最近刪除</span>
          <button type="button" className="btn btn--primary" onClick={onReload}>
            重試
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
          <span className="state-card__title">最近刪除是空的</span>
        </div>
      ) : (
        <ul className="card trash__list" aria-label="已刪除的素材">
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
                  {a.deleted_at == null ? '' : `${formatStamp(a.deleted_at)} 刪除`}
                </span>
                {a.removal === 'trashed' && left !== null ? (
                  <Chip tone={left <= 7 ? 'warn' : 'neutral'}>{`${String(left)} 天`}</Chip>
                ) : (
                  <Chip tone="warn">
                    {a.removal === 'original_trashed' ? '原檔在垃圾桶' : '已移出'}
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
                          onToast({ message: '已恢復到原位置', undo: null });
                          onReload();
                        })
                        .catch((err: unknown) => {
                          setBusy(null);
                          setRowError({ id: a.id, message: assetErrorText(err) });
                        });
                    }}
                  >
                    <Icon name="undo" size={14} />
                    恢復
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger btn--small"
                    onClick={() => {
                      onPurge(a);
                    }}
                  >
                    永久刪除
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
      取消
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
        title="移到最近刪除？"
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
              移到最近刪除
            </button>
          </>
        }
      >
        <div className="form">
          <p>
            「{displayName(dialog.asset)}」被 {works.length} 件作品引用。{deleteImpactText(impact)}
          </p>
          {impact.breaking.length > 0 && impact.safe.length > 0 ? (
            <>
              <span className="dialog__group dialog__group--bad">會顯示為缺圖</span>
              <WorkList refs={impact.breaking} onOpenWork={onOpenWork} />
              <span className="dialog__group">圖片是獨立複本，不受影響</span>
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
        title="移出素材庫？"
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
                      message: moveOriginal ? '原檔已移到系統垃圾桶' : '已移出素材庫，原檔未動',
                      undo: null,
                    });
                  },
                );
              }}
            >
              {moveOriginal ? '移到垃圾桶' : '移出'}
            </button>
          </>
        }
      >
        <div className="form">
          <p className="mono faint dialog__path">
            {assetLocation(dialog.asset, home, mounts, userHome)}
          </p>
          <fieldset className="optcards">
            <legend className="visually-hidden">原檔處理</legend>
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
                <span className="optcard__title">只從素材庫移除</span>
                <span className="faint">原檔留在外部資料夾</span>
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
                <span className="optcard__title">原檔也移到系統垃圾桶</span>
                <span className="faint">可從 Finder 垃圾桶還原</span>
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
        title={`移除 ${String(dialog.ids.length)} 個素材？`}
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
                          ? `已移除 ${String(dialog.ids.length)} 個素材`
                          : `已移除 ${String(dialog.ids.length)} 個素材 · ${
                              batchRefs.impact.breaking.length === 0
                                ? '文章中的圖片不受影響'
                                : '部分作品顯示為缺圖'
                            }`,
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
              {batchRefs === null ? '移除' : '仍要移除'}
            </button>
          </>
        }
      >
        <div className="form">
          <dl className="kv">
            <dt>移到最近刪除</dt>
            <dd>{managed} 個</dd>
            <dt>外部掛載</dt>
            <dd>{external === 0 ? '無' : `${String(external)} 個，只從素材庫移除，原檔不動`}</dd>
          </dl>
          {batchRefs !== null && (
            <p className="dialog__warn" role="alert">
              其中 {batchRefs.count} 個被作品引用。{deleteImpactText(batchRefs.impact)}
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
        title={`為 ${String(dialog.ids.length)} 個素材加標籤`}
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
                    message: `已為 ${String(dialog.ids.length)} 個素材加上標籤`,
                    undo: null,
                  });
                });
              }}
            >
              加上
            </button>
          </>
        }
      >
        <div className="form">
          <label className="field-block">
            <span className="field-block__label">標籤（用逗號或空白分開）</span>
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
        title="永久刪除這個素材？"
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
                          ? '已永久刪除'
                          : `已永久刪除；${broken.join('、')} 的正文仍連到這個檔案，會顯示為缺圖`,
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
              永久刪除
            </button>
          </>
        }
      >
        <div className="form">
          <p>「{displayName(dialog.asset)}」的檔案會從磁碟刪除，無法復原。</p>
          {errorLine}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`永久刪除 ${String(dialog.count)} 個素材？`}
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
                          ? `已清空最近刪除（${String(res.purged.length)} 個）`
                          : `已清空；${broken.join('、')} 的正文仍連到被刪的檔案，會顯示為缺圖`,
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
            永久刪除
          </button>
        </>
      }
    >
      <div className="form">
        <p>最近刪除裡的檔案會從磁碟刪除，無法復原。</p>
        {errorLine}
      </div>
    </Dialog>
  );
}
