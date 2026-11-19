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
import { CATEGORIES, CATEGORY_HEADING, pickCategory } from '../src/renderer/SettingsNav.js';
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
    expect(readPreferences(tmpFile())).toEqual({ theme: 'system' });
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual(['淺色', '深色', '跟隨系統']);
  });

  it('remembers the choice and ignores damaged or unknown values', () => {
    const file = tmpFile();
    writePreferences(file, { theme: 'dark' });
    expect(readPreferences(file)).toEqual({ theme: 'dark' });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['preferences.json']);
    fs.writeFileSync(file, '{"theme":"sepia"}');
    expect(readPreferences(file)).toEqual({ theme: 'system' });
    fs.writeFileSync(file, 'not json');
    expect(readPreferences(file)).toEqual({ theme: 'system' });
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

  it('follows the heading scrolled past last, and the last one at the bottom', () => {
    const tops = [
      { key: 'appearance', top: 28 },
      { key: 'service', top: 300 },
      { key: 'backup', top: 600 },
      { key: 'about', top: 1500 },
    ] as const;
    const at = (top: number) => pickCategory(tops, { top, height: 700, scrollHeight: 2400 });
    expect(at(0)).toBe('appearance');
    expect(at(260)).toBe('service');
    expect(at(590)).toBe('backup');
    expect(at(1000)).toBe('backup');
    expect(pickCategory(tops, { top: 1700, height: 700, scrollHeight: 2400 })).toBe('about');
  });

  it('shows 3 backups before 「全部 N 份」', () => {
    expect(VISIBLE_ROWS).toBe(3);
  });
});
