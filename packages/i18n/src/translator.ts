import type { Message } from './define.js';
import { intlLocale, type Locale } from './locale.js';

export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Placeholder names used by a message (both plural forms included). */
export function placeholders(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : [message.one ?? '', message.other];
  const names = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1] ?? '');
  return [...names].sort();
}

/** Fill `{name}` from params; numbers are formatted for the locale. */
export function formatMessage(
  locale: Locale,
  message: Message,
  params: MessageParams = {},
): string {
  let text: string;
  if (typeof message === 'string') {
    text = message;
  } else {
    const count = params['count'];
    const form =
      typeof count === 'number' ? new Intl.PluralRules(intlLocale(locale)).select(count) : 'other';
    text = form === 'one' && message.one !== undefined ? message.one : message.other;
  }
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === 'number'
      ? new Intl.NumberFormat(intlLocale(locale)).format(value)
      : value;
  });
}
