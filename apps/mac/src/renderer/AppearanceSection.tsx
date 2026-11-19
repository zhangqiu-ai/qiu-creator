import { palettes, type ColorScheme } from '@qiu-creator/design-tokens';
import type { KeyboardEvent } from 'react';
import type { ThemeSource } from '../shared/bridge.js';
import { THEME_OPTIONS, useTheme } from './theme.js';

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
 * 外觀 (PT-20261119-001 「v2 · 設定」): three cards, applied to the whole
 * app as soon as one is picked and remembered on this Mac. 跟隨系統 is the
 * default and shows which look macOS is using right now.
 */
export function AppearanceSection() {
  const { theme, setTheme, systemDark, error } = useTheme();
  const pick = (key: ThemeSource) => {
    if (key !== theme) setTheme(key);
  };
  // Radio-group keys: arrows move the choice, like native segmented radios.
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = THEME_OPTIONS[(index + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
    if (next === undefined) return;
    pick(next.key);
    const group = e.currentTarget.parentElement;
    group
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [THEME_OPTIONS.indexOf(next)]?.focus();
  };
  return (
    <section className="settings__sec" id="set-appearance" aria-labelledby="set-appearance-h">
      <h2 id="set-appearance-h" className="settings__h" tabIndex={-1}>
        外觀
      </h2>
      <div className="theme-cards" role="radiogroup" aria-label="主題">
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
                onKey(e, i);
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
                  <span className="theme-card__note">{systemDark ? '目前深色' : '目前淺色'}</span>
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
    </section>
  );
}
