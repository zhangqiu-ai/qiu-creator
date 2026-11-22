import { describe, expect, it } from 'vitest';
import {
  findMatches,
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
