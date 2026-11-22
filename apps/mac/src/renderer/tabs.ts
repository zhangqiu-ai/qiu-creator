import type { PersistedTabs, TabKind, TabMode } from '../shared/tabs.js';

export type { PersistedTabs, TabKind, TabMode } from '../shared/tabs.js';

/** The side panel next to the document; it belongs to the tab. */
export type TabPanel = 'ai' | 'history' | 'assets';

/** Where the user was in a tab, kept across switches and unloads. */
export interface TabView {
  mode: TabMode | null;
  /** Caret or selection as a Markdown source range. */
  selection: { start: number; end: number } | null;
  scrollTop: number;
  panel: TabPanel;
}

export interface Tab {
  /** The work id. */
  id: string;
  kind: TabKind;
  title: string;
  /** An editor is mounted for this tab. Unloaded tabs show in italics and load on click. */
  loaded: boolean;
  view: TabView;
  /** The draft differs from what is on the server. */
  unsaved: boolean;
  /** A 409 or a newer revision from elsewhere is waiting for the user. */
  conflict: boolean;
  /** An AI candidate is waiting to be accepted or dismissed. */
  aiCandidate: boolean;
  /** An AI job is running for this tab (keeps it loaded). */
  aiBusy: boolean;
  /** The work could not be opened (deleted meanwhile). */
  missing: boolean;
}

/** A closed tab that 重新開啟 can bring back, with the draft it was closed with. */
export interface ClosedTab<D = unknown> {
  tab: Tab;
  index: number;
  /** The unsaved draft discarded by 不儲存並關閉, offered back on reopen. */
  draft: D | null;
}

export interface TabsState {
  tabs: readonly Tab[];
  activeId: string | null;
  /** The tab to flash (opened again while already open); `flashSeq` restarts the animation. */
  flashId: string | null;
  flashSeq: number;
  /** The last closed tab, while 重新開啟 is offered. */
  closed: ClosedTab | null;
  /** 「已恢復上次的 N 個分頁」 after launch, until dismissed. */
  restored: number | null;
}

export const DEFAULT_VIEW: TabView = { mode: null, selection: null, scrollTop: 0, panel: 'ai' };

/** Editors kept mounted at once; the rest are unloaded (least recently used first). */
export const MAX_LOADED = 8;

export type TabStatusPatch = Partial<
  Pick<Tab, 'title' | 'kind' | 'unsaved' | 'conflict' | 'aiCandidate' | 'aiBusy' | 'missing'>
>;

/** A tab that must not be unloaded: unloading would drop work the user has not settled. */
export function pinned(tab: Tab): boolean {
  return tab.unsaved || tab.conflict || tab.aiCandidate || tab.aiBusy;
}

/**
 * The open editor tabs (QC-047, PT-20261121-001 「多分頁編輯」). Pure state with
 * a subscribe/snapshot pair for `useSyncExternalStore`; no React, no Electron,
 * so the rules are unit-tested:
 *
 * - Opening a work that is already open focuses its tab and flashes it.
 * - At most `maxLoaded` editors stay mounted; switching to an unloaded tab
 *   loads it and unloads the least recently used clean tab. Tabs with unsaved
 *   edits, a conflict or AI work are never unloaded.
 * - 關閉其他 keeps tabs with unsaved edits or a conflict.
 * - The last closed tab can be reopened at its old position.
 */
export class TabsModel {
  private state: TabsState = {
    tabs: [],
    activeId: null,
    flashId: null,
    flashSeq: 0,
    closed: null,
    restored: null,
  };
  private readonly listeners = new Set<() => void>();
  /** Most recently active last. */
  private recency: string[] = [];

  constructor(private readonly maxLoaded: number = MAX_LOADED) {}

  getSnapshot = (): TabsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<TabsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get tabs(): readonly Tab[] {
    return this.state.tabs;
  }

  get active(): Tab | null {
    return this.state.tabs.find((t) => t.id === this.state.activeId) ?? null;
  }

  find(id: string): Tab | null {
    return this.state.tabs.find((t) => t.id === id) ?? null;
  }

