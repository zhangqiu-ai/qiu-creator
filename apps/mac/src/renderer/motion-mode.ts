import { useSyncExternalStore } from 'react';

/**
 * How much motion the App may use (DESIGN.md 動效 · 無障礙、測試模式):
 * - `off`: e2e or `CREATORHUB_MOTION=off` (`<html data-motion="off">`); nothing animates.
 * - `reduced`: macOS 減少動態效果; fades only, no movement, scaling or springs.
 * - `full`: everything in the spec.
 * QC-065 adds `lite` (Low Power Mode / thermal pressure) on the same switch.
 */
export type MotionMode = 'full' | 'reduced' | 'off';

const REDUCE = '(prefers-reduced-motion: reduce)';

export function currentMotionMode(): MotionMode {
  if (typeof document === 'undefined') return 'off';
  if (document.documentElement.dataset['motion'] === 'off') return 'off';
  if (typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches)
    return 'reduced';
  return 'full';
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return () => undefined;
  const mq = window.matchMedia(REDUCE);
  mq.addEventListener('change', listener);
  return () => {
    mq.removeEventListener('change', listener);
  };
}

export function useMotionMode(): MotionMode {
  return useSyncExternalStore(subscribe, currentMotionMode, () => 'off');
}
