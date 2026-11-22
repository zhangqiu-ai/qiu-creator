import {
  duration,
  easingCurve,
  motionDistance,
  motionScale,
  spring,
  type DurationToken,
} from '@qiu-creator/design-tokens';
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useIsPresent,
  type HTMLMotionProps,
  type Transition,
  type Variants,
} from 'motion/react';
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { currentMotionMode, moves, useMotionMode, type MotionMode } from './motion-mode.js';

/**
 * The App's motion vocabulary (DESIGN.md 動效, QC-065): token-based transitions
 * and the presets every page uses. Pages never set their own durations or
 * curves; they pick a preset and wrap leaving elements in <Presence>.
 * `motion` lives only here and in the renderer; `packages/*` hold the numbers.
 */

type Curve = keyof typeof easingCurve;

/** A tween of a duration token on a curve token. */
export function tween(d: DurationToken, curve: Curve = 'out'): Transition {
  return { type: 'tween', duration: duration[d] / 1000, ease: [...easingCurve[curve]] };
}

/** `snappy` for layout and indicators, `settle` for drops and check marks. */
export function springOf(name: keyof typeof spring): Transition {
  return { type: 'spring', ...spring[name] };
}

/** Where a popover grows from: the side of its trigger (it flips when the menu opens upwards). */
export type Origin =
  'top left' | 'top right' | 'bottom left' | 'bottom right' | 'bottom center' | 'center';

export type Preset =
  | { kind: 'popover'; origin: Origin }
  | { kind: 'contextMenu' }
  | { kind: 'dialog' }
  | { kind: 'scrim' }
  | { kind: 'panel'; from: 'left' | 'right' }
  /** `stacked`: other toasts are showing, so this one comes up with them (no overlap). */
  | { kind: 'toast'; stacked?: boolean }
  | { kind: 'listItem' }
  /** A generated image or its placeholder (QC-074): a slower fade, no movement or scale. */
  | { kind: 'reveal' }
  | { kind: 'fade' };

/**
 * initial / animate / exit for a preset (DESIGN.md 動效 · 各類互動). Without full
 * motion only opacity changes, in `fast`; in test mode nothing animates at all.
 */
export function presetVariants(preset: Preset, mode: MotionMode): Variants {
  if (mode === 'off') {
    const none = { duration: 0 };
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1, transition: none },
      exit: { opacity: 0, transition: none },
    };
  }
  if (!moves(mode)) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: tween('fast', 'out') },
      exit: { opacity: 0, transition: tween('fast', 'in') },
    };
  }
  const fadeOut = { opacity: 0, transition: tween('fast', 'in') };
  switch (preset.kind) {
    case 'popover': {
      const up = preset.origin.startsWith('bottom');
      return {
        initial: {
          opacity: 0,
          scale: motionScale.menu,
          y: up ? motionDistance.nudge : -motionDistance.nudge,
        },
        animate: { opacity: 1, scale: 1, y: 0, transition: tween('base', 'out') },
        exit: fadeOut,
      };
    }
    case 'contextMenu':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween('instant', 'out') },
        exit: fadeOut,
      };
    case 'dialog':
      return {
        initial: { opacity: 0, scale: motionScale.dialog },
        animate: { opacity: 1, scale: 1, transition: tween('moderate', 'out') },
        exit: fadeOut,
      };
    case 'scrim':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween('base', 'out') },
        exit: fadeOut,
      };
    case 'panel': {
      const x = preset.from === 'right' ? motionDistance.panel : -motionDistance.panel;
      return {
        initial: { opacity: 0, x },
        animate: { opacity: 1, x: 0, transition: tween('moderate', 'out') },
        exit: { opacity: 0, x, transition: tween('base', 'in') },
      };
    }
    case 'toast':
      // Joining a stack (QC-073): the others slide up by this toast's height and the gap on
      // the `snappy` spring; this one rises on the same spring from a little more than its own
      // height below (the layout slide starts a frame later), so the two never overlap.
      if (preset.stacked === true)
        return {
          initial: { opacity: 0, y: '150%' },
          animate: { opacity: 1, y: 0, transition: springOf('snappy') },
          exit: fadeOut,
        };
      return {
        initial: { opacity: 0, y: motionDistance.rise },
        animate: { opacity: 1, y: 0, transition: tween('base', 'out') },
        exit: fadeOut,
      };
    case 'listItem':
      return {
        initial: { opacity: 0, scale: 0.98 },
        animate: { opacity: 1, scale: 1, transition: tween('base', 'out') },
        exit: { opacity: 0, scale: 0.98, transition: tween('fast', 'in') },
      };
    case 'reveal':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween('moderate', 'out') },
        exit: fadeOut,
      };
    case 'fade':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: tween('fast', 'out') },
        exit: fadeOut,
      };
  }
}

/**
 * The App's motion settings: in test mode every motion animation takes no
 * time; in reduced and lite modes transforms and layout animations are off
 * (only opacity changes). Wraps the whole App once.
 */
