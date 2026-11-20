import { describe, expect, it } from 'vitest';
import { blockEndAt, boundaryBeforeBlock, imageMarkdown, insertBlockAt } from '../src/insert.js';

const DOC = '# 標題\n\n第一段。\n\n第二段。\n';

describe('insertBlockAt (QC-039)', () => {
  it('puts the block between blocks with one blank line each side', () => {
    const at = DOC.indexOf('第二段');
    const r = insertBlockAt(DOC, at, '![](assets/a.png)');
    expect(r.markdown).toBe('# 標題\n\n第一段。\n\n![](assets/a.png)\n\n第二段。\n');
    expect(r.markdown.slice(r.start, r.end)).toBe('![](assets/a.png)');
  });

  it('handles the start, the end and an empty document', () => {
    expect(insertBlockAt(DOC, 0, 'X').markdown).toBe(`X\n\n${DOC}`);
    expect(insertBlockAt(DOC, DOC.length, 'X').markdown).toBe(
      '# 標題\n\n第一段。\n\n第二段。\n\nX\n',
    );
    expect(insertBlockAt('', 0, 'X')).toEqual({ markdown: 'X\n', start: 0, end: 1 });
  });

  it('collapses blank lines around the insertion point', () => {
    expect(insertBlockAt('a\n\n\n\nb', 2, 'X').markdown).toBe('a\n\nX\n\nb');
  });
});

describe('caret and drop positions', () => {
  it('a caret inside a paragraph inserts after that paragraph, never inside it', () => {
    const inside = DOC.indexOf('一段');
    expect(blockEndAt(DOC, inside)).toBe(DOC.indexOf('第一段。') + '第一段。'.length);
    const between = DOC.indexOf('\n\n第二段') + 1;
    expect(blockEndAt(DOC, between)).toBe(between);
    expect(blockEndAt(DOC, 9999)).toBe(DOC.length);
  });

  it('maps a visual block index to the boundary before it', () => {
    expect(boundaryBeforeBlock(DOC, 0)).toBe(0);
    expect(boundaryBeforeBlock(DOC, 1)).toBe('# 標題'.length);
    expect(boundaryBeforeBlock(DOC, 3)).toBe(DOC.trimEnd().length);
    expect(boundaryBeforeBlock(DOC, 99)).toBe(DOC.trimEnd().length);
  });
});

describe('imageMarkdown', () => {
  it('makes alt and path safe for Markdown', () => {
    expect(imageMarkdown('assets/a.png')).toBe('![](assets/a.png)');
    expect(imageMarkdown('assets/a b(1).png', '清晨 [竹林]')).toBe(
      '![清晨 竹林](assets/a%20b%281%29.png)',
    );
  });
});
