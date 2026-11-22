import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  isThemeSource,
  readPreferences,
  writePreferences,
} from '../src/main/preferences.js';
import { VISIBLE_ROWS } from '../src/renderer/BackupSection.js';
import {
  CATEGORIES,
  CATEGORY_HEADING,
  readLastCategory,
  writeLastCategory,
} from '../src/renderer/SettingsNav.js';
import { applyTheme, effectiveScheme, THEME_OPTIONS } from '../src/renderer/theme.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc038-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'preferences.json');
}

describe('外觀 preference (QC-038)', () => {
  it('defaults to following the system', () => {
    expect(DEFAULT_PREFERENCES.theme).toBe('system');
    expect(readPreferences(tmpFile())).toEqual({ theme: 'system', language: 'system', tabs: null });
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual(['淺色', '深色', '跟隨系統']);
  });

  it('remembers the choice and ignores damaged or unknown values', () => {
    const file = tmpFile();
    writePreferences(file, { theme: 'dark', language: 'en', tabs: null });
    expect(readPreferences(file)).toEqual({ theme: 'dark', language: 'en', tabs: null });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['preferences.json']);
    fs.writeFileSync(file, '{"theme":"sepia","language":"fr"}');
    expect(readPreferences(file)).toEqual({ theme: 'system', language: 'system', tabs: null });
    fs.writeFileSync(file, 'not json');
    expect(readPreferences(file)).toEqual({ theme: 'system', language: 'system', tabs: null });
    expect(isThemeSource('light')).toBe(true);
    expect(isThemeSource('Light')).toBe(false);
    expect(isThemeSource(null)).toBe(false);
  });

  it('pins data-theme for light and dark and clears it for the system', () => {
    const root = { dataset: {} as DOMStringMap };
    applyTheme(root, 'dark');
    expect(root.dataset['theme']).toBe('dark');
    applyTheme(root, 'light');
    expect(root.dataset['theme']).toBe('light');
    applyTheme(root, 'system');
    expect(root.dataset['theme']).toBeUndefined();
    expect(effectiveScheme('system', true)).toBe('dark');
    expect(effectiveScheme('system', false)).toBe('light');
    expect(effectiveScheme('light', true)).toBe('light');
  });
});

describe('設定 categories', () => {
  it('lists the six categories of the approved board', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual([
      '外觀',
      '本機服務',
      '備份與還原',
      'AI 服務',
      '資料夾',
      '關於',
    ]);
    expect(Object.keys(CATEGORY_HEADING)).toHaveLength(6);
  });

  it('reopens on the category shown last, and on 外觀 when nothing (valid) is stored (QC-057)', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    try {
      expect(readLastCategory()).toBe('appearance');
      writeLastCategory('ai');
      expect(readLastCategory()).toBe('ai');
      store.set('qc.settings.category', 'nonsense');
      expect(readLastCategory()).toBe('appearance');
    } finally {
      g.localStorage = before;
    }
    // No storage at all (a private window): still 外觀, never a throw.
    expect(readLastCategory()).toBe('appearance');
  });

  it('shows 3 backups before 「全部 N 份」', () => {
    expect(VISIBLE_ROWS).toBe(3);
  });
});
