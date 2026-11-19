import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  COLLAPSED_KEY,
  isToggleShortcut,
  limitLabel,
  loadPrefs,
  savePrefs,
  serviceSummary,
  SIDEBAR_DEFAULT,
  widthForKey,
  WIDTH_KEY,
  type PrefStorage,
} from '../src/renderer/sidebar-prefs.js';

class MemoryStorage implements PrefStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('sidebar width (QC-041)', () => {
  it('stays between 200 and 320', () => {
    expect(clampWidth(150)).toBe(200);
    expect(clampWidth(260.4)).toBe(260);
    expect(clampWidth(999)).toBe(320);
    expect(clampWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });

  it('moves 16 px per arrow key and jumps with Home/End', () => {
    expect(widthForKey(232, 'ArrowLeft')).toBe(216);
    expect(widthForKey(232, 'ArrowRight')).toBe(248);
    expect(widthForKey(208, 'ArrowLeft')).toBe(200);
    expect(widthForKey(316, 'ArrowRight')).toBe(320);
    expect(widthForKey(232, 'Home')).toBe(200);
    expect(widthForKey(232, 'End')).toBe(320);
    expect(widthForKey(232, 'Enter')).toBeNull();
  });

  it('labels the limits while dragging', () => {
    expect(limitLabel(200)).toBe('最小 200');
    expect(limitLabel(320)).toBe('最大 320');
    expect(limitLabel(232)).toBeNull();
  });
});

describe('sidebar preferences', () => {
  it('defaults to 232 and expanded', () => {
    expect(loadPrefs(new MemoryStorage())).toEqual({ width: 232, collapsed: false });
    expect(loadPrefs(null)).toEqual({ width: 232, collapsed: false });
  });

  it('remembers width and collapsed state, clamped', () => {
    const s = new MemoryStorage();
    savePrefs(s, { width: 400, collapsed: true });
    expect(s.items.get(WIDTH_KEY)).toBe('320');
    expect(s.items.get(COLLAPSED_KEY)).toBe('1');
    expect(loadPrefs(s)).toEqual({ width: 320, collapsed: true });
  });

  it('ignores garbage and a storage that throws', () => {
    const s = new MemoryStorage();
    s.setItem(WIDTH_KEY, 'wide');
    expect(loadPrefs(s).width).toBe(SIDEBAR_DEFAULT);
    const broken: PrefStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadPrefs(broken)).toEqual({ width: 232, collapsed: false });
    expect(() => {
      savePrefs(broken, { width: 250, collapsed: false });
    }).not.toThrow();
  });
});

describe('⌃⌘S', () => {
  it('toggles only with Control and Command, not while composing', () => {
    expect(isToggleShortcut(key('s', { ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isToggleShortcut(key('S', { ctrlKey: true, metaKey: true }))).toBe(true);
    expect(isToggleShortcut(key('s', { metaKey: true }))).toBe(false);
    expect(isToggleShortcut(key('s', { ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(
      isToggleShortcut({ ...key('s', { ctrlKey: true, metaKey: true }), isComposing: true }),
    ).toBe(false);
  });
});

describe('service dot', () => {
  const health = { version: '0.1.0', commit: 'bf3aaf8e12' };
  it('is green when the service, live updates and the Agent API are fine', () => {
    expect(serviceSummary({ serviceUp: true, events: 'open', health, restoring: false })).toEqual({
      tone: 'ok',
      title: '一切正常',
      realtime: '已連線',
      agentApi: '可用',
      version: '0.1.0 · bf3aaf8',
    });
  });

  it('turns red when the service or live updates fail', () => {
    expect(
      serviceSummary({ serviceUp: false, events: 'reconnecting', health: null, restoring: false }),
    ).toMatchObject({ tone: 'bad', title: '本機服務未回應', agentApi: '無法使用', version: '—' });
    expect(
      serviceSummary({ serviceUp: true, events: 'reconnecting', health, restoring: false }),
    ).toMatchObject({ tone: 'bad', title: '即時更新已中斷', realtime: '已中斷' });
  });

  it('shows the restore in progress and a version without commit', () => {
    expect(
      serviceSummary({
        serviceUp: true,
        events: 'open',
        health: { version: '0.1.0', commit: null },
        restoring: true,
      }),
    ).toMatchObject({ tone: 'restoring', title: '還原中', version: '0.1.0' });
  });
});
