import { useSyncExternalStore } from 'react';
import type { MotionPreference } from '../shared/bridge.js';

/**
 * How much motion the App may use (DESIGN.md 動效 · 無障礙、效能、測試模式):
 * - `off`: e2e or `CREATORHUB_MOTION=off` (`<html data-motion="off">`); nothing animates and
 *   leaving elements go at once.
 * - `lite`: the Mac is hot (`<html data-motion="lite">`); `fast` fades only, no layout,
 *   springs or stagger.
 * - `reduced`: macOS 減少動態效果; fades (shortened to `fast`), no movement, scaling or springs.
 * - `full`: everything in the spec.
 */
export type MotionMode = 'full' | 'reduced' | 'lite' | 'off';

const REDUCE = '(prefers-reduced-motion: reduce)';
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Called with what the main process allows, at start and when the Mac heats up or cools. */
export function applyMotionPreference(preference: MotionPreference): void {
  const root = document.documentElement;
  if (preference === 'auto') delete root.dataset['motion'];
  else root.dataset['motion'] = preference;
  notify();
}

export function currentMotionMode(): MotionMode {
  if (typeof document === 'undefined') return 'off';
  const forced = document.documentElement.dataset['motion'];
  if (forced === 'off') return 'off';
  if (typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches)
    return 'reduced';
  if (forced === 'lite') return 'lite';
  return 'full';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCE)
      : null;
  mq?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    mq?.removeEventListener('change', listener);
  };
}

export function useMotionMode(): MotionMode {
  return useSyncExternalStore(subscribe, currentMotionMode, () => 'off');
}

/** Movement, scaling, springs and layout animation are allowed (only in `full`). */
export function moves(mode: MotionMode): boolean {
  return mode === 'full';
}
