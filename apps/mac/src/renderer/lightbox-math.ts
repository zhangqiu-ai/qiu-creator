/** Numbers behind the large preview (QC-077): fitting, zooming and moving between items. */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.25;

/** The scale that fits `natural` in `stage`, never enlarging past 100%. */
export function fitScale(stage: Size, natural: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(1, stage.width / natural.width, stage.height / natural.height);
}

/** One ⌘+ / ⌘− step from `scale`, kept between half of `fit` and `MAX_SCALE`. */
export function zoomed(scale: number, fit: number, direction: 1 | -1): number {
  const next = direction === 1 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
  return Math.min(MAX_SCALE, Math.max(fit / 2, next));
}

/** Double-click: from fit to 100%, from anything else back to fit. */
export function toggledScale(scale: number, fit: number): number {
  return Math.abs(scale - fit) < 0.001 ? 1 : fit;
}

/** The previous (-1) or next (+1) index; it stops at the ends instead of wrapping. */
export function stepIndex(index: number, count: number, direction: 1 | -1): number {
  return Math.min(count - 1, Math.max(0, index + direction));
}

/** Keep the picture from being dragged out of reach: it may move as far as its overflow. */
export function clampPan(
  pan: { x: number; y: number },
  stage: Size,
  shown: Size,
): { x: number; y: number } {
  const limit = (box: number, view: number) => Math.max(0, (box - view) / 2);
  const lx = limit(shown.width, stage.width);
  const ly = limit(shown.height, stage.height);
  return {
    x: Math.min(lx, Math.max(-lx, pan.x)),
    y: Math.min(ly, Math.max(-ly, pan.y)),
  };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Transform that puts the picture's final box over the thumbnail it grows from. */
export function expandFrom(origin: Rect, final: Rect): { x: number; y: number; scale: number } {
  const scale = final.width === 0 ? 1 : origin.width / final.width;
  return {
    x: origin.left + origin.width / 2 - (final.left + final.width / 2),
    y: origin.top + origin.height / 2 - (final.top + final.height / 2),
    scale,
  };
}
