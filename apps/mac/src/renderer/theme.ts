import { useCallback, useEffect, useState } from 'react';
import { LANGUAGE_PREFERENCES, type LanguagePreference, type MessageKey } from '@qiu-creator/i18n';
import type { LanguageState, ThemeSource } from '../shared/bridge.js';
import { setLocale, t } from './i18n.js';

/**
 * 外觀 (QC-038, PT-20261119-001 「v2 · 設定」). The main process keeps the
 * choice and sets Electron's nativeTheme, which drives prefers-color-scheme;
 * the renderer also pins `data-theme` on <html> so the design tokens switch
 * at once even before the system media query reports the change.
 */

const option = (key: ThemeSource, label: MessageKey) => ({
  key,
  get label() {
    return t(label);
  },
});

export const THEME_OPTIONS: readonly { key: ThemeSource; label: string }[] = [
  option('light', 'settings.themeLight'),
  option('dark', 'settings.themeDark'),
  option('system', 'settings.themeSystem'),
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
      setError(t('settings.themeSaveFailed'));
    });
  }, []);
  return { theme, setTheme, systemDark, error };
}

/** 語言 options in card order: 跟隨系統, 简体中文, 繁體中文, English (QC-042). */
export const LANGUAGE_OPTIONS: readonly LanguagePreference[] = LANGUAGE_PREFERENCES;

/**
 * The saved language (null until read) and a setter. The main process saves
 * it, rebuilds the menu and tells every window; this window switches at once.
 */
export function useLanguage(): {
  language: LanguageState | null;
  setLanguage: (preference: LanguagePreference) => void;
  error: string | null;
} {
  const [language, setState] = useState<LanguageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const bridge = window.creatorhub;
    if (bridge === undefined) return;
    let alive = true;
    void bridge.getLanguage().then((s) => {
      if (alive) setState(s);
    });
    const off = bridge.onLanguage((s) => {
      setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  const setLanguage = useCallback((preference: LanguagePreference) => {
    setError(null);
    setState((s) => (s === null ? s : { ...s, preference }));
    window.creatorhub
      ?.setLanguage(preference)
      .then((s) => {
        setState(s);
        setLocale(s.locale);
      })
      .catch(() => {
        setError(t('settings.languageSaveFailed'));
      });
  }, []);
  return { language, setLanguage, error };
}
