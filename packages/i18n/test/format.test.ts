import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatDateTime, formatNumber, formatWhen } from '../src/index.js';

describe('Intl formatting (QC-042)', () => {
  const now = new Date(2026, 10, 21, 15, 0);
  it('relative day words in each language', () => {
    const justNow = new Date(2026, 10, 21, 14, 59, 30).toISOString();
    const yesterday = new Date(2026, 10, 20, 9, 0).toISOString();
    expect(formatWhen('zh-Hant', justNow, now)).toBe('剛剛');
    expect(formatWhen('en', justNow, now)).toBe('Just now');
    expect(formatWhen('zh-Hant', yesterday, now)).toBe('昨天');
    expect(formatWhen('zh-Hans', yesterday, now)).toBe('昨天');
    expect(formatWhen('en', yesterday, now)).toBe('Yesterday');
  });

  it('times and dates', () => {
    const today = new Date(2026, 10, 21, 14, 32).toISOString();
    expect(formatWhen('zh-Hant', today, now)).toBe('14:32');
    expect(formatWhen('en', today, now)).toBe('2:32 PM');
    const older = new Date(2026, 10, 14, 9, 0).toISOString();
    expect(formatWhen('zh-Hant', older, now)).toBe('11/14');
    expect(formatWhen('en', older, now)).toBe('Nov 14');
  });

  it('dates with times keep the numeric form in Chinese', () => {
    const d = new Date(2026, 10, 19, 8, 0);
    // zh-TW separates date and time with a thin space (U+2009).
    expect(formatDateTime('zh-Hant', d)).toBe('2026/11/19\u200908:00');
    expect(formatDateTime('zh-Hans', d)).toBe('2026/11/19 08:00');
    expect(formatDateTime('en', d)).toBe('Nov 19, 2026, 8:00 AM');
    expect(formatDate('zh-Hant', d)).toBe('2026/11/19');
  });

  it('numbers and sizes', () => {
    expect(formatNumber('en', 12345)).toBe('12,345');
    expect(formatBytes('en', 999)).toBe('999 B');
    expect(formatBytes('zh-Hans', 1_530_000)).toBe('1.53 MB');
    expect(formatBytes('en', 152_000_000)).toBe('152 MB');
  });
});
