import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from '@qiu-creator/domain';

/** Why a contained path could not be opened. */
export class ContainedPathError extends Error {
  constructor(
    readonly reason: 'rejected' | 'missing',
    message: string,
  ) {
    super(message);
    this.name = 'ContainedPathError';
  }
}

/**
 * Normalize a `/`-separated reference against `baseDir` (also `/`-separated,
 * relative to the root) into a root-relative path. Returns `null` when the
 * result would leave the root (`..` past the top), is absolute, empty, or
 * contains NUL or backslashes. Purely lexical.
 */
export function normalizeContainedPath(baseDir: string, reference: string): string | null {
  if (reference === '' || reference.includes('\0') || reference.includes('\\')) return null;
  if (reference.startsWith('/')) return null;
  const joined = path.posix.normalize(path.posix.join(baseDir === '' ? '.' : baseDir, reference));
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.startsWith('/')) {
    return null;
  }
  return joined.replace(/\/+$/, '');
}

export interface ContainedFile {
  /** Open read-only descriptor; the caller must close it (directly or via a stream). */
  fd: number;
  size: number;
  mtimeMs: number;
  /** Real absolute path of the opened file. */
  absPath: string;
}

/**
 * Open `rel` (a normalized, `/`-separated path relative to `root`) for reading
 * without following any symlink below the root:
 *
 * - every path segment is `lstat`ed; a symlink anywhere is refused (`rejected`);
 * - the final file must be a regular file, opened with `O_NOFOLLOW`;
 * - the opened descriptor must be the same inode that was checked, so a file
 *   swapped for a symlink between the check and the open is refused too.
 *
 * The root itself may sit behind a symlink (e.g. `/var` → `/private/var`); it
 * is resolved once and treated as trusted configuration.
 */
export function openContainedFile(root: string, rel: string): ContainedFile {
  if (normalizeContainedPath('', rel) !== rel) {
    throw new ContainedPathError('rejected', 'path is not a normalized relative path');
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new ContainedPathError('missing', 'root folder is not available');
  }
  const segments = rel.split('/');
  let current = realRoot;
  let last: fs.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      last = fs.lstatSync(current);
    } catch {
      throw new ContainedPathError('missing', 'file does not exist');
    }
    if (last.isSymbolicLink()) {
      throw new ContainedPathError('rejected', 'path crosses a symbolic link');
    }
    const isLast = index === segments.length - 1;
    if (!isLast && !last.isDirectory()) {
      throw new ContainedPathError('missing', 'file does not exist');
    }
  }
  if (last === undefined || !last.isFile()) {
    throw new ContainedPathError('missing', 'not a regular file');
  }
  if (!isPathInside(realRoot, current)) {
    throw new ContainedPathError('rejected', 'path escapes root');
  }
  let fd: number;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ELOOP') {
      throw new ContainedPathError('rejected', 'path crosses a symbolic link');
    }
    throw new ContainedPathError('missing', 'file could not be opened');
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.ino !== last.ino || stat.dev !== last.dev) {
    fs.closeSync(fd);
    throw new ContainedPathError('rejected', 'file changed while it was being opened');
  }
  return { fd, size: stat.size, mtimeMs: stat.mtimeMs, absPath: current };
}

/** Read up to `length` bytes from the start of an open file (for magic-byte sniffing). */
export function readHead(fd: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, 0);
  return buf.subarray(0, n);
}
