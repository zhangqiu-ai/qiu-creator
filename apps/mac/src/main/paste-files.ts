import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The biggest clipboard image the app accepts (QC-039). */
export const PASTE_MAX_BYTES = 200 * 1024 * 1024;

/** A single safe file name for a pasted image: last segment, no separators or control characters. */
export function pasteFileName(name: string): string {
  let safe = '';
  for (const ch of path.basename(name).slice(0, 120)) {
    const code = ch.charCodeAt(0);
    safe += code < 32 || code === 127 || ch === '/' || ch === '\\' || ch === ':' ? '-' : ch;
  }
  return safe === '' || safe.startsWith('.') ? 'pasted-image.png' : safe;
}

/**
 * Pasted images have no file on disk, but uploads read from disk: each one is
 * written to `<root>/<uuid>/<name>` (QC-039). A file is removed once its
 * upload succeeds or is cancelled, or when the user removes its failure card;
 * it is kept while a failure is still shown so 重試 can read it again. The
 * whole folder is cleared at start and when the app quits.
 */
export class PasteFiles {
  private readonly files = new Map<string, string>();

  constructor(private readonly root: string) {}

  /** Write the bytes; returns the file to queue for upload. */
  async write(name: string, data: Uint8Array): Promise<string> {
    if (data.byteLength === 0 || data.byteLength > PASTE_MAX_BYTES) throw new Error('invalid size');
    const dir = path.join(this.root, randomUUID());
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, pasteFileName(name));
    await fs.promises.writeFile(file, data);
    return file;
  }

  /** Remember which upload reads this file. */
  track(uploadId: string, file: string): void {
    this.files.set(uploadId, file);
  }

  has(uploadId: string): boolean {
    return this.files.has(uploadId);
  }

  /** After the upload list changed: a finished or cancelled upload no longer needs its file. */
  settle(items: readonly { id: string; state: string }[]): void {
    for (const item of items) {
      if (item.state === 'succeeded' || item.state === 'cancelled') this.release(item.id);
    }
  }

  /** The user removed the card (移除), or the upload is gone: delete its file now. */
  release(uploadId: string): void {
    const file = this.files.get(uploadId);
    if (file === undefined) return;
    this.files.delete(uploadId);
    if (path.dirname(path.dirname(file)) !== this.root) return;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  /** At start and on quit: nothing pasted survives the app session. */
  clearAll(): void {
    this.files.clear();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
