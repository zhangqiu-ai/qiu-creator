import { describe, expect, it } from 'vitest';
import {
  composeSegments,
  diffSentences,
  hunkCount,
  insertAfter,
  sentences,
  splice,
} from '../src/renderer/rewrite-diff.js';

describe('sentences', () => {
  it('splits after terminators, keeps closing quotes, and loses nothing', () => {
    const text = '他說：「好。」然後走了！真的？Yes. It works.\n下一行';
    const parts = sentences(text);
    expect(parts).toEqual([
      '他說：「好。」',
      '然後走了！',
      '真的？',
      'Yes. ',
      'It works.\n',
      '下一行',
    ]);
    expect(parts.join('')).toBe(text);
  });

  it('does not split decimals or abbreviations without a following space', () => {
    expect(sentences('版本 3.5 很穩。')).toEqual(['版本 3.5 很穩。']);
  });
});

describe('diffSentences', () => {
  const before = '第一句。第二句。第三句。';
  const after = '第一句改。第二句。第三句也改了。第四句。';

  it('keeps uneven runs together as one hunk', () => {
    const segs = diffSentences(before, after);
    expect(hunkCount(segs)).toBe(2);
    expect(segs).toEqual([
      { kind: 'change', before: '第一句。', after: '第一句改。', index: 0 },
      { kind: 'same', text: '第二句。' },
      { kind: 'change', before: '第三句。', after: '第三句也改了。第四句。', index: 1 },
    ]);
  });

  it('composes all, none or some of the hunks exactly', () => {
    const segs = diffSentences(before, after);
    expect(composeSegments(segs, [true, true])).toBe(after);
    expect(composeSegments(segs, [false, false])).toBe(before);
    expect(composeSegments(segs, [false, true])).toBe('第一句。第二句。第三句也改了。第四句。');
  });

  it('pairs a run of rewritten sentences one by one', () => {
    const segs = diffSentences('甲。乙。丙。', '甲一。乙二。丙三。');
    expect(hunkCount(segs)).toBe(3);
    expect(composeSegments(segs, [true, false, true])).toBe('甲一。乙。丙三。');
  });

  it('has no hunks for identical text', () => {
    expect(hunkCount(diffSentences(before, before))).toBe(0);
  });
});

describe('splice and insertAfter', () => {
  const md = '# 標題\n\n段落一。\n\n段落二。\n';
  const range = { start: md.indexOf('段落一'), end: md.indexOf('段落一') + 4 };

  it('replaces a range', () => {
    expect(splice(md, range, '新段落。')).toBe('# 標題\n\n新段落。\n\n段落二。\n');
  });

  it('inserts a new block after the range, also at the end of the document', () => {
    expect(insertAfter(md, range, ' 補充。 ')).toBe('# 標題\n\n段落一。\n\n補充。\n\n段落二。\n');
    const last = { start: md.indexOf('段落二'), end: md.length };
    expect(insertAfter(md, last, '結尾。')).toBe('# 標題\n\n段落一。\n\n段落二。\n\n結尾。\n');
  });
});
