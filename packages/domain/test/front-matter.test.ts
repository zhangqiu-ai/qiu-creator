import { describe, expect, it } from 'vitest';
import { FrontMatterError, parseWorkSource, writeWorkSource } from '../src/front-matter.js';

describe('work front matter (QC-045/046)', () => {
  it('leaves Markdown without front matter alone', () => {
    const article = '# 京都\n\n---\n\n正文\n';
    expect(parseWorkSource(article)).toEqual({
      frontMatter: null,
      body: article,
      invalid: false,
      warnings: [],
    });
  });

  it('reads type, title, ordered images, cover, video and tags', () => {
    const md = [
      '---',
      'type: image',
      'title: 京都秋天',
      'images:',
      '  - assets/b.png',
      '  - assets/a.png',
      'cover: assets/a.png',
      'tags: [旅行, 京都]',
      '---',
      '紅葉季的描述。',
      '',
    ].join('\n');
    expect(parseWorkSource(md)).toEqual({
      frontMatter: {
        type: 'image',
        title: '京都秋天',
        images: ['assets/b.png', 'assets/a.png'],
        cover: { path: 'assets/a.png' },
        video: null,
        tags: ['旅行', '京都'],
      },
      body: '紅葉季的描述。\n',
      invalid: false,
      warnings: [],
    });
    const video = parseWorkSource(
      '---\ntype: video\nvideo: assets/v.mp4\ncover:\n  time_seconds: 12.5\n---\n',
    );
    expect(video.frontMatter).toMatchObject({
      video: 'assets/v.mp4',
      cover: { time_seconds: 12.5 },
    });
    expect(video.body).toBe('');
  });

  it('flags invalid YAML and odd shapes instead of guessing', () => {
    expect(parseWorkSource('---\ntitle: [unclosed\n---\nx').invalid).toBe(true);
    expect(parseWorkSource('---\n- a\n- b\n---\nx').invalid).toBe(true);
    const odd = parseWorkSource('---\nimages: 3\ncover: {time_seconds: -1}\n---\n');
    expect(odd.frontMatter).toMatchObject({ images: [], cover: null });
    expect(odd.warnings).toEqual(['images', 'cover']);
    expect(() => writeWorkSource('---\ntitle: [unclosed\n---\nx', { title: 'y' })).toThrow(
      FrontMatterError,
    );
  });

  it('writes a new front matter in a fixed key order', () => {
    expect(
      writeWorkSource('', {
        type: 'image',
        title: '京都秋天',
        images: ['assets/a.png', 'assets/b.png'],
        cover: { path: 'assets/a.png' },
        tags: ['旅行'],
        body: '描述',
      }),
    ).toBe(
      [
        '---',
        'type: image',
        'title: 京都秋天',
        'images:',
        '  - assets/a.png',
        '  - assets/b.png',
        'cover: assets/a.png',
        'tags:',
        '  - 旅行',
        '---',
        '描述',
      ].join('\n'),
    );
    expect(
      writeWorkSource('', { type: 'video', video: 'assets/v.mp4', cover: { time_seconds: 3 } }),
    ).toBe('---\ntype: video\ncover: { time_seconds: 3 }\nvideo: assets/v.mp4\n---\n');
  });

  it('keeps unknown keys, comments and order, and round-trips without loss', () => {
    const md = [
      '---',
      '# written by hand',
      'title: 舊標題',
      'location: 京都 # where',
      'images:',
      '  - assets/a.png',
      'custom:',
      '  nested: true',
      '---',
      '描述第一行',
      '',
      '第二段',
      '',
    ].join('\n');
    const next = writeWorkSource(md, { title: '新標題', images: ['assets/b.png', 'assets/a.png'] });
    expect(next).toBe(
      [
        '---',
        '# written by hand',
        'title: 新標題',
        'location: 京都 # where',
        'images:',
        '  - assets/b.png',
        '  - assets/a.png',
        'custom:',
        '  nested: true',
        '---',
        '描述第一行',
        '',
        '第二段',
        '',
      ].join('\n'),
    );
    // Writing what was read changes nothing that was read.
    const parsed = parseWorkSource(next);
    const again = writeWorkSource(next, {
      title: parsed.frontMatter?.title ?? undefined,
      images: parsed.frontMatter?.images,
      body: parsed.body,
    });
    expect(parseWorkSource(again)).toEqual(parsed);
    expect(again).toBe(next);
  });

  it('removes a field with null and replaces the description', () => {
    const md = '---\ntype: image\ncover: assets/a.png\nimages: [assets/a.png]\n---\n舊描述\n';
    const next = writeWorkSource(md, { cover: null, body: '新描述\n' });
    expect(parseWorkSource(next)).toMatchObject({
      frontMatter: { cover: null, images: ['assets/a.png'] },
      body: '新描述\n',
    });
    expect(next).not.toContain('cover');
  });

  it('adds front matter above an existing description without front matter', () => {
    expect(writeWorkSource('只有描述\n', { type: 'image', images: [] })).toBe(
      '---\ntype: image\nimages: []\n---\n只有描述\n',
    );
  });
});
