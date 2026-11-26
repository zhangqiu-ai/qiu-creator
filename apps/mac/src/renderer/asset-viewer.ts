import type { AssetRecord } from '@qiu-creator/contracts';

/**
 * Rules behind the 素材庫 gallery view (QC-108, PT-20261126-001 方案 B): which
 * key does what, where the view goes after a delete, and the faint info line
 * under the content. Kept free of React so they are tested on their own.
 */

export type ViewerAction = 'prev' | 'next' | 'back' | 'closeInfo' | 'info' | 'fullscreen' | 'space';

export interface ViewerKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
}

export interface ViewerKeyContext {
  /** Focus is in a text field (the info card's name, alt text, note, tags). */
  readonly typing: boolean;
  /** Focus is on a button, link or menu item, which own Space and Enter. */
  readonly onControl: boolean;
  readonly infoOpen: boolean;
  /** The asset is a video, so F means full screen. */
  readonly video: boolean;
}

/**
 * What a key does in the gallery view (keys.png of the prototype): ← → move,
 * Esc closes the info card first and then goes back to the grid, I toggles
 * the info card, F puts a video in full screen, Space plays or opens the
 * full-window preview. ↑ ↓ are not bound. Nothing while typing, except Esc.
 */
export function viewerKeyAction(e: ViewerKeyEvent, ctx: ViewerKeyContext): ViewerAction | null {
  if (e.isComposing || e.defaultPrevented) return null;
  if (e.key === 'Escape') return ctx.infoOpen ? 'closeInfo' : 'back';
  if (ctx.typing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'ArrowLeft' && !e.shiftKey) return 'prev';
  if (e.key === 'ArrowRight' && !e.shiftKey) return 'next';
  if (e.shiftKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'i') return 'info';
  if (key === 'f' && ctx.video) return 'fullscreen';
  if (e.key === ' ' && !ctx.onControl) return 'space';
  return null;
}

/**
 * The asset to show after `removed` left the list (檢視中刪除後跳到下一個):
 * the next one, else the previous one, else none (back to the grid).
 */
export function nextAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/**
 * Characters for a Markdown asset's info line: CJK characters count one each,
 * runs of Latin letters or digits count as one word; Markdown marks and front
 * matter do not count.
 */
export function countWords(markdown: string): number {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const cjk = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  );
  const words = text
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
    .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return (cjk?.length ?? 0) + (words?.length ?? 0);
}

/** The second at which a video's card thumbnail is taken: past a black first frame, inside short clips. */
export function thumbTime(duration: number | null): number {
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return 1;
  return Math.min(1, duration / 2);
}

/** Whether the gallery view can show this kind large (otherwise an icon and the file's facts). */
export function viewable(asset: Pick<AssetRecord, 'kind'>): boolean {
  return (
    asset.kind === 'image' ||
    asset.kind === 'video' ||
    asset.kind === 'audio' ||
    asset.kind === 'markdown'
  );
}
