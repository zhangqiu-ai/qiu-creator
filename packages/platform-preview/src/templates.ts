import { PLATFORM_LIMITS, type Platform } from '@qiu-creator/contracts';

/**
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

export type PreviewKind = 'image_post' | 'article' | 'video';

/** Per-platform layout facts. */
export interface PreviewTemplate {
  platform: Platform;
  /** Plain-text platform name; never a logo. */
  displayName: string;
  /** Short name for tabs. */
  shortName: string;
  kinds: readonly PreviewKind[];
  /** Cover aspect ratio as width / height. */
  coverAspectRatio: number;
  coverRatioLabel: string;
  titleMaxChars: number | null;
  bodyPreviewMaxChars: number | null;
  /** Previews are always labelled as simulations. */
  simulated: true;
}

function template(
  platform: Platform,
  displayName: string,
  shortName: string,
  kinds: readonly PreviewKind[],
  coverAspectRatio: number,
  coverRatioLabel: string,
): PreviewTemplate {
  return {
    platform,
    displayName,
    shortName,
    kinds,
    coverAspectRatio,
    coverRatioLabel,
    titleMaxChars: PLATFORM_LIMITS[platform].titleMaxChars,
    bodyPreviewMaxChars: PLATFORM_LIMITS[platform].bodyMaxChars,
    simulated: true,
  };
}

/** Layout facts from the approved prototype (MacPreview); limits come from contracts. */
export const templates: Readonly<Record<Platform, PreviewTemplate>> = {
  xiaohongshu: template('xiaohongshu', '小紅書', '小紅書', ['image_post', 'video'], 3 / 4, '3:4'),
  wechat_mp: template('wechat_mp', '微信公眾號', '公眾號', ['article'], 2.35, '2.35:1'),
  douyin: template('douyin', '抖音', '抖音', ['video', 'image_post'], 9 / 16, '9:16'),
  wechat_channels: template(
    'wechat_channels',
    '微信視頻號',
    '視頻號',
    ['video', 'image_post'],
    6 / 7,
    '6:7',
  ),
};

export function getTemplate(platform: Platform): PreviewTemplate {
  return templates[platform];
}

/** Label shown on every preview surface. */
export const SIMULATED_LABEL = '模擬';
