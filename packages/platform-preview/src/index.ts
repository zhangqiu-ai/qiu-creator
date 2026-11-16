import type { Platform } from '@qiu-creator/contracts';

/**
 * Platform preview skeleton (QC-002). Only types and empty templates live here
 * for now; layouts are designed in the prototype and implemented in M2.
 *
 * Previews simulate layout and information structure only. They never use the
 * platforms' logos or trademarks; platforms are named in plain text.
 */

export type { Platform };

export const PLATFORMS = [
  'xiaohongshu',
  'wechat_mp',
  'douyin',
  'wechat_channels',
] as const satisfies readonly Platform[];

/** What a preview renders: one platform variant of a work. */
export interface PreviewInput {
  platform: Platform;
  title: string;
  body: string;
  tags: readonly string[];
  /** Resolved cover image URL, or null when the variant has no cover. */
  coverUrl: string | null;
  /** Ordered image URLs (image posts). */
  imageUrls: readonly string[];
  /** Video stream URL for video cards, or null. */
  videoUrl: string | null;
}

export type PreviewKind = 'image_post' | 'article' | 'video';

/** Per-platform layout facts. `null` means "not decided yet" (needs the prototype). */
export interface PreviewTemplate {
  platform: Platform;
  /** Plain-text platform name; never a logo. */
  displayName: string;
  kinds: readonly PreviewKind[];
  /** Cover aspect ratio as width / height. */
  coverAspectRatio: number | null;
  titleMaxChars: number | null;
  bodyPreviewMaxChars: number | null;
  /** Previews are always labelled as simulations. */
  simulated: true;
}

function emptyTemplate(
  platform: Platform,
  displayName: string,
  kinds: readonly PreviewKind[],
): PreviewTemplate {
  return {
    platform,
    displayName,
    kinds,
    coverAspectRatio: null,
    titleMaxChars: null,
    bodyPreviewMaxChars: null,
    simulated: true,
  };
}

export const templates: Readonly<Record<Platform, PreviewTemplate>> = {
  xiaohongshu: emptyTemplate('xiaohongshu', '小紅書', ['image_post', 'video']),
  wechat_mp: emptyTemplate('wechat_mp', '微信公眾號', ['article']),
  douyin: emptyTemplate('douyin', '抖音', ['video', 'image_post']),
  wechat_channels: emptyTemplate('wechat_channels', '微信視頻號', ['video']),
};

export function getTemplate(platform: Platform): PreviewTemplate {
  return templates[platform];
}

/** Label shown on every preview surface. */
export const SIMULATED_LABEL = '模擬';
