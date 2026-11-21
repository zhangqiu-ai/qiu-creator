import {
  charCount,
  GEMINI_VIDEO_LIMITS,
  PLATFORM_LIMITS,
  type AssetRecord,
  type Platform,
} from '@qiu-creator/contracts';

/**
 * Rules of the video-work editor (QC-046, PT-20261121-001 「v3 · 視頻作品」),
 * kept apart from the components so they are unit-tested.
 */

/** The two platforms a video work is written for. */
export const VIDEO_PLATFORMS = ['douyin', 'wechat_channels'] as const satisfies readonly Platform[];
export type VideoPlatform = (typeof VIDEO_PLATFORMS)[number];

/** Cover crops per platform (PT-20261121-001): 抖音 3:4, 視頻號 6:7. */
export const COVER_CROPS: Readonly<Record<VideoPlatform, string>> = {
  douyin: '3 / 4',
  wechat_channels: '6 / 7',
};

/** ←→ on the player move this many seconds. */
export const SEEK_STEP_SECONDS = 5;

/** Frames offered for the cover: evenly spaced, never the very first or last instant. */
export function frameTimes(duration: number, count = 8): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return Array.from({ length: count }, (_, i) => round1(((i + 0.5) * duration) / count));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The player position after ←/→, kept inside the video. */
export function seekBy(current: number, delta: number, duration: number): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(max, current + delta));
}

/** Where a time sits on the scrubber, 0–100 (%). */
export function scrubPercent(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(100, (time / duration) * 100));
}

export type AnalyzeBlock = 'uploading' | 'too_large' | 'too_long' | null;

/**
 * Why this video cannot go to Gemini at all, known before asking the service:
 * still uploading, over the 2 GB file limit, or longer than even low
 * resolution allows. Null when it may be estimated and sent.
 */
export function analyzeBlock(
  asset: Pick<AssetRecord, 'bytes' | 'duration'> | null,
  uploading: boolean,
): AnalyzeBlock {
  if (uploading) return 'uploading';
  if (asset === null) return null;
  if (asset.bytes > GEMINI_VIDEO_LIMITS.maxFileBytes) return 'too_large';
  if (asset.duration !== null && asset.duration > GEMINI_VIDEO_LIMITS.maxDurationSeconds.low) {
    return 'too_long';
  }
  return null;
}

/** Longer than the default-resolution limit: analysed in full at low resolution (decision). */
export function isLongVideo(asset: Pick<AssetRecord, 'duration'> | null): boolean {
  return (
    asset !== null &&
    asset.duration !== null &&
    asset.duration > GEMINI_VIDEO_LIMITS.maxDurationSeconds.default
  );
}

export type Orientation = 'portrait' | 'landscape' | 'square';

export function orientationOf(width: number | null, height: number | null): Orientation | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  if (width === height) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

export interface CopyCount {
  platform: VideoPlatform;
  actual: number;
  limit: number | null;
  over: boolean;
}

function counts(actual: number, limit: (p: VideoPlatform) => number | null): CopyCount[] {
  return VIDEO_PLATFORMS.map((platform) => {
    const l = limit(platform);
    return { platform, actual, limit: l, over: l !== null && actual > l };
  });
}

/** Title length (code points) against 抖音 30 and 視頻號 16. */
export function videoTitleCounts(title: string): CopyCount[] {
  return counts(charCount(title), (p) => PLATFORM_LIMITS[p].titleMaxChars);
}

/** Description length against each platform's limit. */
export function videoBodyCounts(body: string): CopyCount[] {
  return counts(charCount(body), (p) => PLATFORM_LIMITS[p].bodyMaxChars);
}

/** Topics against each platform's limit (抖音 5). */
export function videoTagCounts(tags: readonly string[]): CopyCount[] {
  return counts(tags.length, (p) => PLATFORM_LIMITS[p].tagsMax);
}

/** 0:42 style label for a time point. */
export function timeLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}
