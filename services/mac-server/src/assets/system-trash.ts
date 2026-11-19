import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** Moves a file to the user's Trash (QC-037). Injectable: tests must never touch the real Trash. */
export interface SystemTrash {
  /** Resolves once `absPath` is in the Trash; rejects and leaves the file in place otherwise. */
  moveToTrash(absPath: string): Promise<void>;
}

/** macOS 15+ ships `/usr/bin/trash`, the same "Move to Trash" as Finder (Put Back works). */
export const MACOS_TRASH = '/usr/bin/trash';

export class SystemTrashError extends Error {}

export class MacSystemTrash implements SystemTrash {
  constructor(private readonly binary = MACOS_TRASH) {}

  moveToTrash(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, [absPath], { timeout: 30_000 }, (err, _stdout, stderr) => {
        if (err !== null) {
          reject(new SystemTrashError(`${this.binary} failed: ${stderr.trim() || err.message}`));
          return;
        }
        // Trust the file system, not just the exit status.
        if (fs.existsSync(absPath)) {
          reject(new SystemTrashError(`${absPath} is still in place after ${this.binary}`));
          return;
        }
        resolve();
      });
    });
  }
}

/** Where moving to the Trash is not possible (no macOS, or under the test runner). */
export const unavailableSystemTrash: SystemTrash = {
  moveToTrash: () => Promise.reject(new SystemTrashError('the system Trash is not available')),
};

/** The macOS Trash, except under the test runner (tests inject their own). */
export function defaultSystemTrash(): SystemTrash {
  if (process.env['VITEST'] !== undefined) return unavailableSystemTrash;
  return process.platform === 'darwin' ? new MacSystemTrash() : unavailableSystemTrash;
}
