import { duration, easingCurve } from '@qiu-creator/design-tokens';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon.js';
import { t } from './i18n.js';
import {
  clampPan,
  expandFrom,
  fitScale,
  stepIndex,
  toggledScale,
  zoomed,
  type Rect,
} from './lightbox-math.js';
import { currentMotionMode, moves } from './motion-mode.js';
import { useExitFade } from './motion.js';

/** One thing the large preview can show. URLs are given, so authorising them stays elsewhere. */
export interface LightboxItem {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio' | 'other';
  readonly name: string;
  /** Natural size when known (an image's width and height). */
  readonly width: number | null;
  readonly height: number | null;
  /** Shown while the original loads. */
  readonly thumbSrc: string | null;
  /** The original file. */
  readonly src: string | null;
  /** Dimensions and the like, shown next to the name. */
  readonly info: string | null;
  readonly icon: IconName;
}

/**
 * Quick Look style large preview (QC-077): the picture fits the window, zooms
 * with ⌘+ ⌘− ⌘0, a pinch or a double-click, pans by dragging; ← → move between
 * items; Esc, space or a click on the backdrop close it. It first shows the
 * thumbnail and swaps in the original once that has loaded. It grows from
 * `origin` (the thumbnail's box) under full motion and just fades otherwise.
 * Focus goes in on open; the host puts it back where it was.
 */
export function Lightbox({
  items,
  index,
  origin,
  onIndex,
  onClose,
  extra,
}: {
  items: readonly LightboxItem[];
  index: number;
  origin: Rect | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Extra controls for the current item (「在 Finder 顯示」 for files that cannot be shown). */
  extra?: (item: LightboxItem) => ReactNode;
}) {
  const item = items[index];
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLDivElement>(null);
  useExitFade(root);

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState<number | null>(null); // null = fit
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [original, setOriginal] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const opened = useRef(false);

  // A new item starts fitted, with its own size; the original loads behind the thumbnail.
  const itemId = item?.id;
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    const item = itemRef.current;
    setScale(null);
    setPan({ x: 0, y: 0 });
    setOriginal(null);
    setFailed(false);
    setNatural(item?.width && item.height ? { width: item.width, height: item.height } : null);
    if (item === undefined || item.kind !== 'image' || item.src === null) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      setOriginal(item.src);
      setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (live) setFailed(true);
    };
    img.src = item.src;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [itemId]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (el === null) return;
    const measure = () => {
      setStageSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // Focus in on open.
  useEffect(() => {
    root.current?.focus();
  }, []);

  const fit = natural === null ? 1 : fitScale(stageSize, natural);
  const current = scale ?? fit;
  const shown =
    natural === null ? null : { width: natural.width * current, height: natural.height * current };

  // Grow from the thumbnail, once, when the first picture is in place.
  useLayoutEffect(() => {
    if (opened.current || shown === null || origin === null) return;
    const fig = figure.current;
    if (fig === null) return;
    opened.current = true;
    if (!moves(currentMotionMode())) return;
    const box = fig.getBoundingClientRect();
    if (box.width === 0) return;
    const from = expandFrom(origin, box);
    fig.animate(
      [
        {
          transform: `translate(${String(from.x)}px, ${String(from.y)}px) scale(${String(from.scale)})`,
        },
        { transform: 'none' },
      ],
      {
        duration: duration.moderate,
        easing: `cubic-bezier(${easingCurve.out.join(',')})`,
      },
    );
  }, [shown, origin]);

  const setZoom = useCallback(
    (next: number) => {
      setScale(next);
      if (natural !== null) {
        setPan((p) =>
          clampPan(p, stageSize, { width: natural.width * next, height: natural.height * next }),
        );
      }
    },
    [natural, stageSize],
  );

  if (item === undefined) return null;
  const isImage = item.kind === 'image';

  const go = (direction: 1 | -1) => {
    const next = stepIndex(index, items.length, direction);
    if (next !== index) onIndex(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const inControl =
      target.tagName === 'VIDEO' || target.tagName === 'AUDIO' || target.tagName === 'BUTTON';
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === ' ' && !inControl) {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowLeft' && target.tagName !== 'VIDEO') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight' && target.tagName !== 'VIDEO') {
      e.preventDefault();
      go(1);
    } else if (isImage && (e.metaKey || e.ctrlKey)) {
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
    } else if (e.key === 'Tab') {
      // Keep focus inside: the controls are few, so cycle through them.
      const focusable = [
        ...(root.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), video[controls], audio[controls]',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        e.preventDefault();
      } else if (e.shiftKey && (target === first || target === root.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && target === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!isImage || natural === null) return;
    if (e.ctrlKey) {
      // A trackpad pinch arrives as a wheel with ctrlKey.
      setZoom(Math.min(8, Math.max(fit / 2, current * Math.exp(-e.deltaY * 0.01))));
    } else if (shown !== null) {
      setPan((p) => clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }, stageSize, shown));
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!isImage || shown === null || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d === null || shown === null) return;
    setPan(clampPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }, stageSize, shown));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const position = t('assets.lightboxPosition', {
    n: String(index + 1),
    total: String(items.length),
  });

  return (
    <div
      ref={root}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('assets.lightbox', { name: item.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="lightbox__bar">
        <span className="lightbox__name" title={item.name}>
          {item.name}
        </span>
        {item.info !== null && <span className="lightbox__info">{item.info}</span>}
        <span className="lightbox__pos" aria-live="polite">
          {position}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon lightbox__close"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>

      <div
        ref={stage}
        className="lightbox__stage"
        onClick={(e) => {
          // A click on the backdrop (not on the picture or a control) closes.
          if (e.target === e.currentTarget) onClose();
        }}
        onWheel={onWheel}
      >
        {isImage && !failed ? (
          shown !== null && (
            <div
              ref={figure}
              className={`lightbox__figure${scale !== null && scale > fit ? ' lightbox__figure--zoomed' : ''}`}
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
                key={original ?? item.thumbSrc ?? 'none'}
                className="lightbox__img"
                src={original ?? item.thumbSrc ?? undefined}
                alt={item.name}
                data-original={original !== null ? 'true' : 'false'}
                draggable={false}
              />
            </div>
          )
        ) : item.kind === 'video' && item.src !== null ? (
          <video
            className="lightbox__video"
            src={item.src}
            controls
            autoPlay
            aria-label={item.name}
          />
        ) : item.kind === 'audio' && item.src !== null ? (
          <audio
            className="lightbox__audio"
            src={item.src}
            controls
            autoPlay
            aria-label={item.name}
          />
        ) : (
          <div className="lightbox__other">
            <Icon name={item.icon} size={48} />
            {failed && <span role="status">{t('assets.previewImageFailed')}</span>}
            {extra?.(item)}
          </div>
        )}
      </div>

      {index > 0 && (
        <button
          type="button"
          className="btn btn--ghost btn--icon lightbox__nav lightbox__nav--prev"
          aria-label={t('assets.lightboxPrev')}
          onClick={() => {
            go(-1);
          }}
        >
          <Icon name="chevronRight" />
        </button>
      )}
      {index < items.length - 1 && (
        <button
          type="button"
          className="btn btn--ghost btn--icon lightbox__nav lightbox__nav--next"
          aria-label={t('assets.lightboxNext')}
          onClick={() => {
            go(1);
          }}
        >
          <Icon name="chevronRight" />
        </button>
      )}
    </div>
  );
}
