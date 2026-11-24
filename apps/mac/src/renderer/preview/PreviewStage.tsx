import { animate, motion, useMotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n.js';
import { Icon } from '../Icon.js';
import { springOf, tween } from '../motion.js';
import { moves, useMotionMode } from '../motion-mode.js';
import {
  BodyScreen,
  FeedScreen,
  PublishScreen,
  statusBarColor,
  screenTone,
} from './PhoneScreens.js';
import { SCREENS, type PhoneActions, type PhoneModel, type Screen } from './phone-model.js';
import {
  clampPan,
  restingPan,
  FIT_HEIGHT,
  PHONE_H,
  PHONE_W,
  pinchZoom,
  scaleFor,
  stepZoom,
  SWIPE_PX,
  ZOOM_STEPS,
  zoomKey,
  type ZoomChoice,
} from './preview-prefs.js';

/** Width of one screen inside the bezel (390 − 2 × 11). */
const PAGE_W = PHONE_W - 22;

const SCREEN_LABEL = {
  publish: 'previewPanel.screenPublish',
  feed: 'previewPanel.screenFeed',
  body: 'previewPanel.screenBody',
} as const;

export function zoomLabel(choice: ZoomChoice): string {
  if (choice.kind === 'fit-height') return t('previewPanel.fitHeight');
  if (choice.kind === 'fit-width') return t('previewPanel.fitWidth');
  return '';
}

function useStageSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = () => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return size;
}

export interface PreviewStageProps {
  model: PhoneModel;
  actions: PhoneActions;
  screen: Screen;
  onScreen: (screen: Screen) => void;
  zoom: ZoomChoice;
  onZoom: (zoom: ZoomChoice) => void;
  /** Field to focus on the publish screen after a tap elsewhere; `n` makes each ask new. */
  focus: { field: 'title' | 'cover' | 'tags'; n: number } | null;
  /** A bottom sheet inside the phone (AI 標題, 選封面), or null. */
  sheet: ReactNode;
  /** Bumped when follow should scroll the body screen to the current block. */
  followTick: number;
  /** Follow scrolls smoothly unless reduced motion. */
  follow: boolean;
}

/**
 * The stage (QC-084, PT-20261123-001 v2): the screen tabs 發布編輯｜刷到時｜正文,
 * the phone at a fixed device size scaled by the zoom choice, position dots and
 * the zoom pill. Only the current screen scrolls; the stage itself never does.
 * Two-finger horizontal swipes and ←／→ on the tabs switch screens; ⌘0,
 * ⌘＋／⌘－ and pinching zoom while the pointer or focus is in the stage; with
 * the phone larger than the stage, hold Space and drag to pan.
 */
