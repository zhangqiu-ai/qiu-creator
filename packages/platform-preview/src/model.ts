import {
  charCount,
  checkVariantLimits,
  imagesLimit,
  PLATFORM_LIMITS,
  type Platform,
  type VariantWarning,
} from '@qiu-creator/contracts';
import { SOURCE_LOCALE, translate, type Locale, type MessageKey } from '@qiu-creator/i18n';
import { getTemplate, type PreviewTemplate } from './templates.js';

/**
 * Platform names for our own labels (QC-042). The simulated platforms' own
 * interface text stays untranslated in `./templates.ts`; everything we write
 * around the simulation comes from the catalog.
 */
export const PLATFORM_NAME_KEY: Readonly<Record<Platform, MessageKey>> = {
  xiaohongshu: 'library.platformXiaohongshu',
  wechat_mp: 'library.platformWechatMp',
  douyin: 'library.platformDouyin',
  wechat_channels: 'library.platformWechatChannels',
};

/** Short platform names, for tabs and inline labels. */
export const PLATFORM_SHORT_KEY: Readonly<Record<Platform, MessageKey>> = {
  xiaohongshu: 'library.shortXiaohongshu',
  wechat_mp: 'library.shortWechatMp',
  douyin: 'library.shortDouyin',
  wechat_channels: 'library.shortWechatChannels',
};

export function platformName(locale: Locale, platform: Platform): string {
  return translate(locale, PLATFORM_NAME_KEY[platform]);
}

export function platformShortName(locale: Locale, platform: Platform): string {
  return translate(locale, PLATFORM_SHORT_KEY[platform]);
}

/**
 * Platform-neutral view model for a simulated post. Pure TypeScript: the Mac
 * app renders it with the DOM templates in `./react`, and the phase-two
 * mobile app can render the same model natively or in a WebView.
 */

export interface PreviewSource {
  platform: Platform;
  title: string;
  body: string;
  tags: readonly string[];
  /** Resolved cover URL; null shows a neutral placeholder. */
  coverUrl: string | null;
  /** Ordered image URLs (the cover is usually also the first image). */
  imageUrls: readonly string[];
  /** Number of images in the variant, even if some URLs are not resolved yet. */
  imageCount?: number;
  /** Display name of the account in the simulation. */
  author?: string;
  /** Date line, already formatted for display. */
  dateLabel?: string;
  /** The work's type: image posts count images against `imagePostImagesMax` (QC-045). */
  workType?: string;
  /** Language for the labels we write ourselves (the placeholder author name). */
  locale?: Locale;
}

export type PreviewBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'item'; text: string };

export interface PreviewModel {
  platform: Platform;
  template: PreviewTemplate;
  author: string;
  dateLabel: string;
  title: {
    /** What the platform would show: cut at the limit with an ellipsis. */
    shown: string;
    length: number;
    limit: number | null;
    overBy: number;
  };
  body: {
    /** Plain text for caption-style platforms. */
    text: string;
    /** Rendered blocks for article platforms (公眾號). */
    blocks: PreviewBlock[];
    length: number;
    limit: number | null;
    overBy: number;
  };
  tags: { shown: readonly string[]; line: string; limit: number | null; overBy: number };
  images: {
    /** URLs the platform would show, in order. */
    visible: readonly string[];
    total: number;
    limit: number | null;
    overBy: number;
  };
  coverUrl: string | null;
  warnings: VariantWarning[];
}

/** Cut to `limit` code points (never splitting a surrogate pair) and add an ellipsis. */
export function truncate(text: string, limit: number | null): string {
  if (limit === null) return text;
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`;
}

function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Light Markdown → blocks for the article simulation: headings, paragraphs and
 * list items; images, HTML and code fences are left out. A simulation, not a
 * renderer: the exact WeChat typesetting is out of scope.
 */
export function markdownBlocks(markdown: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  let paragraph: string[] = [];
  let fenced = false;
  const flush = (): void => {
    const text = stripInline(paragraph.join(' '));
    if (text !== '') blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (line.trim() === '' || /^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush();
    } else if (heading !== null) {
      flush();
      const text = stripInline(heading[1] ?? '');
      if (text !== '') blocks.push({ kind: 'heading', text });
    } else if (item !== null) {
      flush();
      const text = stripInline(item[1] ?? '');
      if (text !== '') blocks.push({ kind: 'item', text });
    } else {
      paragraph.push(line.replace(/^>\s?/, ''));
    }
  }
  flush();
  return blocks;
}

export function buildPreviewModel(source: PreviewSource): PreviewModel {
  const limits = PLATFORM_LIMITS[source.platform];
  const template = getTemplate(source.platform);
  const total = source.imageCount ?? source.imageUrls.length;
  const warnings = checkVariantLimits(
    source.platform,
    {
      title: source.title,
      body: source.body,
      image_asset_ids: Array.from({ length: total }, (_, i) => String(i)),
      tags: source.tags,
    },
    PLATFORM_LIMITS,
    source.workType,
  );
  const titleLength = charCount(source.title);
  const bodyLength = charCount(source.body);
  const over = (actual: number, limit: number | null): number =>
    limit === null ? 0 : Math.max(0, actual - limit);
  const shownTags = limits.tagsMax === null ? source.tags : source.tags.slice(0, limits.tagsMax);
  const imagesMax = imagesLimit(source.platform, source.workType ?? 'article');
  const visible = imagesMax === null ? source.imageUrls : source.imageUrls.slice(0, imagesMax);

  return {
    platform: source.platform,
    template,
    author: source.author ?? translate(source.locale ?? SOURCE_LOCALE, 'library.previewAuthor'),
    dateLabel: source.dateLabel ?? '',
    title: {
      shown: truncate(source.title, limits.titleMaxChars),
      length: titleLength,
      limit: limits.titleMaxChars,
      overBy: over(titleLength, limits.titleMaxChars),
    },
    body: {
      text:
        limits.bodyFormat === 'markdown' ? source.body : truncate(source.body, limits.bodyMaxChars),
      blocks: limits.bodyFormat === 'markdown' ? markdownBlocks(source.body) : [],
      length: bodyLength,
      limit: limits.bodyMaxChars,
      overBy: over(bodyLength, limits.bodyMaxChars),
    },
    tags: {
      shown: shownTags,
      line: shownTags.map((t) => `#${t}`).join(' '),
      limit: limits.tagsMax,
      overBy: over(source.tags.length, limits.tagsMax),
    },
    images: {
      visible,
      total,
      limit: imagesMax,
      overBy: over(total, imagesMax),
    },
    coverUrl: source.coverUrl,
    warnings,
  };
}
