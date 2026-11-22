import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  findMatches,
  matchesPinyinFolded,
  PINYIN_LONG_TEXT_MIN_LENGTH,
  pinyinKey,
  foldForSearch,
  matchesSearch,
  matchExcerpt,
  searchKey,
} from '../src/search.js';

const marked = (text: string, query: string): string => {
  let out = '';
  let at = 0;
  for (const m of findMatches(text, query)) {
    out += `${text.slice(at, m.start)}[${text.slice(m.start, m.end)}]`;
    at = m.end;
  }
  return out + text.slice(at);
};

describe('搜尋比對 (QC-068)', () => {
  it('folds full-width, letter case and Traditional to Simplified', () => {
    expect(foldForSearch('ＡＢＣ１２３')).toBe('abc123');
    expect(foldForSearch('Markdown')).toBe('markdown');
    expect(foldForSearch('設計常用')).toBe('设计常用');
    expect(searchKey('  常用  ')).toBe('常用');
  });

  it('marks every hit in the original text, whatever form it is written in', () => {
    expect(marked('常用的設計：常用字', '常用')).toBe('[常用]的設計：[常用]字');
    expect(marked('簡繁：设计與設計', '設計')).toBe('簡繁：[设计]與[設計]');
    expect(marked('ＡＩ 改寫 and ai', 'ai')).toBe('[ＡＩ] 改寫 and [ai]');
    expect(marked('Markdown 原稿', 'MARK')).toBe('[Mark]down 原稿');
  });

  it('keeps emoji and other surrogate pairs whole', () => {
    expect(marked('🎬 視頻 🎬', '視頻')).toBe('🎬 [視頻] 🎬');
    expect(marked('a😀b', '😀')).toBe('a[😀]b');
  });

  it('an empty query or no hit marks nothing', () => {
    expect(findMatches('常用', '')).toEqual([]);
    expect(findMatches('常用', '   ')).toEqual([]);
    expect(findMatches('常用', '罕見')).toEqual([]);
    expect(matchesSearch('常用', '')).toBe(false);
    expect(matchesSearch('設計常用', '设计')).toBe(true);
  });

  it('a passage around the first hit, cut with …', () => {
    const text = `${'前'.repeat(100)}這裡有關鍵詞${'後'.repeat(100)}`;
    const passage = matchExcerpt(text, '關鍵詞', 40);
    expect(passage).not.toBeNull();
    expect(passage).toContain('關鍵詞');
    expect(passage?.startsWith('…')).toBe(true);
    expect(passage?.endsWith('…')).toBe(true);
    expect(Array.from(passage ?? '').length).toBeLessThanOrEqual(42);
    expect(matchExcerpt('短文有關鍵詞', '關鍵詞', 40)).toBe('短文有關鍵詞');
    expect(matchExcerpt('沒有', '關鍵詞', 40)).toBeNull();
  });
});

describe('detectLanguage (QC-075)', () => {
  it('tells Traditional, Simplified and English apart, or gives up', () => {
    expect(detectLanguage('今年的紅葉比往年早，清水寺人很多。')).toBe('zh-Hant');
    expect(detectLanguage('今年的红叶比往年早，清水寺人很多。')).toBe('zh-Hans');
    expect(detectLanguage('Autumn in Kyoto came early this year.')).toBe('en');
    expect(detectLanguage('我用 Markdown 寫筆記')).toBe('zh-Hant');
    expect(detectLanguage('This is a long English sentence with one 字.')).toBe('en');
    expect(detectLanguage('2026-11-22 12:00')).toBeNull();
    expect(detectLanguage('今天天氣')).toBe('zh-Hant');
    expect(detectLanguage('今天')).toBeNull();
    expect(detectLanguage('')).toBeNull();
  });
});

describe('pinyin search (QC-079)', () => {
  const hits = (text: string, query: string, options?: { pinyinMinLength?: number }) =>
    findMatches(text, query, options).map((r) => text.slice(r.start, r.end));

  it('matches full pinyin, initials and a mix, with or without spaces, in any case', () => {
    expect(hits('我的常用工具', 'changyong')).toEqual(['常用']);
    expect(hits('我的常用工具', 'cy')).toEqual(['常用']);
    expect(hits('我的常用工具', 'changy')).toEqual(['常用']);
    expect(hits('我的常用工具', 'cyong')).toEqual(['常用']);
    expect(hits('我的常用工具', 'chang yong')).toEqual(['常用']);
    expect(hits('我的常用工具', "chang'yong")).toEqual(['常用']);
    expect(hits('我的常用工具', 'ChangYong')).toEqual(['常用']);
    expect(hits('我的常用工具', 'ＣＹ')).toEqual(['常用']);
    // zh/ch/sh count as initials; the last syllable may be partly typed.
    expect(hits('我的常用工具', 'chy')).toEqual(['常用']);
    expect(hits('我的常用工具', 'changyo')).toEqual(['常用']);
    expect(hits('常用工具', 'cygj')).toEqual(['常用工具']);
  });

  it('takes every reading of a polyphonic character', () => {
    expect(hits('銀行', 'yinhang')).toEqual(['銀行']);
    expect(hits('行走', 'xingzou')).toEqual(['行走']);
    expect(hits('長大', 'zhangda')).toEqual(['長大']);
    expect(hits('長大', 'changda')).toEqual(['長大']);
    expect(hits('綠色', 'lvse')).toEqual(['綠色']);
    expect(hits('綠色', 'luse')).toEqual(['綠色']);
  });

  it('reads Traditional characters through their Simplified form, ranges on the original', () => {
    const text = '京都旅行設計筆記';
    expect(hits(text, 'sheji')).toEqual(['設計']);
    expect(findMatches(text, 'sj')).toEqual([{ start: 4, end: 6 }]);
    expect(matchesSearch(text, 'jingdu')).toBe(true);
    // Letters in the text are matched as themselves, also next to Han characters.
    expect(hits('A股行情', 'agu')).toEqual(['A股']);
  });

  it('keeps literal matches and merges them with pinyin ones', () => {
    expect(hits('cy 是常用', 'cy')).toEqual(['cy', '常用']);
    expect(findMatches('常用', 'c')).toEqual([]);
    expect(pinyinKey('c')).toBeNull();
    expect(pinyinKey('常用')).toBeNull();
    expect(pinyinKey('cy1')).toBeNull();
    expect(pinyinKey(' Chang Yong ')).toBe('changyong');
  });

  it('needs longer queries for long text', () => {
    expect(PINYIN_LONG_TEXT_MIN_LENGTH).toBe(4);
    expect(hits('今天常用工具', 'cy', { pinyinMinLength: PINYIN_LONG_TEXT_MIN_LENGTH })).toEqual(
      [],
    );
    expect(hits('今天常用工具', 'cygj', { pinyinMinLength: PINYIN_LONG_TEXT_MIN_LENGTH })).toEqual([
      '常用工具',
    ]);
    expect(matchExcerpt('前文。今天常用工具很多。', 'changyong', 20)).toContain('常用');
    expect(matchesPinyinFolded(foldForSearch('常用'), 'cy')).toBe(true);
    expect(matchesPinyinFolded(foldForSearch('常用'), 'xy')).toBe(false);
  });
});
