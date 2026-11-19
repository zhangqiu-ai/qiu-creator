// Renders build/icon.svg into build/icon.icns (16–1024 px, @1x and @2x) and
// build/icon.png (1024) for electron-builder (QC-041). Run after editing the SVG:
//   node apps/mac/scripts/build-icon.mjs
// Uses sharp from the service workspace (a dev-time tool only) and macOS iconutil.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, 'build');
const requireFromServer = createRequire(
  path.join(root, '..', '..', 'services', 'mac-server', 'package.json'),
);
const sharp = requireFromServer('sharp');
const svg = fs.readFileSync(path.join(build, 'icon.svg'));

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-icon-')) + '/icon.iconset';
fs.mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
    await sharp(svg, { density: Math.max(72, (72 * px) / 1024) * 4 })
      .resize(px, px)
      .png()
      .toFile(path.join(iconset, name));
  }
}
await sharp(svg, { density: 288 }).resize(1024, 1024).png().toFile(path.join(build, 'icon.png'));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
console.log('wrote build/icon.icns and build/icon.png');
