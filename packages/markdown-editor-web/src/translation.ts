import { lookup, SOURCE_LOCALE, type Locale } from '@qiu-creator/i18n';

/**
 * MDXEditor's chrome in the app's language (QC-042). MDXEditor asks for a key
 * (`toolbar.undo`) with its own English default and `{{…}}` interpolations;
 * the catalog holds the same keys under `editor.mdx.*`, so an unknown key
 * falls back to MDXEditor's English.
 */
export type EditorTranslation = (
  key: string,
  defaultValue: string,
  interpolations?: Record<string, unknown>,
) => string;

export function editorTranslation(locale: Locale = SOURCE_LOCALE): EditorTranslation {
  return (key, defaultValue, interpolations = {}) => {
    const full = `editor.mdx.${key}`;
    const message = lookup(locale, full);
    // `lookup` answers with the key itself when the catalog has no such message.
    let value = typeof message === 'string' && message !== full ? message : defaultValue;
    for (const [k, v] of Object.entries(interpolations)) {
      value = value.replaceAll(`{{${k}}}`, String(v));
    }
    return value;
  };
}
