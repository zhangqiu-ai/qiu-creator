import { describe, expect, it } from 'vitest';
import { restoreFinalNewline } from '../src/lossy.js';

describe('restoreFinalNewline', () => {
  it('restores the final newline only when the loaded text had one', () => {
    expect(restoreFinalNewline('a', 'b\n')).toBe('a\n');
    expect(restoreFinalNewline('a\n', 'b\n')).toBe('a\n');
    expect(restoreFinalNewline('a', 'b')).toBe('a');
  });
});
