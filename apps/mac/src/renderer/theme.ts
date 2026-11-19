import { useCallback, useEffect, useState } from 'react';
import type { ThemeSource } from '../shared/bridge.js';

/**
 * 外觀 (QC-038, PT-20261119-001 「v2 · 設定」). The main process keeps the
 * choice and sets Electron's nativeTheme, which drives prefers-color-scheme;
 * the renderer also pins `data-theme` on <html> so the design tokens switch
 * at once even before the system media query reports the change.
 */

export const THEME_OPTIONS: readonly { key: ThemeSource; label: string }[] = [
  { key: 'light', label: '淺色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟隨系統' },
];

export function applyTheme(root: { dataset: DOMStringMap }, theme: ThemeSource): void {
  if (theme === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
}

export function effectiveScheme(theme: ThemeSource, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** Apply the saved choice as early as possible (called before the first render). */
export async function restoreTheme(): Promise<void> {
  const bridge = window.creatorhub;
  if (bridge === undefined) return;
  applyTheme(document.documentElement, await bridge.getTheme());
}

function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => {
      setDark(mq.matches);
    };
    mq.addEventListener('change', on);
    return () => {
      mq.removeEventListener('change', on);
    };
  }, []);
  return dark;
}

/** The saved theme (null until read), a setter that applies at once, and the system's look. */
export function useTheme(): {
  theme: ThemeSource | null;
  setTheme: (theme: ThemeSource) => void;
  systemDark: boolean;
  error: string | null;
} {
  const [theme, setThemeState] = useState<ThemeSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const systemDark = useSystemDark();
  useEffect(() => {
    let alive = true;
    void window.creatorhub?.getTheme().then((t) => {
      if (alive) setThemeState(t);
    });
    return () => {
      alive = false;
    };
  }, []);
  const setTheme = useCallback((next: ThemeSource) => {
    setThemeState(next);
    setError(null);
    applyTheme(document.documentElement, next);
    window.creatorhub?.setTheme(next).catch(() => {
      setError('無法儲存外觀設定，下次開啟時會恢復原本的選擇');
    });
  }, []);
  return { theme, setTheme, systemDark, error };
}
