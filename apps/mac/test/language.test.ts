import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translator } from '@qiu-creator/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageController } from '../src/main/language.js';
import { menuTemplate } from '../src/main/menu.js';
import { migrateLanguage, readPreferences } from '../src/main/preferences.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function prefsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc042-'));
  dirs.push(dir);
  return path.join(dir, 'preferences.json');
}

describe('upgrade keeps 繁體中文 (QC-042, decision C)', () => {
  it('an existing preferences file without language gets zh-Hant; other keys stay as they were', () => {
    const file = prefsFile();
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', windowBounds: { w: 1280 }, extra: 1 }));
    expect(migrateLanguage(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      theme: 'dark',
      windowBounds: { w: 1280 },
      extra: 1,
      language: 'zh-Hant',
    });
    expect(readPreferences(file)).toEqual({ theme: 'dark', language: 'zh-Hant', tabs: null });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['preferences.json']);
  });

  it('runs once: a saved language (even 跟隨系統) is never overwritten', () => {
    const file = prefsFile();
    fs.writeFileSync(file, JSON.stringify({ theme: 'light', language: 'system' }));
    expect(migrateLanguage(file)).toBe(false);
    expect(readPreferences(file).language).toBe('system');
  });

  it('a new install (no file) writes nothing and follows the system', () => {
    const file = prefsFile();
    expect(migrateLanguage(file)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(readPreferences(file).language).toBe('system');
  });
});

describe('LanguageController', () => {
  it('follows macOS while set to 跟隨系統 and notifies only on a real change', () => {
    let system = ['en-US', 'zh-Hant-US'];
    const c = new LanguageController('system', () => system);
    const seen: string[] = [];
    c.onChange((s) => seen.push(`${s.preference}:${s.locale}`));
    expect(c.current).toEqual({ preference: 'system', locale: 'en', systemLocale: 'en' });
    c.refresh();
    expect(seen).toEqual([]);
    system = ['zh-Hans-CN'];
    c.refresh();
    expect(c.locale).toBe('zh-Hans');
    c.setPreference('zh-Hant');
    system = ['ja-JP'];
    c.refresh();
    expect(c.locale).toBe('zh-Hant');
    expect(c.current.systemLocale).toBe('en');
    expect(seen).toEqual(['system:zh-Hans', 'zh-Hant:zh-Hant', 'zh-Hant:zh-Hant']);
    expect(c.t('common.cancel')).toBe('取消');
  });
});

describe('menu bar', () => {
  const labels = (locale: 'zh-Hans' | 'zh-Hant' | 'en') =>
    menuTemplate(translator(locale), 'qiu-creator', {
      devTools: false,
      onTabCommand: () => undefined,
    }).map((m) => m.label);
  it('top-level menus in each language', () => {
    expect(labels('zh-Hant')).toEqual(['qiu-creator', '檔案', '編輯', '顯示方式', '視窗']);
    expect(labels('zh-Hans')).toEqual(['qiu-creator', '文件', '编辑', '显示', '窗口']);
    expect(labels('en')).toEqual(['qiu-creator', 'File', 'Edit', 'View', 'Window']);
  });
  it('keeps the standard roles and only shows developer tools in development', () => {
    const roles = (devTools: boolean) =>
      menuTemplate(translator('en'), 'qiu-creator', { devTools, onTabCommand: () => undefined })
        .flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : []))
        .map((i) => i.role)
        .filter((r) => r !== undefined);
    expect(roles(false)).toContain('paste');
    expect(roles(false)).toContain('quit');
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('toggleDevTools');
    const app = menuTemplate(translator('en'), 'qiu-creator', {
      devTools: false,
      onTabCommand: () => undefined,
    })[0];
    const quit = Array.isArray(app?.submenu) ? app.submenu.at(-1) : undefined;
    expect(quit?.label).toBe('Quit qiu-creator');
  });
});
