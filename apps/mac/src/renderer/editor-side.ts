import type { PrefStorage } from './sidebar-prefs.js';

/**
 * The work editor's full-height right sidebar (QC-085, PT-20261123-002 A):
 * which tab is in front, whether it is open, how wide, and whether the
 * window is too narrow so it opens as a drawer over the text. One store per
 * window, shared by every work tab; framework-free for tests.
 */

/** The sidebar's tabs, in bar order. New content gets a new entry here. */
export const SIDE_TABS = ['preview', 'ai', 'history', 'assets'] as const;
export type SideTab = (typeof SIDE_TABS)[number];

export const SIDE_DEFAULT = 520;
export const SIDE_MIN = 400;
export const SIDE_MAX = 760;
/** ←/→ on the focused resize handle. */
export const SIDE_STEP = 16;
/** Collapsed: a 44 px column of tab icons. */
export const SIDE_RAIL = 44;
/** Dragging the edge this far below the minimum snaps the sidebar shut. */
export const SIDE_SNAP_BELOW = SIDE_MIN - 80;
/** An editor column narrower than this turns the sidebar into a drawer over the text. */
export const EDITOR_MIN = 560;

export const SIDE_KEY = 'qc.editorSide.v1';

export interface SidePrefs {
  open: boolean;
  tab: SideTab;
  width: number;
}

export const DEFAULT_SIDE: SidePrefs = { open: true, tab: 'preview', width: SIDE_DEFAULT };

export function clampSide(width: number): number {
  if (!Number.isFinite(width)) return SIDE_DEFAULT;
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(width)));
}

const isTab = (v: unknown): v is SideTab => SIDE_TABS.some((x) => x === v);

export function loadSidePrefs(storage: PrefStorage | null): SidePrefs {
  try {
    const raw = storage?.getItem(SIDE_KEY) ?? null;
    if (raw === null) return DEFAULT_SIDE;
    const v = JSON.parse(raw) as Partial<Record<keyof SidePrefs, unknown>>;
    return {
      open: typeof v.open === 'boolean' ? v.open : DEFAULT_SIDE.open,
      tab: isTab(v.tab) ? v.tab : DEFAULT_SIDE.tab,
      width: typeof v.width === 'number' ? clampSide(v.width) : DEFAULT_SIDE.width,
    };
  } catch {
    return DEFAULT_SIDE;
  }
}

export function saveSidePrefs(storage: PrefStorage | null, prefs: SidePrefs): void {
  try {
    storage?.setItem(SIDE_KEY, JSON.stringify(prefs));
  } catch {
    // A full or blocked storage only loses the remembered choice.
  }
}

/** Too narrow for text and sidebar side by side: the sidebar becomes a drawer. */
export function isDrawer(areaWidth: number, sideWidth: number): boolean {
  return areaWidth > 0 && areaWidth - sideWidth < EDITOR_MIN;
}

/** The tab shown for an editor that offers only some tabs (貼圖 has no AI). */
export function shownTab(wanted: SideTab, offered: readonly SideTab[]): SideTab {
  return offered.includes(wanted) ? wanted : (offered[0] ?? wanted);
}

export interface SideState {
  prefs: SidePrefs;
  /** The window is narrow: the sidebar is a drawer over the text. */
  drawer: boolean;
  /** The drawer is out (narrow windows only; never remembered, so a work opens on its text). */
  drawerOpen: boolean;
  /** Works whose preview goes over a platform limit (the orange dot on 預覽). */
  over: ReadonlySet<string>;
}

export class SideStore {
  private state: SideState;
  private readonly listeners = new Set<() => void>();
  private areaWidth = 0;

  constructor(private readonly storage: PrefStorage | null) {
    this.state = {
      prefs: loadSidePrefs(storage),
      drawer: false,
      drawerOpen: false,
      over: new Set(),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SideState => this.state;

  /** Is the sidebar showing its content (docked open, or the drawer out)? */
  get expanded(): boolean {
    return this.state.drawer ? this.state.drawerOpen : this.state.prefs.open;
  }

  private set(next: Partial<SideState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  private setPrefs(change: Partial<SidePrefs>): void {
    const prefs = { ...this.state.prefs, ...change };
    saveSidePrefs(this.storage, prefs);
    this.set({ prefs });
  }

  private setExpanded(on: boolean): void {
    if (this.state.drawer) this.set({ drawerOpen: on });
    else this.setPrefs({ open: on });
  }

  /** ⌥⌘0 and the collapse button: show or hide, keeping the last tab. */
  toggle(): void {
    this.setExpanded(!this.expanded);
  }

  collapse(): void {
    if (this.expanded) this.setExpanded(false);
  }

  /** Bring a tab forward and make sure the sidebar is open. */
  show(tab: SideTab): void {
    if (this.state.prefs.tab !== tab) this.setPrefs({ tab });
    if (!this.expanded) this.setExpanded(true);
  }

  /** ⌘⇧P, ⌘⇧I: open on that tab, or close when it is already in front. */
  toggleTab(tab: SideTab): void {
    if (this.expanded && this.state.prefs.tab === tab) this.setExpanded(false);
    else this.show(tab);
  }

  /**
   * Dragging the left edge; far enough below the minimum snaps shut, keeping
   * `from` (the width when the drag began) for the next time it opens.
   */
  resize(raw: number, from?: number): void {
    if (raw < SIDE_SNAP_BELOW) {
      if (from !== undefined && from !== this.state.prefs.width) this.setPrefs({ width: from });
      this.collapse();
      return;
    }
    const width = clampSide(raw);
    if (width !== this.state.prefs.width) this.setPrefs({ width });
    this.measure(this.areaWidth);
  }

  /** The editor area's width changed: dock or float the sidebar. */
  measure(areaWidth: number): void {
    this.areaWidth = areaWidth;
    const drawer = isDrawer(areaWidth, this.state.prefs.width);
    if (drawer !== this.state.drawer) this.set({ drawer, drawerOpen: false });
  }

  setOver(workId: string, over: boolean): void {
    if (this.state.over.has(workId) === over) return;
    const next = new Set(this.state.over);
    if (over) next.add(workId);
    else next.delete(workId);
    this.set({ over: next });
  }
}
