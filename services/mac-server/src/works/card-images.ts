import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  THUMBNAIL_FRAME_MAX_BYTES,
  WORK_EXCERPT_MAX_CHARS,
  type WorkCardImage,
} from '@qiu-creator/contracts';
import { parseWorkSource } from '@qiu-creator/domain';
import sharp from 'sharp';
import { ServiceError } from '../errors.js';
import { atomicWriteFileSync } from '../fs/atomic.js';
import { openContainedFile } from '../fs/contained-file.js';
import type { Layout } from '../layout.js';
import { extractFrame } from '../media/ffmpeg.js';
import { classifyRef, extractMediaRefs } from '../media/markdown-refs.js';
import { renderThumbnail, THUMBNAIL_MAX_EDGE } from '../media/thumbnails.js';
import { isTypedWork, type TypedWorkMedia, type WorkLocation } from './typed-media.js';

/** Image files an article's first Markdown image may be (anything sharp reads). */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i;

interface CardSource {
  kind: 'image' | 'frame';
  /** As written in the Markdown or front matter. */
  reference: string;
  absPath: string;
  assetId: string | null;
  /** Frame time (0 for images). */
  timeSeconds: number;
  version: string;
}

type Lookup = { status: 'none' } | { status: 'missing' } | { status: 'ok'; source: CardSource };

export type UnavailableReason = 'none' | 'missing' | 'needs_frame' | 'decode_failed';

export interface CardImageOptions {
  /** ffmpeg for video frames; null = the app uploads frames (QC-061). */
  ffmpeg: string | null;
  /** Thumbnails rendered at the same time (default 2). */
  concurrency?: number;
  onError?: (err: unknown) => void;
}

/**
 * Library card images (QC-061). The source is picked from the work itself
 * (image cover, first image, video frame; for articles the front-matter cover
 * or first local Markdown image), always resolved by path, never by asset id,
 * with the same containment rules as `WorkMediaService`. Results are WebP
 * files (longest edge 512) in `cache/work-thumbnails/`, named by a fingerprint
 * of the source, so they are rebuildable and never stale. Sources are only
 * read: originals are never written.
 */
export class WorkCardImages {
  private readonly inflight = new Map<string, Promise<void>>();
  /** Versions ffmpeg could not decode: the app is asked for the frame instead. */
  private readonly ffmpegFailed = new Set<string>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency: number;

  constructor(
    private readonly layout: Layout,
    private readonly typed: TypedWorkMedia,
    private readonly options: CardImageOptions,
  ) {
    this.concurrency = options.concurrency ?? 2;
  }

  /** The `card_image` list field. */
  cardImage(loc: WorkLocation, markdown: string): WorkCardImage | null {
    const found = this.lookup(loc, markdown);
    if (found.status !== 'ok') return null;
    const { source } = found;
    const needsFrame =
      source.kind === 'frame' && !this.cached(loc.id, source.version) && !this.canExtract(source);
    return {
      version: source.version,
      needs_frame: needsFrame,
      // Signed by the list route, which knows the caller (`withCardUrls`).
      url: null,
      ...(needsFrame
        ? {
            frame_source: {
              asset_id: source.assetId,
              path: source.reference,
              time_seconds: source.timeSeconds,
            },
          }
        : {}),
    };
  }

  /** Absolute path of the card image, rendered now if it is not cached. */
  async file(loc: WorkLocation, markdown: string): Promise<{ file: string; version: string }> {
    const found = this.lookup(loc, markdown);
    if (found.status !== 'ok') throw unavailable(found.status);
    const { source } = found;
    const target = this.target(loc.id, source.version);
    if (!fs.existsSync(target)) {
      if (source.kind === 'frame' && !this.canExtract(source)) throw unavailable('needs_frame');
      await this.once(target, () => this.render(loc.id, source, target));
    }
    return { file: target, version: source.version };
  }

  /**
   * Store a frame the app captured (QC-061): only for the work's current
   * video and frame time, and only while no image would be shown instead.
   */
  async putFrame(
    loc: WorkLocation,
    markdown: string,
    frame: { version: string; source: string; timeSeconds: number; bytes: Buffer },
  ): Promise<WorkCardImage> {
    const found = this.lookup(loc, markdown);
    if (
      found.status !== 'ok' ||
      found.source.kind !== 'frame' ||
      // The source fingerprint: a frame of a replaced video never overwrites the new one.
      found.source.version !== frame.version ||
      found.source.reference !== frame.source ||
      Math.abs(found.source.timeSeconds - frame.timeSeconds) > 0.001
    ) {
      throw new ServiceError(
        409,
        'thumbnail_frame_stale',
        'the work no longer uses this video frame as its card image; reload the list',
        found.status === 'ok' && found.source.kind === 'frame'
          ? {
              version: found.source.version,
              path: found.source.reference,
              time_seconds: found.source.timeSeconds,
            }
          : {},
      );
    }
    if (frame.bytes.length > THUMBNAIL_FRAME_MAX_BYTES) {
      throw new ServiceError(413, 'payload_too_large', 'a frame may be at most 2 MiB');
    }
    let webp: Buffer;
    try {
      webp = await sharp(frame.bytes, { failOn: 'error', limitInputPixels: 40_000_000 })
        .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new ServiceError(415, 'unsupported_media_type', 'the frame is not a readable image');
    }
    const target = this.target(loc.id, found.source.version);
    this.write(loc.id, target, webp);
    return { version: found.source.version, needs_frame: false, url: null };
  }

