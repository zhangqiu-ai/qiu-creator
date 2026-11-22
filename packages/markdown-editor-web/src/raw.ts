import type { Nodes, Root } from 'mdast';
import { parseMarkdown, tableIsEdgeCase } from './lossy.js';

/**
 * Syntax the visual editor cannot edit or would rewrite on save: HTML,
 * footnotes, reference-style links, table edge cases, math and directives.
 * Before a document goes into the visual editor each such span is swapped for
 * a placeholder tag (`<qc-raw n="3" />`). The editor shows the original text
 * in a read-only node and writes the tag back unchanged; saving swaps the
 * originals back in. Whatever the user does not touch therefore comes out
 * byte-for-byte as it went in.
 */
export interface RawProtected {
  /** The text to hand to the visual editor. */
  readonly text: string;
  /** The original source of each placeholder, by index. */
  readonly originals: readonly string[];
}

const PLACEHOLDER_NAME = 'qc-raw';
export const RAW_ELEMENT_NAME = PLACEHOLDER_NAME;
/**
 * `p` records the blank line `protectRawSyntax` added before (1) and after (2) a
 * block, so `restoreRawSyntax` takes it out again. The editor drops `p` when it
 * writes the document, and puts its own blank lines between blocks.
 */
const PLACEHOLDER_RE = /(\n?)<qc-raw n="(\d+)"(?: p="(\d)")?\s*\/>(\n?)/g;
/** Parents whose children are inline content. */
const INLINE_PARENTS = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell',
]);

interface Span {
  start: number;
  end: number;
  block: boolean;
}

export function placeholderFor(index: number, pad = 0): string {
  return `<${PLACEHOLDER_NAME} n="${String(index)}"${pad === 0 ? '' : ` p="${String(pad)}"`} />`;
}

/** Spans of the document that must be kept as they are. Null when it cannot be parsed or used. */
function rawSpans(markdown: string): Span[] | null {
  let tree: Root;
  try {
    tree = parseMarkdown(markdown);
  } catch {
    return null;
  }
  const spans: Span[] = [];

  /** Is this node itself raw syntax? Returns its kind, or null. */
  const kindOf = (node: Nodes, parent: Nodes | null): 'block' | 'inline' | null => {
    switch (node.type) {
      case 'html':
        return parent !== null && INLINE_PARENTS.has(parent.type) ? 'inline' : 'block';
      case 'footnoteDefinition':
      case 'definition':
        return 'block';
      case 'footnoteReference':
      case 'linkReference':
      case 'imageReference':
        return 'inline';
      case 'paragraph': {
        const s = node.position?.start.offset;
        const e = node.position?.end.offset;
        if (s === undefined || e === undefined) return null;
        const raw = markdown.slice(s, e);
        return /^(\$\$|:{2,})/.test(raw) ? 'block' : null;
      }
      case 'table':
        return tableIsEdgeCase(node, markdown) || containsRaw(node, node) ? 'block' : null;
      default:
        return null;
    }
  };
  const containsRaw = (node: Nodes, root: Nodes): boolean => {
    if (!('children' in node)) return false;
    return node.children.some((child) => {
      if (child.type === 'html' || child.type.endsWith('Reference')) return true;
      return containsRaw(child, root);
    });
  };

  const visit = (node: Nodes, parent: Nodes | null): void => {
    const kind = kindOf(node, parent);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (kind !== null && start !== undefined && end !== undefined && end > start) {
      spans.push({ start, end, block: kind === 'block' });
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child, node);
  };
  visit(tree, null);
  return spans;
}

/** Swap every raw span for a placeholder. Null when the text cannot be protected. */
export function protectRawSyntax(markdown: string): RawProtected | null {
  // A document that already uses our tag name cannot be told apart from a placeholder.
  if (markdown.includes(`<${PLACEHOLDER_NAME}`)) return null;
  const spans = rawSpans(markdown);
  if (spans === null) return null;
  spans.sort((a, b) => a.start - b.start);
  // Blocks that touch (a run of link definitions, say) go in as one.
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start < last.end) continue;
    if (last?.block === true && span.block && markdown.slice(last.end, span.start) === '\n') {
      last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  const originals: string[] = [];
  let text = '';
  let at = 0;
  for (const span of merged) {
    text += markdown.slice(at, span.start);
    // A block placeholder gets a blank line either side, so it never merges with a neighbour.
    const before =
      span.block &&
      span.start > 1 &&
      markdown[span.start - 1] === '\n' &&
      markdown[span.start - 2] !== '\n';
    const after =
      span.block &&
      markdown[span.end] === '\n' &&
      markdown[span.end + 1] !== '\n' &&
      span.end + 1 < markdown.length;
    if (before) text += '\n';
    text += placeholderFor(originals.length, (before ? 1 : 0) + (after ? 2 : 0));
    if (after) text += '\n';
    originals.push(markdown.slice(span.start, span.end));
    at = span.end;
  }
  text += markdown.slice(at);
  return { text, originals };
}

/** Put the original source back in place of each placeholder. */
export function restoreRawSyntax(text: string, originals: readonly string[]): string {
  return text.replace(
    PLACEHOLDER_RE,
    (whole, nlBefore: string, n: string, pad: string | undefined, nlAfter: string) => {
      const original = originals[Number(n)];
      if (original === undefined) return whole;
      const bits = Number(pad ?? 0);
      return `${bits & 1 ? '' : nlBefore}${original}${bits & 2 ? '' : nlAfter}`;
    },
  );
}
