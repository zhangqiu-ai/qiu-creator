import type { CreatorHubClient } from '@qiu-creator/api-client';
import type { AssetRecord } from '@qiu-creator/contracts';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { thumbnailUrl } from '../shared/bridge.js';
import type { PendingInsert } from './editor-insert.js';
import { assetName } from './format.js';
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
        插入
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div
          ref={menu}
          className="pop insert-menu__pop"
          role="menu"
          aria-label="插入"
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
            從素材庫
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
            上傳圖片…
            <kbd>⌘⇧U</kbd>
          </button>
          <div className="pop__sep" />
          <div className="pop__hint">
            <span>⌘V 貼上剪貼簿圖片</span>
            <span>從 Finder 或素材抽屜拖進文中</span>
            <span>空行輸入 / 叫出指令</span>
          </div>
        </div>
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
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const q = query.trim();
  const shown = commands.filter((c) => q === '' || (c.label + c.hint).includes(q));
  const pick = Math.min(selected, Math.max(0, shown.length - 1));
  return (
    <div className="pop slash" style={{ left: at.x, top: at.y }}>
      <label className="visually-hidden" htmlFor="slash-input">
        斜線指令
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
      <div id="slash-list" role="listbox" aria-label="插入指令">
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
        {shown.length === 0 && <div className="pop__empty">沒有符合的指令</div>}
      </div>
      <div className="pop__sep" />
      <div className="pop__keys">
        <span>↑↓ 選擇</span>
        <span>↩ 插入</span>
        <span>esc 關閉</span>
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
}: {
  client: CreatorHubClient;
  workId: string;
  disabledReason: string | null;
  onInsert: (asset: AssetRecord) => void;
  onDragAsset: (asset: AssetRecord | null) => void;
  onClose: () => void;
}) {
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
                .filter((a) => a.kind === 'image' && (q === '' || nameOf(a).includes(q))),
            )
        : client.assets
            .list({ kind: 'image', q: q === '' ? undefined : q, limit: 60 })
            .then((r) => r.items);
    req
      .then((list) => {
        setItems(list);
        setSelected(0);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [client, workId, scope, applied]);
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
    <aside className="panel drawer" aria-label="素材抽屜" id="asset-drawer">
      <div className="drawer__head">
        <span className="drawer__title">素材</span>
        <button
          type="button"
          className="btn btn--ghost btn--small drawer__close"
          aria-keyshortcuts="Meta+Shift+I"
          onClick={onClose}
        >
          <Icon name="spark" size={14} />
          回到 AI
        </button>
      </div>
      <div className="drawer__controls">
        <label className="search drawer__search">
          <Icon name="search" />
          <span className="visually-hidden">搜尋素材</span>
          <input
            type="search"
            placeholder="搜尋素材"
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
        <div className="seg" role="group" aria-label="範圍">
          {(
            [
              ['images', '全部圖片'],
              ['work', '本作品'],
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
              {label}
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
        aria-label="素材"
        tabIndex={0}
        onKeyDown={onKey}
      >
        {failed ? (
          <div className="drawer__empty" role="alert">
            無法載入素材
            <button type="button" className="btn btn--small" onClick={load}>
              重試
            </button>
          </div>
        ) : items === null ? (
          <div className="drawer__empty" aria-busy="true">
            載入中…
          </div>
        ) : items.length === 0 ? (
          <div className="drawer__empty">
            {scope === 'work' ? '這篇作品還沒有圖片' : '沒有符合的圖片'}
          </div>
        ) : (
          items.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === selected}
              className="drawer__tile"
              aria-label={`插入 ${nameOf(a)}`}
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
                <img src={thumbnailUrl(a.id)} alt="" draggable={false} loading="lazy" />
              </span>
              <span className="drawer__name">{nameOf(a)}</span>
            </button>
          ))
        )}
      </div>
      <div className="drawer__foot">
        <span>點選插入游標處</span>
        <span>拖進文中指定位置</span>
        <span>方向鍵 ＋ ↩</span>
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
    <div className="pending" aria-label="插入中的圖片">
      {pending.map((p) =>
        p.state === 'failed' ? (
          <div key={p.key} className="pending__card pending__card--bad" role="alert">
            <Icon name="alert" size={18} />
            <div className="pending__main">
              <span className="pending__title">上傳失敗 · {p.error}</span>
              <span className="pending__sub">{p.name} · 圖片暫存在此視窗</span>
            </div>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                onRetry(p.key);
              }}
            >
              重試
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                onRemove(p.key);
              }}
            >
              移除
            </button>
          </div>
        ) : (
          <div key={p.key} className="pending__card" role="status" aria-label={`上傳中 ${p.name}`}>
            <span className="pending__thumb">
              {p.preview !== null && <img src={p.preview} alt="" />}
            </span>
            <div className="pending__main">
              <span className="pending__row">
                <span className="pending__title">{p.name}</span>
                <span className="pending__pct">
                  {p.state === 'attaching'
                    ? '插入中'
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
                取消
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Where a drop will land: an accent line between blocks and a badge saying what happens. */
export function DropIndicator({ y, label }: { y: number | null; label: string }) {
  return (
    <div className="drop" aria-hidden="true">
      {y !== null && <div className="drop__line" style={{ top: y }} />}
      <div className="drop__badge" style={y === null ? undefined : { top: y + 10 }}>
        <Icon name="upload" size={14} />
        {label}
      </div>
    </div>
  );
}
