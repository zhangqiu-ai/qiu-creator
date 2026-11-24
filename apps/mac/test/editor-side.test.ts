import { describe, expect, it } from 'vitest';
import {
  clampSide,
  DEFAULT_SIDE,
  isDrawer,
  loadSidePrefs,
  shownTab,
  SIDE_KEY,
  SideStore,
} from '../src/renderer/editor-side.js';

/** QC-085: the work editor's right sidebar (PT-20261123-002 A), pure parts. */

function memory(): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('editor sidebar preferences', () => {
  it('defaults to open on 預覽, 520 wide; clamps to 400–760', () => {
    expect(DEFAULT_SIDE).toEqual({ open: true, tab: 'preview', width: 520 });
    expect(clampSide(100)).toBe(400);
    expect(clampSide(900)).toBe(760);
    expect(clampSide(Number.NaN)).toBe(520);
  });

  it('remembers tab, width and open across stores (per window, every work)', () => {
    const storage = memory();
    const a = new SideStore(storage);
    a.show('history');
    a.resize(640);
    a.toggle();
    const b = new SideStore(storage);
    expect(b.getSnapshot().prefs).toEqual({ open: false, tab: 'history', width: 640 });
  });

  it('falls back to defaults on broken or unknown values', () => {
    const storage = memory();
    storage.setItem(SIDE_KEY, '{nope');
    expect(loadSidePrefs(storage)).toEqual(DEFAULT_SIDE);
    storage.setItem(SIDE_KEY, JSON.stringify({ open: 'x', tab: 'chat', width: 9999 }));
    expect(loadSidePrefs(storage)).toEqual({ ...DEFAULT_SIDE, width: 760 });
  });
});

describe('editor sidebar behaviour', () => {
  it('⌘⇧P opens 預覽, and closes it when 預覽 is already in front', () => {
    const s = new SideStore(null);
    s.show('ai');
    s.toggleTab('preview');
    expect(s.getSnapshot().prefs).toMatchObject({ open: true, tab: 'preview' });
    s.toggleTab('preview');
    expect(s.getSnapshot().prefs).toMatchObject({ open: false, tab: 'preview' });
    // ⌥⌘0 reopens on the last tab.
    s.toggle();
    expect(s.getSnapshot().prefs).toMatchObject({ open: true, tab: 'preview' });
  });

  it('dragging well below the minimum snaps shut; just below stays at 400', () => {
    const s = new SideStore(null);
    s.resize(380);
    expect(s.getSnapshot().prefs).toMatchObject({ open: true, width: 400 });
    s.resize(200);
    expect(s.getSnapshot().prefs.open).toBe(false);
    // A drag that passes 400 on its way to snapping shut reopens at the width it started from.
    s.toggle();
    s.resize(600);
    s.resize(400, 600);
    s.resize(260, 600);
    expect(s.getSnapshot().prefs).toMatchObject({ open: false, width: 600 });
  });

  it('becomes a drawer when the editor column would be under 560, closed at first', () => {
    expect(isDrawer(1080, 520)).toBe(false);
    expect(isDrawer(1079, 520)).toBe(true);
    expect(isDrawer(0, 520)).toBe(false);
    const s = new SideStore(null);
    s.measure(900);
    expect(s.getSnapshot()).toMatchObject({ drawer: true, drawerOpen: false });
    expect(s.expanded).toBe(false);
    s.toggleTab('preview');
    expect(s.getSnapshot().drawerOpen).toBe(true);
    // The drawer never changes the remembered docked state.
    s.collapse();
    expect(s.getSnapshot()).toMatchObject({ drawerOpen: false, prefs: { open: true } });
    s.measure(1400);
    expect(s.getSnapshot().drawer).toBe(false);
    expect(s.expanded).toBe(true);
  });

  it('shows the first offered tab when the window’s tab is not offered (貼圖 has no AI)', () => {
    expect(shownTab('ai', ['preview', 'history', 'assets'])).toBe('preview');
    expect(shownTab('history', ['preview', 'history', 'assets'])).toBe('history');
  });

  it('tracks which works go over a limit and notifies only on change', () => {
    const s = new SideStore(null);
    let calls = 0;
    s.subscribe(() => {
      calls++;
    });
    s.setOver('w1', true);
    s.setOver('w1', true);
    expect(s.getSnapshot().over.has('w1')).toBe(true);
    s.setOver('w1', false);
    expect(s.getSnapshot().over.has('w1')).toBe(false);
    expect(calls).toBe(2);
  });
});
