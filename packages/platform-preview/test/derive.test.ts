import { describe, expect, it } from 'vitest';
import type { Platform } from '@qiu-creator/contracts';
import {
  blockAtSource,
  checkDerivedLimits,
  countedText,
  derivedLength,
  codePointToIndex,
  deriveVariantBody,
  deriveWorkVariantBody,
  sourceOffsetAt,
  textOffsetAt,
} from '../src/index.js';
import { markdownForArticle, markdownToPlainText } from './support/legacy-draft.js';

const CORPUS: readonly { title: string; markdown: string }[] = [
  { title: '標題', markdown: '# 標題\n\n第一段 **粗體** 與 [連結](https://x.test)。\n\n第二段' },
  {
    title: 'T',
    markdown:
      '---\ntitle: T\ntags: [a]\n---\n\n# T\n\n## 小節\n\n- 一\n- 二 `code`\n  - 巢狀\n\n1. 甲\n2. 乙\n\n- [x] 完成\n- [ ] 未完成\n',
  },
  {
    title: '無關',
    markdown:
      '# 另一個標題\n\n> 引言一\n> 引言二\n\n![圖](a.png)\n\n<div>html</div>\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n行一  \n行二\n\n文字[^1]\n\n[^1]: 註腳\n',
  },
  { title: 'x', markdown: '' },
  { title: 'x', markdown: '   \n\n  ' },
  { title: 'Emoji', markdown: '# Emoji\n\n😀 表情 &amp; 實體 \\* 跳脫\n續行\n' },
  { title: 'x', markdown: '    縮排程式碼\n\n段落' },
];

const PLAIN: readonly Platform[] = ['xiaohongshu', 'douyin', 'wechat_channels'];

describe('deriveVariantBody parity with QC-009 drafts', () => {
  it.each(CORPUS.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    for (const platform of PLAIN) {
      expect(deriveVariantBody(c.markdown, platform, { title: c.title }).text).toBe(
        markdownToPlainText(c.markdown, c.title),
      );
    }
    expect(deriveVariantBody(c.markdown, 'wechat_mp', { title: c.title }).text).toBe(
      markdownForArticle(c.markdown, c.title),
    );
  });
});

describe('deriveVariantBody', () => {
  it('plain platforms: format, blocks and an exact map for verbatim text', () => {
    const md = '# 標題\n\n第一段 **粗體**。\n\n- 甲\n- 乙\n';
    const d = deriveVariantBody(md, 'xiaohongshu', { title: '標題' });
    expect(d.format).toBe('plain');
    expect(d.text).toBe('第一段 粗體。\n\n• 甲\n• 乙');
    expect(d.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['paragraph', '第一段 粗體。'],
      ['item', '• 甲\n• 乙'],
    ]);
    for (const b of d.blocks) expect(d.text.slice(b.text_start, b.text_end)).toBe(b.text);
    // Every mapped character is the same character in the source.
    for (const s of d.map) {
      expect(md.slice(s.source_start, s.source_end)).toBe(d.text.slice(s.text_start, s.text_end));
    }
    const i = d.text.indexOf('粗體');
    expect(sourceOffsetAt(d, i)).toBe(md.indexOf('粗體'));
    expect(textOffsetAt(d, md.indexOf('乙'))).toBe(d.text.indexOf('乙'));
    expect(blockAtSource(d, md.indexOf('甲'))?.kind).toBe('item');
  });

  it('wechat_mp keeps the Markdown and maps it one to one', () => {
    const md = '---\na: 1\n---\n# 標題\n\n## 小節\n\n- 甲\n  - 乙\n\n> 引言\n';
    const d = deriveVariantBody(md, 'wechat_mp', { title: '標題' });
    expect(d.format).toBe('markdown');
    expect(d.text).toBe('## 小節\n\n- 甲\n  - 乙\n\n> 引言');
    expect(d.blocks.map((b) => [b.kind, b.text, b.depth])).toEqual([
      ['heading', '小節', 2],
      ['item', '甲', 0],
      ['item', '乙', 1],
      ['quote', '引言', undefined],
    ]);
    expect(sourceOffsetAt(d, 0)).toBe(md.indexOf('## 小節'));
    expect(d.text.slice(d.blocks[0]?.text_start, d.blocks[0]?.text_end)).toBe('## 小節');
  });

  it('keeps a leading heading that is not the title', () => {
    expect(deriveVariantBody('# 別的\n\n內文', 'douyin', { title: '標題' }).text).toBe(
      '別的\n\n內文',
    );
    expect(deriveVariantBody('# 標題\n\n內文', 'douyin').text).toBe('標題\n\n內文');
  });

  it('plain-text sources (image and video descriptions) are kept as written', () => {
    const work = {
      title: 'T',
      markdown: '# 不用',
      description: '  第一段 **不是粗體**\n\n第二段 ',
    };
    for (const p of [...PLAIN, 'wechat_mp'] as const) {
      const d = deriveWorkVariantBody(work, p);
      expect(d.text).toBe('第一段 **不是粗體**\n\n第二段');
      expect(d.blocks.map((b) => b.text)).toEqual(['第一段 **不是粗體**', '第二段']);
      expect(sourceOffsetAt(d, 0)).toBe(2);
    }
    expect(deriveWorkVariantBody({ ...work, description: null }, 'douyin').text).toBe('不用');
  });
});

