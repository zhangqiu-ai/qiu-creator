import fs from 'node:fs';
import path from 'node:path';
import type { ThemeSource } from '../shared/bridge.js';

/**
 * App preferences that must apply before the first window paints (QC-038):
 * kept by the main process in `<userData>/preferences.json`, not in the
 * renderer's localStorage, so the theme never flashes the wrong colours.
 */
export interface Preferences {
  theme: ThemeSource;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system' };

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readPreferences(file: string): Preferences {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFERENCES };
    const theme = (parsed as Record<string, unknown>)['theme'];
    return { theme: isThemeSource(theme) ? theme : DEFAULT_PREFERENCES.theme };
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
