import type { MotionPreference } from '../shared/bridge.js';

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';

/**
 * How much motion the renderer may use (DESIGN.md 動效 · 效能、測試模式):
 * - `CREATORHUB_MOTION=off`, or an e2e run, turns every animation off so tests never wait on one;
 * - `CREATORHUB_MOTION=on` keeps full motion even in e2e, to record it at normal speed;
 * - a hot Mac (thermal state `serious` / `critical`) gets the `lite` set: fades only.
 * Reduce Motion is read by the renderer itself (`prefers-reduced-motion`).
 * Low Power Mode is not exposed by Electron on macOS (QC-065: NOT_VERIFIED), so only heat counts.
 */
export function motionPreference(
  env: Readonly<Record<string, string | undefined>>,
  backgroundRun: boolean,
  thermal: ThermalState,
): MotionPreference {
  const forced = env['CREATORHUB_MOTION'];
  if (forced === 'off') return 'off';
  if (forced !== 'on' && backgroundRun) return 'off';
  if (thermal === 'serious' || thermal === 'critical') return 'lite';
  return 'auto';
}