export function AppMotion({ children }: { children: ReactNode }) {
  const mode = useMotionMode();
  return (
    <MotionConfig
      reducedMotion={moves(mode) ? 'never' : 'always'}
      {...(mode === 'off' ? { transition: { duration: 0 } } : {})}
    >
      {children}
    </MotionConfig>
  );
}

/**
 * AnimatePresence for the App: leaving elements play their exit, except in
 * test mode, where they go at once (no AnimatePresence at all), so a test
 * never waits on an animation.
 */
export function Presence({
  children,
  popLayout = false,
}: {
  children: ReactNode;
  /** A leaving item stops taking space at once, so the others close the gap while it fades. */
  popLayout?: boolean;
}) {
  const mode = useMotionMode();
  if (mode === 'off') return <>{children}</>;
  return (
    <AnimatePresence initial={false} mode={popLayout ? 'popLayout' : 'sync'}>
      {children}
    </AnimatePresence>
  );
}

/**
 * A motion.div playing a preset. While it leaves it is `inert` and takes no
 * pointer, so nothing can click or Tab into what is going away; focus moves
 * in on mount without waiting for the entrance (DESIGN.md 動效 · 無障礙).
 */
export function Animated({
  preset,
  style,
  ...rest
}: Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit' | 'variants'> & {
  preset: Preset;
}) {
  const mode = useMotionMode();
  const present = useIsPresent();
  const origin = preset.kind === 'popover' ? preset.origin : 'center';
  return (
    <motion.div
      {...rest}
      variants={presetVariants(preset, mode)}
      initial="initial"
      animate="animate"
      exit="exit"
      inert={!present}
      style={{
        ...style,
        transformOrigin: origin,
        ...(present ? {} : { pointerEvents: 'none' as const }),
      }}
    />
  );
}

/**
 * Everything right of the sidebar. When the sidebar collapses or expands the
 * content takes its final width at once and slides from where it was
 * (sidebar-morph.ts, QC-068); it is opaque so the sidebar can slide under it.
 */
export function ShellMain({ children }: { children: ReactNode }) {
  return <div className="shell__main">{children}</div>;
}

/** How a leaving overlay goes: a plain fade, or a side panel sliding back out to the right. */
export type ExitKind = 'fade' | 'panel';

/** The keyframes and timing a leaving overlay plays (DESIGN.md 動效: exits are quicker than entrances). */
export function exitAnimation(
  kind: ExitKind,
  mode: MotionMode,
): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } | null {
  if (mode === 'off') return null;
  const ease = (curve: readonly number[]) => `cubic-bezier(${curve.join(', ')})`;
  if (kind === 'panel' && moves(mode)) {
    return {
      keyframes: [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: `translateX(${String(motionDistance.panel)}px)` },
      ],
      options: { duration: duration.base, easing: ease(easingCurve.in), fill: 'forwards' },
    };
  }
  return {
    keyframes: [{ opacity: 1 }, { opacity: 0 }],
    options: { duration: duration.fast, easing: ease(easingCurve.in), fill: 'forwards' },
  };
}

/** Marks a still copy that is fading away (useExitFade, the sidebar transition). */
export const LEAVING = 'data-leaving';

/**
 * Whether a dialog (and, with `menus`, a right-click menu) is open, so a
 * shortcut should leave the page alone. Still copies fading away after they
 * closed do not count (QC-073): the person can go on at once.
 */
export function hasOpenLayer(menus = false): boolean {
  const live = `:not([${LEAVING}])`;
  const selector = menus
    ? `[aria-modal="true"]${live}, .ctx-menu${live}`
    : `[aria-modal="true"]${live}`;
  return document.querySelector(selector) !== null;
}

/**
 * Exit animation for an overlay its parent simply stops rendering (menus,
 * dialogs, popovers, panels): when it unmounts, a still copy of it stays
 * where it was, inert and untouchable, and fades (or slides) away, then goes.
 * The real element is gone at once, so nothing waits on the animation and
 * focus has already moved on (DESIGN.md 動效 · 無障礙). Test mode: no copy.
 */
export function useExitFade(ref: RefObject<HTMLElement | null>, kind: ExitKind = 'fade'): void {
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node === null) return;
      const anim = exitAnimation(kind, currentMotionMode());
      const parent = node.parentElement;
      if (anim === null || parent === null || !node.isConnected) return;
      // An <ExitFade> wrapper has no box of its own: the overlay is its child.
      const target = getComputedStyle(node).display === 'contents' ? node.firstElementChild : node;
      if (!(target instanceof HTMLElement)) return;
      const box = target.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      const clone = target.cloneNode(true) as HTMLElement;
      clone.removeAttribute('id');
      for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
      // Only a picture of what left (QC-073): not a dialog or a menu any more, so nothing
      // that asks whether a layer is open (⌘A, ⌘W, ⌘⌫) is held up while it fades.
      for (const el of [clone, ...clone.querySelectorAll('[role], [aria-modal]')]) {
        el.removeAttribute('role');
        el.removeAttribute('aria-modal');
      }
      clone.setAttribute(LEAVING, '');
      clone.inert = true;
      clone.setAttribute('aria-hidden', 'true');
      Object.assign(clone.style, {
        position: 'fixed',
        left: `${String(box.left)}px`,
        top: `${String(box.top)}px`,
        width: `${String(box.width)}px`,
        height: `${String(box.height)}px`,
        margin: '0',
        pointerEvents: 'none',
      });
      // StrictMode's rehearsal unmount (development only) leaves the node in place: no copy then.
      queueMicrotask(() => {
        if (node.isConnected) return;
        parent.append(clone);
        const run = clone.animate(anim.keyframes, anim.options);
        run.onfinish = () => {
          clone.remove();
        };
        run.oncancel = () => {
          clone.remove();
        };
      });
    };
  }, [ref, kind]);
}

