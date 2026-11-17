import { describe, expect, it } from 'vitest';
import { countWords, formatWhen, sourceLabel } from '../src/renderer/format.js';

describe('countWords', () => {
  it('counts CJK characters one each and Latin words or numbers one each, ignoring Markdown', () => {
    expect(countWords('# 旅行筆記\n\n- 早上 run 5 km\n')).toBe(4 + 2 + 3);
    expect(countWords('**粗體**與`code`')).toBe(3 + 1);
    expect(countWords('')).toBe(0);
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 10, 16, 15, 0, 0);
  it('uses 剛剛, a time today, 昨天, then a date', () => {
    expect(formatWhen(new Date(2026, 10, 16, 14, 59, 30).toISOString(), now)).toBe('剛剛');
    expect(formatWhen(new Date(2026, 10, 16, 9, 12).toISOString(), now)).toBe('09:12');
    expect(formatWhen(new Date(2026, 10, 15, 22, 0).toISOString(), now)).toBe('昨天');
    expect(formatWhen(new Date(2026, 10, 14, 8, 0).toISOString(), now)).toBe('11/14');
  });
});

describe('sourceLabel', () => {
  it('names where a work came from', () => {
    expect(sourceLabel({ source: 'mac-app', storage_mode: 'managed' })).toBe('Mac');
    expect(sourceLabel({ source: 'api:claude-code', storage_mode: 'managed' })).toBe('Agent API');
    expect(sourceLabel({ source: 'cli', storage_mode: 'managed' })).toBe('CLI');
    expect(sourceLabel({ source: 'cli', storage_mode: 'external' })).toBe('外部掛載');
  });
});

describe('asset formatting', () => {
  it('formats bytes like Finder', async () => {
    const { formatBytes } = await import('../src/renderer/format.js');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(840_000)).toBe('840 KB');
    expect(formatBytes(3_200_000)).toBe('3.2 MB');
    expect(formatBytes(1_420_000_000)).toBe('1.42 GB');
    expect(formatBytes(312_000_000)).toBe('312 MB');
  });

  it('formats durations and dimensions', async () => {
    const { formatDuration, formatDimensions, shortHash, assetName } =
      await import('../src/renderer/format.js');
    expect(formatDuration(252.4)).toBe('4:12');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDimensions(3840, 2160)).toBe('3840 × 2160');
    expect(formatDimensions(null, 10)).toBeNull();
    expect(shortHash('9f2c' + '0'.repeat(56) + 'a71e')).toBe('9f2c00…a71e');
    expect(assetName({ original_name: null, path: 'library/assets/ab/x.png' })).toBe('x.png');
  });
});
