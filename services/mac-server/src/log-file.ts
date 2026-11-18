import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 5;

/**
 * Append-only log file with a size cap (QC-030). When a write would push the
 * file past `maxBytes`, it is renamed to `<file>.1` (older ones shift up to
 * `<file>.<keep>`, the oldest is dropped) and a new file is started. So the
 * logs never take more than about `maxBytes × (keep + 1)`. launchd itself
 * does not rotate. Synchronous on purpose: lines are small, and a fatal error
 * log must reach the disk before the process exits.
 */
export class RotatingLogFile {
  private fd: number;
  private size: number;

  constructor(
    private readonly file: string,
    private readonly maxBytes = DEFAULT_LOG_MAX_BYTES,
    private readonly keep = DEFAULT_LOG_KEEP,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(file, 'a', 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }

  /** pino calls `write(line)`. */
  write(chunk: string): boolean {
    const bytes = Buffer.byteLength(chunk);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.writeSync(this.fd, chunk);
    this.size += bytes;
    return true;
  }

  private rotate(): void {
    fs.closeSync(this.fd);
    fs.rmSync(`${this.file}.${String(this.keep)}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${String(i)}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${String(i + 1)}`);
    }
    if (this.keep > 0) fs.renameSync(this.file, `${this.file}.1`);
    else fs.rmSync(this.file, { force: true });
    this.fd = fs.openSync(this.file, 'a', 0o600);
    this.size = 0;
  }
}

/**
 * launchd's StandardErrorPath only gets what escapes the logger (a crash
 * before it starts, a native abort). It cannot be rotated while launchd holds
 * it open, so at start it is cut back to empty once it passes the cap.
 */
export function trimFile(file: string | undefined, maxBytes = DEFAULT_LOG_MAX_BYTES): void {
  if (file === undefined || file === '') return;
  try {
    if (fs.statSync(file).size > maxBytes) fs.truncateSync(file, 0);
  } catch {
    // Missing file: nothing to trim.
  }
}
