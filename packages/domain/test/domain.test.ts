import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeFileName,
  checkRevision,
  isPathInside,
  isSafeFileName,
  parseIfMatch,
  parseRange,
  resolveBaseRevision,
  resolveInside,
  sha256Hex,
  UnsafePathError,
} from '../src/index.js';

describe('sha256Hex', () => {
  it('hashes UTF-8 strings and bytes identically', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('你好')).toBe(sha256Hex(Buffer.from('你好', 'utf8')));
  });
});

describe('checkRevision', () => {
  it('accepts an exact match', () => {
    expect(checkRevision('a', 'a')).toEqual({ ok: true });
  });
  it('rejects a stale base', () => {
    expect(checkRevision('a', 'b')).toEqual({
      ok: false,
      reason: 'stale_base',
      current: 'b',
      base: 'a',
    });
  });
  it('rejects a missing base', () => {
    expect(checkRevision(undefined, 'b')).toEqual({
      ok: false,
      reason: 'missing_base',
      current: 'b',
    });
    expect(checkRevision('', 'b')).toEqual({ ok: false, reason: 'missing_base', current: 'b' });
  });
});

describe('If-Match handling', () => {
  it('parses strong, weak and bare tags', () => {
    expect(parseIfMatch('"r1"')).toEqual(['r1']);
    expect(parseIfMatch('W/"r1", "r2"')).toEqual(['r1', 'r2']);
    expect(parseIfMatch('r1')).toEqual(['r1']);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('*')).toEqual(['*']);
  });
  it('does not let the wildcard bypass the revision check', () => {
    expect(resolveBaseRevision(undefined, '*', 'cur')).toBeNull();
  });
  it('prefers whichever precondition is stale when body and header disagree', () => {
    expect(resolveBaseRevision('cur', '"old"', 'cur')).toBe('old');
    expect(resolveBaseRevision('old', '"cur"', 'cur')).toBe('old');
    expect(resolveBaseRevision(undefined, '"cur"', 'cur')).toBe('cur');
  });
});

describe('path safety', () => {
  const root = path.resolve('/srv/creatorhub');

  it('accepts ordinary and Chinese file names', () => {
    expect(isSafeFileName('source.md')).toBe(true);
    expect(isSafeFileName('封面 01.png')).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a:b', 'nul\0byte', ' padded', 'x'.repeat(256)])(
    'rejects unsafe file name %j',
    (name) => {
      expect(isSafeFileName(name)).toBe(false);
      expect(() => assertSafeFileName(name)).toThrow(UnsafePathError);
    },
  );

  it.each(['../etc/passwd', 'library/../../etc', '/etc/passwd', 'a/\0b', 'library\\..\\..\\x'])(
    'rejects escaping relative path %j',
    (rel) => {
      expect(() => resolveInside(root, rel)).toThrow(UnsafePathError);
    },
  );

  it('resolves paths that stay inside the root', () => {
    expect(resolveInside(root, 'library/works/a/source.md')).toBe(
      path.join(root, 'library/works/a/source.md'),
    );
  });

  it('does not treat sibling prefixes as inside', () => {
    expect(isPathInside(root, `${root}-evil/x`)).toBe(false);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside('relative', '/abs')).toBe(false);
  });
});

describe('parseRange', () => {
  const size = 1000;
  it('serves the full body without a header or for unsupported forms', () => {
    expect(parseRange(undefined, size)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-6', size)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-1', size)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=9-3', size)).toEqual({ kind: 'full' });
  });
  it('parses bounded, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 },
    });
    expect(parseRange('bytes=900-', size)).toEqual({
      kind: 'partial',
      range: { start: 900, end: 999 },
    });
    expect(parseRange('bytes=-100', size)).toEqual({
      kind: 'partial',
      range: { start: 900, end: 999 },
    });
    expect(parseRange('bytes=990-5000', size)).toEqual({
      kind: 'partial',
      range: { start: 990, end: 999 },
    });
  });
  it('reports unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', size)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', size)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
