import {
  defaultDropAnimationSideEffects,
  PointerSensor,
  useSensor,
  useSensors,
  type DropAnimation,
} from '@dnd-kit/core';
import { CSS, type Transform } from '@dnd-kit/utilities';
import { DRAG_ACTIVATION_PX, duration, easing, motionScale } from '@qiu-creator/design-tokens';
import type { MotionMode } from './motion-mode.js';

/**
 * dnd-kit with the App's motion (DESIGN.md 動效 · 拖放, QC-065): every drag in
 * the App (project rows, works onto projects, editor tabs, image-post tiles)
 * uses these sensors, drop animations and sorting transitions, so none sets
 * its own timings.
 */

/** Pointer drags start after 4 px, so a click still opens and a double-click still renames. */
export function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_PX } }),
  );
}

/** How the floating copy leaves when the pointer is released (DESIGN.md 動效 · 拖放). */
export type Landing = 'into' | 'sort' | 'cancel';

/** Into a project row: the copy shrinks to 0.6 and fades where it was let go. */
export function dropIntoKeyframes(at: Transform): Keyframe[] {
  return [
    { opacity: 1, transform: CSS.Transform.toString(at) },
    {
      opacity: 0,
      transform: CSS.Transform.toString({
        ...at,
        scaleX: motionScale.dropInto,
        scaleY: motionScale.dropInto,
      }),
    },
  ];
}

/** dnd-kit's options form of a drop animation (it also takes a function). */
type DropAnimationOptions = Exclude<DropAnimation, (...args: never[]) => unknown>;

export function dropAnimationFor(landing: Landing, mode: MotionMode): DropAnimationOptions | null {
  // Reduced motion and test mode: straight to the end state.
  if (mode !== 'full') return null;
  const sideEffects = defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } });
  if (landing === 'into') {
    // Shrink and fade where it was let go.
    return {
      duration: duration.base,
      easing: easing.out,
      sideEffects,
      keyframes: ({ transform }) => dropIntoKeyframes(transform.initial),
    };
  }
  // A row settles into its new place; a cancelled drag flies back where it came from.
  return landing === 'sort'
    ? { duration: duration.base, easing: easing.out, sideEffects }
    : { duration: duration.moderate, easing: easing.inOut, sideEffects };
}

/** How sortable items move aside: `base` / ease-out, or not at all without full motion. */
export function sortTransition(mode: MotionMode): { duration: number; easing: string } | null {
  return mode === 'full' ? { duration: duration.base, easing: easing.out } : null;
}