  /** The reference (Markdown/front-matter path) the card image comes from, or null. */
  sourcePath(loc: WorkLocation, markdown: string): string | null {
    const found = this.lookup(loc, markdown);
    return found.status === 'ok' ? found.source.reference : null;
  }

  // ---- Internals --------------------------------------------------------------

  private lookup(loc: WorkLocation, markdown: string): Lookup {
    if (isTypedWork(loc.type)) {
      const { media } = this.typed.describe(loc, markdown);
      const cover = media.cover?.kind === 'image' ? media.cover.item : null;
      const image = cover ?? media.images[0] ?? null;
      if (image !== null)
        return this.resolve(loc, 'image', image.path, image.asset_id, 0, image.status);
      if (media.video !== null) {
        const time = media.cover?.kind === 'frame' ? media.cover.time_seconds : 0;
        return this.resolve(
          loc,
          'frame',
          media.video.path,
          media.video.asset_id,
          time,
          media.video.status,
        );
      }
      return { status: 'none' };
    }
    const parsed = parseWorkSource(markdown);
    const fmCover = parsed.frontMatter?.cover;
    if (fmCover != null && 'path' in fmCover) {
      return this.resolve(loc, 'image', fmCover.path, null, 0, 'present');
    }
    for (const src of extractMediaRefs(parsed.body)) {
      const ref = classifyRef(src);
      if (ref.type === 'local' && IMAGE_EXT.test(ref.path)) {
        return this.resolve(loc, 'image', ref.path, null, 0, 'present');
      }
    }
    return { status: 'none' };
  }

  private resolve(
    loc: WorkLocation,
    kind: 'image' | 'frame',
    reference: string,
    assetId: string | null,
    timeSeconds: number,
    status: 'present' | 'missing',
  ): Lookup {
    if (status === 'missing') return { status: 'missing' };
    const where = this.typed.locate(loc, reference);
    if (where === null) return { status: 'missing' };
    let file;
    try {
      file = openContainedFile(where.root, where.rel);
    } catch {
      return { status: 'missing' };
    }
    fs.closeSync(file.fd);
    const version = createHash('sha256')
      .update(
        JSON.stringify([kind, file.absPath, file.size, Math.trunc(file.mtimeMs), timeSeconds]),
      )
      .digest('hex')
      .slice(0, 16);
    return {
      status: 'ok',
      source: { kind, reference, absPath: file.absPath, assetId, timeSeconds, version },
    };
  }

  private canExtract(source: CardSource): boolean {
    return this.options.ffmpeg !== null && !this.ffmpegFailed.has(source.version);
  }

  private async render(workId: string, source: CardSource, target: string): Promise<void> {
    if (source.kind === 'image') {
      try {
        await this.limited(() => renderThumbnail(source.absPath, target));
      } catch {
        throw unavailable('decode_failed');
      }
      this.removeOthers(workId, target);
      return;
    }
    const ffmpeg = this.options.ffmpeg;
    if (ffmpeg === null) throw unavailable('needs_frame');
    const temp = `${target}.${String(process.pid)}.frame.png`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.limited(async () => {
        await extractFrame(ffmpeg, source.absPath, source.timeSeconds, temp);
        await renderThumbnail(temp, target);
      });
      this.removeOthers(workId, target);
    } catch (err) {
      // Let the app capture it instead (Chromium decodes what ffmpeg could not here).
      this.ffmpegFailed.add(source.version);
      this.options.onError?.(err);
      throw unavailable('needs_frame');
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private write(workId: string, target: string, data: Buffer): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFileSync(target, data);
    this.removeOthers(workId, target);
  }

  /** Drop the work's older card images; the cache only keeps the current one. */
  private removeOthers(workId: string, keep: string): void {
    const dir = path.dirname(keep);
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (name.startsWith(`${workId}-`) && name.endsWith('.webp') && file !== keep) {
          fs.rmSync(file, { force: true });
        }
      }
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  private cached(workId: string, version: string): boolean {
    return fs.existsSync(this.target(workId, version));
  }

  private target(workId: string, version: string): string {
    return this.layout.abs(this.layout.workThumbnailRel(workId, version));
  }

  /** One render per target at a time; concurrent requests wait for the same one. */
  private once(target: string, run: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(target);
    if (existing !== undefined) return existing;
    const promise = run().finally(() => this.inflight.delete(target));
    this.inflight.set(target, promise);
    return promise;
  }

  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await run();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

function unavailable(reason: UnavailableReason): ServiceError {
  return new ServiceError(404, 'thumbnail_unavailable', 'this work has no card image', { reason });
}

/**
 * Plain-text preview of a work (QC-061): the description of image and video
 * works; for articles the body without front matter, the first H1, images,
 * code fences and Markdown syntax. Whitespace collapsed; at most
 * `WORK_EXCERPT_MAX_CHARS` characters, with `…` when cut. Null without text.
 */
export function workExcerpt(type: string, markdown: string): string | null {
  let text = parseWorkSource(markdown).body;
  if (!isTypedWork(type)) text = text.replace(/^[ \t]*#[ \t]+.*$/m, '');
  text = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, ' ')
    .replace(/(\*\*|__|~~|`|\*)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  const chars = Array.from(text);
  return chars.length <= WORK_EXCERPT_MAX_CHARS
    ? text
    : `${chars
        .slice(0, WORK_EXCERPT_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}
