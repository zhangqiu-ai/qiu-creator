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

/**
 * Into a project row (DESIGN.md 動效 · 拖放：放下): the copy flies toward the
 * row's centre (`toward`, from where it was let go) while it shrinks to 0.6
 * and fades, so it shows where the works went.
 */
export function dropIntoKeyframes(at: Transform, toward = { x: 0, y: 0 }): Keyframe[] {
  return [
    { opacity: 1, transform: CSS.Transform.toString(at) },
    {
      opacity: 0,
      transform: CSS.Transform.toString({
        x: at.x + toward.x,
        y: at.y + toward.y,
        scaleX: motionScale.dropInto,
        scaleY: motionScale.dropInto,
      }),
    },
  ];
}

/** A box on screen (dnd-kit's ClientRect has these too). */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far the copy's centre is from the target's centre. */
export function towardCentre(copy: Rect, target: Rect): { x: number; y: number } {
  return {
    x: target.left + target.width / 2 - (copy.left + copy.width / 2),
    y: target.top + target.height / 2 - (copy.top + copy.height / 2),
  };
}

/** dnd-kit's options form of a drop animation (it also takes a function). */
type DropAnimationOptions = Exclude<DropAnimation, (...args: never[]) => unknown>;

export function dropAnimationFor(
  landing: Landing,
  mode: MotionMode,
  /** Where an 'into' drop lands (the target row), when known. */
  target: () => Rect | null = () => null,
): DropAnimationOptions | null {
  // Reduced motion and test mode: straight to the end state.
  if (mode !== 'full') return null;
  const sideEffects = defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } });
  if (landing === 'into') {
    // Fly into the target row, shrinking and fading.
    return {
      duration: duration.base,
      easing: easing.out,
      sideEffects,
      keyframes: ({ transform, dragOverlay }) => {
        const to = target();
        return dropIntoKeyframes(
          transform.initial,
          to === null ? undefined : towardCentre(dragOverlay.rect, to),
        );
      },
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
