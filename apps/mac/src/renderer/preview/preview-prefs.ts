import type { PrefStorage } from '../sidebar-prefs.js';
import { SCREENS, type Screen } from './phone-model.js';

/**
 * The preview split's zoom, size and remembered choices (QC-084,
 * PT-20261123-001). Framework-free for tests.
 *
 * The phone is a fixed 390×844 device; only its screen scrolls. Zoom scales
 * the whole device inside the stage: 適應高度 (default) shows all of it,
 * 適應寬度 fills the split's width, or a fixed percentage. Pinching gives any
 * percentage between the bounds.
 */

export const PHONE_W = 390;
export const PHONE_H = 844;
/**
 * Room the stage keeps around the phone: the 模擬 badge and 復原 above, the
 * position dots below. Screen tabs and zoom sit in a bar above the stage (QC-085).
 */
export const STAGE_PAD = { top: 44, bottom: 36, side: 20 } as const;

export const ZOOM_STEPS = [50, 75, 100, 150] as const;
export const ZOOM_MIN = 25;
export const ZOOM_MAX = 300;

export type ZoomChoice =
  { kind: 'fit-height' } | { kind: 'fit-width' } | { kind: 'percent'; percent: number };

export const FIT_HEIGHT: ZoomChoice = { kind: 'fit-height' };

const clampPercent = (p: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(p)));

/** The scale for a choice in a stage of `w`×`h` CSS pixels. */
export function scaleFor(choice: ZoomChoice, stage: { w: number; h: number }): number {
  if (choice.kind === 'percent') return clampPercent(choice.percent) / 100;
  const raw =
    choice.kind === 'fit-height'
      ? (stage.h - STAGE_PAD.top - STAGE_PAD.bottom) / PHONE_H
      : (stage.w - STAGE_PAD.side * 2) / PHONE_W;
  if (!Number.isFinite(raw) || raw <= 0) return ZOOM_MIN / 100;
  return Math.min(ZOOM_MAX / 100, Math.max(ZOOM_MIN / 100, raw));
}

/** ⌘＋ / ⌘－: the next fixed step above or below the current scale. */
export function stepZoom(scale: number, dir: 1 | -1): ZoomChoice {
  const now = Math.round(scale * 100);
  if (dir === 1) {
    const next = ZOOM_STEPS.find((s) => s > now);
    return { kind: 'percent', percent: next ?? ZOOM_MAX };
  }
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < now);
  return { kind: 'percent', percent: prev ?? ZOOM_MIN };
}

/** Pinch: scale follows the fingers (a ctrl-wheel delta on macOS trackpads). */
export function pinchZoom(scale: number, deltaY: number): ZoomChoice {
  return { kind: 'percent', percent: clampPercent(scale * 100 * Math.exp(-deltaY / 100)) };
}

/** ⌘0 / ⌘＋ / ⌘－ (with = and the shifted ＋), or null for other keys. */
export function zoomKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): 'fit' | 'in' | 'out' | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === '0') return 'fit';
  if (e.key === '=' || e.key === '+') return 'in';
  if (e.key === '-' || e.key === '_') return 'out';
  return null;
}

/**
 * Where a phone taller than the room rests: its top at the top of the room
 * (QC-084 pre-release), not centred with the top cut off.
 * The offset is from the centred position; space-drag pans from here.
 */
export function restingPan(
  phone: { w: number; h: number },
  stage: { w: number; h: number },
): { x: number; y: number } {
  const room = stage.h - STAGE_PAD.top - STAGE_PAD.bottom;
  return { x: 0, y: Math.max(0, (phone.h - room) / 2) };
}

/** Pan offset kept so at least part of the phone stays in the stage. */
export function clampPan(
  pan: { x: number; y: number },
  phone: { w: number; h: number },
  stage: { w: number; h: number },
): { x: number; y: number } {
  const room = (p: number, s: number, margin: number) => Math.max(0, (p - s) / 2 + margin);
  const rx = room(phone.w, stage.w, 40);
  // Vertically the resting place (top at the top of the room) must be reachable.
  const ry = room(phone.h, stage.h, Math.max(STAGE_PAD.top, STAGE_PAD.bottom));
  return {
    x: Math.min(rx, Math.max(-rx, pan.x)),
    y: Math.min(ry, Math.max(-ry, pan.y)),
  };
}

/** Two-finger horizontal swipe: accumulated deltaX past this switches screens. */
export const SWIPE_PX = 60;

/** What the preview remembers; width and open/closed belong to the editor sidebar (QC-085). */
export interface PreviewPrefs {
  zoom: ZoomChoice;
  /** First open lands on 刷到時: it shows best how title and cover look. */
  screen: Screen;
  follow: boolean;
}

export const DEFAULT_PREFS: PreviewPrefs = {
  zoom: FIT_HEIGHT,
  screen: 'feed',
  follow: true,
};

const KEY = 'qc.preview.v2';

function parseZoom(v: unknown): ZoomChoice {
  if (typeof v !== 'object' || v === null) return FIT_HEIGHT;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'fit-width') return { kind: 'fit-width' };
  const percent = (v as { percent?: unknown }).percent;
  if (kind === 'percent' && typeof percent === 'number' && Number.isFinite(percent)) {
    return { kind: 'percent', percent: clampPercent(percent) };
  }
  return FIT_HEIGHT;
}

export function loadPreviewPrefs(storage: PrefStorage | null): PreviewPrefs {
  try {
    const raw = storage?.getItem(KEY) ?? null;
    if (raw === null) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const screen = SCREENS.find((s) => s === v['screen']) ?? DEFAULT_PREFS.screen;
    return {
      zoom: parseZoom(v['zoom']),
      screen,
      follow: v['follow'] !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePreviewPrefs(storage: PrefStorage | null, prefs: PreviewPrefs): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // A convenience only: the defaults apply next time.
  }
}

/** Which block of the derived body holds a source offset (follow), or null. */
export function blockAt(
  blocks: readonly { sourceStart: number; sourceEnd: number }[],
  offset: number,
): number | null {
  let best: number | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b === undefined) continue;
    if (offset >= b.sourceStart && offset <= b.sourceEnd) return i;
    if (b.sourceStart <= offset) best = i;
  }
  return best;
}
