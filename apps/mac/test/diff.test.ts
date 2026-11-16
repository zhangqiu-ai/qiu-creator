import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/renderer/diff.js';

describe('diffLines', () => {
  it('marks lines only in the server version as removed and only in mine as added', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('returns all-same for identical text', () => {
    expect(diffLines('中文\n第二行', '中文\n第二行').every((l) => l.kind === 'same')).toBe(true);
  });
});
