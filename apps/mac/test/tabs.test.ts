import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translator } from '@qiu-creator/i18n';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { menuTemplate } from '../src/main/menu.js';
import { readPreferences, writePreferences } from '../src/main/preferences.js';
import type { TabCommand } from '../src/shared/bridge.js';
import { parsePersistedTabs } from '../src/shared/tabs.js';
import { DEFAULT_VIEW, MAX_LOADED, TabsModel } from '../src/renderer/tabs.js';

const work = (id: string, title = `作品 ${id}`) => ({ id, kind: 'article' as const, title });

function modelWith(ids: string[], max = MAX_LOADED): TabsModel {
  const m = new TabsModel(max);
  for (const id of ids) m.open(work(id));
  return m;
}

const order = (m: TabsModel) => m.tabs.map((t) => t.id);
const loadedIds = (m: TabsModel) => m.tabs.filter((t) => t.loaded).map((t) => t.id);

describe('TabsModel: opening and switching (QC-047)', () => {
  it('opens works in order and makes the new one active', () => {
    const m = modelWith(['a', 'b', 'c']);
    expect(order(m)).toEqual(['a', 'b', 'c']);
    expect(m.active?.id).toBe('c');
    expect(loadedIds(m)).toEqual(['a', 'b', 'c']);
  });

  it('opening an open work focuses its tab and flashes it, without a second tab', () => {
    const m = modelWith(['a', 'b']);
    const seq = m.getSnapshot().flashSeq;
    expect(m.open(work('a'))).toBe('focused');
    expect(order(m)).toEqual(['a', 'b']);
    expect(m.active?.id).toBe('a');
    expect(m.getSnapshot().flashId).toBe('a');
    expect(m.getSnapshot().flashSeq).toBe(seq + 1);
    m.open(work('a'));
    expect(m.getSnapshot().flashSeq).toBe(seq + 2);
  });

  it('⌘1–8 go to that tab, ⌘9 to the last, out of range does nothing', () => {
    const m = modelWith(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    m.jump(1);
    expect(m.active?.id).toBe('a');
    m.jump(8);
    expect(m.active?.id).toBe('h');
    m.jump(9);
    expect(m.active?.id).toBe('j');
    const small = modelWith(['a', 'b']);
    small.jump(5);
    expect(small.active?.id).toBe('b');
    small.jump(9);
    expect(small.active?.id).toBe('b');
  });

  it('⌘⇧[ ] step through the tabs and wrap around', () => {
    const m = modelWith(['a', 'b', 'c']);
    m.step(1);
    expect(m.active?.id).toBe('a');
    m.step(-1);
    expect(m.active?.id).toBe('c');
    m.step(-1);
    expect(m.active?.id).toBe('b');
  });

  it('keeps each tab’s view (mode, caret, scroll) as saved', () => {
    const m = modelWith(['a', 'b']);
    const view = {
      mode: 'source' as const,
      selection: { start: 3, end: 7 },
      scrollTop: 420,
    };
    m.saveView('a', view);
    m.activate('a');
    expect(m.find('a')?.view).toEqual(view);
    expect(m.find('b')?.view).toEqual(DEFAULT_VIEW);
  });
});

describe('TabsModel: at most 8 editors loaded', () => {
  it('unloads the least recently used tab when a ninth is opened', () => {
    const m = modelWith(['1', '2', '3', '4', '5', '6', '7', '8']);
    m.activate('1');
    m.open(work('9'));
    expect(loadedIds(m)).toHaveLength(MAX_LOADED);
    // 2 was used least recently (1 was activated again).
    expect(m.find('2')?.loaded).toBe(false);
    expect(m.find('1')?.loaded).toBe(true);
  });

  it('loads an unloaded tab when it is clicked, unloading another', () => {
    const m = modelWith(['1', '2', '3'], 2);
    expect(loadedIds(m)).toEqual(['2', '3']);
    m.activate('1');
    expect(m.find('1')?.loaded).toBe(true);
    expect(loadedIds(m)).toEqual(['1', '3']);
  });

  it('never unloads tabs with unsaved edits, a conflict or AI work', () => {
    const m = modelWith(['1', '2'], 2);
    m.update('1', { unsaved: true });
    m.update('2', { aiCandidate: true });
    m.open(work('3'));
    expect(loadedIds(m)).toEqual(['1', '2', '3']);
    m.open(work('4'));
    // 3 was clean: it goes; the pinned ones stay.
    expect(loadedIds(m)).toEqual(['1', '2', '4']);
    // Once 1 is saved it can be unloaded too.
    m.update('1', { unsaved: false });
    expect(loadedIds(m)).toEqual(['2', '4']);
    m.update('2', { aiCandidate: false, conflict: true });
    m.open(work('5'));
    expect(loadedIds(m)).toEqual(['2', '5']);
  });
});

describe('TabsModel: closing', () => {
  it('closing the active tab shows its right neighbour, else its left one', () => {
    const m = modelWith(['a', 'b', 'c']);
    m.activate('b');
    m.close('b');
    expect(order(m)).toEqual(['a', 'c']);
    expect(m.active?.id).toBe('c');
    m.close('c');
    expect(m.active?.id).toBe('a');
    m.close('a');
    expect(m.active).toBeNull();
    expect(m.tabs).toHaveLength(0);
  });

  it('closing a background tab keeps the active one', () => {
    const m = modelWith(['a', 'b', 'c']);
    m.close('a');
    expect(m.active?.id).toBe('c');
  });

  it('重新開啟 puts the last closed tab back at its place, with its discarded draft', () => {
    const m = modelWith(['a', 'b', 'c']);
    m.update('b', { unsaved: true });
    m.close('b', { title: 'x', markdown: 'draft', status: 'drafting', tags: [] });
    expect(m.getSnapshot().closed?.tab.id).toBe('b');
    const back = m.reopen();
    expect(back?.draft).toEqual({ title: 'x', markdown: 'draft', status: 'drafting', tags: [] });
    expect(order(m)).toEqual(['a', 'b', 'c']);
    expect(m.active?.id).toBe('b');
    expect(m.find('b')?.loaded).toBe(true);
    expect(m.getSnapshot().closed).toBeNull();
    expect(m.reopen()).toBeNull();
  });

  it('關閉其他 keeps the chosen tab and tabs with unsaved edits or a conflict', () => {
    const m = modelWith(['a', 'b', 'c', 'd']);
    m.update('b', { unsaved: true });
    m.update('d', { conflict: true });
    expect(m.closeOthers('c')).toBe(1);
    expect(order(m)).toEqual(['b', 'c', 'd']);
    expect(m.active?.id).toBe('c');
  });

  it('全部關閉 keeps only unsaved tabs', () => {
    const m = modelWith(['a', 'b', 'c']);
    m.update('a', { unsaved: true });
    expect(m.closeAll()).toBe(2);
    expect(order(m)).toEqual(['a']);
    expect(m.active?.id).toBe('a');
  });
});

describe('TabsModel: drag reorder', () => {
  it('moves a tab before the tab at the drop index, or to the end', () => {
    const m = modelWith(['a', 'b', 'c', 'd']);
    m.move('d', 0);
    expect(order(m)).toEqual(['d', 'a', 'b', 'c']);
    m.move('d', 4);
    expect(order(m)).toEqual(['a', 'b', 'c', 'd']);
    m.move('a', 2);
    expect(order(m)).toEqual(['b', 'a', 'c', 'd']);
    // Dropping on either side of itself changes nothing.
    m.move('a', 1);
    m.move('a', 2);
    expect(order(m)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('TabsModel: restoring last launch', () => {
  it('restores every tab, loads only the active one, and reports how many', () => {
    const m = new TabsModel();
    m.restore({
      items: [
        { id: 'a', kind: 'article', title: 'A', mode: 'source' },
        { id: 'b', kind: 'image', title: 'B', mode: null },
        { id: 'a', kind: 'article', title: 'dup', mode: null },
        { id: 'c', kind: 'video', title: 'C', mode: 'visual' },
      ],
      active: 'b',
    });
    expect(order(m)).toEqual(['a', 'b', 'c']);
    expect(m.active?.id).toBe('b');
    expect(loadedIds(m)).toEqual(['b']);
    expect(m.find('a')?.view.mode).toBe('source');
    expect(m.getSnapshot().restored).toBe(3);
    m.dismissRestored();
    expect(m.getSnapshot().restored).toBeNull();
  });

  it('falls back to the first tab when the saved active one is gone', () => {
    const m = new TabsModel();
    m.restore({ items: [{ id: 'a', kind: 'article', title: 'A', mode: null }], active: 'zzz' });
    expect(m.active?.id).toBe('a');
  });

  it('round-trips through persisted()', () => {
    const m = modelWith(['a', 'b']);
    m.saveView('a', { ...DEFAULT_VIEW, mode: 'source' });
    m.activate('a');
    const saved = m.persisted();
    expect(saved).toEqual({
      items: [
        { id: 'a', kind: 'article', title: '作品 a', mode: 'source' },
        { id: 'b', kind: 'article', title: '作品 b', mode: null },
      ],
      active: 'a',
    });
    const again = new TabsModel();
    again.restore(saved);
    expect(again.persisted()).toEqual(saved);
  });
});

describe('tabs in the app preferences', () => {
  const tmpFile = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qc047-')), 'preferences.json');

  it('validates what is read back and drops damaged entries', () => {
    expect(parsePersistedTabs(null)).toBeNull();
    expect(parsePersistedTabs({ items: 'x' })).toBeNull();
    expect(
      parsePersistedTabs({
        items: [
          { id: 'a', kind: 'article', title: 'A', mode: 'source' },
          { id: '', kind: 'article' },
          { id: 'b', kind: 'podcast' },
          { id: 'c', kind: 'video', title: 3, mode: 'wide' },
          'junk',
        ],
        active: 5,
      }),
    ).toEqual({
      items: [
        { id: 'a', kind: 'article', title: 'A', mode: 'source' },
        { id: 'c', kind: 'video', title: '', mode: null },
      ],
      active: null,
    });
  });

  it('are saved next to theme and language without touching them', () => {
    const file = tmpFile();
    const tabs = {
      items: [{ id: 'a', kind: 'article' as const, title: 'A', mode: null }],
      active: 'a',
    };
    writePreferences(file, { theme: 'dark', language: 'en', tabs });
    expect(readPreferences(file)).toEqual({ theme: 'dark', language: 'en', tabs });
    // A file from before QC-047 has no tabs.
    fs.writeFileSync(file, '{"theme":"light","language":"zh-Hant"}');
    expect(readPreferences(file)).toEqual({ theme: 'light', language: 'zh-Hant', tabs: null });
  });
});

describe('tab items in the menu bar', () => {
  const items = (locale: 'zh-Hant' | 'zh-Hans' | 'en', sent: TabCommand[] = []) => {
    const all: MenuItemConstructorOptions[] = [];
    const walk = (list: MenuItemConstructorOptions[]) => {
      for (const item of list) {
        all.push(item);
        if (Array.isArray(item.submenu)) walk(item.submenu);
      }
    };
    walk(
      menuTemplate(translator(locale), 'qiu-creator', {
        devTools: false,
        onTabCommand: (c) => sent.push(c),
      }),
    );
    return all;
  };
  const byId = (list: MenuItemConstructorOptions[], id: string) => list.find((i) => i.id === id);

  it('has ⌘W, ⌘⇧[ ], ⌘1–8 and ⌘9 in all three languages', () => {
    for (const locale of ['zh-Hant', 'zh-Hans', 'en'] as const) {
      const list = items(locale);
      expect(byId(list, 'tab-close')?.accelerator).toBe('CommandOrControl+W');
      expect(byId(list, 'tab-previous')?.accelerator).toBe('CommandOrControl+Shift+[');
      expect(byId(list, 'tab-next')?.accelerator).toBe('CommandOrControl+Shift+]');
      for (let n = 1; n <= 9; n += 1) {
        expect(byId(list, `tab-jump-${String(n)}`)?.accelerator).toBe(
          `CommandOrControl+${String(n)}`,
        );
      }
      // 關閉視窗 moves to ⌘⇧W so ⌘W can close the tab.
      expect(list.find((i) => i.role === 'close')?.accelerator).toBe('CommandOrControl+Shift+W');
    }
    expect(byId(items('zh-Hant'), 'tab-close')?.label).toBe('關閉分頁');
    expect(byId(items('zh-Hans'), 'tab-close')?.label).toBe('关闭标签页');
    expect(byId(items('en'), 'tab-close')?.label).toBe('Close Tab');
    expect(byId(items('en'), 'tab-jump-3')?.label).toBe('Tab 3');
    expect(byId(items('en'), 'tab-jump-9')?.label).toBe('Last Tab');
  });

  it('sends the command when clicked', () => {
    const sent: TabCommand[] = [];
    const list = items('en', sent);
    for (const id of ['tab-close', 'tab-next', 'tab-jump-9']) {
      const click = byId(list, id)?.click;
      expect(click).toBeTypeOf('function');
      (click as () => void)();
    }
    expect(sent).toEqual(['close', 'next', 'jump-9']);
  });
});
