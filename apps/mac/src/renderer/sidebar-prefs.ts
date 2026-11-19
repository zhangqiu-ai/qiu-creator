import type { HealthResponse } from '@qiu-creator/contracts';
import type { EventStreamStatus } from '../shared/bridge.js';

/**
 * Sidebar v2 (PT-20261119-001 「v2 · 側欄狀態」, QC-041): width, collapsed
 * rail, saved preferences and the service dot. Framework-free for tests.
 */

export const SIDEBAR_DEFAULT = 232;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_RAIL = 56;
/** ←/→ on the focused resize handle. */
export const SIDEBAR_STEP = 16;
/** Windows narrower than this always show the rail (the text needs the room). */
export const SIDEBAR_FORCE_RAIL_BELOW = 900;

export const WIDTH_KEY = 'qc.sidebar.width';
export const COLLAPSED_KEY = 'qc.sidebar.collapsed';

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

export interface SidebarPrefs {
  width: number;
  collapsed: boolean;
}

/** Minimal storage surface, so tests and a failing localStorage are both fine. */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPrefs(storage: PrefStorage | null): SidebarPrefs {
  try {
    const raw = storage?.getItem(WIDTH_KEY) ?? null;
    const width = raw === null ? SIDEBAR_DEFAULT : clampWidth(Number(raw));
    return { width, collapsed: storage?.getItem(COLLAPSED_KEY) === '1' };
  } catch {
    return { width: SIDEBAR_DEFAULT, collapsed: false };
  }
}

export function savePrefs(storage: PrefStorage | null, prefs: SidebarPrefs): void {
  try {
    storage?.setItem(WIDTH_KEY, String(clampWidth(prefs.width)));
    storage?.setItem(COLLAPSED_KEY, prefs.collapsed ? '1' : '0');
  } catch {
    // A convenience only: the defaults apply next time.
  }
}

/** ⌃⌘S toggles the sidebar (not while an input method is composing). */
export function isToggleShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    e.ctrlKey &&
    e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.isComposing !== true &&
    e.key.toLowerCase() === 's'
  );
}

/** Width after a handle key press, or null for other keys. */
export function widthForKey(width: number, key: string): number | null {
  if (key === 'ArrowLeft') return clampWidth(width - SIDEBAR_STEP);
  if (key === 'ArrowRight') return clampWidth(width + SIDEBAR_STEP);
  if (key === 'Home') return SIDEBAR_MIN;
  if (key === 'End') return SIDEBAR_MAX;
  return null;
}

/** 「最小 200」「最大 320」 while dragging against a limit, else null. */
export function limitLabel(width: number): string | null {
  if (width <= SIDEBAR_MIN) return `最小 ${String(SIDEBAR_MIN)}`;
  if (width >= SIDEBAR_MAX) return `最大 ${String(SIDEBAR_MAX)}`;
  return null;
}

export type ServiceTone = 'ok' | 'bad' | 'restoring';

export interface ServiceSummary {
  tone: ServiceTone;
  /** Accessible name of the dot and title of the popover. */
  title: string;
  realtime: string;
  agentApi: string;
  version: string;
}

/**
 * Green when the service, live updates and the Agent API are all fine; red
 * as soon as one is not (the popover says which). Amber while a backup
 * restore is being applied (QC-031).
 */
export function serviceSummary(input: {
  serviceUp: boolean;
  events: EventStreamStatus | null;
  health: Pick<HealthResponse, 'version' | 'commit'> | null;
  restoring: boolean;
}): ServiceSummary {
  const realtime =
    input.events === 'open' ? '已連線' : input.events === 'reconnecting' ? '已中斷' : '連線中';
  const agentApi = input.serviceUp ? '可用' : '無法使用';
  const commit = input.health?.commit ?? null;
  const version =
    input.health === null
      ? '—'
      : commit === null || commit === ''
        ? input.health.version
        : `${input.health.version} · ${commit.slice(0, 7)}`;
  if (input.restoring) {
    return { tone: 'restoring', title: '還原中', realtime, agentApi, version };
  }
  if (!input.serviceUp) {
    return { tone: 'bad', title: '本機服務未回應', realtime, agentApi, version };
  }
  if (input.events === 'reconnecting') {
    return { tone: 'bad', title: '即時更新已中斷', realtime, agentApi, version };
  }
  return { tone: 'ok', title: '一切正常', realtime, agentApi, version };
}
