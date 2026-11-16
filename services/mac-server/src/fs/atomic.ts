import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The filesystem calls `atomicWriteFileSync` needs. Injectable so tests can
 * simulate a crash between any two steps.
 */
export interface AtomicFsOps {
  openSync: typeof fs.openSync;
  writeSync: (fd: number, data: Uint8Array) => number;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

export const nodeFsOps: AtomicFsOps = {
  openSync: fs.openSync,
  writeSync: (fd, data) => fs.writeSync(fd, data),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
};

/**
 * Replace `target` with `data` so readers only ever see the old or the new
 * content: write a sibling temp file, fsync it, rename over the target, then
 * fsync the directory. On any failure the temp file is removed and the
 * original file is untouched.
 */
export function atomicWriteFileSync(
  target: string,
  data: string | Uint8Array,
  ops: AtomicFsOps = nodeFsOps,
): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let fd: number | undefined;
  try {
    fd = ops.openSync(tmp, 'wx', 0o644);
    let offset = 0;
    while (offset < bytes.length) {
      offset += ops.writeSync(fd, bytes.subarray(offset));
    }
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    ops.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        // already failing; the original error is more useful
      }
    }
    ops.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDirectory(dir);
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort (not supported on every filesystem).
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write a file that must not already exist (snapshots are immutable). */
export function writeNewFileSync(target: string, data: string | Uint8Array): void {
  fs.writeFileSync(target, data, { flag: 'wx', mode: 0o644 });
}
