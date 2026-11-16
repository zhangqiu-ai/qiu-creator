import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** A real PNG generated in memory. */
export async function pngBytes(width = 800, height = 600, color = '#3366ff'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** Minimal ISO-BMFF header (`ftyp isom`) that magic-byte sniffing recognizes as video/mp4. */
export function mp4Bytes(totalSize = 64 * 1024): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const body = Buffer.alloc(Math.max(0, totalSize - ftyp.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([ftyp, body]);
}

/** A ZIP archive signature: something that must never be accepted, whatever it is named. */
export function zipBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), Buffer.alloc(200, 1)]);
}

/**
 * A stand-in ffprobe: a shell script that prints `json` (or exits with
 * `exitCode`). Never runs the real binary, so tests do not depend on Homebrew.
 */
export function fakeFfprobe(
  dir: string,
  behaviour: { json: unknown } | { exitCode: number },
): string {
  const file = path.join(dir, 'ffprobe');
  const script =
    'json' in behaviour
      ? `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(behaviour.json)}\nJSON\n`
      : `#!/bin/sh\necho "boom" >&2\nexit ${behaviour.exitCode}\n`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}
