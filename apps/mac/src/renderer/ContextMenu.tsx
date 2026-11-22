import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';

export type MenuEntry =
  | {
      kind: 'item';
      id: string;
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** Shows a check mark (the current status in 改狀態). */
      checked?: boolean;
      /**
       * A checkbox of a set where several may be on (項目 membership, QC-062);
       * 'mixed' when only some of the chosen works have it.
       */
      checkbox?: boolean | 'mixed';
      /** A colour swatch before the label (項目 colours). */
      swatch?: string;
      hint?: string;
    }
  | { kind: 'sub'; id: string; label: string; items: readonly MenuEntry[]; disabled?: boolean }
  | { kind: 'sep'; id: string };

export interface MenuAnchor {
  x: number;
  y: number;
}

/** Where a right-click (or the keyboard's menu key, which has no pointer) opens the menu. */
export function anchorOf(e: {
  clientX: number;
  clientY: number;
  currentTarget: Element;
}): MenuAnchor {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + 12, y: r.top + Math.min(r.height, 32) };
}

/** Keep a box of `size` inside the window, flipping to the other side of `at` when it would overflow. */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  flipX = 0,
): { left: number; top: number } {
  const margin = 8;
  let left = at.x;
  if (left + size.width > view.width - margin) left = Math.max(margin, at.x - flipX - size.width);
  let top = at.y;
  if (top + size.height > view.height - margin)
    top = Math.max(margin, view.height - margin - size.height);
  return { left, top };
}

const SUB_OPEN_MS = 120;
/** Moving across other rows toward an open submenu does not close it at once (kubai-999-002). */
const SUB_CLOSE_MS = 280;

/**
 * Right-click menu (QC-052), drawn by the app rather than a native Electron
 * menu so its wording follows the interface language live, it matches the
 * other popovers (`.pop`), and e2e can drive it. ↑↓ move, → opens a
 * submenu and ← closes it, ↩ picks, esc or a click outside closes and gives
 * focus back to where it was.
 */
