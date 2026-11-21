import fs from 'node:fs';
import path from 'node:path';
import { isLanguagePreference, type LanguagePreference } from '@qiu-creator/i18n';
import type { ThemeSource } from '../shared/bridge.js';

/**
 * App preferences that must apply before the first window paints (QC-038):
 * kept by the main process in `<userData>/preferences.json`, not in the
 * renderer's localStorage, so the theme never flashes the wrong colours.
 */
export interface Preferences {
  theme: ThemeSource;
  /** 設定 → 外觀 → 語言 (QC-042); applied before the first window too. */
  language: LanguagePreference;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', language: 'system' };

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readPreferences(file: string): Preferences {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFERENCES };
    const theme = (parsed as Record<string, unknown>)['theme'];
    const language = (parsed as Record<string, unknown>)['language'];
    return {
      theme: isThemeSource(theme) ? theme : DEFAULT_PREFERENCES.theme,
      language: isLanguagePreference(language) ? language : DEFAULT_PREFERENCES.language,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Write through a temporary file and rename, so a crash never leaves half a file. */
export function writePreferences(file: string, prefs: Preferences): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Upgrades keep their language (QC-042, decision (C) of 2026-11-21): a
 * preferences file written before 語言 existed means an install that was
 * using 繁體中文, so it gets `language: 'zh-Hant'` written once, and every
 * other key is kept as it was. Without a file (a new install) nothing is
 * written and the default, 跟隨系統, applies. Returns true when it wrote.
 */
export function migrateLanguage(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const old: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if ('language' in old) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...old, language: 'zh-Hant' }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}
