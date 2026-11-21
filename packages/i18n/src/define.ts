import type { Locale } from './locale.js';

/** A message: plain text, or plural forms chosen by `{count}` (Intl.PluralRules). */
export type Message = string | PluralMessage;
export interface PluralMessage {
  one?: string;
  other: string;
}

/** One catalog area in all three languages; 繁體 keys are the contract. */
export type CatalogArea<K extends string> = Readonly<Record<Locale, Readonly<Record<K, Message>>>>;

/**
 * Declare an area's messages. The 繁體中文 object defines the keys; the other
 * languages must have exactly the same ones (a missing or extra key fails to
 * typecheck, and the catalog test checks values and placeholders).
 */
export function defineMessages<const T extends Readonly<Record<string, Message>>>(area: {
  'zh-Hant': T;
  'zh-Hans': { readonly [K in keyof T]: Message };
  en: { readonly [K in keyof T]: Message };
}): CatalogArea<keyof T & string> {
  return area;
}
