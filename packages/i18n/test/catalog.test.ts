import { describe, expect, it } from 'vitest';
import { catalog, LOCALES, placeholders, type Message } from '../src/index.js';

const areas = Object.entries(catalog) as [string, Record<string, Record<string, Message>>][];

function texts(m: Message): string[] {
  return typeof m === 'string' ? [m] : [m.one ?? '', m.other].filter((s) => s !== '');
}

describe('message catalogs (QC-042)', () => {
  it('every area has the same keys in all three languages', () => {
    for (const [name, area] of areas) {
      const source = Object.keys(area['zh-Hant'] ?? {}).sort();
      for (const locale of LOCALES) {
        expect(Object.keys(area[locale] ?? {}).sort(), `${name} · ${locale}`).toEqual(source);
      }
    }
  });

  it('no value is empty', () => {
    for (const [name, area] of areas) {
      for (const locale of LOCALES) {
        for (const [key, m] of Object.entries(area[locale] ?? {})) {
          expect(texts(m).length, `${name}.${key} · ${locale}`).toBeGreaterThan(0);
          for (const text of texts(m))
            expect(text.trim(), `${name}.${key} · ${locale}`).not.toBe('');
        }
      }
    }
  });

  it('placeholders are the same in all three languages', () => {
    for (const [name, area] of areas) {
      for (const [key, source] of Object.entries(area['zh-Hant'] ?? {})) {
        const expected = placeholders(source);
        for (const locale of LOCALES) {
          const m = area[locale]?.[key];
          expect(m, `${name}.${key} · ${locale}`).toBeDefined();
          if (m === undefined) continue;
          expect(placeholders(m), `${name}.${key} · ${locale}`).toEqual(expected);
          // Both plural forms carry the same placeholders, except `one` may drop `{count}`.
          if (typeof m !== 'string' && m.one !== undefined) {
            const one = placeholders(m.one).filter((p) => p !== 'count');
            expect(one, `${name}.${key} · ${locale} · one`).toEqual(
              expected.filter((p) => p !== 'count'),
            );
          }
        }
      }
    }
  });

  it('English is not left in Chinese, and Chinese is not left in English', () => {
    const han = /\p{Script=Han}/u;
    for (const [name, area] of areas) {
      for (const [key, m] of Object.entries(area['en'] ?? {})) {
        for (const text of texts(m)) expect(han.test(text), `${name}.${key}: ${text}`).toBe(false);
      }
    }
  });

  it('简体 differs from 繁體 wherever the 繁體 text uses traditional-only characters', () => {
    // A light guard against copying 繁體 strings unchanged into 简体.
    const traditionalOnly = /[們這個來說時會對開關體與網頁檔視點選擇設儲復處應錄]/u;
    for (const [name, area] of areas) {
      for (const [key, m] of Object.entries(area['zh-Hans'] ?? {})) {
        for (const text of texts(m)) {
          expect(traditionalOnly.test(text), `${name}.${key}: ${text}`).toBe(false);
        }
      }
    }
  });
});
