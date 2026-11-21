import { catalog, type MessageKey } from './catalog/index.js';
import type { CatalogArea, Message } from './define.js';
import { SOURCE_LOCALE, type Locale } from './locale.js';
import { formatMessage, type MessageParams } from './translator.js';

export * from './locale.js';
export * from './format.js';
export { defineMessages, type CatalogArea, type Message, type PluralMessage } from './define.js';
export { formatMessage, placeholders, type MessageParams } from './translator.js';
export { catalog, type MessageKey } from './catalog/index.js';

const areas: Readonly<Record<string, CatalogArea<string>>> = catalog;

/** The raw message for a key (falls back to 繁體中文, then the key itself). */
export function lookup(locale: Locale, key: string): Message {
  const dot = key.indexOf('.');
  const area = areas[key.slice(0, dot)];
  const name = key.slice(dot + 1);
  return area?.[locale][name] ?? area?.[SOURCE_LOCALE][name] ?? key;
}

/** Translate `key` into `locale`, filling `{name}` placeholders. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return formatMessage(locale, lookup(locale, key), params);
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function translator(locale: Locale): Translate {
  return (key, params) => translate(locale, key, params);
}
