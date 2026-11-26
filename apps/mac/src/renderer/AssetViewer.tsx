import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord, AssetWorkItem, Mount, WorkAssetRole } from '@qiu-creator/contracts';
import { duration, easingCurve } from '@qiu-creator/design-tokens';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import {
  AssetEditor,
  displayName,
  FIELD_LABEL,
  fileExt,
  isExternal,
  type EditorState,
  type SaveStatus,
} from './asset-session.js';
import { useAssetText } from './asset-text.js';
import { countWords, viewerKeyAction } from './asset-viewer.js';
import { AssetThumb } from './AssetThumb.js';
import { Chip } from './Chip.js';
import { ContextMenu, type MenuAnchor, type MenuEntry } from './ContextMenu.js';
import { useRefreshOn } from './events.js';
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
import { formatDateTime, t } from './i18n.js';
import { Icon } from './Icon.js';
import { clampPan, expandFrom, toggledScale, zoomed, type Rect } from './lightbox-math.js';
import { MarkdownReader } from './MarkdownReader.js';
import { currentMotionMode, moves } from './motion-mode.js';
import { Animated, hasOpenLayer, Presence } from './motion.js';
import { TagEditor } from './TagEditor.js';
import './asset-viewer.css';

/**
 * 素材庫 gallery view (QC-108, PT-20261126-001 方案 B 圖庫檢視): a click on a
 * card shows the asset in the main area with the sidebar still there. The
 * content takes the stage; one faint line of facts sits under it and an 84px
 * strip of the neighbours at the bottom. ← → move, Esc or 「‹ 素材庫」 go
 * back to the grid where it was. The fields (name, tags, alt text, note,
 * where it is used, file facts) wait in a card that I or 「資訊」 brings up,
 * closed every time the view opens, saving as you type. Space plays a video
 * or audio and opens the full-window preview (QC-077) for the rest. In 回收站
 * the tools become 還原 and 永久刪除.
 */

export type ViewerMode = 'active' | 'trash';

const ROLE_LABEL: Readonly<Record<WorkAssetRole, () => string>> = {
  cover: () => t('assets.roleCover'),
  body: () => t('assets.roleBody'),
  video: () => t('assets.roleVideo'),
};

const SAVE_LABEL: Readonly<Record<SaveStatus, () => { label: string; tone: ChipTone }>> = {
  saved: () => ({ label: t('format.saveSaved'), tone: 'ok' }),
  pending: () => ({ label: t('format.saveDirty'), tone: 'neutral' }),
  saving: () => ({ label: t('format.saveSaving'), tone: 'neutral' }),
  error: () => ({ label: t('format.saveError'), tone: 'bad' }),
  conflict: () => ({ label: t('assets.saveConflict'), tone: 'warn' }),
};

export interface AssetViewerProps {
  client: CreatorHubClient;
  mode: ViewerMode;
  /** The assets in grid order; ← → and the strip move through them. */
  assets: readonly AssetRecord[];
  index: number;
  /** The card's box, so the content grows from it (full motion only). */
  origin: Rect | null;
  /** Start this video at a second (an AI result's time point). */
  startAt: number | null;
  home: string | null;
  mounts: ReadonlyMap<string, Mount>;
  userHome: string | null;
  onIndex: (index: number) => void;
  onBack: () => void;
  onOpenWork: (workId: string) => void;
  onSaved: (asset: AssetRecord) => void;
  /** 移到回收站 / 移出素材庫 (the page runs the delete rules and moves on to the next asset). */
  onDelete: (asset: AssetRecord) => void;
  onRestore: (asset: AssetRecord) => void;
  onPurge: (asset: AssetRecord) => void;
  /** Space on a picture or text: the full-window preview. */
  onFullPreview: (asset: AssetRecord, from: Element | null) => void;
}

