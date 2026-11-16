import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { atomicWriteFileSync } from '../fs/atomic.js';

export const THUMBNAIL_MAX_EDGE = 512;
export const THUMBNAIL_MIME = 'image/webp';

/**
 * Render a WebP thumbnail (longest edge 512px, EXIF orientation applied) and
 * write it atomically. Also returns the source dimensions so the asset row
 * can record width/height for images.
 */
export async function renderThumbnail(
  source: string,
  target: string,
): Promise<{ width: number; height: number }> {
  const image = sharp(source, { failOn: 'error', limitInputPixels: 268_402_689 });
  const meta = await image.metadata();
  const buffer = await image
    .rotate()
    .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFileSync(target, buffer);
  const swap = (meta.orientation ?? 1) >= 5;
  const { width, height } = meta;
  return swap ? { width: height, height: width } : { width, height };
}
