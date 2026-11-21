import {
  resolveLocale,
  resolveSystemLocale,
  translator,
  type LanguagePreference,
  type Locale,
  type Translate,
} from '@qiu-creator/i18n';
import type { LanguageState } from '../shared/bridge.js';

/**
 * The main process's language (QC-042): the saved choice plus macOS's
 * preferred languages. Menus, dialogs and upload errors read `t`; `onChange`
 * fires only when the language in use actually changes.
 */
export class LanguageController {
  private state: LanguageState;
  private readonly listeners = new Set<(state: LanguageState) => void>();

  constructor(
    preference: LanguagePreference,
    private readonly systemLanguages: () => readonly string[],
  ) {
    this.state = this.compute(preference);
  }

  private compute(preference: LanguagePreference): LanguageState {
    const system = this.systemLanguages();
    return {
      preference,
      locale: resolveLocale(preference, system),
      systemLocale: resolveSystemLocale(system),
    };
  }

  get current(): LanguageState {
    return this.state;
  }

  get locale(): Locale {
    return this.state.locale;
  }

  /** Translate with the language in use now. */
  t: Translate = (key, params) => translator(this.state.locale)(key, params);

  onChange(listener: (state: LanguageState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A new choice from 設定. */
  setPreference(preference: LanguagePreference): LanguageState {
    this.apply(this.compute(preference));
    return this.state;
  }

  /** Re-read macOS's languages (they may have changed while following the system). */
  refresh(): void {
    this.apply(this.compute(this.state.preference));
  }

  private apply(next: LanguageState): void {
    const prev = this.state;
    this.state = next;
    if (
      prev.locale !== next.locale ||
      prev.preference !== next.preference ||
      prev.systemLocale !== next.systemLocale
    ) {
      for (const l of this.listeners) l(next);
    }
  }
}
