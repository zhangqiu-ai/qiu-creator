import { palettes, type ColorScheme } from '@qiu-creator/design-tokens';
import type { ThemeSource } from '../shared/bridge.js';
import { htmlLang, LOCALE_NAMES, type LanguagePreference } from '@qiu-creator/i18n';
import { t } from './i18n.js';
import { radioKeys } from './radio-keys.js';
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
      <section className="set-g" aria-labelledby="set-theme-h">
        <h2 className="set-g__t" id="set-theme-h">
          {t('settings.theme')}
        </h2>
        <div className="set-list set-list--pad">
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
        </div>
        {error !== null && (
          <p className="set-err" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="set-g" aria-labelledby="set-language-h">
        <h2 className="set-g__t" id="set-language-h">
          {t('settings.language')}
        </h2>
        <div className="set-list">
          <div className="set-row">
            <div className="set-row__k">
              <b id="set-ui-lang">{t('settingsPages.uiLang')}</b>
              {language?.preference === 'system' && (
                <span>
                  {t('settings.languageNow', { name: LOCALE_NAMES[language.systemLocale] })}
                </span>
              )}
            </div>
            <div className="seg" role="radiogroup" aria-labelledby="set-language-h">
              {LANGUAGE_OPTIONS.map((pref, i) => {
                const checked = language?.preference === pref;
                return (
                  <button
                    key={pref}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-pressed={checked}
                    tabIndex={checked || (language === null && i === 0) ? 0 : -1}
                    lang={pref === 'system' ? undefined : htmlLang(pref)}
                    onClick={() => {
                      pickLanguage(pref);
                    }}
                    onKeyDown={(e) => {
                      radioKeys(e, LANGUAGE_OPTIONS, i, pickLanguage);
                    }}
                  >
                    {pref === 'system' ? t('settings.languageSystem') : LOCALE_NAMES[pref]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      {languageError !== null && (
        <p className="set-err" role="alert">
          {languageError}
        </p>
      )}
    </section>
  );
}
