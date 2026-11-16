export type ByteRange = { start: number; end: number };

export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; range: ByteRange } | { kind: 'unsatisfiable' };

/**
 * Parse a single-range `Range: bytes=...` header against a resource of
 * `size` bytes (RFC 9110 §14). Multi-range and malformed headers are ignored
 * (served as a full 200 response), which the RFC permits.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'full' };
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };

  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { kind: 'partial', range: { start, end: size - 1 } };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: 'full' };
  return { kind: 'partial', range: { start, end } };
}