  /** Open a work in a new tab, or focus (and flash) the tab that already has it. */
  open(work: { id: string; kind: TabKind; title: string }): 'opened' | 'focused' {
    if (this.find(work.id) !== null) {
      this.activate(work.id);
      this.set({ flashId: work.id, flashSeq: this.state.flashSeq + 1 });
      return 'focused';
    }
    const tab: Tab = {
      id: work.id,
      kind: work.kind,
      title: work.title,
      loaded: true,
      view: DEFAULT_VIEW,
      unsaved: false,
      conflict: false,
      aiCandidate: false,
      aiBusy: false,
      missing: false,
    };
    this.set({ tabs: [...this.state.tabs, tab] });
    this.activate(work.id);
    return 'opened';
  }

  /**
   * 在新分頁開啟 (QC-052): add the tab behind the one in front, without
   * leaving the page; it loads when first shown. Already open: nothing changes.
   */
  openInBackground(work: { id: string; kind: TabKind; title: string }): 'opened' | 'exists' {
    if (this.find(work.id) !== null) return 'exists';
    if (this.state.activeId === null) {
      this.open(work);
      return 'opened';
    }
    const tab: Tab = {
      id: work.id,
      kind: work.kind,
      title: work.title,
      loaded: false,
      view: DEFAULT_VIEW,
      unsaved: false,
      conflict: false,
      aiCandidate: false,
      aiBusy: false,
      missing: false,
    };
    this.set({ tabs: [...this.state.tabs, tab] });
    return 'opened';
  }

  activate(id: string): void {
    if (this.find(id) === null) return;
    this.recency = [...this.recency.filter((r) => r !== id), id];
    this.set({
      activeId: id,
      tabs: this.state.tabs.map((t) => (t.id === id && !t.loaded ? { ...t, loaded: true } : t)),
    });
    this.enforceLimit();
  }

  private enforceLimit(): void {
    const loaded = this.state.tabs.filter((t) => t.loaded);
    let excess = loaded.length - this.maxLoaded;
    if (excess <= 0) return;
    const rank = (id: string) => this.recency.indexOf(id);
    const candidates = loaded
      .filter((t) => t.id !== this.state.activeId && !pinned(t))
      .sort((a, b) => rank(a.id) - rank(b.id));
    const unload = new Set<string>();
    for (const c of candidates) {
      if (excess <= 0) break;
      unload.add(c.id);
      excess -= 1;
    }
    if (unload.size === 0) return;
    this.set({
      tabs: this.state.tabs.map((t) => (unload.has(t.id) ? { ...t, loaded: false } : t)),
    });
  }

