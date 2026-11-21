import { format } from './catalog/format.js';
import { intlLocale, type Locale } from './locale.js';

function justNow(locale: Locale): string {
  const m = format[locale].justNow;
  return typeof m === 'string' ? m : m.other;
}

/**
 * Dates, numbers, sizes and relative times through `Intl` (QC-042), so each
 * language reads naturally: 14:32 / 昨天 / 11/14, or 2:32 PM / Yesterday / Nov 14.
 */

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function formatTime(locale: Locale, d: Date): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: locale === 'en' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: locale === 'en' ? undefined : false,
  }).format(d);
}

export function formatShortDate(locale: Locale, d: Date): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: locale === 'en' ? 'short' : 'numeric',
    day: 'numeric',
  }).format(d);
}

/** Date and time: 2026/11/21 14:32 in Chinese, Nov 21, 2026, 2:32 PM in English. */
export function formatDateTime(locale: Locale, d: Date): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...dateParts(locale),
    hour: locale === 'en' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: locale === 'en' ? undefined : false,
  }).format(d);
}

/** 2026/11/21, or Nov 21, 2026. */
export function formatDate(locale: Locale, d: Date): string {
  return new Intl.DateTimeFormat(intlLocale(locale), dateParts(locale)).format(d);
}

function dateParts(locale: Locale): Intl.DateTimeFormatOptions {
  return locale === 'en'
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
}

/** 剛剛 / just now within a minute; today → time; yesterday → 昨天 / Yesterday; else the date. */
export function formatWhen(locale: Locale, iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const diff = now.getTime() - d.getTime();
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  if (diff >= 0 && diff < 60_000) return justNow(locale);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return formatTime(locale, d);
  if (d.getTime() >= startOfToday - 86_400_000) return capitalize(locale, rtf.format(-1, 'day'));
  return formatShortDate(locale, d);
}

/** 3 分鐘前 / in 2 days, from a signed number of seconds relative to now. */
export function formatRelative(locale: Locale, seconds: number): string {
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

function capitalize(locale: Locale, text: string): string {
  return locale === 'en' && text !== '' ? (text[0] ?? '').toUpperCase() + text.slice(1) : text;
}

/** 1 KB = 1000 bytes, as Finder shows sizes; the digits follow the locale. */
export function formatBytes(locale: Locale, bytes: number): string {
  const nf = (v: number, digits: number) =>
    new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: digits }).format(v);
  if (bytes < 1000) return `${nf(bytes, 0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${nf(value, digits)} ${units[unit] ?? 'TB'}`;
}
