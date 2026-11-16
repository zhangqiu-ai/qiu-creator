import { describe, expect, it } from 'vitest';
import { detectLossySyntax, restoreFinalNewline } from '../src/lossy.js';

import { fixture } from './fixture.js';

describe('detectLossySyntax', () => {
  it('finds nothing in plain CommonMark + GFM documents', () => {
    expect(detectLossySyntax(fixture('structure.md'))).toEqual([]);
    expect(detectLossySyntax(fixture('long-chinese.md'))).toEqual([]);
  });

  it('flags HTML, footnotes and reference links', () => {
    expect(detectLossySyntax(fixture('lossy.md')).sort()).toEqual(
      ['footnote', 'html', 'reference_link'].sort(),
    );
  });

  it('flags table edge cases', () => {
    expect(detectLossySyntax('| a | b |\n| - | - |\n| x \\| y | z |\n')).toContain(
      'table_edge_case',
    );
    expect(detectLossySyntax('| a | b |\n| - | - |\n| x | y | z |\n')).toContain('table_edge_case');
    expect(detectLossySyntax('| a | b |\n| - | - |\n| x | y |\n')).toEqual([]);
  });

  it('flags math blocks and directives', () => {
    expect(detectLossySyntax('$$\nE = mc^2\n$$\n')).toContain('math');
    expect(detectLossySyntax(':::note\n提示\n:::\n')).toContain('directive');
  });
});

describe('restoreFinalNewline', () => {
  it('restores the final newline only when the loaded text had one', () => {
    expect(restoreFinalNewline('a', 'b\n')).toBe('a\n');
    expect(restoreFinalNewline('a\n', 'b\n')).toBe('a\n');
    expect(restoreFinalNewline('a', 'b')).toBe('a');
  });
});
