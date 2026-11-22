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
import type { ReactNode } from 'react';
import { moves, useMotionMode, type MotionMode } from './motion-mode.js';

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
export type Origin = 'top left' | 'top right' | 'bottom left' | 'bottom right' | 'center';

export type Preset =
  | { kind: 'popover'; origin: Origin }
  | { kind: 'contextMenu' }
  | { kind: 'dialog' }
  | { kind: 'scrim' }
  | { kind: 'panel'; from: 'left' | 'right' }
  | { kind: 'toast' }
  | { kind: 'listItem' }
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
export function Presence({ children }: { children: ReactNode }) {
  const mode = useMotionMode();
  if (mode === 'off') return <>{children}</>;
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
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
 * Everything right of the sidebar (DESIGN.md 動效 · 側欄收合): when the sidebar
 * collapses or expands, the content takes its final width at once and slides
 * from where it was (`layout="position"`, `moderate` / `inOut`), so nothing is
 * re-laid out frame by frame. Dragging the sidebar's edge does not animate.
 */
export function ShellMain({ rail, children }: { rail: boolean; children: ReactNode }) {
  const mode = useMotionMode();
  return (
    <motion.div
      className="shell__main"
      layout={moves(mode) ? 'position' : false}
      layoutDependency={rail}
      transition={tween('moderate', 'inOut')}
    >
      {children}
    </motion.div>
  );
}
