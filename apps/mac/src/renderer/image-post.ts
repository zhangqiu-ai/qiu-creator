import {
  charCount,
  imagesLimit,
  PLATFORM_LIMITS,
  type Platform,
  type VariantWarning,
} from '@qiu-creator/contracts';
import { PLATFORM_SHORT_KEY, PLATFORMS } from '@qiu-creator/platform-preview';
import { t } from './i18n.js';
import type { DraftCover } from './work-session.js';

/**
 * Rules of the image-post editor (QC-045, PT-20261121-001 「v3 · 貼圖編輯」),
 * kept apart from the components so they are unit-tested. Limits are the
 * reference values in `PLATFORM_LIMITS`: they only warn, never block a save.
 */

/** Where a new image goes: before the image at `index`, or at the end. */
export type ImageSlot = number | 'end';

/** Add `id` at `slot`; an id already in the list moves there instead of repeating. */
export function insertImage(ids: readonly string[], id: string, slot: ImageSlot): string[] {
  const at = slot === 'end' ? ids.length : Math.max(0, Math.min(slot, ids.length));
  if (ids.includes(id)) return moveImageTo(ids, id, at);
  const next = [...ids];
  next.splice(at, 0, id);
  return next;
}

/** Drag reorder with an insertion line: put `id` before the image now at `toIndex` (or at the end). */
export function moveImageTo(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const target = Math.max(0, Math.min(toIndex, ids.length));
  if (target === from || target === from + 1) return [...ids];
  const next = ids.filter((x) => x !== id);
  next.splice(target > from ? target - 1 : target, 0, id);
  return next;
}

/** ⌥← / ⌥→: one step left or right. */
export function nudgeImage(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  [next[i], next[j]] = [next[j] as string, next[i] as string];
  return next;
}

/**
 * Remove an image. When it was the cover, the cover goes back to "the first
 * image" (null) rather than pointing at a file no longer in the post.
 */
export function removeImage(
  ids: readonly string[],
  cover: DraftCover | null,
  id: string,
): { images: string[]; cover: DraftCover | null } {
  return {
    images: ids.filter((x) => x !== id),
    cover: cover !== null && 'asset_id' in cover && cover.asset_id === id ? null : cover,
  };
}

/** 重新指定: put `replacement` where the missing `id` was. */
export function replaceImage(ids: readonly string[], id: string, replacement: string): string[] {
  if (ids.includes(replacement)) return ids.filter((x) => x !== id);
  return ids.map((x) => (x === id ? replacement : x));
}

/** The image shown as cover: the chosen one, else the first image. */
export function coverAssetId(ids: readonly string[], cover: DraftCover | null): string | null {
  if (cover !== null && 'asset_id' in cover) return cover.asset_id;
  return ids[0] ?? null;
}

export interface PlatformCount {
  platform: Platform;
  limit: number | null;
  actual: number;
  over: boolean;
}

/** Per-platform image count against each platform's image-post limit. */
export function imageCounts(count: number): PlatformCount[] {
  return PLATFORMS.map((platform) => {
    const limit = imagesLimit(platform, 'image');
    return { platform, limit, actual: count, over: limit !== null && count > limit };
  });
}

/** Per-platform title length (code points) against each title limit. */
export function titleCounts(title: string): PlatformCount[] {
  const actual = charCount(title);
  return PLATFORMS.map((platform) => {
    const limit = PLATFORM_LIMITS[platform].titleMaxChars;
    return { platform, limit, actual, over: limit !== null && actual > limit };
  });
}

/** The platforms whose image limit the image at `index` (0-based) is past. */
export function platformsOverAt(index: number): Platform[] {
  return PLATFORMS.filter((p) => {
    const limit = imagesLimit(p, 'image');
    return limit !== null && index >= limit;
  });
}

/** The longest description any platform takes for an image post (the shared text). */
export const DESCRIPTION_LIMIT = Math.min(
  ...PLATFORMS.map((p) => PLATFORM_LIMITS[p].bodyMaxChars ?? Number.POSITIVE_INFINITY),
);

export function shortPlatform(platform: Platform): string {
  return t(PLATFORM_SHORT_KEY[platform]);
}

/**
 * A variant warning in the interface language, from its `code`, `limit` and
 * `actual` (QC-048): the service's `message` is 繁體中文 and never shown.
 */
export function warningText(w: Pick<VariantWarning, 'code' | 'limit' | 'actual'>): string {
  const vars = { limit: w.limit, actual: w.actual, count: w.actual };
  switch (w.code) {
    case 'title_too_long':
      return t('library.warnTitle', vars);
    case 'body_too_long':
      return t('library.warnBody', vars);
    case 'too_many_images':
      return t('library.warnImages', vars);
    case 'too_many_tags':
      return t('library.warnTags', vars);
  }
}