  /** Badges and title reported by the tab's editor. */
  update(id: string, patch: TabStatusPatch): void {
    const tab = this.find(id);
    if (tab === null) return;
    const changed = (Object.keys(patch) as (keyof TabStatusPatch)[]).some(
      (k) => patch[k] !== undefined && patch[k] !== tab[k],
    );
    if (!changed) return;
    this.set({ tabs: this.state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    // A tab that just became clean may now be unloaded.
    this.enforceLimit();
  }

  /** Mode, caret, scroll and side panel, saved when the tab is left or unloaded. */
  saveView(id: string, view: TabView): void {
    if (this.find(id) === null) return;
    this.set({ tabs: this.state.tabs.map((t) => (t.id === id ? { ...t, view } : t)) });
  }

  /** The tab to show after `id` is closed: the one to its right, else to its left. */
  private neighbour(id: string): string | null {
    const i = this.state.tabs.findIndex((t) => t.id === id);
    const next = this.state.tabs[i + 1] ?? this.state.tabs[i - 1];
    return next?.id ?? null;
  }

  /** Close a tab. `draft` is what 不儲存並關閉 discarded, kept for 重新開啟. */
  close(id: string, draft: unknown = null): void {
    const index = this.state.tabs.findIndex((t) => t.id === id);
    const tab = this.state.tabs[index];
    if (tab === undefined) return;
    const wasActive = this.state.activeId === id;
    const next = wasActive ? this.neighbour(id) : this.state.activeId;
    this.recency = this.recency.filter((r) => r !== id);
    this.set({
      tabs: this.state.tabs.filter((t) => t.id !== id),
      activeId: next,
      closed: { tab: { ...tab, loaded: false }, index, draft },
      flashId: this.state.flashId === id ? null : this.state.flashId,
    });
    if (wasActive && next !== null) this.activate(next);
  }

  /** 重新開啟: put the last closed tab back where it was. Returns its draft, if any. */
  reopen(): ClosedTab | null {
    const closed = this.state.closed;
    if (closed === null) return null;
    if (this.find(closed.tab.id) !== null) {
      this.set({ closed: null });
      this.activate(closed.tab.id);
      return closed;
    }
    const tabs = [...this.state.tabs];
    tabs.splice(Math.min(closed.index, tabs.length), 0, { ...closed.tab, loaded: true });
    this.set({ tabs, closed: null });
    this.activate(closed.tab.id);
    return closed;
  }

  dismissClosed(): void {
    if (this.state.closed !== null) this.set({ closed: null });
  }

  /**
   * 關閉其他分頁: everything but `keepId`, except tabs with unsaved edits or a
   * conflict. Returns how many were closed.
   */
  closeOthers(keepId: string): number {
    const keep = (t: Tab) => t.id === keepId || t.unsaved || t.conflict;
    const closing = this.state.tabs.filter((t) => !keep(t));
    if (closing.length === 0) return 0;
    const ids = new Set(closing.map((t) => t.id));
    this.recency = this.recency.filter((r) => !ids.has(r));
    this.set({ tabs: this.state.tabs.filter(keep), closed: null });
    this.activate(keepId);
    return closing.length;
  }

  /** 全部關閉 (from the restore notice): closes every tab without unsaved edits or a conflict. */
  closeAll(): number {
    const keep = (t: Tab) => t.unsaved || t.conflict;
    const closing = this.state.tabs.filter((t) => !keep(t));
    const ids = new Set(closing.map((t) => t.id));
    this.recency = this.recency.filter((r) => !ids.has(r));
    const tabs = this.state.tabs.filter(keep);
    const active = tabs.some((t) => t.id === this.state.activeId)
      ? this.state.activeId
      : (tabs[0]?.id ?? null);
    this.set({ tabs, activeId: active, closed: null, restored: null });
    if (active !== null) this.activate(active);
    return closing.length;
  }

  /** Drag reorder: put tab `id` before the tab now at `toIndex` (or at the end). */
  move(id: string, toIndex: number): void {
    const from = this.state.tabs.findIndex((t) => t.id === id);
    const tab = this.state.tabs[from];
    if (tab === undefined) return;
    const target = Math.max(0, Math.min(toIndex, this.state.tabs.length));
    // Dropping right before or after itself changes nothing.
    if (target === from || target === from + 1) return;
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    tabs.splice(target > from ? target - 1 : target, 0, tab);
    this.set({ tabs });
  }

  /** ⌘⇧] / ⌘⇧[ and ←→ on the tab bar: the next or previous tab, wrapping around. */
  step(delta: 1 | -1): void {
    const n = this.state.tabs.length;
    if (n === 0) return;
    const i = this.state.tabs.findIndex((t) => t.id === this.state.activeId);
    const next = this.state.tabs[((((i < 0 ? 0 : i) + delta) % n) + n) % n];
    if (next !== undefined) this.activate(next.id);
  }

  /** ⌘1–⌘8: that tab; ⌘9: the last tab (as in browsers). */
  jump(n: number): void {
    const tabs = this.state.tabs;
    const tab = n >= 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (tab !== undefined) this.activate(tab.id);
  }

  dismissRestored(): void {
    if (this.state.restored !== null) this.set({ restored: null });
  }

  persisted(): PersistedTabs {
    return {
      items: this.state.tabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        mode: t.view.mode,
      })),
      active: this.state.activeId,
    };
  }

  /**
   * Bring back last launch's tabs: all of them, unloaded, except the active one
   * (QC-047 「全部恢復，只載入作用中的分頁」).
   */
  restore(saved: PersistedTabs): void {
    const seen = new Set<string>();
    const tabs: Tab[] = [];
    for (const item of saved.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      tabs.push({
        id: item.id,
        kind: item.kind,
        title: item.title,
        loaded: false,
        view: { ...DEFAULT_VIEW, mode: item.mode },
        unsaved: false,
        conflict: false,
        aiCandidate: false,
        aiBusy: false,
        missing: false,
      });
    }
    if (tabs.length === 0) return;
    const active = tabs.some((t) => t.id === saved.active) ? saved.active : (tabs[0]?.id ?? null);
    this.recency = [];
    this.set({ tabs, activeId: null, restored: tabs.length, closed: null });
    if (active !== null) this.activate(active);
  }
}
