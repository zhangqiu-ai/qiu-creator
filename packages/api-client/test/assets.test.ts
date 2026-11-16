import { describe, expect, it } from 'vitest';
import { base64Utf8, parseSseChunk } from '../src/index.js';

describe('base64Utf8', () => {
  it.each(['', 'a', 'ab', 'abc', 'video.mp4', '旅行 01.mov', '🎬'])(
    'matches Buffer for %j',
    (s) => {
      expect(base64Utf8(s)).toBe(Buffer.from(s, 'utf8').toString('base64'));
    },
  );
});

describe('parseSseChunk', () => {
  it('parses complete events, skips comments and keeps the partial tail', () => {
    const { events, rest } = parseSseChunk(
      'retry: 3000\n: connected\n\nid: 5\nevent: work.updated\ndata: {"a":1}\n\nid: 6\ndata: par',
    );
    expect(events).toEqual([{ id: '5', event: 'work.updated', data: '{"a":1}' }]);
    expect(rest).toBe('id: 6\ndata: par');
  });

  it('joins multi-line data and normalizes CRLF', () => {
    const { events } = parseSseChunk('data: line1\r\ndata: line2\r\n\r\n');
    expect(events).toEqual([{ id: undefined, event: undefined, data: 'line1\nline2' }]);
  });
});
