import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { assetMediaUrl, thumbnailUrl } from '../shared/bridge.js';
import type { PendingInsert } from './editor-insert.js';
import { assetName } from './format.js';
import { ExitFade, useExitFade } from './motion.js';
import { t } from './i18n.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Pieces of 「v2 · 編輯器：插入素材」 (QC-039): the 插入 menu, the `/` menu,
 * the asset drawer, pending upload cards and the drop line.
 */

/** Drag type for an asset dragged out of the drawer. */
export const ASSET_DRAG_TYPE = 'application/x-qiu-asset';

function nameOf(a: AssetRecord): string {
  const d = a.display_name ?? null;
  return d !== null && d.trim() !== '' ? d : assetName(a);
}

/** Toolbar 「插入」 menu with the routes the board lists. */
export function InsertMenu({
  disabled,
  disabledReason,
  onLibrary,
  onUpload,
}: {
  disabled: boolean;
  disabledReason: string | null;
  onLibrary: () => void;
  onUpload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menu.current?.contains(e.target) || button.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
    }
  };
  return (
    <div className="insert-menu">
      <button
        ref={button}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={disabledReason ?? undefined}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Icon name="image" />
        {t('editor.insert')}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <ExitFade>
          <div
            ref={menu}
            className="pop insert-menu__pop"
            role="menu"
            aria-label={t('editor.insert')}
            onKeyDown={onKey}
          >
            <button
              type="button"
              className="pop__item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLibrary();
              }}
            >
              <Icon name="assets" size={16} />
              {t('editor.insertFromLibrary')}
              <kbd>⌘⇧I</kbd>
            </button>
            <button
              type="button"
              className="pop__item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onUpload();
              }}
            >
              <Icon name="upload" size={16} />
              {t('editor.uploadImage')}
              <kbd>⌘⇧U</kbd>
            </button>
            <div className="pop__sep" />
            <div className="pop__hint">
              <span>{t('editor.hintPaste')}</span>
              <span>{t('editor.hintDrag')}</span>
              <span>{t('editor.hintSlash')}</span>
            </div>
          </div>
        </ExitFade>
      )}
    </div>
  );
}

export interface SlashCommand {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
  run: () => void;
}