export function ContextMenu({
  anchor,
  label,
  items,
  onClose,
}: {
  anchor: MenuAnchor;
  label: string;
  items: readonly MenuEntry[];
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const subRoot = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<{ id: string; left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const close = useCallback(
    (restoreFocus: boolean) => {
      clearTimer();
      onClose();
      const back = returnTo.current;
      if (restoreFocus && back instanceof HTMLElement && back.isConnected) back.focus();
    },
    [onClose],
  );

  useLayoutEffect(() => {
    returnTo.current = document.activeElement;
    const el = root.current;
    if (el === null) return;
    setPos(
      placeMenu(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);
  // Focus once placed: the first frame is hidden while it is measured, and hidden rows take no focus.
  const placed = pos !== null;
  useLayoutEffect(() => {
    const el = root.current;
    if (placed && el !== null) first(el)?.focus();
  }, [placed]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (root.current?.contains(target) === true || subRoot.current?.contains(target) === true)
        return;
      close(false);
    };
    const onAway = () => {
      close(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    document.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      document.removeEventListener('scroll', onAway, true);
      clearTimer();
    };
  }, [close]);

  const openSub = (id: string, row: HTMLElement, focusFirst: boolean) => {
    clearTimer();
    const r = row.getBoundingClientRect();
    setSub({ id, left: r.right + 2, top: r.top - 6 });
    if (focusFirst) {
      requestAnimationFrame(() => {
        const el = subRoot.current;
        if (el !== null) first(el)?.focus();
      });
    }
  };

  // Keep the submenu on screen once its size is known: flip to the left of the parent row if needed.
  useLayoutEffect(() => {
    const el = subRoot.current;
    if (sub === null || el === null || root.current === null) return;
    const parent = root.current.getBoundingClientRect();
    const placed = placeMenu(
      { x: sub.left, y: sub.top },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      parent.width + 4,
    );
    if (placed.left !== sub.left || placed.top !== sub.top) setSub({ ...sub, ...placed });
  }, [sub]);

  const pick = (entry: MenuEntry) => {
    if (entry.kind !== 'item' || entry.disabled === true) return;
    close(true);
    entry.onSelect();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, level: 'root' | 'sub') => {
    if (e.nativeEvent.isComposing) return;
    const box = level === 'root' ? root.current : subRoot.current;
    if (box === null) return;
    const rows = enabledRows(box);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n === 0) return;
      const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      rows[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? rows[0] : rows.at(-1))?.focus();
    } else if (e.key === 'ArrowRight' && level === 'root') {
      const row = rows[at];
      const id = row?.dataset.sub;
      if (row !== undefined && id !== undefined) {
        e.preventDefault();
        openSub(id, row, true);
      }
    } else if (e.key === 'ArrowLeft' && level === 'sub') {
      e.preventDefault();
      const parentId = sub?.id;
      setSub(null);
      root.current?.querySelector<HTMLElement>(`[data-sub="${parentId ?? ''}"]`)?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
    }
  };

  const subEntry =
    sub === null
      ? null
      : (items.find(
          (i): i is Extract<MenuEntry, { kind: 'sub' }> => i.kind === 'sub' && i.id === sub.id,
        ) ?? null);

  return createPortal(
    <>
      <div
        ref={root}
        className="pop ctx-menu"
        role="menu"
        aria-label={label}
        style={pos === null ? { left: anchor.x, top: anchor.y, visibility: 'hidden' } : pos}
        onKeyDown={(e) => {
          onKeyDown(e, 'root');
        }}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        {items.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            expanded={sub?.id === entry.id}
            onPick={pick}
            onHover={(row) => {
              row.focus();
              clearTimer();
              if (entry.kind === 'sub' && entry.disabled !== true) {
                if (sub?.id === entry.id) return;
                timer.current = setTimeout(() => {
                  openSub(entry.id, row, false);
                }, SUB_OPEN_MS);
              } else if (sub !== null) {
                timer.current = setTimeout(() => {
                  setSub(null);
                }, SUB_CLOSE_MS);
              }
            }}
            onOpenSub={(row) => {
              openSub(entry.id, row, true);
            }}
          />
        ))}
      </div>
      {sub !== null && subEntry !== null && (
        <div
          ref={subRoot}
          className="pop ctx-menu ctx-menu--sub"
          role="menu"
          aria-label={subEntry.label}
          style={{ left: sub.left, top: sub.top }}
          onMouseEnter={clearTimer}
          onKeyDown={(e) => {
            onKeyDown(e, 'sub');
          }}
          onContextMenu={(e) => {
            e.preventDefault();
          }}
        >
          {subEntry.items.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              expanded={false}
              onPick={pick}
              onHover={(row) => {
                row.focus();
              }}
              onOpenSub={() => undefined}
            />
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}

function Row({
  entry,
  expanded,
  onPick,
  onHover,
  onOpenSub,
}: {
  entry: MenuEntry;
  expanded: boolean;
  onPick: (entry: MenuEntry) => void;
  onHover: (row: HTMLElement) => void;
  onOpenSub: (row: HTMLElement) => void;
}) {
  if (entry.kind === 'sep') return <div className="pop__sep" role="separator" />;
  const disabled = entry.disabled === true;
  const isSub = entry.kind === 'sub';
  return (
    <button
      type="button"
      role={
        entry.kind === 'item' && entry.checkbox !== undefined
          ? 'menuitemcheckbox'
          : entry.kind === 'item' && entry.checked !== undefined
            ? 'menuitemradio'
            : 'menuitem'
      }
      className={[
        'pop__item',
        'ctx-menu__item',
        entry.kind === 'item' && entry.danger === true ? 'ctx-menu__item--danger' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-haspopup={isSub ? 'menu' : undefined}
      aria-expanded={isSub ? expanded : undefined}
      aria-checked={
        entry.kind === 'item' && entry.checkbox !== undefined
          ? entry.checkbox
          : entry.kind === 'item' && entry.checked !== undefined
            ? entry.checked
            : undefined
      }
      data-sub={isSub ? entry.id : undefined}
      data-disabled={disabled || undefined}
      onMouseEnter={(e) => {
        onHover(e.currentTarget);
      }}
      onClick={(e) => {
        if (disabled) return;
        if (isSub) onOpenSub(e.currentTarget);
        else onPick(entry);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          if (isSub) onOpenSub(e.currentTarget);
          else onPick(entry);
        }
      }}
    >
      <span className="ctx-menu__check" aria-hidden="true">
        {entry.kind === 'item' && entry.checkbox !== undefined ? (
          <span className={`ctx-menu__box ctx-menu__box--${String(entry.checkbox)}`} />
        ) : (
          entry.kind === 'item' && entry.checked === true && <Icon name="check" size={14} />
        )}
      </span>
      {entry.kind === 'item' && entry.swatch !== undefined && (
        <span
          className="ctx-menu__swatch"
          style={{ background: entry.swatch }}
          aria-hidden="true"
        />
      )}
      <span className="ctx-menu__label">{entry.label}</span>
      {entry.kind === 'item' && entry.hint !== undefined && (
        <span className="pop__item-hint">{entry.hint}</span>
      )}
      {isSub && <Icon name="chevronRight" size={14} />}
    </button>
  );
}

function enabledRows(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(':scope > .ctx-menu__item:not([data-disabled])')];
}

function first(box: HTMLElement): HTMLElement | undefined {
  return enabledRows(box)[0];
}
