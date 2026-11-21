/**
 * Interface languages (QC-042, decisions 2026-11-21 「介面多語言」). 繁體中文
 * is the source text; 简体中文 and English are full translations. Nothing
 * here depends on Electron, so the phase-2 iPhone/iPad app can share it.
 */
export const LOCALES = ['zh-Hans', 'zh-Hant', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** What the user picked in 設定 → 外觀 → 語言. */
export type LanguagePreference = 'system' | Locale;

export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', ...LOCALES];

export const SOURCE_LOCALE: Locale = 'zh-Hant';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-Hans' || value === 'zh-Hant' || value === 'en';
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLocale(value);
}

/**
 * The app language for one BCP 47 tag, or null when the tag is not one we
 * map. `zh` with a script wins over the region (zh-Hant-CN is Traditional).
 */
export function localeForTag(tag: string): Locale | null {
  const parts = tag.replace(/_/g, '-').toLowerCase().split('-');
  const [lang, ...rest] = parts;
  if (lang === 'en') return 'en';
  if (lang !== 'zh') return null;
  if (rest.includes('hant')) return 'zh-Hant';
  if (rest.includes('hans')) return 'zh-Hans';
  if (rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'zh-Hant';
  // zh, zh-CN, zh-SG and any other Chinese default to Simplified.
  return 'zh-Hans';
}

/**
 * 跟隨系統: the first preferred system language decides. zh-Hans/CN/SG →
 * 简体, zh-Hant/TW/HK/MO → 繁體, en* → English, anything else → English.
 */
export function resolveSystemLocale(preferred: readonly string[]): Locale {
  const first = preferred[0];
  if (first === undefined) return 'en';
  return localeForTag(first) ?? 'en';
}

export function resolveLocale(pref: LanguagePreference, preferred: readonly string[]): Locale {
  return pref === 'system' ? resolveSystemLocale(preferred) : pref;
}

/** The `lang` attribute, so CJK fonts pick the right glyphs. */
export function htmlLang(locale: Locale): string {
  return locale;
}

/** The tag handed to `Intl` formatters. */
export function intlLocale(locale: Locale): string {
  switch (locale) {
    case 'zh-Hans':
      return 'zh-CN';
    case 'zh-Hant':
      return 'zh-TW';
    case 'en':
      return 'en-US';
  }
}

/** Each language's own name, as shown on its card (never translated). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
};

/** A glyph that shows each language at a glance on its card (never translated). */
export const LOCALE_SAMPLES: Readonly<Record<Locale, string>> = {
  'zh-Hans': '简',
  'zh-Hant': '繁',
  en: 'Aa',
};
