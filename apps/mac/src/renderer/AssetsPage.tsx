import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AssetKind,
  AssetOrigin,
  AssetRecord,
  AssetWorkItem,
  Mount,
  WorkAssetRole,
} from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import { Chip } from './Chip.js';
import { useRefreshOn } from './events.js';
import { useMounts } from './mounts.js';
import {
  ASSET_KIND,
  assetName,
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

/**
 * 素材庫 (prototype board MacAssets): managed assets as a thumbnail grid with
 * a kind filter, and a viewer for the selected asset. Uploads go through the
 * main process; the grid refreshes from SSE `asset.*` events.
 */
export function AssetsPage({
  client,
  home,
  userHome,
  focusAssetId,
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
  onOpenImports: () => void;
  onOpenSettings: () => void;
}) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusAssetId ?? null);
  const [focused, setFocused] = useState<AssetRecord | null>(null);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const limit = useRef(PAGE_SIZE);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setFailed(false);
    const q = appliedQuery.trim();
    client.assets
      .list({
        kind: kind === 'all' ? undefined : kind,
        q: q === '' ? undefined : q,
        limit: Math.min(limit.current, 200),
      })
      .then((res) => {
        if (id !== request.current) return;
        setListing({ items: res.items, total: res.total });
      })
      .catch(() => {
        if (id !== request.current) return;
        setFailed(true);
      });
  }, [client, kind, appliedQuery]);

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
        // The grid still loads; the viewer just stays closed.
      });
    return () => {
      alive = false;
    };
  }, [client, focusAssetId]);

  const items = listing?.items ?? [];
  const selected =
    items.find((a) => a.id === selectedId) ?? (focused?.id === selectedId ? focused : null);
  const filtering = kind !== 'all' || appliedQuery.trim() !== '';

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
          <label className="search">
            <Icon name="search" />
            <span className="visually-hidden">搜尋檔名</span>
            <input
              type="search"
              placeholder="搜尋檔名"
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
          <button type="button" className="btn btn--primary" onClick={pick}>
            <Icon name="upload" />
            上傳
          </button>
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

        <section className="page__body" aria-label="素材" aria-busy={listing === null && !failed}>
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
                <span className="state-card__title">沒有符合的素材</span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setKind('all');
                    setQuery('');
                    setAppliedQuery('');
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
                      {g.mount !== null && (
                        <span className="asset-section__chip">
                          {offline ? (
                            <Chip tone="bad">找不到資料夾</Chip>
                          ) : (
                            <Chip tone="warn">原檔不移動</Chip>
                          )}
                        </span>
                      )}
                    </div>
                    <div className={offline ? 'asset-grid asset-grid--offline' : 'asset-grid'}>
                      {g.items.map((a) => (
                        <AssetTile
                          key={a.id}
                          asset={a}
                          selected={a.id === selectedId}
                          onSelect={() => {
                            setSelectedId(a.id === selectedId ? null : a.id);
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
      </div>

      {selected !== null && (
        <AssetViewer
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
          onClose={() => {
            setSelectedId(null);
          }}
        />
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
function MediaPreview({ asset }: { asset: AssetRecord }) {
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
  onSelect,
}: {
  asset: AssetRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = assetName(asset);
  return (
    <button
      type="button"
      className="atile"
      aria-pressed={selected}
      aria-label={`${name}，${ASSET_KIND[asset.kind].label}`}
      onClick={onSelect}
    >
      <span className="atile__thumb">
        <Thumb asset={asset} size={28} />
        {asset.duration !== null && (asset.kind === 'video' || asset.kind === 'audio') && (
          <span className="atile__dur">{formatDuration(asset.duration)}</span>
        )}
      </span>
      <span className="atile__name">{name}</span>
    </button>
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

function AssetViewer({
  client,
  asset,
  home,
  mount,
  userHome,
  onOpenWork,
  onClose,
}: {
  client: CreatorHubClient;
  asset: AssetRecord;
  home: string | null;
  mount: Mount | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  useEffect(() => {
    setCopied(false);
    setRevealFailed(false);
  }, [asset.id]);

  const name = assetName(asset);
  const dims = formatDimensions(asset.width, asset.height);
  const note = metadataNote(asset);
  const timed = asset.kind === 'video' || asset.kind === 'audio';

  return (
    <aside className="viewer" aria-label="檢視器">
      <MediaPreview key={asset.id} asset={asset} />
      <div className="viewer__title">
        <h2 className="mono viewer__name">{name}</h2>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--small"
          aria-label="關閉檢視器"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="viewer__chips">
        <Chip>{ASSET_KIND[asset.kind].label}</Chip>
        {asset.mount_id == null ? <Chip>托管</Chip> : <Chip tone="warn">外部掛載</Chip>}
      </div>
      {note !== null && (
        <p className="viewer__note" role="status">
          {note}
        </p>
      )}
      <dl className="kv">
        <dt>尺寸</dt>
        <dd>{dims ?? '—'}</dd>
        {timed && (
          <>
            <dt>時長</dt>
            <dd>{asset.duration === null ? '—' : formatDuration(asset.duration)}</dd>
          </>
        )}
        <dt>編碼</dt>
        <dd>{asset.codec ?? asset.mime_type}</dd>
        <dt>大小</dt>
        <dd>{formatBytes(asset.bytes)}</dd>
        <dt>SHA-256</dt>
        <dd className="mono kv__hash">
          <span title={asset.sha256}>{shortHash(asset.sha256)}</span>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--tiny"
            aria-label="複製雜湊"
            onClick={() => {
              void window.creatorhub?.copyText(asset.sha256).then(() => {
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
          {asset.mount_id == null
            ? home === null
              ? asset.path
              : `${home}/${asset.path}`
            : mount === null
              ? asset.path
              : `${tildePath(mount.root_path, userHome)}/${asset.path}`}
        </dd>
        <dt>來源</dt>
        <dd>{ORIGIN_LABEL[asset.origin]}</dd>
        <dt>加入</dt>
        <dd>{dateTime.format(new Date(asset.created_at))}</dd>
      </dl>
      <AssetRefs client={client} assetId={asset.id} onOpenWork={onOpenWork} />
      <div className="viewer__actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.creatorhub?.reveal({ kind: 'asset', id: asset.id }).then((ok) => {
              setRevealFailed(!ok);
            });
          }}
        >
          <Icon name="folder" />在 Finder 顯示
        </button>
        {revealFailed && (
          <span className="viewer__error" role="alert">
            找不到檔案
          </span>
        )}
      </div>
    </aside>
  );
}
