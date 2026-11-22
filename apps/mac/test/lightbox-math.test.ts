import { describe, expect, it } from 'vitest';
import {
  clampPan,
  expandFrom,
  fitScale,
  MAX_SCALE,
  stepIndex,
  toggledScale,
  zoomed,
} from '../src/renderer/lightbox-math.js';

describe('large preview math (QC-077)', () => {
  it('fits a big picture and never enlarges a small one', () => {
    expect(fitScale({ width: 1000, height: 800 }, { width: 2000, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 1000, height: 800 }, { width: 500, height: 400 })).toBe(1);
    expect(fitScale({ width: 1000, height: 800 }, { width: 1000, height: 3200 })).toBe(0.25);
    expect(fitScale({ width: 0, height: 0 }, { width: 10, height: 10 })).toBe(1);
  });

  it('zooms in steps, between half of fit and the maximum', () => {
    expect(zoomed(1, 0.5, 1)).toBeCloseTo(1.25);
    expect(zoomed(1, 0.5, -1)).toBeCloseTo(0.8);
    expect(zoomed(0.26, 0.5, -1)).toBe(0.25);
    expect(zoomed(MAX_SCALE, 0.5, 1)).toBe(MAX_SCALE);
  });

  it('double-click goes from fit to 100% and back', () => {
    expect(toggledScale(0.5, 0.5)).toBe(1);
    expect(toggledScale(1, 0.5)).toBe(0.5);
    expect(toggledScale(2, 0.5)).toBe(0.5);
  });

  it('moves between items and stops at the ends', () => {
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(2);
  });

  it('keeps a dragged picture within its overflow', () => {
    const stage = { width: 1000, height: 800 };
    expect(clampPan({ x: 999, y: -999 }, stage, { width: 1400, height: 1000 })).toEqual({
      x: 200,
      y: -100,
    });
    expect(clampPan({ x: 50, y: 50 }, stage, { width: 600, height: 400 })).toEqual({ x: 0, y: 0 });
  });

  it('grows from the thumbnail: centre offset and size ratio', () => {
    const from = expandFrom(
      { left: 100, top: 100, width: 100, height: 100 },
      { left: 0, top: 0, width: 400, height: 400 },
    );
    expect(from).toEqual({ x: -50, y: -50, scale: 0.25 });
  });
});
