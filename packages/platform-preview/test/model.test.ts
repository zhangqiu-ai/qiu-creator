import { describe, expect, it } from 'vitest';
import { buildPreviewModel, markdownBlocks, truncate, type PreviewSource } from '../src/index.js';

const base: PreviewSource = {
  platform: 'xiaohongshu',
  title: '京都紅葉季七日慢遊路線',
  body: '第一天。',
  tags: ['京都', '紅葉'],
  coverUrl: 'http://x/c.jpg',
  imageUrls: ['http://x/c.jpg', 'http://x/2.jpg'],
};

describe('truncate', () => {
  it('cuts by code point and never splits an emoji', () => {
    expect(truncate('一二三四', 3)).toBe('一二三…');
    expect(truncate('🍁🍁🍁', 2)).toBe('🍁🍁…');
    expect(truncate('短', 20)).toBe('短');
    expect(truncate('任意長度', null)).toBe('任意長度');
  });
});

describe('buildPreviewModel', () => {
  it('shows a title cut at the platform limit and reports the overflow', () => {
    const m = buildPreviewModel({ ...base, title: '一'.repeat(25) });
    expect(m.title).toMatchObject({ length: 25, limit: 20, overBy: 5 });
    expect(m.title.shown).toBe(`${'一'.repeat(20)}…`);
    expect(m.warnings.map((w) => w.code)).toEqual(['title_too_long']);
  });

  it('applies each platform its own limits', () => {
    const title = '一'.repeat(25);
    expect(buildPreviewModel({ ...base, platform: 'wechat_mp', title }).title.overBy).toBe(0);
    expect(buildPreviewModel({ ...base, platform: 'douyin', title }).title.overBy).toBe(0);
    expect(buildPreviewModel({ ...base, platform: 'wechat_channels', title }).title.overBy).toBe(9);
  });

  it('shows only the images the platform would and counts the rest', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `u${String(i)}`);
    const m = buildPreviewModel({ ...base, platform: 'wechat_channels', imageUrls: urls });
    expect(m.images).toMatchObject({ total: 12, limit: 9, overBy: 3 });
    expect(m.images.visible).toHaveLength(9);
    const mp = buildPreviewModel({ ...base, platform: 'wechat_mp', imageUrls: urls });
    expect(mp.images.overBy).toBe(0);
  });

  it('keeps the image count when URLs are still loading', () => {
    const m = buildPreviewModel({
      ...base,
      platform: 'wechat_channels',
      imageUrls: [],
      imageCount: 10,
    });
    expect(m.images.overBy).toBe(1);
  });

  it('builds the tag line and caps tags where the platform does', () => {
    const tags = ['a', 'b', 'c', 'd', 'e', 'f'];
    const dy = buildPreviewModel({ ...base, platform: 'douyin', tags });
    expect(dy.tags).toMatchObject({ line: '#a #b #c #d #e', overBy: 1 });
  });

  it('renders article bodies as blocks and captions as plain text', () => {
    const body = '# 標題\n\n段落 **粗體** 與[連結](http://x)。\n\n![圖](a.png)\n\n- 一\n- 二\n';
    const mp = buildPreviewModel({ ...base, platform: 'wechat_mp', body });
    expect(mp.body.blocks).toEqual([
      { kind: 'heading', text: '標題' },
      { kind: 'paragraph', text: '段落 粗體 與連結。' },
      { kind: 'item', text: '一' },
      { kind: 'item', text: '二' },
    ]);
    const xhs = buildPreviewModel({ ...base, body: '一'.repeat(1005) });
    expect(xhs.body.blocks).toEqual([]);
    expect(xhs.body.overBy).toBe(5);
    expect(xhs.body.text.endsWith('…')).toBe(true);
  });
});

describe('markdownBlocks', () => {
  it('skips fenced code and rules, joins wrapped lines', () => {
    expect(markdownBlocks('第一行\n第二行\n\n```\ncode\n```\n\n---\n\n> 引用')).toEqual([
      { kind: 'paragraph', text: '第一行 第二行' },
      { kind: 'paragraph', text: '引用' },
    ]);
  });
});