/**
 * Wrap an overlay a component shows with `{open && …}` (a dropdown, a popover)
 * so it fades out when closed. The wrapper takes no box (`display: contents`),
 * so the overlay's own positioning is unchanged.
 */
export function ExitFade({ children, kind = 'fade' }: { children: ReactNode; kind?: ExitKind }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitFade(ref, kind);
  return (
    <div ref={ref} className="exit-fade">
      {children}
    </div>
  );
}

/**
 * Most items that may move with a layout animation at once (DESIGN.md 動效 · 效能).
 * Past it, a list changes with one cross-fade instead of item by item.
 */
export const LAYOUT_LIMIT = 40;

/**
 * A list item that fades and scales in when added (`base`), fades out when
 * removed (`fast`), and, with `layout`, slides to its new place (`snappy`)
 * when the list re-orders or filters. Inert while it leaves.
 */
export const AnimatedItem = forwardRef<
  HTMLLIElement,
  Omit<HTMLMotionProps<'li'>, 'initial' | 'animate' | 'exit' | 'variants' | 'layout'> & {
    layout: boolean;
    /** Added without an entrance (e.g. a list re-drawn as a whole). */
    quiet?: boolean;
    /** How it comes and goes; a list item (fade and a slight scale) unless said otherwise. */
    preset?: Preset;
  }
>(function AnimatedItem({ layout, quiet = false, preset, style, ...rest }, ref) {
  const mode = useMotionMode();
  const present = useIsPresent();
  return (
    <motion.li
      ref={ref}
      {...rest}
      variants={presetVariants(preset ?? { kind: 'listItem' }, mode)}
      initial={quiet ? false : 'initial'}
      animate="animate"
      exit="exit"
      layout={layout && moves(mode) ? 'position' : false}
      transition={springOf('snappy')}
      inert={!present}
      style={{ ...style, ...(present ? {} : { pointerEvents: 'none' as const }) }}
    />
  );
});

/** When something loads: nothing, then a skeleton, then the content (DESIGN.md 動效 · 載入骨架). */
export type LoadingView = 'blank' | 'skeleton' | 'content';

/** Skeletons show only after this long, and once shown stay at least this long. */
export const SKELETON_AFTER_MS = 300;

/**
 * A short wait never flashes a skeleton; a longer one shows it for at least
 * 300 ms, so it does not blink away the moment it appears.
 */
export function useSkeletonGate(loading: boolean): LoadingView {
  const [view, setView] = useState<LoadingView>(loading ? 'blank' : 'content');
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (loading) {
      setView('blank');
      shownAt.current = null;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setView('skeleton');
      }, SKELETON_AFTER_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    const since = shownAt.current;
    if (since === null) {
      setView('content');
      return;
    }
    const timer = setTimeout(
      () => {
        shownAt.current = null;
        setView('content');
      },
      Math.max(0, SKELETON_AFTER_MS - (Date.now() - since)),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [loading]);
  return loading && view === 'content' ? 'blank' : view;
}

/**
 * Where keyboard focus goes after items are removed (DESIGN.md 動效 · 刪除):
 * the first item after the removed ones, or else the one before them.
 */
export function focusAfterRemoval(
  order: readonly string[],
  removed: ReadonlySet<string>,
): string | null {
  const first = order.findIndex((id) => removed.has(id));
  if (first < 0) return null;
  const after = order.slice(first).find((id) => !removed.has(id));
  if (after !== undefined) return after;
  return [...order.slice(0, first)].reverse().find((id) => !removed.has(id)) ?? null;
}

/**
 * A small mark that pops in with the `settle` spring (scale 0.8 → 1, a little
 * overshoot), e.g. a card's check mark when it is selected. Fades only without
 * full motion; appears at once in test mode.
 */
export function SettleIn({ className, children }: { className: string; children: ReactNode }) {
  const mode = useMotionMode();
  return (
    <motion.span
      className={className}
      aria-hidden="true"
      initial={mode === 'off' ? false : moves(mode) ? { opacity: 0, scale: 0.8 } : { opacity: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={moves(mode) ? springOf('settle') : tween('fast')}
    >
      {children}
    </motion.span>
  );
}

/**
 * A determinate progress bar's fill (DESIGN.md 動效 · AI 任務進度): it grows
 * with `transform: scaleX`, so no layout runs per frame. Null: indeterminate.
 */
export function progressStyle(pct: number | null): CSSProperties | undefined {
  if (pct === null) return undefined;
  const p = Math.max(0, Math.min(100, pct)) / 100;
  return { transform: `scaleX(${String(p)})` };
}
