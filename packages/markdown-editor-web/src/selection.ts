import type { Nodes } from 'mdast';
import { parseMarkdown } from './lossy.js';

/** A range of Markdown source in UTF-16 offsets, `end` exclusive. */
export interface MarkdownRange {
  start: number;
  end: number;
}

/** One top-level block (paragraph, heading, list, …) of a Markdown document. */
export interface MarkdownBlock extends MarkdownRange {
  type: string;
  /** Visible text, without Markdown syntax. */
  text: string;
}

function plainText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.type === 'html' || node.type === 'yaml' ? '' : node.value;
  }
  if (node.type === 'image') return node.alt ?? '';
  if ('children' in node) {
    const sep = node.type === 'list' || node.type === 'table' || node.type === 'blockquote';
    return (node.children as Nodes[]).map(plainText).join(sep ? '\n' : '');
  }
  return '';
}

/** Top-level blocks in document order, with their source offsets. */
export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const node of parseMarkdown(markdown).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    blocks.push({ start, end, type: node.type, text: plainText(node) });
  }
  return blocks;
}

/**
 * Widen a range to the whole blocks it touches, so a rewrite never starts or
 * ends inside a word or a Markdown construct. A caret between blocks picks
 * the next block (or the last one). Null for an empty document.
 */
export function expandToBlocks(markdown: string, range: MarkdownRange): MarkdownRange | null {
  const blocks = markdownBlocks(markdown);
  if (blocks.length === 0) return null;
  const touched = blocks.filter((b) =>
    range.start === range.end
      ? range.start >= b.start && range.start <= b.end
      : b.start < range.end && b.end > range.start,
  );
  if (touched.length === 0) {
    const next = blocks.find((b) => b.start >= range.start) ?? blocks[blocks.length - 1];
    return next === undefined ? null : { start: next.start, end: next.end };
  }
  const first = touched[0] as MarkdownBlock;
  const last = touched[touched.length - 1] as MarkdownBlock;
  return { start: first.start, end: last.end };
}

const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * Find the source range of rendered blocks by their visible text (the visual
 * editor has no source offsets). `hint` is the blocks' position among the
 * rendered top-level elements, used to pick between identical paragraphs.
 * Null when a block cannot be matched.
 */
export function rangeForBlockTexts(
  markdown: string,
  startText: string,
  endText: string,
  hint: { start: number; end: number } = { start: 0, end: 0 },
): MarkdownRange | null {
  const blocks = markdownBlocks(markdown);
  const find = (text: string, preferred: number, from: number): number => {
    const want = squash(text);
    if (want === '') return -1;
    const at = blocks[preferred];
    if (preferred >= from && at !== undefined && squash(at.text) === want) return preferred;
    return blocks.findIndex((b, i) => i >= from && squash(b.text) === want);
  };
  const first = find(startText, hint.start, 0);
  if (first < 0) return null;
  const last = find(endText, hint.end, first);
  if (last < 0) return null;
  return {
    start: (blocks[first] as MarkdownBlock).start,
    end: (blocks[last] as MarkdownBlock).end,
  };
}

/** 1-based numbers of the first and last block a range covers (for 「第 2–3 段」). */
export function blockNumbers(
  markdown: string,
  range: MarkdownRange,
): { first: number; last: number } | null {
  const blocks = markdownBlocks(markdown);
  let first = -1;
  let last = -1;
  blocks.forEach((b, i) => {
    if (b.start < range.end && b.end > range.start) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return first < 0 ? null : { first: first + 1, last: last + 1 };
}
