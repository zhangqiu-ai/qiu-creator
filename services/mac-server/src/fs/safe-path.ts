import fs from 'node:fs';
import { isPathInside, resolveInside, UnsafePathError } from '@qiu-creator/domain';

/**
 * Resolve `relativePath` under `root` and verify, on disk, that the target's
 * real path (after following symlinks) is still inside the real root. Catches
 * both `..` traversal and symlinks pointing outside the root.
 */
export function resolveRealPathInside(root: string, relativePath: string): string {
  const lexical = resolveInside(root, relativePath);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(lexical);
  if (!isPathInside(realRoot, real)) {
    throw new UnsafePathError('path resolves outside root via symlink', relativePath);
  }
  return real;
}
