import path from 'node:path';

export class UnsafePathError extends Error {
  constructor(
    message: string,
    readonly candidate: string,
  ) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const RESERVED_NAMES = new Set(['', '.', '..']);
// Control characters (including NUL), path separators and the macOS legacy separator.
const FORBIDDEN_CHARS = new Set([
  ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
  '/',
  '\\',
  ':',
  '\u007f',
]);

/** True when `name` is a single, harmless path segment (no separators, no `..`). */
export function isSafeFileName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return false;
  if (name.length > 255) return false;
  if (name !== name.trim()) return false;
  for (const ch of name) {
    if (FORBIDDEN_CHARS.has(ch)) return false;
  }
  return true;
}

export function assertSafeFileName(name: string): string {
  if (!isSafeFileName(name)) {
    throw new UnsafePathError(`unsafe file name: ${JSON.stringify(name)}`, name);
  }
  return name;
}

/** Lexical containment check: `candidate` equals `root` or lies below it. Both must be absolute. */
export function isPathInside(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Join a relative path onto `root` and refuse anything that escapes it
 * (`..` segments, absolute paths, NUL bytes). This is lexical only; callers
 * that touch the filesystem must also verify the real path to catch symlink
 * escapes (see mac-server `resolveRealPathInside`).
 */
export function resolveInside(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new UnsafePathError('path contains NUL byte', relativePath);
  }
  if (path.isAbsolute(relativePath)) {
    throw new UnsafePathError('absolute path not allowed', relativePath);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((s) => s === '..')) {
    throw new UnsafePathError('parent directory segment not allowed', relativePath);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInside(root, resolved)) {
    throw new UnsafePathError('path escapes root', relativePath);
  }
  return resolved;
}
