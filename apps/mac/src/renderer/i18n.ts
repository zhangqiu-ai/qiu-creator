import { ApiError } from '@qiu-creator/api-client';
import { ErrorCodeSchema } from '@qiu-creator/contracts';
import {
  formatBytes as fmtBytes,
  formatDate as fmtDate,
  formatDateTime as fmtDateTime,
  formatNumber as fmtNumber,
  formatRelative as fmtRelative,
  formatTime as fmtTime,
  formatWhen as fmtWhen,
  htmlLang,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from '@qiu-creator/i18n';
import { useSyncExternalStore } from 'react';
import type { LanguageState } from '../shared/bridge.js';

/**
 * The renderer's language (QC-042). One app-wide locale: `<App>` subscribes
 * with `useLocale()`, so a change re-renders the whole tree in place (drafts,
 * scroll and open dialogs are kept). Anything that renders text calls `t`;
 * module-level tables hold message keys, never translated text, so they
 * follow the language too. Tests default to 繁體中文, the source text.
 */

let locale: Locale = 'zh-Hant';
const listeners = new Set<() => void>();

export function currentLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(next);
  if (next === locale) return;
  locale = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The language in use; components that call it re-render when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

/** Translate into the current language. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(locale, key, params);
}

/** Follow the main process's language: apply it now, then on every change. */
export async function restoreLanguage(): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.creatorhub;
  if (bridge === undefined) {
    setLocale(locale);
    return;
  }
  bridge.onLanguage((state: LanguageState) => {
    setLocale(state.locale);
  });
  setLocale((await bridge.getLanguage()).locale);
}

/**
 * Interface text for a service error: by its code, never the service's own
 * (English) message. Not an ApiError (fetch failed) → the service is down.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return t('common.serviceDown');
  return codeText(err.code);
}

/** Interface text for an error code from the service (or null). */
export function codeText(code: string | null | undefined): string {
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success ? t(`errors.${parsed.data}`) : t('common.unknownError');
}

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  fmtNumber(locale, value, options);
export const formatBytes = (bytes: number): string => fmtBytes(locale, bytes);
export const formatTime = (d: Date): string => fmtTime(locale, d);
export const formatDate = (d: Date): string => fmtDate(locale, d);
export const formatDateTime = (d: Date): string => fmtDateTime(locale, d);
/** 剛剛 / 14:32 / 昨天 / 11/14 in the current language. */
export const formatWhen = (iso: string, now: Date = new Date()): string =>
  fmtWhen(locale, iso, now);
/** 3 分鐘前 / in 2 days from signed seconds. */
export const formatRelative = (seconds: number): string => fmtRelative(locale, seconds);
