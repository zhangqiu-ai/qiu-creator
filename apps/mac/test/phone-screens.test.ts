import { describe, expect, it } from 'vitest';
import {
  countText,
  excerpt,
  isOver,
  screenTone,
  splitBlocks,
  statusBarColor,
} from '../src/renderer/preview/PhoneScreens.js';
import type { PhoneBlock } from '../src/renderer/preview/phone-model.js';

const block = (kind: PhoneBlock['kind'], text: string, at: number): PhoneBlock => ({
  kind,
  text,
  at,
  sourceStart: 0,
  sourceEnd: 0,
});

describe('phone screens (QC-084)', () => {
  it('tones and status bars follow the prototype', () => {
    expect(screenTone('douyin', 'publish')).toBe('dark');
    expect(screenTone('wechat_channels', 'publish')).toBe('light');
    expect(screenTone('wechat_channels', 'feed')).toBe('dark');
    expect(screenTone('xiaohongshu', 'body')).toBe('light');
    expect(statusBarColor('douyin', 'publish')).toBe('#111');
    expect(statusBarColor('douyin', 'body')).toBe('#000');
    expect(statusBarColor('wechat_channels', 'feed')).toBe('#000');
    expect(statusBarColor('xiaohongshu', 'feed')).toBe('#F5F5F5');
    expect(statusBarColor('wechat_mp', 'feed')).toBe('#EDEDED');
    expect(statusBarColor('wechat_mp', 'publish')).toBe('#F7F7F7');
    expect(statusBarColor('xiaohongshu', 'publish')).toBe('#fff');
  });

  it('splits blocks at the cut by code points, images after the cut fade', () => {
    // "ab😀cd" is 5 code points at 0; "efgh" at 7 (after "\n\n").
    const blocks = [
      block('paragraph', 'ab😀cd', 0),
      block('image', '', -1),
      block('paragraph', 'efgh', 7),
      block('image', '', -1),
    ];
    expect(splitBlocks(blocks, null).every((b) => b.kind === 'whole')).toBe(true);
    expect(splitBlocks(blocks, 3)).toEqual([
      { kind: 'split', before: 'ab😀', after: 'cd' },
      { kind: 'cut' },
      { kind: 'cut' },
      { kind: 'cut' },
    ]);
    expect(splitBlocks(blocks, 9)).toEqual([
      { kind: 'whole' },
      { kind: 'whole' },
      { kind: 'split', before: 'ef', after: 'gh' },
      { kind: 'cut' },
    ]);
    // A cut in the gap between blocks: the next block is wholly cut.
    expect(splitBlocks(blocks, 6).map((b) => b.kind)).toEqual(['whole', 'whole', 'cut', 'cut']);
  });

  it('excerpts and counts', () => {
    expect(excerpt('ab\n\ncd', 10)).toBe('ab cd');
    expect(excerpt('a😀bcd', 2)).toBe('a😀…');
    expect(countText(3, 10)).toBe('3 / 10');
    expect(countText(3, null)).toBe('3');
    expect(isOver(11, 10)).toBe(true);
    expect(isOver(11, null)).toBe(false);
  });
});
