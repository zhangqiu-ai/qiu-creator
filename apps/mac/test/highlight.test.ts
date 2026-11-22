import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Highlight, HitPassage, leadToHit, SearchHighlight } from '../src/renderer/Highlight.js';

/** QC-079: pinyin hits mark the Chinese characters; body text needs a longer pinyin query. */
function render(query: string, node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(SearchHighlight, { query, children: node }));
}

describe('search highlight (QC-068, QC-079)', () => {
  it('marks the characters a pinyin query matches', () => {
    expect(render('cy', createElement(Highlight, { text: '常用工具' }))).toBe(
      '<mark class="hit">常用</mark>工具',
    );
    expect(render('changyong', createElement(Highlight, { text: '旅行常用清單' }))).toBe(
      '旅行<mark class="hit">常用</mark>清單',
    );
  });

  it('needs 4 letters of pinyin in body text and its excerpts, like the service', () => {
    expect(render('cy', createElement(Highlight, { text: '開頭寫常用的段落', long: true }))).toBe(
      '開頭寫常用的段落',
    );
    expect(render('cy', createElement(HitPassage, { text: '開頭寫常用的段落' }))).toBe(
      '開頭寫常用的段落',
    );
    expect(render('changyong', createElement(HitPassage, { text: '開頭寫常用的段落' }))).toBe(
      '開頭寫<mark class="hit">常用</mark>的段落',
    );
    // Literal hits are marked at any length.
    expect(render('常用', createElement(Highlight, { text: '開頭寫常用的段落', long: true }))).toBe(
      '開頭寫<mark class="hit">常用</mark>的段落',
    );
  });

  it('cuts a passage to just before its first pinyin hit', () => {
    const text = `${'很長的開頭'.repeat(6)}鬱金香花田`;
    expect(leadToHit(text, 'yujinxiang', { pinyinMinLength: 4 })).toBe(
      `…${Array.from(text.slice(0, text.indexOf('鬱')))
        .slice(-10)
        .join('')}鬱金香花田`,
    );
  });
});
