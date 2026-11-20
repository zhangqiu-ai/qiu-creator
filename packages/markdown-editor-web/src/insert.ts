import { markdownBlocks } from './selection.js';

/**
 * Inserting whole blocks (an image, a divider) into Markdown text (QC-039).
 * Pure functions so both editor modes, drag and drop, and tests share them.
 */

export interface InsertResult {
  markdown: string;
  /** Where the inserted block starts and ends in the new text. */
  start: number;
  end: number;
}

/**
 * Insert `block` at `offset` as its own block: blank lines before and after
 * (none before at the very start), surrounding blank lines collapsed, and a
 * final newline when it ends the document. Whatever was there is kept.
 */
export function insertBlockAt(markdown: string, offset: number, block: string): InsertResult {
  const at = Math.max(0, Math.min(offset, markdown.length));
  const left = markdown.slice(0, at).replace(/\n+$/, '');
  const right = markdown.slice(at).replace(/^\n+/, '');
  const body = block.replace(/^\n+|\n+$/g, '');
  const prefix = left === '' ? '' : `${left}\n\n`;
  const next = `${prefix}${body}${right === '' ? '\n' : `\n\n${right}`}`;
  return { markdown: next, start: prefix.length, end: prefix.length + body.length };
}

/**
 * The block boundary at or after `offset`: the end of the block containing it
 * (a caret inside a paragraph inserts after that paragraph), or `offset`
 * itself between blocks. Never splits a block.
 */
export function blockEndAt(markdown: string, offset: number): number {
  for (const b of markdownBlocks(markdown)) {
    if (offset > b.start && offset < b.end) return b.end;
    if (offset <= b.start) return offset;
  }
  return Math.min(offset, markdown.length);
}

/**
 * Offset of the boundary before block `index` (0 = start); `index` past the
 * last block means the end of the document.
 */
export function boundaryBeforeBlock(markdown: string, index: number): number {
  const blocks = markdownBlocks(markdown);
  if (index <= 0) return 0;
  const prev = blocks[Math.min(index, blocks.length) - 1];
  return prev === undefined ? markdown.length : prev.end;
}

/** `![alt](src)` with `]`, `(`, `)` and spaces made safe (the path is already safe from attach). */
export function imageMarkdown(src: string, alt = ''): string {
  const safeAlt = alt
    .replace(/[[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safeSrc = src.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `![${safeAlt}](${safeSrc})`;
}
