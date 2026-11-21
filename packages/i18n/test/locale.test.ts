import { describe, expect, it } from 'vitest';
import {
  formatMessage,
  isLanguagePreference,
  localeForTag,
  resolveLocale,
  resolveSystemLocale,
  translate,
} from '../src/index.js';

describe('system language mapping (QC-042)', () => {
  it.each([
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-US', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-Hant-US', 'zh-Hant'],
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
    ['zh_TW', 'zh-Hant'],
    ['zh-Hant-CN', 'zh-Hant'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
  ])('%s → %s', (tag, locale) => {
    expect(localeForTag(tag)).toBe(locale);
    expect(resolveSystemLocale([tag])).toBe(locale);
  });

  it('other languages and an empty list fall back to English; only the first language counts', () => {
    expect(localeForTag('ja-JP')).toBeNull();
    expect(resolveSystemLocale(['ja-JP', 'zh-Hant-TW'])).toBe('en');
    expect(resolveSystemLocale(['fr-FR'])).toBe('en');
    expect(resolveSystemLocale([])).toBe('en');
    expect(resolveSystemLocale(['en-US', 'zh-Hant-US'])).toBe('en');
  });

  it('a chosen language wins over the system', () => {
    expect(resolveLocale('zh-Hant', ['en-US'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['zh-Hans-CN'])).toBe('zh-Hans');
    expect(isLanguagePreference('system')).toBe(true);
    expect(isLanguagePreference('zh-TW')).toBe(false);
  });
});

describe('translate', () => {
  it('looks up each language and fills placeholders', () => {
    expect(translate('zh-Hant', 'common.cancel')).toBe('取消');
    expect(translate('zh-Hans', 'common.revealInFinder')).toBe('在访达中显示');
    expect(translate('en', 'common.quoted', { text: 'Kyoto' })).toBe('“Kyoto”');
  });

  it('chooses English plural forms by count and formats numbers', () => {
    const m = { one: '{count} work', other: '{count} works' };
    expect(formatMessage('en', m, { count: 1 })).toBe('1 work');
    expect(formatMessage('en', m, { count: 1200 })).toBe('1,200 works');
    expect(formatMessage('zh-Hant', { other: '{count} 件作品' }, { count: 3 })).toBe('3 件作品');
  });

  it('leaves an unknown placeholder visible rather than dropping it', () => {
    expect(formatMessage('en', 'Hi {name}')).toBe('Hi {name}');
  });
});