export function AssetViewer(props: AssetViewerProps) {
  const { assets, index, mode, onIndex, onBack } = props;
  const asset = assets[index];
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [revealFailed, setRevealFailed] = useState(false);
  const refs = useAssetRefs(props.client, mode === 'active' ? (asset?.id ?? null) : null);

  // Focus moves into the view, so Esc, ← → and Tab work at once.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  // A new asset starts formatted, with no stale error.
  const assetId = asset?.id;
  useEffect(() => {
    setRaw(false);
    setRevealFailed(false);
  }, [assetId]);

  const go = useCallback(
    (to: number) => {
      if (to >= 0 && to < assets.length && to !== index) onIndex(to);
    },
    [assets.length, index, onIndex],
  );

  const media = () =>
    stage.current?.querySelector<HTMLMediaElement>('video.aview__video, audio.aview__audio') ??
    null;

  useEffect(() => {
    if (asset === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      // A confirmation, the full-window preview or a menu keeps its own keys.
      if (hasOpenLayer(true)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const action = viewerKeyAction(e, {
        typing:
          target !== null &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)),
        onControl:
          target !== null &&
          target.closest('button, a, summary, video, audio, [role="menuitem"]') !== null,
        infoOpen,
        video: asset.kind === 'video',
      });
      if (action === null) return;
      e.preventDefault();
      switch (action) {
        case 'prev':
          go(index - 1);
          break;
        case 'next':
          go(index + 1);
          break;
        case 'back':
          onBack();
          break;
        case 'closeInfo':
          setInfoOpen(false);
          root.current?.focus({ preventScroll: true });
          break;
        case 'info':
          if (mode === 'active') setInfoOpen((open) => !open);
          break;
        case 'fullscreen': {
          const video = media();
          if (video !== null) void video.requestFullscreen().catch(() => undefined);
          break;
        }
        case 'space': {
          const player = media();
          if (player !== null) {
            if (player.paused) void player.play().catch(() => undefined);
            else player.pause();
          } else if (asset.kind === 'image' || asset.kind === 'markdown') {
            props.onFullPreview(asset, stage.current?.querySelector('.aview__content') ?? null);
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  if (asset === undefined) return null;
  const name = displayName(asset);
  const external = isExternal(asset);

  const menuItems = (): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (asset.kind === 'image' || asset.kind === 'markdown') {
      items.push({
        kind: 'item',
        id: 'full',
        label: t('assets.fullPreview'),
        hint: 'Space',
        onSelect: () => {
          props.onFullPreview(asset, stage.current?.querySelector('.aview__content') ?? null);
        },
      });
    }
    if (asset.kind === 'video') {
      items.push({
        kind: 'item',
        id: 'fullscreen',
        label: t('assets.fullscreen'),
        hint: 'F',
        onSelect: () => {
          void media()
            ?.requestFullscreen()
            .catch(() => undefined);
        },
      });
    }
    if (asset.kind === 'markdown') {
      items.push(
        {
          kind: 'item',
          id: 'raw',
          label: raw ? t('assets.showFormatted') : t('assets.showRaw'),
          onSelect: () => {
            setRaw((r) => !r);
          },
        },
        {
          kind: 'item',
          id: 'copy',
          label: t('assets.copyText'),
          onSelect: () => {
            const text = stage.current?.querySelector('[data-md-source]')?.textContent ?? null;
            if (text !== null) void window.creatorhub?.copyText(text);
          },
        },
      );
    }
    return items;
  };
  const moreItems = menuItems();

  return (
    <section
      ref={root}
      className="aview"
      aria-label={t('assets.viewer', { name })}
      tabIndex={-1}
      data-asset-id={asset.id}
    >
      <header className="aview__bar">
        <button
          type="button"
          className="btn btn--ghost btn--small aview__back"
          aria-label={t('assets.backToGridLabel')}
          aria-keyshortcuts="Escape"
          onClick={onBack}
        >
          <Icon name="chevronLeft" size={14} />
          {mode === 'trash' ? t('assets.scopeTrash') : t('assets.backToGrid')}
        </button>
        <span className="aview__pos" aria-live="polite">
          {t('assets.lightboxPosition', { n: String(index + 1), total: String(assets.length) })}
        </span>
        <div className="aview__tools">
          {revealFailed && (
            <span className="viewer__error" role="alert">
              {t('assets.revealFailed')}
            </span>
          )}
          {mode === 'active' ? (
            <>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                aria-pressed={infoOpen}
                aria-keyshortcuts="I"
                onClick={() => {
                  setInfoOpen((open) => !open);
                }}
              >
                <Icon name="info" size={14} />
                {t('assets.info')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={t('common.revealInFinder')}
                title={t('common.revealInFinder')}
                onClick={() => {
                  void window.creatorhub?.reveal({ kind: 'asset', id: asset.id }).then((ok) => {
                    setRevealFailed(!ok);
                  });
                }}
              >
                <Icon name="folder" size={15} />
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={external ? t('assets.removeFromLibrary') : t('assets.moveToTrash')}
                title={external ? t('assets.removeFromLibrary') : t('assets.moveToTrash')}
                aria-keyshortcuts="Meta+Backspace"
                onClick={() => {
                  props.onDelete(asset);
                }}
              >
                <Icon name="trash" size={15} />
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--small"
                aria-label={t('assets.more')}
                title={t('assets.more')}
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                disabled={moreItems.length === 0}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.right - 200, y: r.bottom + 4 });
                }}
              >
                <Icon name="more" size={15} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  props.onRestore(asset);
                }}
              >
                <Icon name="undo" size={14} />
                {t('common.restore')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--danger btn--small"
                onClick={() => {
                  props.onPurge(asset);
                }}
              >
                {t('assets.purge')}
              </button>
            </>
          )}
        </div>
      </header>

      <div ref={stage} className="aview__stage">
        <ViewerContent
          key={asset.id}
          asset={asset}
          raw={raw}
          origin={props.origin}
          startAt={props.startAt}
          onFullPreview={(from) => {
            props.onFullPreview(asset, from);
          }}
        />
        <Presence>
          {infoOpen && mode === 'active' && (
            <Animated key="info" preset={{ kind: 'panel', from: 'right' }} className="aview__card">
              <InfoCard
                key={asset.id}
                client={props.client}
                asset={asset}
                refs={refs}
                home={props.home}
                mount={
                  asset.mount_id === null || asset.mount_id === undefined
                    ? null
                    : (props.mounts.get(asset.mount_id) ?? null)
                }
                userHome={props.userHome}
                onOpenWork={props.onOpenWork}
                onSaved={props.onSaved}
                onClose={() => {
                  setInfoOpen(false);
                  root.current?.focus({ preventScroll: true });
                }}
              />
            </Animated>
          )}
        </Presence>
      </div>

      <InfoLine asset={asset} refs={refs} mode={mode} />

      <Filmstrip assets={assets} index={index} onPick={go} />

      {menu !== null && moreItems.length > 0 && (
        <ContextMenu
          anchor={menu}
          label={t('assets.more')}
          items={moreItems}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </section>
  );
}

/** Where the asset is used, for the info line and the card; reloads when works change. */
function useAssetRefs(client: CreatorHubClient, assetId: string | null): AssetWorkItem[] | null {
  const [state, setState] = useState<{ id: string; items: AssetWorkItem[] } | null>(null);
  const load = useCallback(() => {
    if (assetId === null) return;
    client.assets
      .works(assetId)
      .then((res) => {
        setState({ id: assetId, items: res.items });
      })
      .catch(() => {
        setState({ id: assetId, items: [] });
      });
  }, [client, assetId]);
  useEffect(load, [load]);
  // Linking or unlinking arrives as work.assets_changed.
  useRefreshOn(['work'], load, 400);
  return state !== null && state.id === assetId ? state.items : null;
}

/** The faint facts under the content; back to full contrast on hover. */
function InfoLine({
  asset,
  refs,
  mode,
}: {
  asset: AssetRecord;
  refs: readonly AssetWorkItem[] | null;
  mode: ViewerMode;
}) {
  const text = useMarkdownWords(asset);
  const facts = [
    formatDimensions(asset.width, asset.height),
    asset.duration !== null && (asset.kind === 'video' || asset.kind === 'audio')
      ? formatDuration(asset.duration)
      : null,
    text === null ? null : t('assets.words', { count: text }),
    formatBytes(asset.bytes),
  ].filter((f): f is string => f !== null && f !== '');
  const works = new Set(refs?.map((r) => r.work_id) ?? []).size;
  return (
    <footer className="aview__line">
      <span className="aview__name">{displayName(asset)}</span>
      <span>{facts.join(' · ')}</span>
      {mode === 'active' && refs !== null && (
        <span className="aview__sep">
          {works === 0 ? t('assets.scopeUnreferenced') : t('assets.usedIn', { count: works })}
        </span>
      )}
      {(asset.tags ?? []).map((tag) => (
        <span key={tag} className="aview__sep">
          #{tag}
        </span>
      ))}
      {mode === 'active' && (
        <span className="aview__hint">
          <kbd>I</kbd>
          {t('assets.info')}
        </span>
      )}
    </footer>
  );
}

function useMarkdownWords(asset: AssetRecord): number | null {
  const isText = asset.kind === 'markdown';
  const state = useAssetText(isText ? asset : { id: '', sha256: '' });
  if (!isText || state.status !== 'ready') return null;
  return countWords(state.text);
}

/** The neighbours at the bottom: click to show one; the current one stays in view. */
function Filmstrip({
  assets,
  index,
  onPick,
}: {
  assets: readonly AssetRecord[];
  index: number;
  onPick: (index: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-current="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [index]);
  return (
    <nav className="aview__strip" aria-label={t('assets.filmstrip')}>
      <div ref={strip} className="aview__strip-row">
        {assets.map((a, i) => (
          <button
            key={a.id}
            type="button"
            className="aview__frame"
            aria-current={i === index}
            aria-label={displayName(a)}
            title={displayName(a)}
            tabIndex={-1}
            onClick={() => {
              onPick(i);
            }}
          >
            <AssetThumb asset={a} size={18} />
          </button>
        ))}
      </div>
    </nav>
  );
}

/** The content itself: a picture to zoom, a player, the text, or the kind's icon. */
function ViewerContent({
  asset,
  raw,
  origin,
  startAt,
  onFullPreview,
}: {
  asset: AssetRecord;
  raw: boolean;
  origin: Rect | null;
  startAt: number | null;
  onFullPreview: (from: Element | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Grow from the card once, when the view opens on it (DESIGN.md 動效: moderate/out).
  const grown = useRef(false);
  useLayoutEffect(() => {
    if (grown.current || origin === null) return;
    grown.current = true;
    const el = box.current?.querySelector<HTMLElement>('.aview__content');
    if (el === null || el === undefined || !moves(currentMotionMode())) return;
    const final = el.getBoundingClientRect();
    if (final.width === 0) return;
    const from = expandFrom(origin, final);
    el.animate(
      [
        {
          transform: `translate(${String(from.x)}px, ${String(from.y)}px) scale(${String(from.scale)})`,
        },
        { transform: 'none' },
      ],
      { duration: duration.moderate, easing: `cubic-bezier(${easingCurve.out.join(',')})` },
    );
  }, [origin]);

  const name = displayName(asset);
  let content;
  if (failed) {
    content = <Unavailable asset={asset} note={t('assets.previewFormatFailed')} />;
  } else if (asset.kind === 'image') {
    content = (
      <ZoomImage
        asset={asset}
        onFailed={() => {
          setFailed(true);
        }}
        onFullPreview={onFullPreview}
      />
    );
  } else if (asset.kind === 'video') {
    content = (
      <video
        className="aview__content aview__video"
        src={assetMediaUrl(asset.id)}
        controls
        preload="metadata"
        aria-label={name}
        onError={() => {
          setFailed(true);
        }}
        onLoadedMetadata={(e) => {
          if (startAt === null) return;
          const video = e.currentTarget;
          video.currentTime = Math.min(startAt, video.duration || startAt);
          void video.play().catch(() => undefined);
        }}
      />
    );
  } else if (asset.kind === 'audio') {
    content = (
      <div className="aview__content aview__sound">
        <span className="aview__sound-icon">
          <Icon name="audio" size={36} />
        </span>
        <span className="aview__sound-name">{name}</span>
        <audio
          className="aview__audio"
          src={assetMediaUrl(asset.id)}
          controls
          preload="metadata"
          aria-label={name}
          onError={() => {
            setFailed(true);
          }}
        />
      </div>
    );
  } else if (asset.kind === 'markdown') {
    content = <TextContent asset={asset} raw={raw} />;
  } else {
    content = <Unavailable asset={asset} note={t('assets.viewerUnavailable')} />;
  }
  return (
    <div ref={box} className={`aview__view aview__view--${asset.kind}`}>
      {content}
    </div>
  );
}

function Unavailable({ asset, note }: { asset: AssetRecord; note: string }) {
  return (
    <div className="aview__content aview__other" role="status">
      <Icon name={ASSET_KIND[asset.kind].icon} size={40} />
      <span>{note}</span>
    </div>
  );
}

/** A Markdown asset laid out for reading, or its source text (更多 › 顯示原始文字). */
export function TextContent({ asset, raw }: { asset: AssetRecord; raw: boolean }) {
  const state = useAssetText(asset);
  return (
    <div className="aview__content aview__doc">
      {state.status === 'loading' ? (
        <p className="faint" aria-busy="true">
          {t('assets.mdLoading')}
        </p>
      ) : state.status === 'failed' ? (
        <p className="faint" role="status">
          {t('assets.mdFailed')}
        </p>
      ) : (
        <>
          {state.truncated && (
            <p className="aview__doc-note" role="status">
              {t('assets.mdTruncated')}
            </p>
          )}
          {raw ? (
            <pre className="aview__raw">{state.text}</pre>
          ) : (
            <MarkdownReader markdown={state.text} />
          )}
          <span hidden data-md-source="">
            {state.text}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The picture, fitted to the stage (larger or smaller), zooming as in the
 * full-window preview (QC-077): ⌘+ ⌘− ⌘0, a pinch, a double-click between fit
 * and 100%, dragging to pan. Thumbnail first, original once loaded.
 */
function ZoomImage({
  asset,
  onFailed,
  onFullPreview,
}: {
  asset: AssetRecord;
  onFailed: () => void;
  onFullPreview: (from: Element | null) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(
    asset.width !== null && asset.height !== null && asset.width > 0 && asset.height > 0
      ? { width: asset.width, height: asset.height }
      : null,
  );
  const [original, setOriginal] = useState<string | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  useEffect(() => {
    const src = assetMediaUrl(asset.id);
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      setOriginal(src);
      setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (live) onFailedRef.current();
    };
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [asset.id]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (el === null) return;
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const fit =
    natural === null || size.width === 0 || size.height === 0
      ? 1
      : Math.min(size.width / natural.width, size.height / natural.height);
  const current = scale ?? fit;
  const shown =
    natural === null ? null : { width: natural.width * current, height: natural.height * current };

  const setZoom = useCallback(
    (next: number) => {
      setScale(next);
      if (natural !== null) {
        setPan((p) =>
          clampPan(p, size, { width: natural.width * next, height: natural.height * next }),
        );
      }
    },
    [natural, size],
  );

  // ⌘+ ⌘− ⌘0 while the view has the keys (not while typing or with a dialog open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.isComposing || hasOpenLayer(true)) return;
      const target = e.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom(zoomed(current, fit, 1));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoom(zoomed(current, fit, -1));
      } else if (e.key === '0') {
        e.preventDefault();
        setScale(null);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [current, fit, setZoom]);

  const onWheel = (e: ReactWheelEvent) => {
    if (natural === null) return;
    if (e.ctrlKey) {
      setZoom(Math.min(8, Math.max(fit / 2, current * Math.exp(-e.deltaY * 0.01))));
    } else if (shown !== null && scale !== null) {
      setPan((p) => clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }, size, shown));
    }
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (shown === null || e.button !== 0 || scale === null) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d === null || shown === null) return;
    setPan(clampPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }, size, shown));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const thumb = asset.thumbnail_status === 'failed' ? null : thumbnailUrl(asset.id);
  return (
    <div ref={stage} className="aview__zoom" onWheel={onWheel}>
      {shown !== null && (
        <div
          className={`aview__content aview__figure${scale !== null && scale > fit ? ' aview__figure--zoomed' : ''}`}
          style={{
            width: shown.width,
            height: shown.height,
            transform: `translate(${String(pan.x)}px, ${String(pan.y)}px)`,
          }}
          onDoubleClick={() => {
            setPan({ x: 0, y: 0 });
            const next = toggledScale(current, fit);
            setScale(Math.abs(next - fit) < 0.001 ? null : next);
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img
            key={original ?? thumb ?? 'none'}
            className="aview__img"
            src={original ?? thumb ?? undefined}
            alt={asset.alt_text ?? displayName(asset)}
            data-original={original !== null ? 'true' : 'false'}
            draggable={false}
            title={t('assets.fullPreview')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onFullPreview(e.currentTarget);
            }}
          />
        </div>
      )}
    </div>
  );
}

function useEditor(editor: AssetEditor): EditorState {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot);
}

/**
 * The fields, floating over the content without pushing it: name, tags, alt
 * text (pictures only), note, where it is used, and the file facts folded
 * away. Saves as you type, as the old inspector did (QC-037).
 */
function InfoCard({
  client,
  asset,
  refs,
  home,
  mount,
  userHome,
  onOpenWork,
  onSaved,
  onClose,
}: {
  client: CreatorHubClient;
  asset: AssetRecord;
  refs: readonly AssetWorkItem[] | null;
  home: string | null;
  mount: Mount | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onSaved: (asset: AssetRecord) => void;
  onClose: () => void;
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
      // Leaving the asset or closing the card saves what was typed, then lets go.
      void e.flush().finally(() => {
        e.dispose();
      });
    };
  }, [client]);
  if (editor === null) return null;
  return (
    <InfoFields
      editor={editor}
      asset={asset}
      refs={refs}
      home={home}
      mount={mount}
      userHome={userHome}
      onOpenWork={onOpenWork}
      onClose={onClose}
    />
  );
}

function InfoFields({
  editor,
  asset,
  refs,
  home,
  mount,
  userHome,
  onOpenWork,
  onClose,
}: {
  editor: AssetEditor;
  asset: AssetRecord;
  refs: readonly AssetWorkItem[] | null;
  home: string | null;
  mount: Mount | null;
  userHome: string | null;
  onOpenWork: (workId: string) => void;
  onClose: () => void;
}) {
  const state = useEditor(editor);
  const [copied, setCopied] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName(asset));
  useEffect(() => {
    editor.adopt(asset);
  }, [editor, asset]);

  const current = state.asset;
  const save = SAVE_LABEL[state.status]();
  const external = isExternal(current);
  const timed = current.kind === 'video' || current.kind === 'audio';

  return (
    <div className="aview__card-body" role="group" aria-label={t('assets.infoCard')}>
      <div className="aview__card-head">
        <h2 className="aview__card-title">{t('assets.info')}</h2>
        <span className="faint aview__autosave">{t('assets.autosave')}</span>
        <span role="status">
          <Chip tone={save.tone}>{save.label}</Chip>
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--small"
          aria-label={t('assets.closeInfo')}
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
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
      {metadataNote(current) !== null && (
        <p className="viewer__note" role="status">
          {metadataNote(current)}
        </p>
      )}
      <div className="field-block">
        <label className="field-block__label" htmlFor="asset-name">
          {t('assets.name')}
        </label>
        <div className="aview__name-row">
          <input
            id="asset-name"
            className="input"
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
        </div>
      </div>
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
      {current.kind === 'image' && (
        <div className="field-block">
          <label className="field-block__label" htmlFor="asset-alt">
            {t('assets.altText')}
          </label>
          <textarea
            id="asset-alt"
            className="input aview__area"
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
      )}
      <div className="field-block">
        <label className="field-block__label" htmlFor="asset-note">
          {t('assets.note')}
        </label>
        <textarea
          id="asset-note"
          className="input aview__area"
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
      <div className="field-block">
        <span className="field-block__label">{t('assets.refsLabel')}</span>
        {refs === null ? (
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
                  <Icon name="link" size={14} />
                  <span className="ref__title">{r.title}</span>
                  <span className="faint">{ROLE_LABEL[r.role]()}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="inspector__details">
        <summary>{t('assets.fileInfo')}</summary>
        <dl className="kv">
          <dt>{t('assets.fileName')}</dt>
          <dd className="mono">{assetName(current)}</dd>
          <dt>{t('assets.dimensions')}</dt>
          <dd>{formatDimensions(current.width, current.height) ?? '—'}</dd>
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
          <dd>{originLabel(current.origin)}</dd>
          <dt>{t('assets.added')}</dt>
          <dd>{formatDateTime(new Date(current.created_at))}</dd>
        </dl>
      </details>
    </div>
  );
}

function metadataNote(asset: AssetRecord): string | null {
  if (asset.metadata_status === 'pending') return t('assets.metaPending');
  if (asset.metadata_status === 'unavailable') return t('assets.metaUnavailable');
  if (asset.metadata_status === 'failed') return t('assets.metaFailed');
  return null;
}

function originLabel(origin: AssetRecord['origin']): string {
  switch (origin) {
    case 'upload':
      return t('assets.originUpload');
    case 'url':
      return t('assets.originUrl');
    case 'folder':
      return t('assets.originFolder');
    case 'api':
      return 'Agent API';
    case 'manual':
      return t('assets.originManual');
  }
}
