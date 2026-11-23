import type { Platform } from '@qiu-creator/contracts';

/**
 * What the simulated phone shows for one platform (QC-084, PT-20261123-001
 * v2). The panel builds it from the platform's overrides and the body derived
 * live from the unsaved editor draft; the screens only render it and report
 * edits through `PhoneActions`. Nothing here talks to the server.
 */

/** The three screens of every platform, in swipe order. */
export const SCREENS = ['publish', 'feed', 'body'] as const;
export type Screen = (typeof SCREENS)[number];

/** A per-platform field: `own` is true when the platform overrides the source (「自訂」). */
export interface PhoneField<T> {
  value: T;
  own: boolean;
}

export interface PhoneImage {
  id: string;
  url: string;
}

/** One block of the derived body, with its place in the Markdown source (for follow). */
export interface PhoneBlock {
  kind: 'heading' | 'paragraph' | 'item' | 'image';
  /** Plain text; empty for images. */
  text: string;
  /** Image URL for `image` blocks (公眾號 renders images inline). */
  src?: string;
  /** Code-point offset of the block's first character in `PhoneBody.text` (-1 for images). */
  at: number;
  /** Source range in the work's Markdown, for follow and 在原稿編輯. */
  sourceStart: number;
  sourceEnd: number;
}

export interface PhoneBody {
  /** The derived plain text the platform would publish. */
  text: string;
  blocks: readonly PhoneBlock[];
  /** Code points in `text`. */
  length: number;
  limit: number | null;
  /** Where the platform cuts (code points into `text`), or null within the limit. */
  cutAt: number | null;
}

export interface PhoneModel {
  platform: Platform;
  /** Account name and date line for the simulation (already formatted). */
  author: string;
  dateLabel: string;
  title: PhoneField<string> & { length: number; limit: number | null };
  /** Resolved cover URL (platform override, else the work's cover cropped); null shows a placeholder. */
  cover: PhoneField<string | null>;
  /** Cover aspect ratio, width / height (小紅書 3/4, 公眾號 2.35, 抖音 3/4, 視頻號 6/7). */
  coverRatio: number;
  coverRatioLabel: string;
  images: PhoneField<readonly PhoneImage[]> & { limit: number | null };
  tags: PhoneField<readonly string[]> & { limit: number | null };
  body: PhoneBody;
  /** Index into `body.blocks` the editor caret is in (follow highlight), or null. */
  current: number | null;
}

/** What the screens can ask for. All optional fields of the publish screen go through here. */
export interface PhoneActions {
  /** Typing in the title (the panel saves it as this platform's override). */
  editTitle: (text: string) => void;
  /** 「改回跟隨原稿」 for one field. */
  follow: (field: 'title' | 'cover' | 'images' | 'tags') => void;
  /** Dragged into a new order (ids); the first image is the cover unless one is set. */
  reorderImages: (ids: readonly string[]) => void;
  removeTag: (tag: string) => void;
  addTags: (text: string) => void;
  /** Opens the AI 標題 sheet inside the phone. */
  openTitleAi: () => void;
  /** Opens the 選封面 sheet (pick an image, AI 封面, upload) inside the phone. */
  openCover: () => void;
  /** Tapping title or cover on the feed or body screen: back to publish, focusing that field. */
  goEdit: (field: 'title' | 'cover' | 'tags') => void;
  /** 「在原稿編輯」: put the editor caret at a source offset. */
  editSource: (sourceOffset: number) => void;
  /** 「在原稿標出第 N 字」: select the cut point in the editor (source offset). */
  markCut: () => void;
  /** 「用 AI 縮寫」: a shortened source as a candidate with diff in the editor. */
  shorten: () => void;
  /** Input method composition (no autosave while composing). */
  composing: (on: boolean) => void;
}