describe('checkDerivedLimits', () => {
  it('body_too_long carries the cut in code points and its source offset', () => {
    // 1001 characters, the first an astral emoji (two UTF-16 units).
    const body = `😀${'字'.repeat(1000)}`;
    const md = `# T\n\n${body}\n`;
    const derived = deriveVariantBody(md, 'xiaohongshu', { title: 'T' });
    const [w] = checkDerivedLimits('xiaohongshu', {
      title: 'T',
      body: derived,
      image_asset_ids: [],
      tags: [],
    });
    expect(w?.code).toBe('body_too_long');
    expect(w?.cut_at).toBe(1000);
    expect(w?.actual).toBe(1001);
    // The 1000th code point is the last 字, at UTF-16 index 1001 of the text.
    expect(codePointToIndex(derived.text, 1000)).toBe(1001);
    expect(w?.source_offset).toBe(md.indexOf(body) + 1001);
  });

  it('other warnings have no cut', () => {
    const derived = deriveVariantBody('短', 'xiaohongshu');
    const ws = checkDerivedLimits('xiaohongshu', {
      title: '一'.repeat(21),
      body: derived,
      image_asset_ids: [],
      tags: [],
    });
    expect(ws).toHaveLength(1);
    expect(ws[0]?.cut_at).toBeUndefined();
  });
});

describe('what the 公眾號 limit counts (QC-084 pre-release)', () => {
  const md = '# 標題\n\n第一段**重點**。\n\n![](assets/p0.png)\n\n## 小標\n\n第二段。\n';

  it('counts the visible text, not Markdown syntax such as image links', () => {
    const d = deriveVariantBody(md, 'wechat_mp', { title: '標題' });
    expect(d.text).toContain('![](assets/p0.png)');
    expect(countedText(d)).toBe('第一段重點。\n\n小標\n\n第二段。');
    expect(derivedLength(d)).toBe(16);
    // Caption platforms count their plain text as is.
    const plain = deriveVariantBody(md, 'xiaohongshu', { title: '標題' });
    expect(countedText(plain)).toBe(plain.text);
  });

  it('checks the limit on the same text and cuts in the right block', () => {
    const long = `# T\n\n![](assets/p0.png)\n\n${'字'.repeat(20_005)}\n`;
    const d = deriveVariantBody(long, 'wechat_mp', { title: 'T' });
    const [w] = checkDerivedLimits('wechat_mp', {
      title: 'T',
      body: d,
      image_asset_ids: [],
      tags: [],
    });
    expect(w).toMatchObject({ code: 'body_too_long', actual: 20_005, cut_at: 20_000 });
    expect(w?.source_offset).toBe(long.indexOf('字') + 20_000);
    const short = deriveVariantBody('# T\n\n![](a.png)\n\n短。\n', 'wechat_mp', { title: 'T' });
    expect(
      checkDerivedLimits('wechat_mp', { title: 'T', body: short, image_asset_ids: [], tags: [] }),
    ).toEqual([]);
  });
});
