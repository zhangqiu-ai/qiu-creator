import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '..');

/** Chunk types in an .icns file (`icns` header, then <type><length> chunks). */
function icnsTypes(file: string): string[] {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(0, 4).toString('latin1')).toBe('icns');
  expect(buf.readUInt32BE(4)).toBe(buf.length);
  const types: string[] = [];
  for (let at = 8; at < buf.length;) {
    types.push(buf.subarray(at, at + 4).toString('latin1'));
    const len = buf.readUInt32BE(at + 4);
    expect(len).toBeGreaterThan(8);
    at += len;
  }
  return types;
}

describe('App icon (QC-041, option B 「q 字標」)', () => {
  it('ships an icns with every size from 16 to 1024 px', () => {
    const types = icnsTypes(path.join(root, 'build', 'icon.icns'));
    // iconutil's types: 16 (ic04), 16@2x (ic11), 32 (ic05), 32@2x (ic12), 128 (ic07),
    // 128@2x (ic13), 256 (ic08), 256@2x (ic14), 512 (ic09), 512@2x = 1024 (ic10).
    for (const t of [
      'ic04',
      'ic11',
      'ic05',
      'ic12',
      'ic07',
      'ic13',
      'ic08',
      'ic14',
      'ic09',
      'ic10',
    ]) {
      expect(types).toContain(t);
    }
  });

  it('is wired into electron-builder and built from the committed SVG', () => {
    const config = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(config).toMatch(/^\s+icon: build\/icon\.icns$/m);
    expect(config).toMatch(/^\s+buildResources: build$/m);
    const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
    expect(svg).toContain('#1C1B19');
    expect(svg).toContain('#8EA2FF');
    const png = fs.readFileSync(path.join(root, 'build', 'icon.png'));
    // PNG signature and a 1024×1024 IHDR.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});
