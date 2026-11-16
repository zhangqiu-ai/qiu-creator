import fs from 'node:fs';
import type { AssetKind } from '@qiu-creator/contracts';
import { fileTypeFromFile } from 'file-type';

export interface DetectedMedia {
  kind: AssetKind;
  mime: string;
  /** Canonical extension derived from the content, not from the uploaded name. */
  ext: string;
}

/**
 * Allowed binary types, keyed by the MIME type `file-type` reports from magic
 * bytes. Anything not listed is rejected even if the file name looks right.
 */
const ALLOWED: Record<string, DetectedMedia> = {
  'image/jpeg': { kind: 'image', mime: 'image/jpeg', ext: 'jpg' },
  'image/png': { kind: 'image', mime: 'image/png', ext: 'png' },
  'image/gif': { kind: 'image', mime: 'image/gif', ext: 'gif' },
  'image/webp': { kind: 'image', mime: 'image/webp', ext: 'webp' },
  'image/heic': { kind: 'image', mime: 'image/heic', ext: 'heic' },
  'image/heif': { kind: 'image', mime: 'image/heif', ext: 'heif' },
  'image/avif': { kind: 'image', mime: 'image/avif', ext: 'avif' },
  'video/mp4': { kind: 'video', mime: 'video/mp4', ext: 'mp4' },
  'video/x-m4v': { kind: 'video', mime: 'video/x-m4v', ext: 'm4v' },
  'video/quicktime': { kind: 'video', mime: 'video/quicktime', ext: 'mov' },
  'video/webm': { kind: 'video', mime: 'video/webm', ext: 'webm' },
  'audio/mpeg': { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' },
  'audio/x-m4a': { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' },
  'audio/mp4': { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' },
  'audio/wav': { kind: 'audio', mime: 'audio/wav', ext: 'wav' },
  'audio/x-wav': { kind: 'audio', mime: 'audio/wav', ext: 'wav' },
};

const MARKDOWN: DetectedMedia = {
  kind: 'markdown',
  mime: 'text/markdown; charset=utf-8',
  ext: 'md',
};

/** Per-kind size limits in bytes. */
export type SizeLimits = Record<AssetKind, number>;

const MiB = 1024 * 1024;
export const DEFAULT_SIZE_LIMITS: SizeLimits = {
  image: 50 * MiB,
  video: 20 * 1024 * MiB,
  audio: 1024 * MiB,
  markdown: 5 * MiB,
  other: 0,
};

export class MediaRejectedError extends Error {
  constructor(
    readonly reason: 'unsupported_media_type' | 'payload_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'MediaRejectedError';
  }
}

/** Valid UTF-8 without NUL bytes: the only "magic" plain Markdown has. */
function looksLikeUtf8Text(file: string, maxBytes: number): boolean {
  const size = fs.statSync(file).size;
  if (size > maxBytes) return false;
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identify a file by its content. Binary formats are matched by magic bytes;
 * a file with no recognizable signature is accepted only as Markdown, and
 * only when the name ends in `.md`/`.markdown` and the bytes are valid UTF-8.
 * Throws `MediaRejectedError` for disallowed types or sizes over the limit.
 */
export async function detectMedia(
  file: string,
  originalName: string,
  limits: SizeLimits = DEFAULT_SIZE_LIMITS,
): Promise<DetectedMedia> {
  const size = fs.statSync(file).size;
  const sniffed = await fileTypeFromFile(file);
  let media: DetectedMedia | undefined;
  if (sniffed) {
    media = ALLOWED[sniffed.mime];
    if (!media) {
      throw new MediaRejectedError(
        'unsupported_media_type',
        `file content is ${sniffed.mime}, which is not an allowed media type`,
      );
    }
  } else if (/\.(md|markdown)$/i.test(originalName) && looksLikeUtf8Text(file, limits.markdown)) {
    media = MARKDOWN;
  } else if (/\.(md|markdown)$/i.test(originalName) && size > limits.markdown) {
    media = MARKDOWN; // size check below reports the real problem
  } else {
    throw new MediaRejectedError(
      'unsupported_media_type',
      'file content does not match any allowed media type',
    );
  }
  if (size > limits[media.kind]) {
    throw new MediaRejectedError(
      'payload_too_large',
      `${media.kind} files are limited to ${limits[media.kind]} bytes`,
    );
  }
  return media;
}

export function maxUploadBytes(limits: SizeLimits): number {
  return Math.max(...Object.values(limits));
}