export function PreviewStage({
  model,
  actions,
  screen,
  onScreen,
  zoom,
  onZoom,
  focus,
  sheet,
  followTick,
  follow,
}: PreviewStageProps) {
  const mode = useMotionMode();
  const animated = moves(mode);
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useStageSize(stageRef);
  const scale = size.w === 0 ? 1 : scaleFor(zoom, size);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinching = useRef(false);
  const hover = useRef(false);
  const index = SCREENS.indexOf(screen);
  const pagerX = useMotionValue(-index * PAGE_W);
  const phoneW = PHONE_W * scale;
  const phoneH = PHONE_H * scale;
  const shownPan = clampPan(pan, { w: phoneW, h: phoneH }, size);
  // Latest values for the native listeners below.
  const live = useRef({ scale, size, screen, onScreen, onZoom });
  live.current = { scale, size, screen, onScreen, onZoom };

  // Screen switch: a horizontal slide (base), or a jump without full motion.
  useEffect(() => {
    const to = -index * PAGE_W;
    if (!animated) {
      pagerX.set(to);
      return;
    }
    const a = animate(pagerX, to, tween('base'));
    return () => {
      a.stop();
    };
  }, [index, animated, pagerX]);

  // Pinch (ctrl-wheel) and two-finger horizontal swipes need a non-passive listener.
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    let swipe = 0;
    let locked = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        pinching.current = true;
        live.current.onZoom(pinchZoom(live.current.scale, e.deltaY));
        return;
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        swipe = 0;
        locked = false;
      }, 220);
      if (locked) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) < SWIPE_PX) return;
      const i = SCREENS.indexOf(live.current.screen) + (swipe > 0 ? 1 : -1);
      const next = SCREENS[i];
      locked = true;
      swipe = 0;
      if (next !== undefined) live.current.onScreen(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (idle !== null) clearTimeout(idle);
    };
  }, []);

  // ⌘0 / ⌘＋ / ⌘－ only while the pointer or focus is in the stage; elsewhere the App's own zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = boxRef.current;
      if (el === null || e.isComposing) return;
      const inside = hover.current || el.contains(document.activeElement);
      if (!inside) return;
      const k = zoomKey(e);
      if (k !== null) {
        e.preventDefault();
        e.stopPropagation();
        pinching.current = false;
        live.current.onZoom(
          k === 'fit' ? FIT_HEIGHT : stepZoom(live.current.scale, k === 'in' ? 1 : -1),
        );
        return;
      }
      if (e.key === ' ' && !e.repeat && !isInteractive(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  // A new zoom choice from the pill or keys puts the phone back at rest: centred when it fits,
  // else with its top just under the screen tabs (nothing floats over the top of the phone).
  const measured = size.w > 0;
  useEffect(() => {
    if (!measured || pinching.current) return;
    // Only a new choice (or the first measurement) moves it; resizing keeps the pan.
    const { scale: s, size: at } = live.current;
    setPan(restingPan({ w: PHONE_W * s, h: PHONE_H * s }, at));
  }, [zoom, measured]);

  // Follow: bring the current block of the body screen into view.
  useEffect(() => {
    if (followTick === 0 || screen !== 'body') return;
    const page = stageRef.current?.querySelector<HTMLElement>('[data-screen="body"]');
    const block = page?.querySelector<HTMLElement>('.curp');
    if (page == null || block == null) return;
    const top =
      (block.getBoundingClientRect().top - page.getBoundingClientRect().top) / scale +
      page.scrollTop -
      160;
    page.scrollTo({ top: Math.max(0, top), behavior: follow && animated ? 'smooth' : 'auto' });
  }, [followTick, screen, scale, follow, animated]);

  // The first layout after the stage is measured jumps into place: nothing springs in from scale 1.
  const settled = useRef(false);
  useEffect(() => {
    if (measured) settled.current = true;
  }, [measured]);
  const spring =
    animated && settled.current && !pinching.current ? springOf('snappy') : { duration: 0 };
  const zoomed = scale * 100;

  return (
    <div
      ref={boxRef}
      className="pv-stagebox"
      onPointerEnter={() => {
        hover.current = true;
      }}
      onPointerLeave={() => {
        hover.current = false;
      }}
    >
      {/* Screen tabs on the left, zoom on the right: a bar above the stage, never over the phone (QC-085). */}
      <div className="pv-stage__bar">
        <div
          className="seg pv-stage__screens"
          role="tablist"
          aria-label={t('previewPanel.screens')}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = SCREENS[index + (e.key === 'ArrowRight' ? 1 : -1)];
            if (next === undefined) return;
            onScreen(next);
            requestAnimationFrame(() => {
              boxRef.current?.querySelector<HTMLElement>(`[data-screen-tab="${next}"]`)?.focus();
            });
          }}
        >
          {SCREENS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              data-screen-tab={s}
              aria-selected={s === screen}
              tabIndex={s === screen ? 0 : -1}
              onClick={() => {
                onScreen(s);
              }}
            >
              {t(SCREEN_LABEL[s])}
            </button>
          ))}
        </div>
        <div className="pv-zoom" role="group" aria-label={t('previewPanel.zoom')}>
          <button
            type="button"
            aria-label={t('previewPanel.zoomOut')}
            title={`${t('previewPanel.zoomOut')} ⌘−`}
            onClick={() => {
              onZoom(stepZoom(scale, -1));
            }}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="pv-zoom__val"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((o) => !o);
            }}
          >
            {zoomLabel(zoom)}
            <span className="pv-zoom__pct">{`${String(Math.round(zoomed))}%`}</span>
          </button>
          <button
            type="button"
            aria-label={t('previewPanel.zoomIn')}
            title={`${t('previewPanel.zoomIn')} ⌘＋`}
            onClick={() => {
              onZoom(stepZoom(scale, 1));
            }}
          >
            <Icon name="plus" size={14} />
          </button>
          {menuOpen && (
            <ZoomMenu
              zoom={zoom}
              onPick={(z) => {
                setMenuOpen(false);
                onZoom(z);
              }}
              onClose={() => {
                setMenuOpen(false);
              }}
            />
          )}
        </div>
      </div>
      <div
        ref={stageRef}
        className={`pv-stage${spaceDown ? ' pv-stage--pan' : ''}${dragging ? ' pv-stage--panning' : ''}`}
        onPointerDown={(e) => {
          if (!spaceDown) return;
          e.preventDefault();
          const start = { x: e.clientX - shownPan.x, y: e.clientY - shownPan.y };
          setDragging(true);
          const move = (ev: PointerEvent) => {
            setPan({ x: ev.clientX - start.x, y: ev.clientY - start.y });
          };
          const up = () => {
            setDragging(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      >
        <span className="pv-stage__sim" title={t('library.simulationNote')}>
          {t('previewPanel.simulated')}
        </span>

        <motion.div
          className="pv-phwrap"
          style={measured ? undefined : { visibility: 'hidden' }}
          initial={false}
          animate={{ width: phoneW, height: phoneH, x: shownPan.x, y: shownPan.y }}
          transition={dragging ? { duration: 0 } : spring}
          onAnimationComplete={() => {
            pinching.current = false;
          }}
        >
          <motion.div
            className="pv-phone"
            data-tone={screenTone(model.platform, screen)}
            initial={false}
            animate={{ scale }}
            transition={spring}
            aria-label={t('previewPanel.phone')}
            role="group"
          >
            <div
              className="pv-phone__bar"
              style={{ background: statusBarColor(model.platform, screen) }}
              aria-hidden="true"
            >
              <span>9:41</span>
              <span className="pv-phone__sig">
                <i />
                <i />
                <i />
                <b />
              </span>
            </div>
            <motion.div className="pv-pager" style={{ x: pagerX }}>
              {SCREENS.map((s) => (
                <div
                  key={s}
                  className="pv-page"
                  data-tone={screenTone(model.platform, s)}
                  aria-hidden={s !== screen}
                  inert={s !== screen}
                >
                  {s === 'publish' && (
                    <PublishScreen
                      model={model}
                      actions={actions}
                      focus={screen === 'publish' && focus !== null ? focus.field : null}
                      key={focus?.n ?? 0}
                    />
                  )}
                  {s === 'feed' && <FeedScreen model={model} actions={actions} />}
                  {s === 'body' && <BodyScreen model={model} actions={actions} />}
                </div>
              ))}
            </motion.div>
            {sheet}
          </motion.div>
        </motion.div>

        <div className="pv-dots" aria-hidden="true">
          {SCREENS.map((s) => (
            <i key={s} className={s === screen ? 'on' : undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Space pans only when it would not type or press something (buttons, dnd handles, fields). */
function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('button, input, textarea, select, a[href], [role="button"], [tabindex]') !== null
  );
}

const same = (a: ZoomChoice, b: ZoomChoice): boolean =>
  a.kind === b.kind && (a.kind !== 'percent' || (b.kind === 'percent' && a.percent === b.percent));

function ZoomMenu({
  zoom,
  onPick,
  onClose,
}: {
  zoom: ZoomChoice;
  onPick: (z: ZoomChoice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')
      ?.focus();
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || ref.current?.parentElement?.contains(e.target) !== true) {
        onClose();
      }
    };
    window.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
    };
  }, [onClose]);
  const items: { z: ZoomChoice; label: string; key?: string }[] = [
    { z: FIT_HEIGHT, label: t('previewPanel.fitHeight'), key: '⌘0' },
    { z: { kind: 'fit-width' }, label: t('previewPanel.fitWidth') },
    ...ZOOM_STEPS.map((p): { z: ZoomChoice; label: string } => ({
      z: { kind: 'percent', percent: p },
      label: `${String(p)}%`,
    })),
  ];
  return (
    <div
      ref={ref}
      className="pv-zmenu"
      role="menu"
      aria-label={t('previewPanel.zoom')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const all = [
          ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
        ];
        const i = all.indexOf(document.activeElement as HTMLElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.label}
          type="button"
          role="menuitemradio"
          aria-checked={same(it.z, zoom)}
          className={i === 2 ? 'pv-zmenu__sep' : undefined}
          onClick={() => {
            onPick(it.z);
          }}
        >
          {it.label}
          {it.key !== undefined && <kbd>{it.key}</kbd>}
        </button>
      ))}
    </div>
  );
}
