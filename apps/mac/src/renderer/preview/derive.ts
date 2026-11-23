import { charCount, PLATFORM_LIMITS, type Platform } from '@qiu-creator/contracts';
import {
  codePointToIndex,
  deriveVariantBody,
  sourceOffsetAt,
  type DeriveOptions,
  type DerivedBody,
} from '@qiu-creator/platform-preview';
import type { PhoneBlock, PhoneBody } from './phone-model.js';

/**
 * The body each platform shows, derived live from the editor's unsaved draft
 * with the same `deriveVariantBody` the server uses (QC-084: the body always
 * follows the source), turned into what the phone screens read.
 */

const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

/** Images in the source, for the article simulation (公眾號 shows them inline). */
function sourceImages(source: string): { at: number; src: string }[] {
  return [...source.matchAll(IMAGE)].map((m) => ({ at: m.index, src: m[1] ?? '' }));
}

function cp(text: string, index: number): number {
  return charCount(text.slice(0, index));
}

export interface LiveBody {
  derived: DerivedBody;
  phone: PhoneBody;
}

/**
 * `resolveImage` turns a Markdown image target into a URL the phone can show
 * (the editor's asset links), or null to leave it out.
 */
export function liveBody(
  source: string,
  platform: Platform,
  options: DeriveOptions,
  resolveImage: (target: string) => string | null = () => null,
): LiveBody {
  const derived = deriveVariantBody(source, platform, options);
  const limit = PLATFORM_LIMITS[platform].bodyMaxChars;
  const blocks: PhoneBlock[] = derived.blocks.map((b) => ({
    kind: b.kind === 'heading' ? 'heading' : b.kind === 'item' ? 'item' : 'paragraph',
    text: b.text,
    at: cp(derived.text, b.text_start),
    sourceStart: b.source_start,
    sourceEnd: b.source_end,
  }));
  if (derived.format === 'markdown' && options.sourceFormat !== 'text') {
    // Images sit between blocks, by their place in the source.
    for (const img of sourceImages(source)) {
      const src = resolveImage(img.src);
      if (src === null) continue;
      const i = blocks.findIndex((b) => b.kind !== 'image' && b.sourceStart > img.at);
      const block: PhoneBlock = {
        kind: 'image',
        text: '',
        src,
        at: -1,
        sourceStart: img.at,
        sourceEnd: img.at,
      };
      if (i < 0) blocks.push(block);
      else blocks.splice(i, 0, block);
    }
  }
  const length = charCount(derived.text);
  return {
    derived,
    phone: {
      text: derived.text,
      blocks,
      length,
      limit,
      cutAt: limit !== null && length > limit ? limit : null,
    },
  };
}

/** Where the platform cuts, in the source (UTF-16), for 「在原稿標出第 N 字」. */
export function cutSourceOffset(body: LiveBody): number | null {
  const cut = body.phone.cutAt;
  if (cut === null) return null;
  return sourceOffsetAt(body.derived, codePointToIndex(body.derived.text, cut));
}
