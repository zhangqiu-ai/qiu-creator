import { palettes, type ColorScheme } from '@qiu-creator/design-tokens';
import type { KeyboardEvent } from 'react';
import type { ThemeSource } from '../shared/bridge.js';
import {
  htmlLang,
  LOCALE_NAMES,
  LOCALE_SAMPLES,
  type LanguagePreference,
  type Locale,
} from '@qiu-creator/i18n';
import { t } from './i18n.js';
import { Icon } from './Icon.js';
import { LANGUAGE_OPTIONS, THEME_OPTIONS, useLanguage, useTheme } from './theme.js';

/** A miniature window in the scheme's real token colours. */
function Mini({ scheme }: { scheme: ColorScheme }) {
  const p = palettes[scheme];
  return (
    <span className="theme-mini__layer" style={{ background: p.bg }}>
      <span className="theme-mini__side" style={{ background: p.sunken }} />
      <span className="theme-mini__title" style={{ background: p.ink }} />
      <span className="theme-mini__card" style={{ background: p.surface, borderColor: p.line }} />
      <span className="theme-mini__accent" style={{ background: p.accent }} />
    </span>
  );
}

/** Arrow keys move the choice within a radio group, like native segmented radios. */
function radioKeys<T>(
  e: KeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  index: number,
  pick: (value: T) => void,
): void {
  const step =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) return;
  e.preventDefault();
  const at = (index + step + options.length) % options.length;
  const next = options[at];
  if (next === undefined) return;
  pick(next);
  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus();
}

/** A language card's tile: its sample glyph, set in that language so CJK fonts pick the right glyphs. */
function LangMini({ locale }: { locale: Locale }) {
  return (
    <span className="lang-mini__sample" lang={htmlLang(locale)}>
      {LOCALE_SAMPLES[locale]}
    </span>
  );
}

/**
 * 外觀 (PT-20261119-001 「v2 · 設定」): theme and language cards, applied to
 * the whole app as soon as one is picked and remembered on this Mac. 跟隨系統
 * is the default for both and shows what macOS uses right now. The language
 * cards (QC-042) reuse the theme card style; each language is named in itself.
 */
export function AppearanceSection() {
  const { theme, setTheme, systemDark, error } = useTheme();
  const { language, setLanguage, error: languageError } = useLanguage();
  const pick = (key: ThemeSource) => {
    if (key !== theme) setTheme(key);
  };
  const pickLanguage = (pref: LanguagePreference) => {
    if (pref !== language?.preference) setLanguage(pref);
  };
  const themeKeys = THEME_OPTIONS.map((o) => o.key);
  return (
    <section className="set-sec" id="set-appearance" aria-labelledby="set-appearance-h">
      <header className="set-h">
        <h1 id="set-appearance-h" className="set-h__title" tabIndex={-1}>
          {t('settings.appearance')}
        </h1>
      </header>
      <h3 className="settings__sub-h" id="set-theme-h">
        {t('settings.theme')}
      </h3>
      <div className="theme-cards" role="radiogroup" aria-labelledby="set-theme-h">
        {THEME_OPTIONS.map((opt, i) => {
          const checked = theme === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              className="theme-card"
              aria-checked={checked}
              tabIndex={checked || (theme === null && i === 0) ? 0 : -1}
              onClick={() => {
                pick(opt.key);
              }}
              onKeyDown={(e) => {
                radioKeys(e, themeKeys, i, pick);
              }}
            >
              <span className="theme-mini" aria-hidden="true">
                {opt.key === 'system' ? (
                  <>
                    <Mini scheme="light" />
                    <span className="theme-mini__split">
                      <Mini scheme="dark" />
                    </span>
                  </>
                ) : (
                  <Mini scheme={opt.key} />
                )}
              </span>
              <span className="theme-card__label">
                <span className="theme-card__name">{opt.label}</span>
                {opt.key === 'system' && checked && (
                  <span className="theme-card__note">
                    {systemDark ? t('settings.nowDark') : t('settings.nowLight')}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {error !== null && (
        <p className="ln__err" role="alert">
          {error}
        </p>
      )}

      <h3 className="settings__sub-h" id="set-language-h">
        {t('settings.language')}
      </h3>
      <div
        className="theme-cards theme-cards--four"
        role="radiogroup"
        aria-labelledby="set-language-h"
      >
        {LANGUAGE_OPTIONS.map((pref, i) => {
          const checked = language?.preference === pref;
          const shown = pref === 'system' ? (language?.systemLocale ?? null) : pref;
          return (
            <button
              key={pref}
              type="button"
              role="radio"
              className="theme-card"
              aria-checked={checked}
              tabIndex={checked || (language === null && i === 0) ? 0 : -1}
              onClick={() => {
                pickLanguage(pref);
              }}
              onKeyDown={(e) => {
                radioKeys(e, LANGUAGE_OPTIONS, i, pickLanguage);
              }}
            >
              <span className="theme-mini lang-mini" aria-hidden="true">
                {shown !== null && <LangMini locale={shown} />}
                {pref === 'system' && <Icon name="appearance" size={14} />}
              </span>
              <span className="theme-card__label">
                {pref === 'system' ? (
                  <span className="theme-card__name">{t('settings.languageSystem')}</span>
                ) : (
                  <span className="theme-card__name" lang={htmlLang(pref)}>
                    {LOCALE_NAMES[pref]}
                  </span>
                )}
                {pref === 'system' && checked && shown !== null && (
                  <span className="theme-card__note">
                    {t('settings.languageNow', { name: LOCALE_NAMES[shown] })}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {languageError !== null && (
        <p className="ln__err" role="alert">
          {languageError}
        </p>
      )}
    </section>
  );
}