/** The `/` menu on an empty line: filter, ↑↓, ↩, esc (input-method composition ignored). */
export function SlashMenu({
  at,
  commands,
  onClose,
}: {
  at: { x: number; y: number };
  commands: readonly SlashCommand[];
  /** `ran`: a command was chosen (it runs right after). */
  onClose: (ran: boolean) => void;
}) {
  const slashRef = useRef<HTMLDivElement>(null);
  useExitFade(slashRef);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const q = query.trim();
  const shown = commands.filter((c) => q === '' || (c.label + c.hint).includes(q));
  const pick = Math.min(selected, Math.max(0, shown.length - 1));
  return (
    <div ref={slashRef} className="pop slash" style={{ left: at.x, top: at.y }}>
      <label className="visually-hidden" htmlFor="slash-input">
        {t('editor.slashInputLabel')}
      </label>
      <input
        id="slash-input"
        className="slash__input"
        autoFocus
        value={`/${query}`}
        role="combobox"
        aria-expanded="true"
        aria-controls="slash-list"
        aria-activedescendant={shown[pick] === undefined ? undefined : `slash-${shown[pick].key}`}
        onChange={(e) => {
          const v = e.target.value;
          if (!v.startsWith('/')) {
            onClose(false);
            return;
          }
          setQuery(v.slice(1));
          setSelected(0);
        }}
        onBlur={() => {
          onClose(false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose(false);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = shown.length;
            if (n > 0) setSelected((pick + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const c = shown[pick];
            onClose(c !== undefined);
            c?.run();
          }
        }}
      />
      <div id="slash-list" role="listbox" aria-label={t('editor.slashListLabel')}>
        {shown.map((c, i) => (
          <div
            key={c.key}
            id={`slash-${c.key}`}
            role="option"
            aria-selected={i === pick}
            className="pop__item"
            onMouseDown={(e) => {
              // Keep focus in the input until the command runs.
              e.preventDefault();
              onClose(true);
              c.run();
            }}
          >
            <Icon name={c.icon} size={16} />
            {c.label}
            <span className="pop__item-hint">{c.hint}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="pop__empty">{t('editor.slashEmpty')}</div>}
      </div>
      <div className="pop__sep" />
      <div className="pop__keys">
        <span>{t('editor.keySelect')}</span>
        <span>{t('editor.keyInsert')}</span>
        <span>{t('editor.keyClose')}</span>
      </div>
    </div>
  );
}

type DrawerScope = 'images' | 'work';

/**
 * 素材 drawer beside the text (⌘⇧I): search, 全部圖片／本作品, click or ↩ to
 * insert at the caret, or drag a tile to a spot in the text.
 */
export function AssetDrawer({
  client,
  workId,
  disabledReason,
  onInsert,
  onDragAsset,
  onClose,
  forPost = false,
  kind = 'image',
}: {
  client: CreatorHubClient;
  workId: string;
  disabledReason: string | null;
  onInsert: (asset: AssetRecord) => void;
  onDragAsset: (asset: AssetRecord | null) => void;
  onClose: () => void;
  /** Image posts (QC-045): images join the grid, and closing goes back to the preview. */
  forPost?: boolean;
  /** Videos for a video work (QC-046); images otherwise. */
  kind?: 'image' | 'video';
}) {
  const panelRef = useRef<HTMLElement>(null);
  useExitFade(panelRef, 'panel');
  const [scope, setScope] = useState<DrawerScope>('images');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [items, setItems] = useState<AssetRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const grid = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setFailed(false);
    const q = applied.trim();
    const req =
      scope === 'work'
        ? client.workAssets
            .list(workId)
            .then((r) =>
              r.items
                .map((i) => i.asset)
                .filter((a) => a.kind === kind && (q === '' || nameOf(a).includes(q))),
            )
        : client.assets.list({ kind, q: q === '' ? undefined : q, limit: 60 }).then((r) => r.items);
    req
      .then((list) => {
        setItems(list);
        setSelected(0);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [client, workId, scope, applied, kind]);
  useEffect(load, [load]);

  const move = (delta: number) => {
    if (items === null || items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, selected + delta));
    setSelected(next);
    grid.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [next]?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown') move(2);
    else if (e.key === 'ArrowUp') move(-2);
    else if (e.key === 'Enter') {
      const a = items?.[selected];
      if (a !== undefined && disabledReason === null) onInsert(a);
    } else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
  };

  return (
    <aside
      ref={panelRef}
      className="panel drawer"
      aria-label={t('editor.drawerLabel')}
      id="asset-drawer"
    >
      <div className="drawer__head">
        <span className="drawer__title">{t('editor.assets')}</span>
        <button
          type="button"
          className="btn btn--ghost btn--small drawer__close"
          aria-keyshortcuts="Meta+Shift+I"
          onClick={onClose}
        >
          <Icon name="spark" size={14} />
          {t(forPost ? 'imagePost.backToPreview' : 'editor.backToAi')}
        </button>
      </div>
      <div className="drawer__controls">
        <label className="search drawer__search">
          <Icon name="search" />
          <span className="visually-hidden">{t('editor.searchAssets')}</span>
          <input
            type="search"
            placeholder={t('editor.searchAssets')}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!(e.nativeEvent as InputEvent).isComposing) setApplied(e.target.value);
            }}
            onCompositionEnd={(e) => {
              setApplied(e.currentTarget.value);
            }}
            onKeyDown={onKey}
          />
          <kbd>⌘⇧I</kbd>
        </label>
        <div className="seg" role="group" aria-label={t('editor.scopeLabel')}>
          {(
            [
              ['images', kind === 'video' ? 'videoWork.scopeAllVideos' : 'editor.scopeAllImages'],
              ['work', 'editor.scopeThisWork'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={scope === k}
              onClick={() => {
                setScope(k);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
        {disabledReason !== null && (
          <p className="drawer__note" role="status">
            {disabledReason}
          </p>
        )}
      </div>
      <div
        ref={grid}
        className="drawer__grid"
        role="listbox"
        aria-label={t('editor.assets')}
        tabIndex={0}
        onKeyDown={onKey}
      >
        {failed ? (
          <div className="drawer__empty" role="alert">
            {t('editor.drawerLoadFailed')}
            <button type="button" className="btn btn--small" onClick={load}>
              {t('common.retry')}
            </button>
          </div>
        ) : items === null ? (
          <div className="drawer__empty" aria-busy="true">
            {t('common.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="drawer__empty">
            {t(scope === 'work' ? 'editor.drawerEmptyWork' : 'editor.drawerEmptySearch')}
          </div>
        ) : (
          items.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === selected}
              className="drawer__tile"
              aria-label={t('editor.insertAsset', { name: nameOf(a) })}
              disabled={disabledReason !== null}
              draggable={disabledReason === null}
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_DRAG_TYPE, a.id);
                e.dataTransfer.setData('text/plain', nameOf(a));
                e.dataTransfer.effectAllowed = 'copy';
                onDragAsset(a);
              }}
              onDragEnd={() => {
                onDragAsset(null);
              }}
              onClick={() => {
                setSelected(i);
                onInsert(a);
              }}
            >
              <span className="drawer__thumb">
                {a.kind === 'video' ? (
                  <video src={`${assetMediaUrl(a.id)}#t=0.5`} muted preload="metadata" />
                ) : (
                  <img src={thumbnailUrl(a.id)} alt="" draggable={false} loading="lazy" />
                )}
              </span>
              <span className="drawer__name">{nameOf(a)}</span>
            </button>
          ))
        )}
      </div>
      <div className="drawer__foot">
        <span>{t(forPost ? 'imagePost.footClick' : 'editor.footClickInsert')}</span>
        <span>{t(forPost ? 'imagePost.footDrag' : 'editor.footDrag')}</span>
        <span>{t('editor.footKeys')}</span>
      </div>
    </aside>
  );
}

/** Pasted and dropped files on their way in: progress, then gone; or failed with 重試／移除. */
export function PendingInserts({
  pending,
  onRetry,
  onRemove,
}: {
  pending: readonly PendingInsert[];
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  if (pending.length === 0) return null;
  return (
    <div className="pending" aria-label={t('editor.pendingLabel')}>
      {pending.map((p) =>
        p.state === 'failed' ? (
          <div key={p.key} className="pending__card pending__card--bad" role="alert">
            <Icon name="alert" size={18} />
            <div className="pending__main">
              <span className="pending__title">
                {t('editor.uploadFailedWhy', { error: p.error ?? t('editor.uploadFailed') })}
              </span>
              <span className="pending__sub">{t('editor.pendingSub', { name: p.name })}</span>
            </div>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                onRetry(p.key);
              }}
            >
              {t('common.retry')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                onRemove(p.key);
              }}
            >
              {t('common.remove')}
            </button>
          </div>
        ) : (
          <div
            key={p.key}
            className="pending__card"
            role="status"
            aria-label={t('editor.uploadingLabel', { name: p.name })}
          >
            <span className="pending__thumb">
              {p.preview !== null && <img src={p.preview} alt="" />}
            </span>
            <div className="pending__main">
              <span className="pending__row">
                <span className="pending__title">{p.name}</span>
                <span className="pending__pct">
                  {p.state === 'attaching'
                    ? t('editor.attaching')
                    : p.progress === null
                      ? ''
                      : `${String(p.progress)}%`}
                </span>
              </span>
              <span className={p.progress === null ? 'bar bar--indeterminate' : 'bar'}>
                <span
                  style={p.progress === null ? undefined : { width: `${String(p.progress)}%` }}
                />
              </span>
            </div>
            {p.state === 'uploading' && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  onRemove(p.key);
                }}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Where a drop will land: an accent line between blocks and a badge saying what happens. */
/** The drop frame, in the scroll container's content coordinates. */
export interface DropFrame {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Gap between the frame and the visible area's edges (and the toolbar). */
export const DROP_INSET = 8;
/** Distance from the frame's top or bottom edge where dragging scrolls. */
export const DROP_SCROLL_ZONE = 48;

/**
 * The visible part of the scroll container below its sticky toolbar, inset
 * evenly on all four sides. It is placed at the current scroll offset so it
 * covers what is on screen, not the top of the document (QC-039 review).
 */
export function dropFrame(doc: HTMLElement): DropFrame {
  const top = doc.getBoundingClientRect().top + doc.clientTop;
  const bar = doc.querySelector('[role="toolbar"]');
  const barBottom =
    bar === null
      ? top
      : Math.min(Math.max(bar.getBoundingClientRect().bottom, top), top + doc.clientHeight);
  const head = barBottom - top;
  return {
    top: doc.scrollTop + head + DROP_INSET,
    left: doc.scrollLeft + DROP_INSET,
    width: Math.max(0, doc.clientWidth - 2 * DROP_INSET),
    height: Math.max(0, doc.clientHeight - head - 2 * DROP_INSET),
  };
}

/**
 * How far to scroll for a pointer at `clientY` while dragging: negative near
 * the frame's top edge, positive near its bottom, faster closer to the edge.
 */
export function dropScrollStep(clientY: number, frameTop: number, frameBottom: number): number {
  const fromTop = clientY - frameTop;
  const fromBottom = frameBottom - clientY;
  const speed = (d: number) =>
    Math.ceil(((DROP_SCROLL_ZONE - Math.max(0, d)) / DROP_SCROLL_ZONE) * 24);
  if (fromTop < DROP_SCROLL_ZONE && fromTop <= fromBottom) return -speed(fromTop);
  if (fromBottom < DROP_SCROLL_ZONE) return speed(fromBottom);
  return 0;
}

export function DropIndicator({
  frame,
  y,
  label,
}: {
  frame: DropFrame;
  /** Insertion line in content coordinates; null when there is no block boundary. */
  y: number | null;
  label: string;
}) {
  const line = y === null ? null : y - frame.top;
  const shown = line !== null && line >= 0 && line <= frame.height ? line : null;
  return (
    <div
      className="drop"
      aria-hidden="true"
      style={{ top: frame.top, left: frame.left, width: frame.width, height: frame.height }}
    >
      {shown !== null && <div className="drop__line" style={{ top: shown }} />}
      <div
        className="drop__badge"
        style={shown === null ? undefined : { top: Math.min(shown + 10, frame.height - 34) }}
      >
        <Icon name="upload" size={14} />
        {label}
      </div>
    </div>
  );
}
