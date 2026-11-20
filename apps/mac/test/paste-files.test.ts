import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASTE_MAX_BYTES, PasteFiles, pasteFileName } from '../src/main/paste-files.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function root(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qc039-paste-'));
  roots.push(base);
  return path.join(base, 'qiu-creator-paste');
}
const png = new Uint8Array([137, 80, 78, 71]);

describe('pasted image temp files (QC-039)', () => {
  it('keeps a safe single file name', () => {
    expect(pasteFileName('貼上的圖片 14.32.png')).toBe('貼上的圖片 14.32.png');
    expect(pasteFileName('../../a:b.png')).toBe('a-b.png');
    expect(pasteFileName('.hidden')).toBe('pasted-image.png');
    expect(pasteFileName('')).toBe('pasted-image.png');
  });

  it('removes the file once the upload succeeds or is cancelled', async () => {
    const p = new PasteFiles(root());
    const a = await p.write('a.png', png);
    const b = await p.write('b.png', png);
    p.track('u1', a);
    p.track('u2', b);
    p.settle([
      { id: 'u1', state: 'uploading' },
      { id: 'u2', state: 'queued' },
    ]);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    p.settle([
      { id: 'u1', state: 'succeeded' },
      { id: 'u2', state: 'cancelled' },
    ]);
    expect(fs.existsSync(path.dirname(a))).toBe(false);
    expect(fs.existsSync(path.dirname(b))).toBe(false);
  });

  it('keeps it while a failure is shown (重試 reads it again), deletes it on 移除', async () => {
    const p = new PasteFiles(root());
    const file = await p.write('c.png', png);
    p.track('u1', file);
    p.settle([{ id: 'u1', state: 'failed' }]);
    expect(fs.existsSync(file)).toBe(true);
    p.release('u1');
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(p.has('u1')).toBe(false);
    // Releasing again or an unknown id is harmless.
    p.release('u1');
    p.release('nope');
  });

  it('clears everything on quit and at start, and refuses empty or huge pastes', async () => {
    const dir = root();
    const p = new PasteFiles(dir);
    const file = await p.write('d.png', png);
    p.track('u1', file);
    p.clearAll();
    expect(fs.existsSync(dir)).toBe(false);
    expect(p.has('u1')).toBe(false);
    await expect(p.write('e.png', new Uint8Array(0))).rejects.toThrow('invalid size');
    expect(PASTE_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it('never deletes outside its own folder', () => {
    const dir = root();
    const outside = path.join(path.dirname(dir), 'keep.txt');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(outside, 'x');
    const p = new PasteFiles(dir);
    p.track('u1', outside);
    p.release('u1');
    expect(fs.existsSync(outside)).toBe(true);
  });
});
